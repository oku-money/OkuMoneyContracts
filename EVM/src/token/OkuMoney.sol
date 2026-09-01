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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OkuMoneyEvents} from "../lib/events/OkuMoneyEvents.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IScaledUIAmount} from "../interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token (ticker `OkuM`) backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). Yield is expressed through appreciation of
 *      `okuMMultiplier()` — the dollar value of one OkuM — which is the pricing input
 *      for the PSM, the OkuDollar vault, and the fiat off-ramp.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMMultiplier() is a separate view function for pricing.
 *
 *      ## Why yield streams instead of stepping
 *
 *      Yield is discovered off-chain in chunks (T-Bills settle periodically), but it is
 *      DELIVERED on-chain continuously, over an operator-defined epoch. Those two things
 *      are independent, and conflating them is a vulnerability:
 *
 *      `okuMMultiplier` is the settlement price for instant, two-way convertibility at
 *      the PSM. A discrete jump in a settlement price is riskless arbitrage — mint
 *      immediately before the jump, redeem immediately after, and capture the entire
 *      increment with no price risk and no holding period, funded out of the PSM buffer
 *      and diluting every honest holder. Yield is compensation for holding across TIME;
 *      a step converts it into compensation for holding across an INSTANT.
 *
 *      A same-block fence cannot fix this. The profitable round-trip spans two blocks
 *      (mint in N, step in N, redeem in N+1), and only requires seeing the update
 *      transaction in the mempool. Streaming removes the instant entirely: there is no
 *      discontinuity to straddle, so a holder earns strictly in proportion to time held.
 *
 *      This mirrors the continuous accrual OkuDollar already uses for `usdMultiplier`,
 *      and follows the same realized-lump-streamed-forward pattern as Synthetix
 *      `StakingRewards.notifyRewardAmount` and Yearn v2's `lockedProfitDegradation`.
 *
 *      ## The epoch model
 *
 *      One epoch fully describes the multiplier for all time within it:
 *
 *          M(t) = baseMultiplier + ratePerSecond * (min(t, endTime) - startTime)
 *
 *      Accrual is LINEAR, not exponential. The operator supplies a realized dollar
 *      amount and a duration; the contract derives the per-second increment. Linear
 *      delivery of a known lump is both the honest shape for "distribute exactly this
 *      much over exactly this long" and avoids the D-th root that deriving an
 *      exponential rate from a target amount would require. Over epoch lengths in the
 *      day-to-month range the curvature difference is negligible.
 *
 *      The multiplier is a pure function of time — no keeper, no per-block writes.
 *      It FLATLINES past `endTime`: a missed renewal freezes yield rather than
 *      extrapolating unearned accrual. That is the safe default, but it is silent,
 *      so operators must monitor {yieldEpochEndsAt}.
 *
 *      Rear-facing discipline is preserved: an epoch only ever distributes yield that
 *      has already been realized off-chain. Monotonicity means a negative period
 *      cannot be passed through — the operator distributes nothing instead.
 *
 *      The minter-allowance design (per-minter cap in `minterAllowance`, decremented on
 *      `mint`) is modeled on Circle's FiatToken minter-controller pattern.
 *      Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 *      Implements ERC-8056 (Scaled UI Amount) so wallets can render dollar values
 *      natively. Note the standard was designed for value-neutral stock splits, whereas
 *      `okuMMultiplier` is a value-additive settlement price; only the interface is
 *      borrowed. See `EVM/README.md § ERC-8056 on OkuMoney`.
 *
 *      See Constants.sol for terminology legend.
 *
 *      Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 *      See https://eips.ethereum.org/EIPS/eip-7201
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

    /// @notice A linear yield-accrual epoch. Fully describes the multiplier within it.
    /// @dev Packs into three slots: two `uint256` + (`uint64`, `uint64`).
    struct YieldEpoch {
        /// @dev Multiplier value at exactly `startTime`.
        uint256 baseMultiplier;
        /// @dev Per-second multiplier increment. Zero means flat (no accrual).
        uint256 ratePerSecond;
        /// @dev Accrual start. Set from `block.timestamp` at write time, never backdated.
        uint64 startTime;
        /// @dev Accrual end. The multiplier FLATLINES past this rather than
        ///      extrapolating — a missed renewal freezes yield, which is the safe
        ///      default. `startTime == endTime` is a valid flat epoch.
        uint64 endTime;
    }

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        // Minter allowance system (Circle FiatToken pattern; see contract NatSpec for source)
        mapping(address => uint256) minterAllowance;
        // Supply cap in token units
        uint256 maxSupply;
        // Blacklist
        mapping(address => bool) isBlacklisted;
        // Active accrual epoch. `okuMMultiplier()` is derived from this, not stored.
        YieldEpoch currentEpoch;
        // Scheduled successor, activating at `currentEpoch.endTime`. A zero `endTime`
        // means none is scheduled.
        YieldEpoch pendingEpoch;
        // Guardian latch. Blocks new epochs and freezes the multiplier at its
        // value when the halt landed. Independent of `Pausable` — see {haltAccrual}.
        bool accrualHalted;
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
    error ZeroSupply();
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
    /// @dev Mirrors SVM `LitePsmError::YieldTooSmall`. The yield amount is too small
    ///      to produce a non-zero per-second increment at the current supply and
    ///      duration, so the epoch would be indistinguishable from a flat one.
    ///      Reverting keeps a no-op call from silently replacing a live epoch.
    error YieldTooSmall();
    /// @dev Epoch duration outside [MIN_EPOCH_DURATION, MAX_EPOCH_DURATION].
    error InvalidEpochDuration();
    /// @dev The epoch's annualized implied rate exceeds `MAX_IMPLIED_APR_BPS`.
    ///      Guards against a mispriced or malicious distribution, and rejects
    ///      durations so short the epoch is effectively a discrete step.
    error ImpliedAprTooHigh(uint256 impliedAprBps, uint256 maxAprBps);
    /// @dev Accrual is latched off; new epochs are rejected until {resumeAccrual}.
    error AccrualIsHalted();
    /// @dev {resumeAccrual} called when accrual was not halted.
    error AccrualNotHalted();
    /// @dev {haltAccrual} called when accrual was already halted.
    error AccrualAlreadyHalted();
    /// @dev {scheduleYieldEpoch} requires a live (non-flatlined) current epoch to
    ///      chain onto. Without one the successor's start time would be in the past.
    error NoActiveEpoch();
    /// @dev {cancelPendingYieldEpoch} called with nothing scheduled.
    error NoPendingEpoch();
    /// @dev A successor is already scheduled. Cancel it before scheduling another.
    error PendingEpochExists();

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
        $.maxSupply = initialMaxSupply;

        // Seed a flat epoch at PRECISION starting now. `ratePerSecond` is zero and
        // `startTime == endTime`, so `okuMMultiplier()` returns exactly $1.00 until
        // the first epoch is started. Seeding matters: an unseeded epoch would leave
        // `baseMultiplier` at zero and every conversion would divide by zero.
        $.currentEpoch = YieldEpoch({
            baseMultiplier: Constants.PRECISION,
            ratePerSecond: 0,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp)
        });

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

    /// @notice Whether accrual is latched off.
    function accrualHalted() external view returns (bool) {
        return _getOkuMoneyStorage().accrualHalted;
    }

    /// @notice The epoch currently governing accrual.
    function currentYieldEpoch() external view returns (YieldEpoch memory) {
        return _resolveEpoch(_getOkuMoneyStorage(), block.timestamp);
    }

    /// @notice The scheduled successor epoch, if any. All-zero when none is scheduled.
    function pendingYieldEpoch() external view returns (YieldEpoch memory) {
        return _getOkuMoneyStorage().pendingEpoch;
    }

    /// @notice Timestamp at which accrual stops absent a new epoch.
    /// @dev Operators MUST monitor this. Past it the multiplier silently flatlines —
    ///      safe (no unearned yield) but invisible without an alert.
    function yieldEpochEndsAt() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        YieldEpoch storage pending = $.pendingEpoch;
        if (pending.endTime != 0) return pending.endTime;
        return $.currentEpoch.endTime;
    }

    // ============ Multiplier Logic (Continuous Linear Accrual) ============

    /// @dev Selects the epoch governing time `t`, crystallising the pending epoch
    ///      when `t` has reached its start. Single source of truth for epoch
    ///      selection — every read path routes through here so the view and the
    ///      mutators can never disagree about which epoch is active.
    function _resolveEpoch(
        OkuMoneyStorage storage $,
        uint256 t
    )
        private
        view
        returns (YieldEpoch memory)
    {
        YieldEpoch memory pending = $.pendingEpoch;
        if (pending.endTime != 0 && t >= pending.startTime) return pending;
        return $.currentEpoch;
    }

    /// @dev Evaluates an epoch at time `t`, flatlining past `endTime`.
    ///      Linear: `base + rate * elapsed`. Capped at `MAX_MULTIPLIER`.
    function _multiplierAt(YieldEpoch memory e, uint256 t) private pure returns (uint256) {
        if (t <= e.startTime) return e.baseMultiplier;
        uint256 until = t < e.endTime ? t : e.endTime;
        uint256 grown = e.baseMultiplier + e.ratePerSecond * (until - e.startTime);
        return grown > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : grown;
    }

    /// @notice OkuM multiplier at an arbitrary timestamp (dollar value per token).
    /// @param t Unix timestamp to evaluate at.
    /// @dev Public because the vault's solvency projection and operator tooling need
    ///      to evaluate the multiplier at a time other than now. Determinism here is
    ///      the point: the multiplier is a pure function of time, so anyone can
    ///      independently verify past and future values without trusting an indexer.
    function okuMMultiplierAt(uint256 t) public view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        return _multiplierAt(_resolveEpoch($, t), t);
    }

    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev Derived from the active epoch, not stored — it advances every second
    ///      while an epoch is live and is flat outside one. Monotonically
    ///      non-decreasing. `balanceOf()` is unaffected; this is consumed by the
    ///      PSM and vault for pricing.
    function okuMMultiplier() public view returns (uint256) {
        return okuMMultiplierAt(block.timestamp);
    }

    /// @dev Shared validation + rate derivation for both epoch mutators.
    ///      Converts a realized dollar amount into a per-second multiplier increment
    ///      and enforces every bound. Reverts rather than clamping so a mispriced
    ///      distribution is never silently accepted at a different value.
    /// @param startMultiplier Multiplier the epoch starts from (for the APR check).
    /// @param yieldAmount     Realized dollar yield (18 decimals).
    /// @param duration        Epoch length in seconds.
    /// @return ratePerSecond  Per-second multiplier increment.
    /// @return supply         Supply snapshot used to derive the increment.
    function _deriveEpochRate(
        uint256 startMultiplier,
        uint256 yieldAmount,
        uint256 duration
    )
        private
        view
        returns (uint256 ratePerSecond, uint256 supply)
    {
        if (yieldAmount == 0) revert Errors.ZeroAmount();
        if (duration < Constants.MIN_EPOCH_DURATION || duration > Constants.MAX_EPOCH_DURATION) {
            revert InvalidEpochDuration();
        }

        supply = totalSupply();
        if (supply == 0) revert ZeroSupply();

        // Per-token dollar increment across the whole epoch, then per second.
        // Both floor, so the delivered total is <= `yieldAmount` — truncation
        // favours the protocol, never the holder.
        uint256 yieldPerToken =
            Math.mulDiv(yieldAmount, Constants.PRECISION, supply, Math.Rounding.Floor);
        ratePerSecond = yieldPerToken / duration;
        // A zero rate is a flat epoch: it would replace a live epoch with nothing
        // while appearing to succeed. Reject instead.
        if (ratePerSecond == 0) revert YieldTooSmall();

        // Recompute the delta from the (truncated) rate so the APR check measures
        // what will ACTUALLY be delivered, not the requested amount.
        uint256 actualDelta = ratePerSecond * duration;

        // impliedApr = (delta / start) * (year / duration), in bps.
        uint256 impliedAprBps = Math.mulDiv(
            actualDelta * Constants.BASIS_POINTS,
            Constants.SECONDS_PER_YEAR,
            startMultiplier * duration,
            Math.Rounding.Floor
        );
        if (impliedAprBps > Constants.MAX_IMPLIED_APR_BPS) {
            revert ImpliedAprTooHigh(impliedAprBps, Constants.MAX_IMPLIED_APR_BPS);
        }

        if (startMultiplier + actualDelta > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();
    }

    /// @notice Begin streaming realized yield over `duration`, starting now.
    /// @param yieldAmount Realized dollar yield to distribute (18 decimals).
    /// @param duration    Seconds over which to stream it.
    /// @dev The epoch starts at the CURRENT multiplier, so there is never a
    ///      discontinuity — this is the property that makes the multiplier
    ///      unsandwichable. Calling mid-epoch replaces the active epoch, rebasing
    ///      from `okuMMultiplier()` at that instant; yield already accrued is kept
    ///      and undelivered yield from the replaced epoch is forgone.
    ///
    ///      Any scheduled successor is discarded: it was chained onto the epoch
    ///      being replaced, so its start time is no longer meaningful. Schedule a
    ///      new one afterwards.
    ///
    ///      `startTime` is always `block.timestamp` — never operator-supplied.
    ///      Backdating would resolve accrual against elapsed time and land a jump,
    ///      reintroducing exactly the discontinuity this design removes.
    ///
    ///      Pause-gated: yield is a state-effect and freezes with user-facing
    ///      transfers during an incident. To stop accrual WITHOUT pausing transfers
    ///      (or vice versa) use {haltAccrual} — the two levers are independent.
    function startYieldEpoch(
        uint256 yieldAmount,
        uint256 duration
    )
        external
        onlyRole(Roles.OKUM_REBASER)
        whenNotPaused
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.accrualHalted) revert AccrualIsHalted();

        uint256 startMultiplier = okuMMultiplier();
        (uint256 ratePerSecond, uint256 supply) =
            _deriveEpochRate(startMultiplier, yieldAmount, duration);

        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = uint64(block.timestamp + duration);

        $.currentEpoch = YieldEpoch({
            baseMultiplier: startMultiplier,
            ratePerSecond: ratePerSecond,
            startTime: startTime,
            endTime: endTime
        });
        delete $.pendingEpoch;

        uint256 endMultiplier = startMultiplier + ratePerSecond * duration;
        emit YieldEpochStarted(
            yieldAmount, startMultiplier, endMultiplier, ratePerSecond, supply, startTime, endTime
        );
        // ERC-8056: the multiplier's trajectory changed as of now.
        emit UIMultiplierUpdated(startMultiplier, endMultiplier, startTime);
    }

    /// @notice Schedule a successor epoch beginning when the current one ends.
    /// @param yieldAmount Realized dollar yield the successor distributes (18 decimals).
    /// @param duration    Successor length in seconds.
    /// @dev Lets operators queue the next period ahead of time so accrual is
    ///      continuous across the boundary with no flat gap. The successor starts at
    ///      the multiplier the current epoch terminates at, so the handover is
    ///      seamless.
    ///
    ///      Requires a live current epoch — chaining onto one that has already
    ///      flatlined would put the successor's start in the past, and it would
    ///      immediately jump to catch up. Restart with {startYieldEpoch} instead.
    ///
    ///      Revocable via {cancelPendingYieldEpoch} at any point before it activates.
    ///      This is the ONLY fully-clean rollback in the design: once yield has
    ///      accrued, monotonicity makes it permanent.
    function scheduleYieldEpoch(
        uint256 yieldAmount,
        uint256 duration
    )
        external
        onlyRole(Roles.OKUM_REBASER)
        whenNotPaused
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.accrualHalted) revert AccrualIsHalted();
        if ($.pendingEpoch.endTime != 0) revert PendingEpochExists();

        YieldEpoch memory active = $.currentEpoch;
        // Must be strictly in the future: `>=` would allow scheduling against an
        // epoch ending this very second, which is the flatlined case.
        if (active.endTime <= block.timestamp) revert NoActiveEpoch();

        // The successor begins where the current epoch terminates.
        uint256 startMultiplier = _multiplierAt(active, active.endTime);
        (uint256 ratePerSecond, uint256 supply) =
            _deriveEpochRate(startMultiplier, yieldAmount, duration);

        uint64 startTime = active.endTime;
        uint64 endTime = uint64(uint256(active.endTime) + duration);

        $.pendingEpoch = YieldEpoch({
            baseMultiplier: startMultiplier,
            ratePerSecond: ratePerSecond,
            startTime: startTime,
            endTime: endTime
        });

        emit YieldEpochScheduled(yieldAmount, ratePerSecond, supply, startTime, endTime);
        emit UIMultiplierUpdated(
            startMultiplier, startMultiplier + ratePerSecond * duration, startTime
        );
    }

    /// @notice Revoke a scheduled successor epoch before it takes effect.
    /// @dev Clean rollback with zero economic impact — the successor never accrued.
    ///      Reverts once it has activated; use {haltAccrual} to stop a live epoch.
    ///      Deliberately NOT pause-gated: revoking a bad scheduled rate must remain
    ///      possible during an incident, and it can only ever reduce future yield.
    function cancelPendingYieldEpoch() external onlyRole(Roles.OKUM_REBASER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        YieldEpoch memory pending = $.pendingEpoch;
        if (pending.endTime == 0) revert NoPendingEpoch();
        // Once active it is no longer "pending" — cancelling would retroactively
        // remove yield that holders have already accrued.
        if (block.timestamp >= pending.startTime) revert NoPendingEpoch();

        delete $.pendingEpoch;
        emit YieldEpochCancelled(pending.startTime, pending.endTime);
    }

    /// @notice Freeze the multiplier and block new epochs.
    /// @dev Crystallises `okuMMultiplier()` into a flat epoch at its current value,
    ///      discards any scheduled successor, and latches until {resumeAccrual}.
    ///
    ///      Independent of {pause} by design. The two address different incidents:
    ///        - Bug found, backing intact -> `pause()` only. Holders keep earning
    ///          yield the protocol genuinely owes them.
    ///        - Backing impaired -> `haltAccrual()`. Stop growing obligations while
    ///          transfers continue normally.
    ///        - Both -> call both.
    ///      Coupling them would force one response onto both situations.
    ///
    ///      Not pause-gated: halting accrual must work during an incident, and it
    ///      can only ever reduce yield.
    function haltAccrual() external onlyRole(Roles.OKUM_REBASER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.accrualHalted) revert AccrualAlreadyHalted();

        uint256 frozen = okuMMultiplier();
        bool hadPending = $.pendingEpoch.endTime != 0;

        $.currentEpoch = YieldEpoch({
            baseMultiplier: frozen,
            ratePerSecond: 0,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp)
        });
        delete $.pendingEpoch;
        $.accrualHalted = true;

        emit AccrualHalted(frozen, hadPending);
        emit UIMultiplierUpdated(frozen, frozen, block.timestamp);
    }

    /// @notice Lift the accrual halt, permitting new epochs.
    /// @dev Does NOT resume accrual on its own — the multiplier stays flat until
    ///      {startYieldEpoch} is called. Yield for the halted interval cannot be
    ///      backdated; if the operator chooses to make it up, that is a fresh
    ///      forward-looking epoch subject to the same APR cap.
    function resumeAccrual() external onlyRole(Roles.OKUM_REBASER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.accrualHalted) revert AccrualNotHalted();
        $.accrualHalted = false;
        emit AccrualResumed(okuMMultiplier());
    }

    // ============ ERC-8056 (Scaled UI Amount) ============
    // The standard was written for value-neutral stock splits, where the multiplier
    // is cosmetic. Here it is the settlement price — value-additive — which is why
    // it must move continuously rather than in steps. Only the interface is borrowed;
    // see the contract NatSpec and `EVM/README.md § ERC-8056 on OkuMoney`.
    //
    // Conformance note: `UIMultiplierUpdated` is emitted whenever the multiplier's
    // TRAJECTORY changes (epoch start/schedule/halt), not on every per-second
    // increment, which would be impossible. A consumer caching on the event alone
    // will under-report; because the multiplier is monotonically non-decreasing,
    // staleness always understates and never overstates. Read `uiMultiplier()` for
    // a live value.

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() external view returns (uint256) {
        return okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev The multiplier at which the scheduled successor begins. With no successor
    ///      scheduled this is the value the active epoch terminates at — i.e. the next
    ///      value the multiplier is committed to reach.
    function newUIMultiplier() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        YieldEpoch memory pending = $.pendingEpoch;
        if (pending.endTime != 0) return pending.baseMultiplier;
        YieldEpoch memory active = $.currentEpoch;
        return _multiplierAt(active, active.endTime);
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Start of the scheduled successor, or the active epoch's end when none is
    ///      scheduled. Always the timestamp at which {newUIMultiplier} is reached.
    function effectiveAt() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        YieldEpoch memory pending = $.pendingEpoch;
        if (pending.endTime != 0) return pending.startTime;
        return $.currentEpoch.endTime;
    }

    /// @inheritdoc IScaledUIAmountConversion
    function toUIAmount(uint256 rawAmount) public view returns (uint256) {
        return MathLib.okuMToDollars(rawAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountConversion
    function fromUIAmount(uint256 uiAmount) public view returns (uint256) {
        return MathLib.dollarsToOkuM(uiAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    function balanceOfUI(address account) external view returns (uint256) {
        return toUIAmount(balanceOf(account));
    }

    /// @inheritdoc IScaledUIAmountBalances
    function totalSupplyUI() external view returns (uint256) {
        return toUIAmount(totalSupply());
    }

    /// @notice ERC-165 interface detection.
    /// @dev Combines the four ERC-8056 IDs with `AccessControlUpgradeable`'s own
    ///      ERC-165 surface. IDs are pinned in `Constants` and asserted against
    ///      `type(I...).interfaceId` in the test suite.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return interfaceId == Constants.IID_SCALED_UI_AMOUNT
            || interfaceId == Constants.IID_SCALED_UI_NEW_MULTIPLIER
            || interfaceId == Constants.IID_SCALED_UI_CONVERSION
            || interfaceId == Constants.IID_SCALED_UI_BALANCES
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

        // `TransferValue` carries the same information as ERC-8056's OPTIONAL
        // `TransferWithUIAmount`; it predates the standard and is kept as the single
        // event so transfers do not pay for two identical logs. Conformance is
        // unaffected — that event is optional.
        uint256 dollarValue = MathLib.okuMToDollars(amount, okuMMultiplier());
        emit TransferValue(from, to, amount, dollarValue);
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
