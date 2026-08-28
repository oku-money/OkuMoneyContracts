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
 * @notice ERC-8056 core interface + all three extensions, written against the
 *         Draft EIP text (no OpenZeppelin reference implementation exists).
 * @dev No `supportsInterface` here — the inheriting contract (OkuM) combines this
 *      with `AccessControlUpgradeable`'s ERC-165 and must declare the final
 *      override. Use {isScaledUIAmountInterface} in that override.
 *
 *      Two deviations from the EIP's reference implementation, both documented in
 *      `EVM/README.md § ERC-8056 on OkuM`:
 *
 *      1. `Math.mulDiv` (via `MathLib`), not naive multiply — extends the safe
 *         input domain by `PRECISION` (1e18x) without making it unbounded;
 *         `toUIAmount(type(uint256).max)` still reverts once the multiplier
 *         pushes past `MAX_MULTIPLIER`-sized results.
 *      2. `_setUIMultiplier` crystallizes the resolved current multiplier into
 *         `$.multiplier` UNCONDITIONALLY on every write (by reading through
 *         {uiMultiplier} rather than branching separately), which is what fixes
 *         the reference implementation's `block.timestamp == effectiveAt`
 *         defect: the reference's setter branches on `>` while its view resolves
 *         on `>=`, so a matured pending value can silently be lost on the next
 *         write. Resolving through the single `>=`-consistent view before
 *         overwriting removes the second branch entirely.
 *
 *      This contract writes every step with `effectiveAtTimestamp ==
 *      block.timestamp` (see {OkuM.setOkuMultiplier}) — i.e. it does not
 *      currently schedule steps ahead of effect, even though the storage and
 *      views are fully general and the pending-multiplier extension is
 *      structurally present (satisfies the EIP's required extension; the
 *      `newUIMultiplier() == uiMultiplier()` boundary invariant holds from the
 *      block of the write onward). Scheduling ahead is a mechanical follow-up if
 *      ever wanted — the storage layout does not need to change.
 */
abstract contract ScaledUIAmountUpgradeable is
    Initializable,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    /// @custom:storage-location erc7201:okumoney.storage.ScaledUIAmount
    struct ScaledUIAmountStorage {
        uint256 multiplier; // M_oku, current live value
        uint256 newMultiplier; // Scheduled next step (ERC-8056 pending extension)
        uint256 effectiveAt; // When newMultiplier takes effect
        uint256 epoch; // Orchestrator-assigned mark number. Reconciliation only
        bool accrualHalted; // OKU_GUARDIAN latch — blocks further setOkuMultiplier calls
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.ScaledUIAmount")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SCALED_UI_AMOUNT_STORAGE_LOCATION =
        0x3cb9c1d6aa88f069eb5ba8341839db9b5d23817fee13933ec1221e36b8fe7800;

    function _getScaledUIAmountStorage() internal pure returns (ScaledUIAmountStorage storage $) {
        assembly {
            $.slot := SCALED_UI_AMOUNT_STORAGE_LOCATION
        }
    }

    /// @dev Must be called from the inheriting contract's `initialize`.
    ///
    ///      BOTH `multiplier` AND `newMultiplier` must be seeded to `PRECISION`.
    ///      {uiMultiplier} resolves `block.timestamp >= effectiveAt ? newMultiplier
    ///      : multiplier`, so leaving `newMultiplier` at its zero-value would make
    ///      a freshly deployed token report `uiMultiplier() == 0` — every
    ///      conversion would return zero or divide by zero. The EIP's reference
    ///      implementation seeds both fields for the same reason.
    ///
    ///      `effectiveAt` is seeded to `block.timestamp` rather than left at zero
    ///      so `OkuMultiplierAdapter.isAccrualStopped()` (which measures
    ///      `block.timestamp - effectiveAt`) reads "fresh" at deploy instead of
    ///      instantly stale.
    function __ScaledUIAmount_init() internal onlyInitializing {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        $.multiplier = Constants.PRECISION;
        $.newMultiplier = Constants.PRECISION;
        $.effectiveAt = block.timestamp;
    }

    // ============ IScaledUIAmount ============

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() public view returns (uint256) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        return block.timestamp >= $.effectiveAt ? $.newMultiplier : $.multiplier;
    }

    // ============ IScaledUIAmountNewUIMultiplier (required extension) ============

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    function newUIMultiplier() external view returns (uint256) {
        return _getScaledUIAmountStorage().newMultiplier;
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    function effectiveAt() external view returns (uint256) {
        return _getScaledUIAmountStorage().effectiveAt;
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
    // Implemented against virtual hooks so this contract never needs to know
    // whether the inheritor's raw ledger is OZ's stock `_balances` or something
    // else; OkuM overrides both hooks to its own `balanceOf`/`totalSupply`.

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

    // ============ Reconciliation + halt state ============

    /// @notice Orchestrator-assigned mark number, written alongside every step.
    /// @dev Reconciliation counter only — it blocks nothing and does not assert
    ///      both chains wrote the SAME value for mark N, only that both wrote.
    function syncEpoch() external view returns (uint256) {
        return _getScaledUIAmountStorage().epoch;
    }

    /// @notice Whether `OKU_GUARDIAN` has halted further multiplier writes.
    function accrualHalted() external view returns (bool) {
        return _getScaledUIAmountStorage().accrualHalted;
    }

    // ============ Internal setter (role-gated by the inheriting contract) ============

    /// @dev Crystallizes the resolved current multiplier into `$.multiplier`
    ///      unconditionally (see contract NatSpec), then writes the new step and
    ///      epoch. Monotonicity, step-size, ceiling, and epoch-ordering checks are
    ///      the caller's responsibility (`OkuM.setOkuMultiplier`) — this function
    ///      only performs the storage write and emits the spec event.
    function _setUIMultiplier(
        uint256 newMultiplierValue,
        uint256 effectiveAtTimestamp,
        uint256 newEpoch
    )
        internal
    {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 previousPending = $.newMultiplier;
        $.multiplier = uiMultiplier();
        $.newMultiplier = newMultiplierValue;
        $.effectiveAt = effectiveAtTimestamp;
        $.epoch = newEpoch;
        emit UIMultiplierUpdated(previousPending, newMultiplierValue, effectiveAtTimestamp);
    }

    function _setAccrualHalted(bool halted) internal {
        _getScaledUIAmountStorage().accrualHalted = halted;
    }

    /// @dev Exposed so the inheriting contract's `supportsInterface` can combine
    ///      this with its other ERC-165 bases without duplicating the ID list.
    function isScaledUIAmountInterface(bytes4 interfaceId) internal pure returns (bool) {
        return interfaceId == Constants.IID_SCALED_UI_AMOUNT
            || interfaceId == Constants.IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER
            || interfaceId == Constants.IID_SCALED_UI_AMOUNT_CONVERSION
            || interfaceId == Constants.IID_SCALED_UI_AMOUNT_BALANCES;
    }
}
