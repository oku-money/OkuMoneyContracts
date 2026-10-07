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
 * @dev `okuMMultiplier()` is COMPUTED from a rate schedule via {MathLib.computeMultiplier},
 *      not stored; see README § Streaming Accrual. `setOkuMMultiplier` is a discrete
 *      emergency override only. Also implements ERC-8056 over the same multiplier (see
 *      {IScaledUIAmount} for deviations). Minter allowances follow Circle's FiatToken.
 *      See Constants.sol for the terminology legend; storage is ERC-7201 namespaced.
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
        // Streaming schedule (written by OKUM_REBASER), packed into 2 slots; the multiplier
        // is computed from it, never stored. Widths: MAX_MULTIPLIER (1e24) fits uint96,
        // MAX_RATE (~1e18) fits uint64, timestamps fit uint48. Runtime values are downcast
        // with SafeCast; the remaining raw casts write compile-time constants.
        //
        // Slot 1: base | rate | pendingRate (96 + 64 + 64 = 224 bits)
        uint96 okuMBaseMultiplier; // snapshot at `okuMLastAccrualTime`; starts 1e18 = $1.00
        uint64 okuMRatePerSecond; // active per-second rate; PRECISION = no yield
        uint64 okuMPendingRatePerSecond; // successor rate, active after `okuMRateEnd`
        // Slot 2: lastAccrualTime | rateEnd | pendingRateEnd (48 + 48 + 48 = 144 bits)
        uint48 okuMLastAccrualTime; // timestamp `okuMBaseMultiplier` was snapshotted at
        // Active rate expiry. 0 only when `okuMRatePerSecond == PRECISION` (halted sentinel).
        uint48 okuMRateEnd;
        // Successor expiry; bounds unattended compounding past `okuMRateEnd`. 0 = none armed.
        uint48 okuMPendingRateEnd;
        mapping(address => uint256) minterAllowance; // Circle FiatToken pattern
        uint256 maxSupply; // supply cap in raw token units
        mapping(address => bool) isBlacklisted;
        // Block of the last discrete override (read via OverrideBlockGuard). Streaming
        // accrual never stamps it.
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

    // ZeroAddress and MultiplierCannotDecrease live in lib/Errors.sol.
    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @dev Above `Constants.MAX_MULTIPLIER` ($1,000,000); keeps downstream math overflow-safe.
    error MultiplierTooHigh();
    /// @dev Below `PRECISION` would shrink the multiplier; `PRECISION` itself means no yield.
    error InvalidRate();
    /// @dev Above `Constants.MAX_RATE` (~2242% APY), the rpow input bound.
    error RateTooHigh();
    /// @dev Halting (`newRate == PRECISION`) requires `endTimestamp == 0`.
    error EndTimestampNotAllowed();
    /// @dev A yielding rate's `endTimestamp` must be strictly in the future.
    error EndTimestampInPast();
    /// @dev A rate window may not exceed `Constants.MAX_RATE_WINDOW`.
    error RateWindowTooLong();
    /// @dev `pendingEndTimestamp` must be strictly after the active `okuMRateEnd`.
    error PendingEndNotAfterRateEnd();
    /// @dev Staging a successor requires a bounded active window.
    error NoRateEndSet();
    /// @dev A successor staged after expiry would snapshot unearned yield; use {setOkuMYieldRate}.
    error RateAlreadyExpired();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name_ ERC-20 name
    /// @param symbol_ ERC-20 symbol (canonical ticker is `OkuM`)
    /// @param _admin Receives every role; operators redistribute post-deploy (roles are per-contract).
    /// @param initialMaxSupply Initial supply cap
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
        _haltSchedule($, Constants.PRECISION);
        $.maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKUM_UPGRADER, _admin);
        _grantRole(Roles.OKUM_PAUSER, _admin);
        _grantRole(Roles.OKUM_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_MINTER, _admin);
        _grantRole(Roles.OKUM_BURNER, _admin);
        _grantRole(Roles.OKUM_REBASER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKUM_CAP_MANAGER, _admin);
        _grantRole(Roles.OKUM_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC-20 Metadata ============

    /// @notice Fixed at {Constants.OKU_M_DECIMALS} (18), the scale PSM conversion and PRECISION share.
    function decimals() public pure override returns (uint8) {
        return Constants.OKU_M_DECIMALS;
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

    /// @notice Block of the last discrete override (0 if none); read by OverrideBlockGuard.
    function lastYieldDistributionBlock() external view returns (uint256) {
        return _getOkuMoneyStorage().lastYieldDistributionBlock;
    }

    // ============ Multiplier Logic (Continuous Streaming Accrual) ============

    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev COMPUTED, not stored, so there is no discrete step to arbitrage. No supply term:
    ///      identical schedule state gives every chain the identical value at a given timestamp.
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
    /// @dev Raw storage, not rolled forward: after `okuMRateEnd` it can lag the live rate.
    ///      Use {okuMEffectiveRatePerSecond} for the rate accruing now.
    function okuMRatePerSecond() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRatePerSecond;
    }

    /// @notice The per-second rate actually accruing right now.
    /// @dev The pending rate once `okuMRateEnd` has elapsed with a successor armed;
    ///      `PRECISION` once `okuMPendingRateEnd` has also elapsed; else the stored rate.
    ///      Basis for the rate setters' pause gate.
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
    /// @param newRate Per-second rate in [PRECISION, MAX_RATE]; PRECISION halts accrual.
    /// @param endTimestamp Expiry. Must be 0 when halting; otherwise strictly future and
    ///        within {Constants.MAX_RATE_WINDOW} (README § Streaming Accrual).
    /// @dev Snapshots the current multiplier as the new base, so the curve is continuous
    ///      across the write (no `lastYieldDistributionBlock` stamp). Clears any armed
    ///      successor. Prefer {setOkuMYieldRateWithSuccessor} to two separate transactions.
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
        _requireRateInRange(newRate);
        if (newRate == Constants.PRECISION) {
            if (endTimestamp != 0) revert EndTimestampNotAllowed();
        } else {
            if (endTimestamp <= block.timestamp) revert EndTimestampInPast();
            if (endTimestamp - block.timestamp > Constants.MAX_RATE_WINDOW) {
                revert RateWindowTooLong();
            }
        }

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldRate = $.okuMRatePerSecond;
        _requireNoIncreaseWhilePaused(newRate);
        uint256 snapshot = okuMMultiplier();

        _emitPendingRateCancelledIfArmed($);

        $.okuMBaseMultiplier = SafeCast.toUint96(snapshot);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMRateEnd = SafeCast.toUint48(endTimestamp);
        $.okuMPendingRatePerSecond = uint64(Constants.PRECISION);
        $.okuMPendingRateEnd = 0;

        emit OkuMYieldRateUpdated(oldRate, newRate, endTimestamp, snapshot);
        // ERC-8056: old == new on purpose; the value is continuous at the write, only the
        // rate going forward changed.
        emit UIMultiplierUpdated(snapshot, snapshot, block.timestamp);
    }

    function _requireRateInRange(uint256 newRate) private pure {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();
    }

    /// @dev While paused only decreases (vs the EFFECTIVE rate) are allowed: incident
    ///      response must be able to zero accrual, and an increase would hand the inflated
    ///      multiplier to whoever redeems first after unpause.
    function _requireNoIncreaseWhilePaused(uint256 newRate) private view {
        if (newRate > okuMEffectiveRatePerSecond() && paused()) {
            revert PausableUpgradeable.EnforcedPause();
        }
    }

    /// @dev A successor is staged and the active window has not yet closed. After
    ///      `okuMRateEnd` the successor is already live ({MathLib.computeMultiplier}
    ///      branch 2), so re-anchoring is not a cancellation.
    function _successorArmed(OkuMoneyStorage storage $) private view returns (bool) {
        uint256 rateEnd = $.okuMRateEnd;
        return rateEnd != 0 && block.timestamp < rateEnd
            && $.okuMPendingRatePerSecond > Constants.PRECISION;
    }

    /// @dev Multiplier projected at `okuMRateEnd`, including the armed successor.
    function _projectedAtRateEnd(OkuMoneyStorage storage $) private view returns (uint256) {
        uint256 rateEnd = $.okuMRateEnd;
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

    /// @dev Emits {IScaledUIAmount-UIMultiplierUpdateCancelled} for a staged, not yet active
    ///      successor. Call BEFORE the caller mutates the schedule.
    function _emitPendingRateCancelledIfArmed(OkuMoneyStorage storage $) private {
        if (!_successorArmed($)) return;
        emit UIMultiplierUpdateCancelled(_projectedAtRateEnd($), $.okuMRateEnd);
    }

    /// @notice Pre-stage the successor rate that activates after {okuMRateEnd}.
    /// @param newRate Per-second rate in [PRECISION, MAX_RATE].
    /// @param pendingEndTimestamp Successor expiry; strictly after `okuMRateEnd`, bounding
    ///        how long it compounds unattended before accrual halts.
    /// @dev Activation keys off the absolute `okuMRateEnd` inside {okuMMultiplier} with no
    ///      transaction at the boundary, so staging on different chains days apart still
    ///      activates simultaneously. Requires a bounded, unexpired active window.
    ///      Pause-gated for increases like {setOkuMYieldRate}.
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
        _requireRateInRange(newRate);

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd == 0) revert NoRateEndSet();
        if (block.timestamp >= rateEnd) revert RateAlreadyExpired();
        if (pendingEndTimestamp <= rateEnd) revert PendingEndNotAfterRateEnd();
        // The successor's own window feeds one `rpow`, so it is bounded independently.
        if (pendingEndTimestamp - rateEnd > Constants.MAX_RATE_WINDOW) {
            revert RateWindowTooLong();
        }
        _requireNoIncreaseWhilePaused(newRate);

        _emitPendingRateCancelledIfArmed($);

        $.okuMPendingRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMPendingRateEnd = SafeCast.toUint48(pendingEndTimestamp);

        emit NextOkuMYieldRateSet(newRate, rateEnd, pendingEndTimestamp);
    }

    /// @notice Atomically re-anchor the active rate AND stage its successor.
    /// @dev Parameters as in {setOkuMYieldRate} (`newRate`, `endTimestamp`) and
    ///      {setNextOkuMYieldRate} (`nextRate`, `nextEndTimestamp`). As two transactions,
    ///      a failure after the first leaves no successor (it clears any pending rate) and
    ///      accrual silently halts at `endTimestamp`; here both land or neither does.
    ///      Pure composition of the shared bodies: every check, event and gate applies in order.
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

    /// @notice Emergency discrete override: re-anchors the base and halts the schedule.
    /// @param newMultiplier Must exceed the current multiplier and be <= MAX_MULTIPLIER.
    /// @dev ESCAPE HATCH ONLY; normal yield flows through {setOkuMYieldRate}, which must be
    ///      called afterward to resume accrual. This creates a discontinuity, so it stamps
    ///      `lastYieldDistributionBlock` and `whenNoOverrideThisBlock` paths revert for the
    ///      rest of the block. Rejects `newMultiplier <= current` so a no-op cannot burn that
    ///      stamp. Pause-gated: a discrete value move freezes alongside transfers.
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
        _haltSchedule($, newMultiplier);

        emit OkuMMultiplierUpdated(currentMultiplier, newMultiplier, totalSupply(), block.number);
        emit UIMultiplierUpdated(currentMultiplier, newMultiplier, block.timestamp);
    }

    /// @dev Collapse to a flat, halted schedule anchored at `base` and now.
    function _haltSchedule(OkuMoneyStorage storage $, uint256 base) private {
        $.okuMBaseMultiplier = SafeCast.toUint96(base);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMRatePerSecond = uint64(Constants.PRECISION);
        $.okuMRateEnd = 0;
        $.okuMPendingRatePerSecond = uint64(Constants.PRECISION);
        $.okuMPendingRateEnd = 0;
    }

    // ============ ERC-8056: Scaled UI Amount ============
    // The OkuM multiplier doubles as the ERC-8056 UI multiplier; see IScaledUIAmount.

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() external view returns (uint256) {
        return okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Schedules a pending *rate*, not a *value*: returns the multiplier projected at
    ///      {effectiveAt}, or the current one when no successor is armed.
    function newUIMultiplier() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        return _successorArmed($) ? _projectedAtRateEnd($) : okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev 0 unless a successor is armed and not yet active; same condition as {newUIMultiplier}.
    function effectiveAt() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        return _successorArmed($) ? $.okuMRateEnd : 0;
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

    /// @dev Blocks blacklisted owners/spenders. Not pause-gated: approvals work while paused.
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

    /// @dev Blocks a blacklisted owner or spender from creating allowances (as Circle
    ///      FiatToken). Existing allowances are not revoked; {transferFrom} stops a
    ///      blacklisted spender from using them.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[_msgSender()]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        return super.approve(spender, value);
    }

    /// @notice Spend an allowance to move tokens from `from` to `to`.
    /// @dev Also checks the spender, which `_update` cannot see (as Circle FiatToken).
    ///      LitePSM is a spender here, so blacklisting it would halt redemptions; same
    ///      accepted self-brick as {mint}.
    function transferFrom(
        address from,
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        if (_getOkuMoneyStorage().isBlacklisted[_msgSender()]) revert SenderBlacklisted();
        return super.transferFrom(from, to, value);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /// @dev Pause blocks peer-to-peer transfers only (mint has its own gate; burn proceeds).
    ///      Blacklist applies to the non-zero side(s).
    function _update(address from, address to, uint256 amount) internal override {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);
        // No TransferValue event: the dollar value would cost an rpow per transfer;
        // indexers derive it from the rate schedule.
    }

    // ============ Minting & Burning ============

    /// @notice Mint raw tokens to an address.
    /// @param to Recipient of the minted tokens.
    /// @param amount Number of raw tokens to mint.
    /// @dev Also checks the minter's blacklist status (as Circle FiatToken). OKUM_MINTER is
    ///      held by LitePSM, so blacklisting it would halt minting; accepted.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        $.minterAllowance[msg.sender] -= amount;

        _mint(to, amount);
    }

    /// @notice Burn raw tokens from the caller's balance. Allowed while paused.
    /// @param amount Number of raw tokens to burn.
    /// @dev `OKUM_BURNER` is separate from `OKUM_MINTER` so burn can be revoked independently.
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

    /// @notice Add `account` to the blacklist.
    /// @param account Address to blacklist.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist.
    /// @param account Address to unblacklist.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause minting and peer-to-peer transfers. Burns, approvals, blacklist changes
    ///         and rate decreases still work.
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
