// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Constants} from "./Constants.sol";
import {MathLib} from "./MathLib.sol";
import {IScaledUIAmount} from "../interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title ScaledUIAmountUpgradeable
 * @notice ERC-8056 core + all three extensions, backed by a CONTINUOUS,
 *         absolutely-time-anchored accrual segment rather than a discrete step.
 *
 * @dev ## Why a segment instead of a step
 *
 *      ERC-8056's reference implementation models a stock split: an instantaneous
 *      jump at `effectiveAt`. That is the right shape for equities and the wrong
 *      shape for a yield-bearing token, for two reasons:
 *
 *        1. A step is a free round-trip. Anyone holding across it captures the whole
 *           increment with no price risk, funded out of the PSM buffer.
 *        2. **A step cannot be synchronised across chains.** Oku Money deploys to ten
 *           networks. An orchestrator stepping each chain separately opens a window
 *           on every mark during which chain A has stepped and chain B has not — a
 *           cross-chain round-trip for as long as propagation takes.
 *
 *      The EIP explicitly permits this: *"How the multiplier is updated is an
 *      implementation detail left to the token issuer."* Only the interface, the
 *      18-decimal precision, ERC-165 detection, and the pending-multiplier extension
 *      are normative.
 *
 *      ## The synchronisation property
 *
 *      A segment is `(baseIndex, ratePerSecond, startTime, endTime)` anchored to
 *      ABSOLUTE wall-clock time — never to `block.timestamp` at the moment of the
 *      write. The index is therefore a pure function of time:
 *
 *          index(t) = baseIndex * rpow(rate, min(t, endTime) - startTime) / PRECISION
 *
 *      Publish identical parameters on every chain and every chain reports an
 *      identical multiplier at every instant, regardless of when each transaction
 *      landed. No messaging, no oracle, no sync window, no bridge.
 *
 *      It is also self-healing. Because the operator supplies `baseIndex` as an
 *      absolute value rather than the contract deriving it from local history, a
 *      chain that misses a segment entirely is restored to the canonical value by
 *      the next one. Deriving the base locally would make such a divergence
 *      permanent.
 *
 *      ## Mapping onto ERC-8056
 *
 *      A segment scheduled to begin in the future IS the pending multiplier:
 *
 *          effectiveAt()      == pending.startTime
 *          newUIMultiplier()  == pending.baseIndex   (the value it takes effect at)
 *
 *      so `uiMultiplier() == newUIMultiplier()` exactly at `effectiveAt`, and the
 *      standard's scheduling primitive doubles as the multichain sync primitive.
 *
 *      ## Deliberate conformance deviation
 *
 *      `uiMultiplier()` drifts continuously while `UIMultiplierUpdated` is emitted
 *      only when a segment is declared. A consumer that caches on the event will
 *      under-display. The value is monotonically non-decreasing, so staleness always
 *      understates and never overstates. Documented normatively for integrators.
 *
 *      ## Deviations from the EIP reference implementation
 *
 *      1. `Math.mulDiv` (via `MathLib`) rather than naive multiplication, extending
 *         the safe input domain by 1e18x without making it unbounded.
 *      2. The reference's setter branches on `>` while its view resolves on `>=`, so
 *         a pending value maturing in the same second as the next write is silently
 *         lost. {_installSegment} crystallises through the same `>=`-consistent
 *         resolution the view uses, which removes the second branch entirely.
 *
 *      No `supportsInterface` here — the inheriting contract combines this with
 *      `AccessControlUpgradeable`'s ERC-165 and declares the final override using
 *      {isScaledUIAmountInterface}.
 */
abstract contract ScaledUIAmountUpgradeable is
    Initializable,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    /// @notice One accrual segment. Fully describes the index for all time within it.
    /// @dev Packs into two slots: (uint256, uint256) + (uint64, uint64).
    struct Segment {
        /// @dev Index value at exactly `startTime`. Absolute, operator-supplied.
        uint256 baseIndex;
        /// @dev Per-second compounding rate, 1e18 = no accrual.
        uint256 ratePerSecond;
        /// @dev Absolute wall-clock start. The anchor that makes chains agree.
        uint64 startTime;
        /// @dev Accrual FLATLINES past this. A missed renewal freezes yield rather
        ///      than compounding unboundedly — the safe default.
        uint64 endTime;
    }

    /// @custom:storage-location erc7201:okumoney.storage.OkuMScaledUI
    struct ScaledUIAmountStorage {
        Segment current;
        Segment pending;
        /// @dev Guardian latch. Blocks further segment declarations; does not
        ///      retroactively alter an in-flight segment, which continues to its
        ///      `endTime` and then flatlines.
        bool accrualHalted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMScaledUI")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SCALED_UI_AMOUNT_STORAGE_LOCATION =
        0x8dde67c0ad66c57d4d9e61c48c6173a56724870d5e3aba8607550c81775e7000;

    function _getScaledUIAmountStorage() internal pure returns (ScaledUIAmountStorage storage $) {
        assembly {
            $.slot := SCALED_UI_AMOUNT_STORAGE_LOCATION
        }
    }

    /// @dev Seeds a flat segment at `PRECISION` starting now.
    ///
    ///      BOTH `current` and `pending` must be seeded. {uiMultiplier} resolves
    ///      `block.timestamp >= pending.startTime ? pending : current`, so leaving
    ///      `pending` zeroed would make a freshly deployed token report a
    ///      `uiMultiplier()` of zero — every conversion returning zero or dividing
    ///      by zero, and the token bricked from deployment. This is a real defect in
    ///      the EIP's own reference implementation shape; it is seeded here
    ///      deliberately and asserted in the test suite.
    function __ScaledUIAmount_init() internal onlyInitializing {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        Segment memory flat = Segment({
            baseIndex: Constants.PRECISION,
            ratePerSecond: Constants.PRECISION,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp)
        });
        $.current = flat;
        $.pending = flat;
    }

    // ============ Index resolution ============

    /// @notice The multiplier at an arbitrary timestamp. Pure function of `t`.
    /// @dev Public because cross-chain reconciliation, the wrapper's forward
    ///      solvency projection, and operator tooling all need to evaluate the index
    ///      at a time other than now. Determinism here is the whole design.
    function indexAt(uint256 t) public view returns (uint256) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        Segment storage s = (t >= $.pending.startTime) ? $.pending : $.current;

        if (t <= s.startTime) return s.baseIndex;

        // Flatline past endTime: a missed renewal freezes accrual.
        uint256 until = t < s.endTime ? t : s.endTime;
        uint256 elapsed = until - s.startTime;
        if (elapsed == 0) return s.baseIndex;

        uint256 grown = MathLib.compound(s.baseIndex, s.ratePerSecond, elapsed);
        return grown > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : grown;
    }

    // ============ IScaledUIAmount ============

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() public view returns (uint256) {
        return indexAt(block.timestamp);
    }

    // ============ IScaledUIAmountNewUIMultiplier (required extension) ============

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev The value the pending segment takes effect AT, which is precisely its
    ///      `baseIndex`. Equals {uiMultiplier} exactly at {effectiveAt}.
    function newUIMultiplier() external view returns (uint256) {
        return _getScaledUIAmountStorage().pending.baseIndex;
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    function effectiveAt() external view returns (uint256) {
        return _getScaledUIAmountStorage().pending.startTime;
    }

    // ============ IScaledUIAmountConversion ============

    /// @inheritdoc IScaledUIAmountConversion
    function toUIAmount(uint256 rawAmount) public view returns (uint256) {
        return MathLib.toUIAmount(rawAmount, uiMultiplier());
    }

    /// @inheritdoc IScaledUIAmountConversion
    function fromUIAmount(uint256 uiAmount) public view returns (uint256) {
        return MathLib.fromUIAmount(uiAmount, uiMultiplier());
    }

    // ============ IScaledUIAmountBalances ============

    /// @inheritdoc IScaledUIAmountBalances
    function balanceOfUI(address account) public view returns (uint256) {
        return toUIAmount(_scaledUIRawBalanceOf(account));
    }

    /// @inheritdoc IScaledUIAmountBalances
    function totalSupplyUI() public view returns (uint256) {
        return toUIAmount(_scaledUIRawTotalSupply());
    }

    function _scaledUIRawBalanceOf(address account) internal view virtual returns (uint256);
    function _scaledUIRawTotalSupply() internal view virtual returns (uint256);

    // ============ Segment accessors ============

    /// @notice The segment currently governing accrual at `block.timestamp`.
    function activeSegment() external view returns (Segment memory) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        return (block.timestamp >= $.pending.startTime) ? $.pending : $.current;
    }

    /// @notice The scheduled segment, whether or not it has taken effect.
    function pendingSegment() external view returns (Segment memory) {
        return _getScaledUIAmountStorage().pending;
    }

    /// @notice When accrual stops absent a new declaration.
    function rateEnd() external view returns (uint256) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        return (block.timestamp >= $.pending.startTime) ? $.pending.endTime : $.current.endTime;
    }

    /// @notice Whether further segment declarations are latched off.
    /// @dev `public`, not `external`: the inheriting contract's rate setter needs to
    ///      read it internally.
    function accrualHalted() public view returns (bool) {
        return _getScaledUIAmountStorage().accrualHalted;
    }

    // ============ Internal mutation ============

    /// @dev Installs a segment. Crystallises a matured pending segment into `current`
    ///      first, reading through the same `>=` comparison {indexAt} uses so the
    ///      reference implementation's boundary defect cannot occur.
    ///
    ///      Validation (bounds, monotonicity, re-anchor limits) is the caller's
    ///      responsibility — this performs the write and emits the spec event only.
    function _installSegment(Segment memory next) internal {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();

        uint256 previousPending = $.pending.baseIndex;
        if (block.timestamp >= $.pending.startTime) {
            $.current = $.pending;
        }
        $.pending = next;

        emit UIMultiplierUpdated(previousPending, next.baseIndex, next.startTime);
    }

    function _setAccrualHalted(bool halted) internal {
        _getScaledUIAmountStorage().accrualHalted = halted;
    }

    /// @dev Exposed so the inheriting contract's `supportsInterface` can combine this
    ///      with its other ERC-165 bases without duplicating the ID list.
    function isScaledUIAmountInterface(bytes4 interfaceId) internal pure returns (bool) {
        return interfaceId == Constants.IID_SCALED_UI_AMOUNT
            || interfaceId == Constants.IID_SCALED_UI_NEW_MULTIPLIER
            || interfaceId == Constants.IID_SCALED_UI_CONVERSION
            || interfaceId == Constants.IID_SCALED_UI_BALANCES;
    }
}
