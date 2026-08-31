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
import {ScaledUIAmountUpgradeable} from "../lib/ScaledUIAmountUpgradeable.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";

/**
 * @title OkuM
 * @notice Oku Money — non-rebasing share token backed by off-chain RWA, with a
 *         continuously-accruing ERC-8056 display multiplier.
 *
 * @dev ## One multiplier, three roles
 *
 *      `uiMultiplier()` is simultaneously the ERC-8056 display multiplier, the
 *      LitePSM mint/redeem price, and the OkuM <-> USDOku conversion price. There is
 *      no second price anywhere in the system. A display price that can drift from a
 *      settlement price is the single most likely source of a user-visible loss, so
 *      they are unified by construction rather than kept in sync by convention.
 *
 *      ## Rear-facing yield, smooth delivery
 *
 *      The rate for a segment is derived from yield the issuer has ALREADY banked,
 *      then delivered smoothly across the following window. Two consequences:
 *
 *        - OkuM never accrues against a forecast. At every instant, cumulative
 *          accrual since declaration is bounded by what was held at declaration.
 *        - The one-period lag leaves the system carrying roughly one period of
 *          surplus at all times — a structural cushion that absorbs an
 *          underperforming period with no intervention.
 *
 *      This CANNOT be proven on-chain: OkuM's backing is off-chain RWA and no
 *      contract can inspect it. The guarantee is procedural. What IS enforced is the
 *      blast radius if the procedure fails or the key is compromised:
 *      {Constants.MAX_IMPLIED_APR_BPS} bounds the rate,
 *      {Constants.MAX_RATE_DURATION} bounds the window,
 *      {Constants.MAX_REANCHOR_BPS} bounds any instantaneous jump, and accrual
 *      FLATLINES past `endTime` absent a fresh declaration. Bounded and self-healing.
 *      Strengthening this requires an independent attester — a custodian signature or
 *      a Proof-of-Reserve feed — which is tracked, not built.
 *
 *      ## Why continuous rather than stepped
 *
 *      See {ScaledUIAmountUpgradeable}. Briefly: a step is a free round-trip for
 *      anyone holding across it, and — decisively for a ten-chain deployment — a step
 *      cannot be synchronised across chains. A segment anchored to absolute
 *      wall-clock time is a pure function of `block.timestamp`, so identical
 *      parameters give an identical multiplier everywhere with no messaging.
 *
 *      The minter-allowance design (per-minter cap decremented on `mint`) follows
 *      Circle's FiatToken minter-controller pattern:
 *      https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 *      Storage uses ERC-7201 namespacing. See https://eips.ethereum.org/EIPS/eip-7201
 */
contract OkuM is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ScaledUIAmountUpgradeable,
    UUPSUpgradeable,
    IOkuM
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuM
    struct OkuMStorage {
        mapping(address => uint256) minterAllowance;
        uint256 maxSupply;
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuM")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUM_STORAGE_LOCATION =
        0xb452deea490617e43215efe5d1021937b5200d3dc5c52d3e2b801ca18fb58800;

    function _getOkuMStorage() private pure returns (OkuMStorage storage $) {
        assembly {
            $.slot := OKUM_STORAGE_LOCATION
        }
    }

    // ============ Events ============

    /// @notice A new accrual segment was declared.
    /// @param baseIndex Index value at `startTime`.
    /// @param ratePerSecond Per-second compounding rate.
    /// @param startTime Absolute wall-clock anchor.
    /// @param endTime Accrual flatlines past this.
    /// @param realizedYieldBacking Dollar amount of ALREADY-REALIZED yield the issuer
    ///        asserts backs this segment, 18dp. Recorded, never enforced — nothing
    ///        on-chain can verify off-chain RWA. It exists so the claim is immutable
    ///        and reconcilable against custodian statements during an audit, and so
    ///        an over-declaration is a specific logged assertion rather than an
    ///        unattributable number. A separate attester role was considered and
    ///        rejected as ceremony: it would compare one attested number against
    ///        another from the same trust domain. See TRACKER.md.
    event OkuMRateSet(
        uint256 baseIndex,
        uint256 ratePerSecond,
        uint64 startTime,
        uint64 endTime,
        uint256 realizedYieldBacking
    );

    event AccrualHalted(address indexed guardian);
    event AccrualResumed(address indexed resumer);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Errors ============

    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    error ExceedsMaxTotalSupply();
    error MultiplierTooHigh();
    error AccrualIsHalted();
    error AlreadyHalted();
    error NotHalted();
    /// @dev `ratePerSecond` outside `[PRECISION, MAX_RATE_PER_SECOND]`.
    error RateOutOfBounds();
    /// @dev `endTime < startTime`, or the span exceeds `MAX_RATE_DURATION`.
    error InvalidRateWindow();
    /// @dev `startTime` further ahead than `MAX_SCHEDULE_LEAD`.
    error ScheduledTooFarAhead();
    /// @dev `startTime` (after sentinel resolution) is in the past. Backdating is
    ///      never legal: it would let `indexAt(startTime)` resolve against stale
    ///      history and admit a jump far larger than `MAX_REANCHOR_BPS` in one call.
    error StartTimeInThePast();
    /// @dev The declared `baseIndex` would move the index DOWN at `startTime`.
    error MultiplierCannotDecrease();
    /// @dev The declared `baseIndex` would jump more than `MAX_REANCHOR_BPS` above
    ///      the value the live segment already reaches at `startTime`.
    error ReanchorTooLarge(uint256 declared, uint256 maxAllowed);
    /// @dev A re-anchor (`baseIndex > indexAt(startTime)`) was scheduled for the
    ///      future instead of taking effect immediately. Forward-scheduling a LEVEL
    ///      step would let it land unattended at `startTime`, exactly the window the
    ///      re-anchor bound exists to close. Catch-up must happen now — pass
    ///      `startTime == 0` to mean "now".
    error ReanchorMustBeImmediate();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name_ ERC-20 name — canonically "Oku Money".
    /// @param symbol_ ERC-20 symbol — canonically "OkuM".
    /// @param _admin Receives the full role set; operational roles are redistributed
    ///        to multisigs and the PSM proxy post-deploy.
    /// @param initialMaxSupply Initial raw supply cap.
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
        if (initialMaxSupply > Constants.MAX_TOTAL_SUPPLY) revert ExceedsMaxTotalSupply();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ScaledUIAmount_init();

        _getOkuMStorage().maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKUM_UPGRADER, _admin);
        _grantRole(Roles.OKUM_PAUSER, _admin);
        _grantRole(Roles.OKUM_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_MINTER, _admin);
        _grantRole(Roles.OKUM_BURNER, _admin);
        _grantRole(Roles.OKUM_RATE_SETTER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKUM_CAP_MANAGER, _admin);
        _grantRole(Roles.OKUM_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC20 / IERC20 disambiguation ============

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

    // ============ ScaledUIAmount hooks ============

    function _scaledUIRawBalanceOf(address account) internal view override returns (uint256) {
        return super.balanceOf(account);
    }

    function _scaledUIRawTotalSupply() internal view override returns (uint256) {
        return super.totalSupply();
    }

    // ============ Views ============

    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuMStorage().minterAllowance[minter_];
    }

    function maxSupply() external view returns (uint256) {
        return _getOkuMStorage().maxSupply;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuMStorage().isBlacklisted[account];
    }

    /// @notice Allowance in DOLLAR terms, saturating at `type(uint256).max`.
    /// @dev A bounded OkuM approval is denominated in RAW units, so its dollar value
    ///      GROWS as the multiplier rises — the opposite drift to a USDOku approval.
    ///      Saturates rather than reverting on the infinite-approval sentinel, which
    ///      would otherwise make every wallet's allowance screen revert.
    function allowanceUI(address owner, address spender) external view returns (uint256) {
        uint256 raw = allowance(owner, spender);
        if (raw == type(uint256).max) return type(uint256).max;
        return toUIAmount(raw);
    }

    // ============ Rate declaration ============

    /// @notice Declare an accrual segment.
    ///
    /// @dev THE load-bearing function. It sets the price every permissionless PSM
    ///      conversion executes at, on every chain.
    ///
    ///      `baseIndex` is supplied as an ABSOLUTE value rather than derived from
    ///      local history. That is deliberate and is what makes the multichain
    ///      property work: publish the same four parameters on every chain and every
    ///      chain reports an identical multiplier at every instant, regardless of
    ///      when each transaction landed. It also makes divergence self-healing — a
    ///      chain that missed a segment entirely is restored by the next one, whereas
    ///      deriving the base locally would make that divergence permanent.
    ///
    ///      ## Two disjoint shapes, not one tolerance band
    ///
    ///      This function used to accept ANY `baseIndex` within `MAX_REANCHOR_BPS` of
    ///      `indexAt(startTime)`, for any `startTime` (past or future). That is unsafe:
    ///      `startTime` had no lower bound, so a caller could pick an arbitrary point
    ///      in the past where `indexAt` resolves low, declare `baseIndex` EQUAL to it
    ///      (passing the "no re-anchor" path trivially), and let the resulting
    ///      `elapsed` at `block.timestamp` compound far past what the re-anchor bound
    ///      was meant to be the only way to exceed. Continuity at `startTime` said
    ///      nothing about the jump actually delivered at `block.timestamp`.
    ///
    ///      The fix separates two shapes that were incorrectly treated as one:
    ///
    ///      - ROUTINE (`baseIndex == indexAt(startTime)`, exactly): the curve is
    ///        seamless, so `startTime` MAY be scheduled in the future — this is what
    ///        makes multichain switchover work, and is the normal path.
    ///      - CATCH-UP (`baseIndex` up to `MAX_REANCHOR_BPS` ABOVE `indexAt(startTime)`):
    ///        a genuine level step, bounded at 0.1%. This may ONLY take effect
    ///        immediately (`startTime == block.timestamp`) — never scheduled ahead,
    ///        because a scheduled step would land unattended at `startTime`, which is
    ///        exactly the arbitrage window the bound exists to close. Pass
    ///        `startTime == 0` as a sentinel for "now": an operator cannot predict the
    ///        exact mined timestamp, so exact equality must be resolvable on-chain.
    ///
    ///      `startTime` in the past is rejected outright in both shapes — see
    ///      {StartTimeInThePast}.
    ///
    /// @param baseIndex Index value at `startTime`, 18dp. Absolute.
    /// @param ratePerSecond Per-second compounding rate; `PRECISION` means no accrual.
    /// @param startTime Absolute wall-clock anchor, or `0` to mean "now". Future is
    ///        allowed only for a routine (non-re-anchoring) declaration.
    /// @param endTime Accrual flatlines past this.
    /// @param realizedYieldBacking Already-realized yield backing this segment, 18dp.
    ///        Logged for audit reconciliation; see {OkuMRateSet}.
    function setOkuMRate(
        uint256 baseIndex,
        uint256 ratePerSecond,
        uint64 startTime,
        uint64 endTime,
        uint256 realizedYieldBacking
    )
        external
        onlyRole(Roles.OKUM_RATE_SETTER)
    {
        if (accrualHalted()) revert AccrualIsHalted();

        // Sentinel resolved FIRST: every downstream check, the stored segment, and
        // the emitted event must all see the real timestamp. Resolving later would
        // let endTime - 0 pass the duration check trivially.
        if (startTime == 0) startTime = uint64(block.timestamp);

        // Rate bounds. `PRECISION` (a flat segment) is always legal: stopping accrual
        // must never be blocked by the same checks that bound raising it.
        if (ratePerSecond < Constants.PRECISION || ratePerSecond > Constants.MAX_RATE_PER_SECOND) {
            revert RateOutOfBounds();
        }
        if (endTime < startTime || endTime - startTime > Constants.MAX_RATE_DURATION) {
            revert InvalidRateWindow();
        }
        // Backdating is never legal. Without this, `indexAt(startTime)` below
        // resolves against arbitrary history instead of the live curve.
        if (startTime < block.timestamp) revert StartTimeInThePast();
        if (startTime > block.timestamp + Constants.MAX_SCHEDULE_LEAD) {
            revert ScheduledTooFarAhead();
        }
        if (baseIndex > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();

        // Continuity. Compare the declared base against what the LIVE segment already
        // reaches at `startTime`. An on-time declaration matches it exactly and the
        // curve is seamless; the tolerance exists only so a late chain can catch up.
        uint256 liveAtStart = indexAt(startTime);
        if (baseIndex < liveAtStart) revert MultiplierCannotDecrease();

        uint256 maxAllowed = liveAtStart
            + Math.mulDiv(liveAtStart, Constants.MAX_REANCHOR_BPS, Constants.BASIS_POINTS);
        if (baseIndex > maxAllowed) revert ReanchorTooLarge(baseIndex, maxAllowed);

        // A genuine re-anchor (level step) may only take effect NOW. Scheduling it
        // ahead would let it land autonomously at `startTime` with nobody watching —
        // the same arbitrage window this bound exists to close.
        if (baseIndex > liveAtStart && startTime != block.timestamp) {
            revert ReanchorMustBeImmediate();
        }

        _installSegment(
            Segment({
                baseIndex: baseIndex,
                ratePerSecond: ratePerSecond,
                startTime: startTime,
                endTime: endTime
            })
        );

        emit OkuMRateSet(baseIndex, ratePerSecond, startTime, endTime, realizedYieldBacking);
    }

    /// @notice Latch off further rate declarations. Warm-key incident lever.
    /// @dev Does NOT rewind an in-flight segment — that would move the price DOWN and
    ///      break monotonicity for everyone holding. The live segment runs to its
    ///      `endTime` and then flatlines, which bounds exposure to at most the
    ///      remainder of one window.
    function haltAccrual() external onlyRole(Roles.OKUM_PAUSER) {
        if (accrualHalted()) revert AlreadyHalted();
        _setAccrualHalted(true);
        emit AccrualHalted(msg.sender);
    }

    /// @notice Resume rate declarations. Cold-key, deliberately asymmetric with halt.
    function resumeAccrual() external onlyRole(Roles.OKUM_UNPAUSER) {
        if (!accrualHalted()) revert NotHalted();
        _setAccrualHalted(false);
        emit AccrualResumed(msg.sender);
    }

    // ============ ERC20Permit override (blacklist) ============

    /// @dev Not pause-gated — approvals remain available while paused.
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
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Transfer hook ============

    /// @dev Pause blocks peer-to-peer transfers only; mint carries its own
    ///      `whenNotPaused` and burn always proceeds, so a blacklisted holder can
    ///      still be burned down during an incident.
    ///
    ///      ERC-8056's optional `TransferWithUIAmount` event is deliberately NOT
    ///      emitted. It would require resolving `uiMultiplier()` — an `rpow` — on
    ///      every single transfer, on the hottest path in the system. The event is
    ///      optional in the EIP and integrators can derive the same figure from
    ///      `Transfer` plus a `uiMultiplier()` read at the same block.
    function _update(address from, address to, uint256 amount) internal override {
        OkuMStorage storage $ = _getOkuMStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);
    }

    // ============ Mint / burn ============

    function mint(address to, uint256 amount) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        OkuMStorage storage $ = _getOkuMStorage();

        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        $.minterAllowance[msg.sender] -= amount;
        _mint(to, amount);
    }

    /// @notice Burn from the caller's balance. Allowed while paused.
    function burn(uint256 amount) external onlyRole(Roles.OKUM_BURNER) {
        if (_getOkuMStorage().isBlacklisted[msg.sender]) revert SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Admin ============

    function configureMinterAllowance(
        address minter_,
        uint256 newAllowance
    )
        external
        onlyRole(Roles.OKUM_ALLOWANCE_MANAGER)
    {
        if (minter_ == address(0)) revert Errors.ZeroAddress();
        OkuMStorage storage $ = _getOkuMStorage();
        emit MinterAllowanceUpdated(minter_, $.minterAllowance[minter_], newAllowance);
        $.minterAllowance[minter_] = newAllowance;
    }

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKUM_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        if (newMaxSupply > Constants.MAX_TOTAL_SUPPLY) revert ExceedsMaxTotalSupply();
        OkuMStorage storage $ = _getOkuMStorage();
        emit MaxSupplyUpdated($.maxSupply, newMaxSupply);
        $.maxSupply = newMaxSupply;
    }

    /// @notice Blacklist `account`. Works while paused, by design — the pause-then-
    ///         blacklist incident protocol depends on it.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    function pause() external onlyRole(Roles.OKUM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.OKUM_UNPAUSER) {
        _unpause();
    }

    // ============ ERC-165 ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return isScaledUIAmountInterface(interfaceId) || super.supportsInterface(interfaceId);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKUM_UPGRADER) {}
}
