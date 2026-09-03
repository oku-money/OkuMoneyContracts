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
 * @dev Standard ERC-20 balances (static). Yield is expressed through multiplier
 *      appreciation. The multiplier is NOT stored — it is COMPUTED continuously
 *      from a rate schedule via {MathLib.computeMultiplier}, streaming each
 *      rear-facing epoch's realized yield smoothly over the following window.
 *
 *      Why streaming rather than discrete ticks:
 *        1. NO MEV. A discrete jump lets an arbitrageur mint one block before the
 *           tick and redeem one block after, capturing a whole period's yield for
 *           ~12s of exposure. A continuous curve has no step to sandwich.
 *        2. CROSS-CHAIN AGREEMENT FOR FREE. `computeMultiplier` has no supply term
 *           and `block.timestamp` is wall-clock, so every chain holding the same
 *           schedule returns the same `uint256` at the same instant — no messaging,
 *           no light client, no state proof. Coordination drops from per-tick to
 *           per-epoch, and a missed transaction halts accrual (safe) rather than
 *           causing divergence (extractable).
 *
 *      {setOkuMMultiplier} survives as a discrete emergency override only; it is
 *      the sole reason `lastYieldDistributionBlock` and the `whenYieldNotDistributing`
 *      guard still exist.
 *
 *      Also implements ERC-8056 (Scaled UI Amount) over the same multiplier — see
 *      {IScaledUIAmount} for the deviations continuous accrual necessitates.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMMultiplier() is a separate view function for pricing — used by PSM and vault.
 *
 *      The minter-allowance design (per-minter cap in `minterAllowance`, decremented on
 *      `mint`) is modeled on Circle's FiatToken minter-controller pattern.
 *      Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
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

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        // ---- Streaming yield schedule (written by OKUM_REBASER) ----
        // The multiplier is COMPUTED from these five fields via
        // MathLib.computeMultiplier(), never stored directly. See okuMMultiplier().
        //
        // Snapshot multiplier taken at `okuMLastAccrualTime` (starts at 1e18 = $1.00).
        uint256 okuMBaseMultiplier;
        // Active per-second rate (PRECISION = no yield). Bounded by Constants.MAX_RATE.
        uint256 okuMRatePerSecond;
        // Timestamp `okuMBaseMultiplier` was snapshotted at.
        uint256 okuMLastAccrualTime;
        // Timestamp the active rate expires (0 = open-ended sentinel).
        uint256 okuMRateEnd;
        // Successor rate, activates after `okuMRateEnd` with no transaction at the
        // boundary. This is what keeps multi-chain epoch handovers simultaneous.
        uint256 okuMPendingRatePerSecond;
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
    /// @dev Rate below `Constants.PRECISION` would shrink the multiplier, violating
    ///      monotonicity. `PRECISION` exactly is the no-yield placeholder.
    error InvalidRate();
    /// @dev Rate above `Constants.MAX_RATE` (~3700% APY), the rpow input sanity bound.
    error RateTooHigh();
    /// @dev A non-zero `endTimestamp` must be strictly in the future.
    error EndTimestampInPast();
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
        // Streaming schedule starts flat: base $1.00, no-yield rate, open-ended.
        $.okuMBaseMultiplier = Constants.PRECISION;
        $.okuMRatePerSecond = Constants.PRECISION;
        $.okuMLastAccrualTime = block.timestamp;
        $.okuMPendingRatePerSecond = Constants.PRECISION;
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
            block.timestamp
        );
    }

    /// @notice Active per-second accrual rate (1e18 = no yield).
    function okuMRatePerSecond() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRatePerSecond;
    }

    /// @notice Snapshot multiplier taken at {okuMLastAccrualTime}.
    function okuMBaseMultiplier() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMBaseMultiplier;
    }

    /// @notice Timestamp the base multiplier was snapshotted at.
    function okuMLastAccrualTime() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMLastAccrualTime;
    }

    /// @notice Timestamp the active rate expires (0 = open-ended).
    function okuMRateEnd() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRateEnd;
    }

    /// @notice Successor rate, active after {okuMRateEnd} (1e18 = none armed).
    function okuMPendingRatePerSecond() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMPendingRatePerSecond;
    }

    /// @notice Set the active yield rate, re-anchoring the accrual base.
    /// @param newRate Per-second rate, in [PRECISION, MAX_RATE]. PRECISION halts accrual.
    /// @param endTimestamp Unix timestamp the rate expires (0 = open-ended).
    /// @dev Snapshots the current multiplier into `okuMBaseMultiplier` and resets
    ///      `okuMLastAccrualTime` to now, so the curve is CONTINUOUS across the
    ///      write — there is no step, and nothing to sandwich. This is why the
    ///      function does not stamp `lastYieldDistributionBlock`.
    ///
    ///      Clears any armed pending rate: a fresh schedule supersedes it.
    ///
    ///      Intentionally NOT pause-gated. Operators may need to ZERO the rate
    ///      (pass `newRate = PRECISION`) during an incident response, and pausing
    ///      this would defeat that. The discrete {setOkuMMultiplier} override IS
    ///      pause-gated, because it is a state-effect rather than a config change.
    ///
    ///      OPERATIONAL NOTE: for rear-facing epochs, prefer {setNextOkuMYieldRate}
    ///      to pre-stage the successor. A pending rate activates off an absolute
    ///      timestamp with NO transaction at the boundary, which keeps epoch
    ///      handovers simultaneous across chains. Calling this function at a
    ///      boundary instead re-anchors at `block.timestamp`, reintroducing
    ///      per-tick cross-chain coordination.
    function setOkuMYieldRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKUM_REBASER)
    {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();
        if (endTimestamp != 0 && endTimestamp <= block.timestamp) revert EndTimestampInPast();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldRate = $.okuMRatePerSecond;
        uint256 snapshot = okuMMultiplier();

        $.okuMBaseMultiplier = snapshot;
        $.okuMLastAccrualTime = block.timestamp;
        $.okuMRatePerSecond = newRate;
        $.okuMRateEnd = endTimestamp;
        $.okuMPendingRatePerSecond = Constants.PRECISION;

        emit OkuMYieldRateUpdated(oldRate, newRate, endTimestamp, snapshot);
        // ERC-8056: the multiplier schedule changed. Under continuous accrual the
        // multiplier itself changes every second, so the EIP's "emit on every
        // change" is not satisfiable; rate changes are the discrete events.
        emit UIMultiplierUpdated(snapshot, snapshot, block.timestamp);
    }

    /// @notice Pre-stage the successor rate that activates after {okuMRateEnd}.
    /// @param newRate Per-second rate, in [PRECISION, MAX_RATE].
    /// @dev The handover fires off the absolute `okuMRateEnd` timestamp inside
    ///      {okuMMultiplier}, with NO transaction at the boundary. Staging
    ///      transactions may therefore land on different chains at different
    ///      times — even days apart — and the activation is still simultaneous
    ///      to the second. This is the primitive that makes the rear-facing
    ///      epoch pipeline cross-chain safe.
    ///
    ///      Requires a bounded active window (`okuMRateEnd != 0`) that has not
    ///      already elapsed.
    function setNextOkuMYieldRate(uint256 newRate) external onlyRole(Roles.OKUM_REBASER) {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd == 0) revert NoRateEndSet();
        if (block.timestamp >= rateEnd) revert RateAlreadyExpired();

        $.okuMPendingRatePerSecond = newRate;

        emit NextOkuMYieldRateSet(newRate, rateEnd);
    }

    /// @notice Emergency discrete override — re-anchors the accrual base.
    /// @param newMultiplier New base multiplier (must be > current, <= MAX_MULTIPLIER).
    /// @dev ESCAPE HATCH ONLY. Normal yield flows through {setOkuMYieldRate}.
    ///
    ///      Re-anchors rather than halting: writes `okuMBaseMultiplier = newMultiplier`
    ///      and resets `okuMLastAccrualTime` to now, leaving the active rate running
    ///      from the corrected base. The rate schedule itself is untouched.
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

        $.lastYieldDistributionBlock = block.number;
        $.okuMBaseMultiplier = newMultiplier;
        $.okuMLastAccrualTime = block.timestamp;

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
    ///      When no window or no pending rate is armed, returns the current
    ///      multiplier (nothing scheduled).
    function newUIMultiplier() external view returns (uint256) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd == 0 || block.timestamp >= rateEnd) return okuMMultiplier();
        return MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            rateEnd,
            $.okuMPendingRatePerSecond,
            rateEnd
        );
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    function effectiveAt() external view returns (uint256) {
        return _getOkuMoneyStorage().okuMRateEnd;
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
