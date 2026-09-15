// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OkuMoneyEvents} from "../lib/events/OkuMoneyEvents.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
} from "../interfaces/IScaledUIAmount.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token (ticker `OkuM`) backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). `okuMMultiplier()` is NOT stored — it is
 *      COMPUTED continuously from a rate schedule via {MathLib.computeMultiplier}.
 *      See README.md § Streaming Accrual for the full MEV / cross-chain rationale.
 *      `setOkuMMultiplier` survives as a discrete emergency override only.
 *
 *      Also implements ERC-8056 (Scaled UI Amount) over the same multiplier — see
 *      {IScaledUIAmount} for the deviations continuous accrual necessitates.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMMultiplier() is a separate view function for pricing — used by PSM and vault.
 *
 *      Minter-allowance design (per-minter cap, decremented on mint) follows Circle's
 *      FiatToken pattern: https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 *      See Constants.sol for terminology legend. Storage uses ERC-7201 namespaced
 *      storage (https://eips.ethereum.org/EIPS/eip-7201) for upgrade safety.
 */
contract OkuMoney is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    OkuMoneyEvents,
    IOkuMoney,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        // ---- Streaming yield schedule (written by OKUM_REBASER), packed into 2 slots ----
        // The multiplier is COMPUTED from these six fields via MathLib.computeMultiplier(),
        // never stored directly. See okuMMultiplier(). Field widths are bounded by
        // MAX_MULTIPLIER (1e24, fits uint96), MAX_RATE (~1e18, fits uint64), and
        // Unix timestamps (fit uint48 until year ~8.9M) — all enforced by SafeCast at
        // every write site, so a truncating downcast can never silently corrupt state.
        //
        // Slot 1: base | rate | pendingRate (96 + 64 + 64 = 224 bits)
        // Snapshot multiplier taken at `okuMLastAccrualTime` (starts at 1e18 = $1.00).
        uint96 okuMBaseMultiplier;
        // Active per-second rate (PRECISION = no yield). Bounded by Constants.MAX_RATE.
        uint64 okuMRatePerSecond;
        // Successor rate, activates after `okuMRateEnd` with no transaction at the
        // boundary. This is what keeps multi-chain epoch handovers simultaneous.
        uint64 okuMPendingRatePerSecond;
        // Slot 2: lastAccrualTime | rateEnd | pendingRateEnd (48 + 48 + 48 = 144 bits)
        // Timestamp `okuMBaseMultiplier` was snapshotted at.
        uint48 okuMLastAccrualTime;
        // Timestamp the active rate expires. 0 only when `okuMRatePerSecond == PRECISION`
        // (the halted sentinel) — any yielding rate always carries a bounded window; see
        // {setOkuMYieldRate}.
        uint48 okuMRateEnd;
        // Timestamp the pending (successor) rate itself expires, bounding how long it
        // can compound unattended past `okuMRateEnd` before accrual halts. 0 only when
        // `okuMPendingRatePerSecond == PRECISION` (none armed).
        uint48 okuMPendingRateEnd;
        // Minter allowance system (Circle FiatToken pattern; see contract NatSpec for source)
        mapping(address => uint256) minterAllowance;
        // Supply cap in token units
        uint256 maxSupply;
        // Blacklist
        mapping(address => bool) isBlacklisted;
        // Block number of the last discrete multiplier override. Used by
        // YieldSandwichGuard consumers (OkuDollar, LitePSM) to block PSM/vault
        // operations in the same block as a discrete write. Continuous accrual
        // creates no step and therefore never stamps this.
        uint256 lastYieldDistributionBlock;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoney")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUMONEY_STORAGE_LOCATION =
        0xa46c29efb747c5ba816fcb25c64c7053e640ad72653ff106cdc2a03e8238d100;

    function _getOkuMoneyStorage() private pure returns (OkuMoneyStorage storage $) {
        assembly {
            $.slot := OKUMONEY_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, MultiplierCannotDecrease) live in lib/Errors.sol.
    // REMOVED (streaming-accrual refactor): ZeroSupply — was only reachable from
    // the deleted `distributeYield(uint256)`; the rate-schedule setters have no
    // supply-dependent math and never revert on zero supply.
    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @dev Math-sanity ceiling — caps the dollar-value-per-token at
    ///      `Constants.MAX_MULTIPLIER` (= $1,000,000) so downstream
    ///      multiplications (PSM mint/redeem, OkuDollar wrap/unwrap) cannot
    ///      lose precision or overflow. The cap is far above any realistic
    ///      yield trajectory; its purpose is to keep the `uint256 * uint256`
    ///      paths within the overflow-safe region, not to constrain a trusted
    ///      operator. Mirrors the explicit `MAX_MULTIPLIER` guard on the SVM side
    ///      (`oku-shared::constants::MAX_MULTIPLIER`, scaled for SVM's 1e9 precision).
    error MultiplierTooHigh();
    /// @dev Rate below `Constants.PRECISION` would shrink the multiplier, violating
    ///      monotonicity. `PRECISION` exactly is the no-yield placeholder.
    error InvalidRate();
    /// @dev Rate above `Constants.MAX_RATE` (~2242% APY), the rpow input sanity bound.
    error RateTooHigh();
    /// @dev Halting (`newRate == PRECISION`) requires `endTimestamp == 0` — a halted
    ///      rate has no window to bound. Passing a non-zero timestamp here reverts
    ///      even if that timestamp is validly in the future.
    error EndTimestampNotAllowed();
    /// @dev A yielding rate's `endTimestamp` must be strictly in the future.
    error EndTimestampInPast();
    /// @dev {setNextOkuMYieldRate}'s `pendingEndTimestamp` must be strictly after
    ///      the active rate's `okuMRateEnd` — it bounds how long the successor can
    ///      compound unattended past activation.
    error PendingEndNotAfterRateEnd();
    /// @dev {setNextOkuMYieldRate} requires a bounded active window to schedule against.
    error NoRateEndSet();
    /// @dev Staging a successor after the active rate already expired would let the
    ///      pending rate accrue from a past `okuMRateEnd` the moment it activates,
    ///      snapshotting unearned yield. Force a fresh {setOkuMYieldRate} instead.
    error RateAlreadyExpired();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name_ ERC-20 name
    /// @param symbol_ ERC-20 symbol (canonical ticker is `OkuM`)
    /// @param _admin Admin address (receives the full role set; see role-grant policy below)
    /// @param initialMaxSupply Initial supply cap
    /// @dev Admin is granted every role at deployment. Operators are expected to
    ///      redistribute operational roles to multisigs, hot wallets, and bridge
    ///      contracts post-deploy. The other contracts in the suite follow the same
    ///      policy and link back here for the canonical description.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _admin,
        uint256 initialMaxSupply
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        // Streaming schedule starts flat and halted: base $1.00, no-yield rate.
        $.okuMBaseMultiplier = uint96(Constants.PRECISION);
        $.okuMRatePerSecond = uint64(Constants.PRECISION);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMPendingRatePerSecond = uint64(Constants.PRECISION);
        $.maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKUM_UPGRADER, _admin);
        _grantRole(Roles.OKUM_PAUSER, _admin);
        _grantRole(Roles.OKUM_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_MINTER, _admin);
        // Both mint and burn are granted to `_admin` at init; operational
        // scripts grant both to the LitePSM proxy after deploy.
        _grantRole(Roles.OKUM_BURNER, _admin);
        _grantRole(Roles.OKUM_REBASER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKUM_CAP_MANAGER, _admin);
        _grantRole(Roles.OKUM_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC20 + IOkuMoney Overrides ============
    // ERC20Upgradeable and IOkuMoney both declare these functions; explicit override
    // specifiers satisfy the Solidity compiler's diamond-inheritance requirement.

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IERC20)
        returns (uint256)
    {
        return super.balanceOf(account);
    }

    function totalSupply() public view override(ERC20Upgradeable, IERC20) returns (uint256) {
        return super.totalSupply();
    }

    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        return super.transfer(to, amount);
    }

    // ============ Storage Accessor Views ============

    /// @notice Remaining minter allowance for `minter_`, in raw token units.
    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuMoneyStorage().minterAllowance[minter_];
    }

    /// @notice Global supply cap in raw token units.
    function maxSupply() external view returns (uint256) {
        return _getOkuMoneyStorage().maxSupply;
    }

    /// @notice Whether `account` is on the blacklist.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuMoneyStorage().isBlacklisted[account];
    }

    /// @notice Block number of the last yield distribution (used by YieldSandwichGuard,
    ///         0 if no distribution has occurred).
    function lastYieldDistributionBlock() external view returns (uint256) {
        return _getOkuMoneyStorage().lastYieldDistributionBlock;
    }

    // ============ Multiplier Logic (Continuous Streaming Accrual) ============

    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev COMPUTED, not stored. Streams continuously from the rate schedule via
    ///      {MathLib.computeMultiplier}, so there is no discrete step for an
    ///      arbitrageur to sandwich (mint before / redeem after a jump).
    ///
    ///      Contains no supply term. Given identical schedule state, every chain
    ///      returns the identical `uint256` at the identical `block.timestamp` —
    ///      which is what makes cross-chain agreement hold with no messaging,
    ///      light client, or state proof.
    ///
    ///      `balanceOf()` is unaffected (OkuM is non-rebasing); the multiplier is
    ///      consumed by the PSM and vault for pricing.
    function okuMMultiplier() public view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        return MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            $.okuMRateEnd,
            $.okuMPendingRatePerSecond,
            $.okuMPendingRateEnd,
            block.timestamp
        );
    }

    /// @notice The schedule's stored active-window rate (1e18 = no yield).
    /// @dev Raw storage, not lazily rolled forward. Once `block.timestamp >
    ///      okuMRateEnd`, {okuMMultiplier} is already accruing at
    ///      `okuMPendingRatePerSecond` instead (see {MathLib.computeMultiplier}) —
    ///      no transaction is required at the boundary, by design, so this getter
    ///      can lag the multiplier's actual accrual rate until the next schedule
    ///      write. Use {okuMEffectiveRatePerSecond} for the rate actually accruing
    ///      right now.
    function okuMRatePerSecond() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRatePerSecond;
    }

    /// @notice The per-second rate actually accruing right now.
    /// @dev Returns `okuMPendingRatePerSecond` once `okuMRateEnd` has elapsed and a
    ///      successor was armed, `PRECISION` once that successor's own
    ///      `okuMPendingRateEnd` has also elapsed (accrual halted — see
    ///      {MathLib.computeMultiplier}), otherwise `okuMRatePerSecond`. Prefer
    ///      this over the raw {okuMRatePerSecond} getter for monitoring/drift-
    ///      checking, since the raw field is never rolled forward at either
    ///      window boundary. Also used internally by the pause gates on
    ///      {setOkuMYieldRate} / {setNextOkuMYieldRate} so "is this an increase"
    ///      is judged against what is actually accruing, not stale storage.
    function okuMEffectiveRatePerSecond() public view returns (uint256) {
        return _effectiveRate(_getOkuMoneyStorage());
    }

    function _effectiveRate(OkuMoneyStorage storage $) private view returns (uint256) {
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd != 0 && block.timestamp > rateEnd) {
            uint256 pendingRateEnd = $.okuMPendingRateEnd;
            if (pendingRateEnd != 0 && block.timestamp > pendingRateEnd) {
                return Constants.PRECISION;
            }
            return $.okuMPendingRatePerSecond;
        }
        return $.okuMRatePerSecond;
    }

    /// @notice Snapshot multiplier taken at {okuMLastAccrualTime}.
    function okuMBaseMultiplier() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMBaseMultiplier;
    }

    /// @notice Timestamp the base multiplier was snapshotted at.
    function okuMLastAccrualTime() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMLastAccrualTime;
    }

    /// @notice Timestamp the active rate expires (0 = accrual halted; open-ended
    ///         yielding rates are rejected — see {setOkuMYieldRate}).
    function okuMRateEnd() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRateEnd;
    }

    /// @notice Successor rate, active after {okuMRateEnd} (1e18 = none armed).
    function okuMPendingRatePerSecond() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMPendingRatePerSecond;
    }

    /// @notice Timestamp the pending (successor) rate itself expires (0 = none armed).
    function okuMPendingRateEnd() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMPendingRateEnd;
    }

    /// @notice Set the active yield rate, re-anchoring the accrual base.
    /// @param newRate Per-second rate, in [PRECISION, MAX_RATE]. PRECISION halts accrual.
    /// @param endTimestamp Unix timestamp the rate expires. Must be 0 when
    ///        `newRate == PRECISION` (halted); must be strictly future otherwise —
    ///        every yielding rate carries a bounded window. An open-ended rate
    ///        would only stop when the next transaction happens to land, and that
    ///        transaction lands at different wall-clock times on different chains —
    ///        reintroducing exactly the cross-chain divergence streaming accrual
    ///        exists to eliminate (see EVM/README.md § Streaming Accrual). The
    ///        `rpow` overflow bound (~30 years at MAX_RATE) is a secondary benefit
    ///        of the same requirement, not the primary reason for it.
    /// @dev Snapshots the current multiplier into `okuMBaseMultiplier` and resets
    ///      `okuMLastAccrualTime` to now, so the curve is CONTINUOUS across the
    ///      write — there is no step, and nothing to sandwich. This is why the
    ///      function does not stamp `lastYieldDistributionBlock`.
    ///
    ///      Clears any armed pending rate: a fresh schedule supersedes it.
    ///
    ///      Intentionally NOT pause-gated for decreases. Operators may need to ZERO
    ///      the rate during an incident response; see the pause check below, which
    ///      only blocks INCREASES while paused (an inflated multiplier realised by
    ///      whoever redeems first on unpause is the failure mode being guarded).
    ///
    ///      OPERATIONAL NOTE: for rear-facing epochs, prefer {setNextOkuMYieldRate}
    ///      to pre-stage the successor — see EVM/README.md for the epoch pipeline.
    ///      Under the base+settlement epoch model, prefer
    ///      {setOkuMYieldRateWithSuccessor} instead of calling this and
    ///      {setNextOkuMYieldRate} as two separate transactions — see that
    ///      function's NatSpec for the atomicity hazard doing so separately
    ///      creates.
    function setOkuMYieldRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKUM_REBASER)
    {
        _setOkuMYieldRate(newRate, endTimestamp);
    }

    /// @dev Shared body for {setOkuMYieldRate} and {setOkuMYieldRateWithSuccessor}.
    function _setOkuMYieldRate(uint256 newRate, uint256 endTimestamp) private {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();
        if (newRate == Constants.PRECISION) {
            if (endTimestamp != 0) revert EndTimestampNotAllowed();
        } else {
            if (endTimestamp <= block.timestamp) revert EndTimestampInPast();
        }

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldRate = $.okuMRatePerSecond;
        // While paused, only decreases relative to the EFFECTIVE rate are allowed
        // (incident response needs to be able to zero accrual). Comparing against
        // raw storage instead would let a caller "increase" up to a stale rate that
        // is actually higher than what's presently accruing (e.g. after a lower
        // pending rate has already taken over) — that's still a real increase in
        // practice, so the check must use the same value {okuMMultiplier} does.
        // An increase while paused would let an inflated multiplier be realised
        // entirely by whoever redeems first on unpause, since no one can exit in
        // between to arbitrage it away.
        if (newRate > _effectiveRate($) && paused()) revert PausableUpgradeable.EnforcedPause();
        uint256 snapshot = okuMMultiplier();

        _emitPendingRateCancelledIfArmed($);

        $.okuMBaseMultiplier = SafeCast.toUint96(snapshot);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMRateEnd = SafeCast.toUint48(endTimestamp);
        $.okuMPendingRatePerSecond = uint64(Constants.PRECISION);
        $.okuMPendingRateEnd = 0;

        emit OkuMYieldRateUpdated(oldRate, newRate, endTimestamp, snapshot);
        // ERC-8056: the multiplier schedule changed. Under continuous accrual the
        // multiplier itself changes every second, so the EIP's "emit on every
        // change" is not satisfiable; rate changes are the discrete events.
        // old == new is deliberate, not a bug: the write is continuous across the
        // curve (see NatSpec above), so the VALUE has no discontinuity at this
        // instant even though the RATE governing it going forward just did —
        // faithfully representing that as "oldMultiplier == newMultiplier ==
        // snapshot, effective now" is more accurate than inventing a future value
        // for a field the EIP defines as the *current* multiplier.
        emit UIMultiplierUpdated(snapshot, snapshot, block.timestamp);
    }

    /// @dev Emits {IScaledUIAmount-UIMultiplierUpdateCancelled} if a successor rate
    ///      is currently staged AND HAS NOT YET ACTIVATED, using the schedule state
    ///      as it stands BEFORE the caller mutates it. Shared by every writer that
    ///      clears `okuMPendingRatePerSecond` ({setOkuMYieldRate}, {setOkuMMultiplier})
    ///      or replaces it ({setNextOkuMYieldRate}).
    ///
    ///      The `block.timestamp < rateEnd` guard matters once `rateEnd` has already
    ///      elapsed: at that point the "pending" rate has already ACTIVATED (see
    ///      {MathLib.computeMultiplier} branch 2) and this call is promoting or
    ///      re-anchoring the schedule, not cancelling a still-future successor.
    ///      Without this guard, a re-anchor performed any time after `rateEnd` would
    ///      spuriously emit `UIMultiplierUpdateCancelled` every time — wrong
    ///      ERC-8056 semantics, and misleading to any indexer or monitor that reads
    ///      the event as "an operator changed their mind before the successor took
    ///      effect."
    function _emitPendingRateCancelledIfArmed(OkuMoneyStorage storage $) private {
        uint256 pendingRate = $.okuMPendingRatePerSecond;
        uint256 rateEnd = $.okuMRateEnd;
        if (pendingRate <= Constants.PRECISION || rateEnd == 0) return;
        if (block.timestamp >= rateEnd) return;

        uint256 cancelledMultiplier = MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            rateEnd,
            pendingRate,
            $.okuMPendingRateEnd,
            rateEnd
        );
        emit UIMultiplierUpdateCancelled(cancelledMultiplier, rateEnd);
    }

    /// @notice Pre-stage the successor rate that activates after {okuMRateEnd}.
    /// @param newRate Per-second rate, in [PRECISION, MAX_RATE].
    /// @param pendingEndTimestamp Timestamp the successor itself expires. Must be
    ///        strictly after `okuMRateEnd` — bounds how long the successor can
    ///        compound unattended before accrual halts (see {MathLib.computeMultiplier}).
    /// @dev The handover fires off the absolute `okuMRateEnd` timestamp inside
    ///      {okuMMultiplier}, with NO transaction at the boundary. Staging
    ///      transactions may therefore land on different chains at different
    ///      times — even days apart — and the activation is still simultaneous
    ///      to the second. This is the primitive that makes the rear-facing
    ///      epoch pipeline cross-chain safe.
    ///
    ///      Requires a bounded active window (`okuMRateEnd != 0`) that has not
    ///      already elapsed.
    ///
    ///      Pause-gated the same way as {setOkuMYieldRate}: while paused, staging
    ///      a successor above the current effective rate reverts. Without this, an
    ///      operator could stage a `MAX_RATE` successor during a pause that later
    ///      activates at `okuMRateEnd` with no transaction at the boundary — the
    ///      exact inflate-while-users-can't-exit vector the gate on the active
    ///      setter closes.
    function setNextOkuMYieldRate(
        uint256 newRate,
        uint256 pendingEndTimestamp
    )
        external
        onlyRole(Roles.OKUM_REBASER)
    {
        _setNextOkuMYieldRate(newRate, pendingEndTimestamp);
    }

    /// @dev Shared body for {setNextOkuMYieldRate} and {setOkuMYieldRateWithSuccessor}.
    function _setNextOkuMYieldRate(uint256 newRate, uint256 pendingEndTimestamp) private {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd == 0) revert NoRateEndSet();
        if (block.timestamp >= rateEnd) revert RateAlreadyExpired();
        if (pendingEndTimestamp <= rateEnd) revert PendingEndNotAfterRateEnd();
        if (newRate > _effectiveRate($) && paused()) revert PausableUpgradeable.EnforcedPause();

        _emitPendingRateCancelledIfArmed($);

        $.okuMPendingRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMPendingRateEnd = SafeCast.toUint48(pendingEndTimestamp);

        emit NextOkuMYieldRateSet(newRate, rateEnd, pendingEndTimestamp);
    }

    /// @notice Atomically re-anchor the active rate AND stage its successor in one
    ///         transaction — {setOkuMYieldRate} followed by {setNextOkuMYieldRate}
    ///         with no observable state in between.
    /// @param newRate Per-second rate for the window starting now, in
    ///        [PRECISION, MAX_RATE]. See {setOkuMYieldRate}.
    /// @param endTimestamp Unix timestamp `newRate` expires. See {setOkuMYieldRate}.
    /// @param nextRate Per-second rate for the successor window, in
    ///        [PRECISION, MAX_RATE]. See {setNextOkuMYieldRate}.
    /// @param nextEndTimestamp Unix timestamp `nextRate` itself expires; must be
    ///        strictly after `endTimestamp`. See {setNextOkuMYieldRate}.
    /// @dev MOTIVATION: the base+settlement epoch model (EVM/README.md § Rear-Facing
    ///      Epoch Accounting) re-anchors to a new rate AND stages its successor at
    ///      every epoch boundary — twice per epoch, forever. Doing that as two
    ///      separate transactions has a real failure window: {setOkuMYieldRate}
    ///      unconditionally clears any pending rate (see its NatSpec), so if the
    ///      first transaction lands and the second fails or is delayed, the chain
    ///      is left with NO successor staged. Accrual then silently halts at
    ///      `endTimestamp` (see {MathLib.computeMultiplier}) until the operator
    ///      notices and re-arms — exactly the accrual-gap failure mode
    ///      `checkMultiplierDrift.ts` now treats as an error rather than a warning.
    ///      This function closes that window entirely: both writes land in one
    ///      transaction or neither does.
    ///
    ///      Pure composition of the two shared bodies — every check, event, and
    ///      pause-gate behavior of {setOkuMYieldRate} and {setNextOkuMYieldRate}
    ///      applies unchanged, in the same order, including that the first call's
    ///      `_emitPendingRateCancelledIfArmed` observes the schedule as it stood
    ///      before EITHER write (so a previously-armed successor is correctly
    ///      reported cancelled, then the new one is armed by the second call).
    function setOkuMYieldRateWithSuccessor(
        uint256 newRate,
        uint256 endTimestamp,
        uint256 nextRate,
        uint256 nextEndTimestamp
    )
        external
        onlyRole(Roles.OKUM_REBASER)
    {
        _setOkuMYieldRate(newRate, endTimestamp);
        _setNextOkuMYieldRate(nextRate, nextEndTimestamp);
    }

    /// @notice Emergency discrete override — re-anchors the accrual base.
    /// @param newMultiplier New base multiplier (must be > current, <= MAX_MULTIPLIER).
    /// @dev ESCAPE HATCH ONLY. Normal yield flows through {setOkuMYieldRate}.
    ///
    ///      Collapses the schedule to halted: writes `okuMBaseMultiplier = newMultiplier`,
    ///      resets `okuMLastAccrualTime` to now, and zeroes the active/pending rate and
    ///      `okuMRateEnd` / `okuMPendingRateEnd`. An operator must call
    ///      {setOkuMYieldRate} afterward to resume accrual.
    ///
    ///      This DOES create a discontinuity, so it stamps `lastYieldDistributionBlock`
    ///      and every PSM/vault path guarded by `whenYieldNotDistributing` reverts for
    ///      the remainder of the block. That guard exists solely for this function.
    ///
    ///      Rejects `newMultiplier <= current` so a no-op cannot burn the
    ///      sandwich-lock window. Pause-gated: a discrete value move is a
    ///      state-effect and must freeze alongside transfers during an incident.
    function setOkuMMultiplier(uint256 newMultiplier)
        external
        onlyRole(Roles.OKUM_REBASER)
        whenNotPaused
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 currentMultiplier = okuMMultiplier();
        if (newMultiplier <= currentMultiplier) revert Errors.MultiplierCannotDecrease();
        if (newMultiplier > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();

        _emitPendingRateCancelledIfArmed($);

        $.lastYieldDistributionBlock = block.number;
        $.okuMBaseMultiplier = SafeCast.toUint96(newMultiplier);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        // Collapse the schedule rather than leaving it running — see contract NatSpec.
        $.okuMRatePerSecond = uint64(Constants.PRECISION);
        $.okuMRateEnd = 0;
        $.okuMPendingRatePerSecond = uint64(Constants.PRECISION);
        $.okuMPendingRateEnd = 0;

        emit OkuMMultiplierUpdated(currentMultiplier, newMultiplier, totalSupply(), block.number);
        emit UIMultiplierUpdated(currentMultiplier, newMultiplier, block.timestamp);
    }

    // ============ ERC-8056: Scaled UI Amount ============
    // OkuM's dollar-value-per-token multiplier doubles as the ERC-8056 UI
    // multiplier. See IScaledUIAmount for the deviations from the draft spec
    // that continuous accrual necessitates.

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() external view returns (uint256) {
        return okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev OkuMoney schedules a pending *rate*, not a pending *value*. This
    ///      returns the multiplier projected to be in effect at {effectiveAt}.
    ///      When no window OR no pending rate is armed, returns the current
    ///      multiplier (nothing scheduled) — this must check BOTH conditions:
    ///      a bounded window with no successor staged is not a scheduled
    ///      change, it's just the current rate continuing (fixed regression;
    ///      an earlier version only checked `rateEnd`, so it reported a
    ///      "scheduled" multiplier — really just the current rate's natural
    ///      continuation to `rateEnd` — even when nothing was actually armed).
    function newUIMultiplier() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (
            rateEnd == 0 || block.timestamp >= rateEnd
                || $.okuMPendingRatePerSecond <= Constants.PRECISION
        ) {
            return okuMMultiplier();
        }
        return MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            rateEnd,
            $.okuMPendingRatePerSecond,
            $.okuMPendingRateEnd,
            rateEnd
        );
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Returns 0 ("nothing scheduled") unless a successor rate is
    ///      actually armed AND its window hasn't already elapsed — matching
    ///      {newUIMultiplier}'s condition exactly, so the two views never
    ///      disagree about whether a change is scheduled (fixed regression;
    ///      an earlier version returned `okuMRateEnd` whenever a bounded
    ///      window existed, regardless of whether a successor was armed).
    function effectiveAt() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (
            rateEnd == 0 || block.timestamp >= rateEnd
                || $.okuMPendingRatePerSecond <= Constants.PRECISION
        ) {
            return 0;
        }
        return rateEnd;
    }

    /// @inheritdoc IScaledUIAmountConversion
    function toUIAmount(uint256 rawAmount) external view returns (uint256) {
        return MathLib.okuMToDollars(rawAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountConversion
    function fromUIAmount(uint256 uiAmount) external view returns (uint256) {
        return MathLib.dollarsToOkuM(uiAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    function balanceOfUI(address account) external view returns (uint256) {
        return MathLib.okuMToDollars(balanceOf(account), okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    function totalSupplyUI() external view returns (uint256) {
        return MathLib.okuMToDollars(totalSupply(), okuMMultiplier());
    }

    /// @notice ERC-165 interface detection (required by ERC-8056).
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return interfaceId == type(IScaledUIAmount).interfaceId
            || interfaceId == type(IScaledUIAmountNewUIMultiplier).interfaceId
            || interfaceId == type(IScaledUIAmountConversion).interfaceId
            || interfaceId == type(IScaledUIAmountBalances).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @dev Blocks blacklisted owners or spenders from using a pre-signed permit.
    ///      Intentionally not pause-gated — approvals are allowed while paused.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        public
        virtual
        override
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    /// @dev Blocks approving a blacklisted spender, mirroring {permit}'s posture.
    ///      Does NOT retroactively revoke an allowance already granted before the
    ///      spender was blacklisted — only new/updated approvals are blocked.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        if (_getOkuMoneyStorage().isBlacklisted[spender]) revert RecipientBlacklisted();
        return super.approve(spender, value);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /// @dev Pause blocks peer-to-peer transfers; mint has its own whenNotPaused;
    ///      burn always proceeds. Blacklist applies to the non-zero side(s).
    function _update(address from, address to, uint256 amount) internal override {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);
        // No TransferValue emission. Under streaming accrual the dollar value would
        // require an rpow on every transfer (~5-10k gas, forever); without the
        // dollar-value field the event duplicates ERC-20 `Transfer` exactly.
        // Indexers derive dollar value off-chain from the rate schedule.
    }

    // ============ Minting & Burning ============

    /// @notice Mint raw tokens to an address.
    /// @param to Recipient of the minted tokens.
    /// @param amount Number of raw tokens to mint.
    /// @dev Creates raw tokens; minting 100 tokens at okuMMultiplier=$1.05 creates $105 of value.
    ///      The PSM handles USDC <-> OkuM conversion using okuMMultiplier(). See contract
    ///      NatSpec for the Circle FiatToken minter-allowance source reference.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        $.minterAllowance[msg.sender] -= amount;

        _mint(to, amount);
    }

    /// @notice Burn raw tokens from the caller's balance. Allowed while paused.
    /// @param amount Number of raw tokens to burn.
    /// @dev Gated on `OKUM_BURNER`, split from `OKUM_MINTER` — grant both to
    ///      LitePSM at deploy time; separating the two lets a future upgrade
    ///      revoke burn privileges without touching mint plumbing.
    function burn(uint256 amount) external onlyRole(Roles.OKUM_BURNER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

    /// @notice Set or update the minter allowance for `minter_`.
    /// @param minter_ Address whose allowance is being configured.
    /// @param newAllowance New allowance in raw token units.
    function configureMinterAllowance(
        address minter_,
        uint256 newAllowance
    )
        external
        onlyRole(Roles.OKUM_ALLOWANCE_MANAGER)
    {
        if (minter_ == address(0)) revert Errors.ZeroAddress();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldAllowance = $.minterAllowance[minter_];
        $.minterAllowance[minter_] = newAllowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, newAllowance);
    }

    // ============ Supply Cap Management ============

    /// @notice Update the global supply cap.
    /// @param newMaxSupply New cap in raw token units (must be >= current totalSupply).
    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKUM_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    /// @notice Add `account` to the blacklist. Works while paused.
    /// @param account Address to blacklist.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist. Works while paused.
    /// @param account Address to unblacklist.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause the contract (blocks minting, transfers, and yield distribution).
    function pause() external onlyRole(Roles.OKUM_PAUSER) {
        _pause();
    }

    /// @notice Unpause the contract.
    function unpause() external onlyRole(Roles.OKUM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKUM_UPGRADER) {}
}
