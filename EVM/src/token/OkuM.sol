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
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ScaledUIAmountUpgradeable} from "../lib/ScaledUIAmountUpgradeable.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {Roles} from "../lib/Roles.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";
import {IScaledUIAmount} from "../interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title OkuM
 * @notice The share token — a fully-backed claim on realized T-Bill yield.
 *
 * @dev **Fixed raw balances. One stepwise realized index (`M_oku`).**
 *
 *      A standard, non-rebasing ERC-20. Raw balances move only on transfer, mint
 *      and burn. Realized yield accrues in a single stepwise UI multiplier; a
 *      holding's dollar value is `rawBalance * uiMultiplier() / 1e18`.
 *
 *      Same construction as Solana's Token-2022 `ScaledUiAmount` extension,
 *      which ERC-8056 standardizes for EVM — including the accrual granularity:
 *      both chains step, with the same value at the same cadence.
 *
 *      THREE LAYERS:
 *        - ERC-20     — raw, stock OpenZeppelin. The accounting layer.
 *        - ERC-4626   — conversion views only. The value layer, what protocols price against.
 *        - ERC-8056   — the display layer, what humans see.
 *
 *      NOT ERC-4626 COMPLIANT, and `supportsInterface` does not claim to be.
 *      `deposit`/`mint`/`withdraw`/`redeem` are absent: subscription and
 *      redemption run through `SubscriptionModule` and may queue rather than
 *      settle. A `deposit()` that reverted for everyone would be worse than an
 *      absent one, because integrators detect the interface and assume it works.
 *
 *      VALUE LAYER IS COARSER THAN THE DISPLAY LAYER, BY CONSTRUCTION.
 *      `convertToAssets` returns USDC (6 dp) per ERC-4626 semantics, while
 *      `uiMultiplier()` is 18 dp. They are related by a floor, not an equality:
 *
 *        convertToAssets(1e18) * usdcDecimalMultiplier
 *            <= uiMultiplier()
 *            <  (convertToAssets(1e18) + 1) * usdcDecimalMultiplier
 *
 *      HARD RULE: the multiplier is an input to *pricing*, never to *accounting*.
 *      Every ledger in the system is denominated in raw units.
 *
 *      Storage uses ERC-7201 namespaced storage. See https://eips.ethereum.org/EIPS/eip-7201
 */
contract OkuM is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ScaledUIAmountUpgradeable,
    IOkuM
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuM
    struct OkuMStorage {
        /// @dev USDC on this chain. Single source of truth — the module and queue
        ///      assert against this at `initialize` rather than deriving their own.
        address asset;
        /// @dev `10 ** (18 - usdcDecimals)`. `1e12` for Circle USDC.
        uint256 usdcDecimalMultiplier;
        /// @dev Per-minter cap, decremented on `mint` (Circle FiatToken pattern).
        mapping(address => uint256) minterAllowance;
        /// @dev Global supply cap in raw units. Bounded by `MAX_TOTAL_SUPPLY`.
        uint256 maxSupply;
        mapping(address => bool) isBlacklisted;
        /// @dev Guardian halt flag. While true, `setOkuMultiplier` reverts.
        bool accrualHalted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuM")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUM_STORAGE_LOCATION =
        0xb452deea490617e43215efe5d1021937b5200d3dc5c52d3e2b801ca18fb58800;

    function _getOkuMStorage() private pure returns (OkuMStorage storage $) {
        assembly {
            $.slot := OKUM_STORAGE_LOCATION
        }
    }

    /// @dev Post-step sync window. Lives in its own namespace, and on the token
    ///      rather than the module, because the multiplier authority is here:
    ///      fail-closed arming is a local write rather than a token -> module
    ///      call, which would invert the dependency direction.
    ///
    ///      Two `uint64`s pack into a single slot. `uint64` seconds overflows in
    ///      year ~584 billion.
    /// @custom:storage-location erc7201:okumoney.storage.SyncWindow
    struct SyncWindowStorage {
        /// @dev Exclusive: the first timestamp at which the window is no longer
        ///      engaged. `0` = never armed.
        uint64 lockedUntil;
        /// @dev Configured window length in seconds. `0` = inert.
        uint64 duration;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.SyncWindow")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SYNCWINDOW_STORAGE_LOCATION =
        0xf060659b9b87033111ee98a1780759ec75c780b1b57099783a2cb524034dd300;

    function _getSyncWindowStorage() private pure returns (SyncWindowStorage storage $) {
        assembly {
            $.slot := SYNCWINDOW_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    error ExceedsSupplyCap(uint256 requested, uint256 cap);
    error ExceedsAllowance(uint256 requested, uint256 available);
    error BelowCurrentSupply(uint256 requested, uint256 currentSupply);
    error AboveMaxTotalSupply(uint256 requested, uint256 maximum);
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @notice The configured asset reports more decimals than supported (>18).
    error AssetDecimalsTooLarge(uint8 reported);
    /// @notice Proposed sync-window duration exceeds `MAX_SYNC_WINDOW`.
    error SyncWindowTooLong(uint256 requested, uint256 maximum);
    /// @notice The guardian halted stepping; `resumeAccrual` (cold) lifts it.
    error AccrualIsHalted();
    /// @notice `distributeYield` called with zero supply outstanding.
    /// @dev There is nobody to distribute to, and the per-share delta would
    ///      divide by zero. Mint first, or use `setOkuMultiplier`.
    error NoSupplyToDistributeTo();
    /// @notice `distributeYield`'s amount was too small to move `M_oku` by 1 wei.
    /// @dev Fails loudly rather than silently accepting a no-op that would still
    ///      stamp `lastSteppedAt` and re-arm the sync window. Mirrors SVM's
    ///      `YieldTooSmall`.
    error YieldTooSmall(uint256 yieldAmount, uint256 totalSupply);

    // ============ Events ============

    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    /// @notice A multiplier step armed the post-step sync window.
    /// @param lockedUntil Exclusive timestamp at which the window lifts.
    event SyncWindowArmed(uint256 lockedUntil);
    event SyncWindowDurationUpdated(uint256 oldDuration, uint256 newDuration);

    /// @notice The guardian blocked further steps.
    /// @param atMultiplier The multiplier frozen in place.
    event AccrualHalted(uint256 atMultiplier);
    /// @notice Cold lifted the guardian halt.
    event AccrualResumed(uint256 atMultiplier);

    /// @notice Dollar-denominated yield was distributed by stepping `M_oku`.
    /// @param yieldAmount Dollars handed in (18 dp).
    /// @param totalSupply Raw supply the amount was spread across.
    /// @param newMultiplier `M_oku` after the step.
    /// @dev Emitted in addition to `OkuMultiplierStepped` and
    ///      `UIMultiplierUpdated`, so the dollar intent is recoverable from logs
    ///      rather than only the resulting index.
    event YieldDistributed(uint256 yieldAmount, uint256 totalSupply, uint256 newMultiplier);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the OkuM proxy.
    /// @param name_ ERC-20 name (canonical: "Oku Money").
    /// @param symbol_ ERC-20 symbol (canonical: "OkuM" — no `r`/`s` prefix; an
    ///        `r` prefix reads as *rebasing*, which is precisely backwards here).
    /// @param _asset USDC address on this chain. Must expose `decimals()`.
    /// @param _admin Receives the full role set; redistributes post-deploy.
    /// @param initialMaxSupply Initial supply cap in raw units.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _asset,
        address _admin,
        uint256 initialMaxSupply
    )
        public
        initializer
    {
        if (_asset == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (initialMaxSupply > Constants.MAX_TOTAL_SUPPLY) {
            revert AboveMaxTotalSupply(initialMaxSupply, Constants.MAX_TOTAL_SUPPLY);
        }

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ScaledUIAmount_init();

        OkuMStorage storage $ = _getOkuMStorage();
        $.asset = _asset;

        uint8 assetDecimals = IERC20Metadata(_asset).decimals();
        if (assetDecimals > Constants.MAX_USDC_DECIMALS) {
            revert AssetDecimalsTooLarge(assetDecimals);
        }
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(assetDecimals));

        $.maxSupply = initialMaxSupply;

        // Sync window ships ON — see `Constants.DEFAULT_SYNC_WINDOW`.
        _getSyncWindowStorage().duration = uint64(Constants.DEFAULT_SYNC_WINDOW);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKU_UPGRADER, _admin);
        _grantRole(Roles.OKU_PAUSER, _admin);
        _grantRole(Roles.OKU_UNPAUSER, _admin);
        _grantRole(Roles.OKU_MINTER, _admin);
        _grantRole(Roles.OKU_BURNER, _admin);
        _grantRole(Roles.OKU_RATE_SETTER, _admin);
        _grantRole(Roles.OKU_GUARDIAN, _admin);
        _grantRole(Roles.OKU_BLACKLISTER, _admin);
        _grantRole(Roles.OKU_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKU_CAP_MANAGER, _admin);
        _grantRole(Roles.OKU_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC-165 ============

    /// @dev Registers all four ERC-8056 interfaces. Deliberately does NOT claim
    ///      `type(IERC4626).interfaceId` — we implement the conversion subset
    ///      only, and claiming it would be false advertisement.
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

    // ============ ERC-8056 Balances extension ============

    /// @inheritdoc IScaledUIAmountBalances
    function balanceOfUI(address account) public view returns (uint256) {
        return MathLib.toUiAmount(balanceOf(account), uiMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    /// @dev Each `balanceOfUI` floors independently, so
    ///      `sum(balanceOfUI) <= totalSupplyUI()` with a gap bounded by the
    ///      holder count. Do not assert equality.
    function totalSupplyUI() public view returns (uint256) {
        return MathLib.toUiAmount(totalSupply(), uiMultiplier());
    }

    /// @notice UI (dollar) value of the allowance `owner` granted `spender`.
    /// @dev Allowances are denominated in RAW units, so a bounded approval's
    ///      dollar value grows with the multiplier. A user who approved a fixed
    ///      amount a year ago has granted more value than they intended.
    ///      Exposed on-chain (not only in the SDK) so explorers and wallets can
    ///      surface the drift without importing anything. There is no
    ///      contract-level fix that preserves ERC-20 semantics; see README
    ///      Limitations.
    function allowanceUI(address owner, address spender) external view returns (uint256) {
        return MathLib.toUiAmount(allowance(owner, spender), uiMultiplier());
    }

    // ============ ERC-4626 conversion subset (value layer) ============

    /// @inheritdoc IOkuM
    function asset() external view returns (address) {
        return _getOkuMStorage().asset;
    }

    /// @inheritdoc IOkuM
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getOkuMStorage().usdcDecimalMultiplier;
    }

    /// @notice Asset-denominated value of `shares` raw tokens. Floors.
    /// @dev Returns USDC native decimals (6), per ERC-4626 semantics. Not the
    ///      inverse of `convertToShares` — see contract NatSpec.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return MathLib.dollarsToUsdc(
            MathLib.toUiAmount(shares, uiMultiplier()), _getOkuMStorage().usdcDecimalMultiplier
        );
    }

    /// @notice Raw tokens corresponding to `assets` USDC. Floors.
    function convertToShares(uint256 assets) public view returns (uint256) {
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars(assets, _getOkuMStorage().usdcDecimalMultiplier), uiMultiplier()
        );
    }

    /// @notice Asset-denominated value of the entire supply.
    /// @dev Derived from the multiplier, not measured. There is no on-chain
    ///      referent for off-chain T-Bill backing; the value interface is exactly
    ///      as trustworthy as the multiplier authority. README Limitations.
    function totalAssets() external view returns (uint256) {
        return convertToAssets(totalSupply());
    }

    // ============ Storage accessors ============

    /// @notice Remaining minter allowance for `minter_`, in raw units.
    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuMStorage().minterAllowance[minter_];
    }

    /// @notice Global supply cap in raw units.
    function maxSupply() external view returns (uint256) {
        return _getOkuMStorage().maxSupply;
    }

    /// @notice Whether `account` is blacklisted.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuMStorage().isBlacklisted[account];
    }

    /// @notice Whether the guardian has blocked further multiplier steps.
    function accrualHalted() external view returns (bool) {
        return _getOkuMStorage().accrualHalted;
    }

    // ============ Multiplier authority ============

    /// @notice Step `M_oku` to `newMultiplier`, effective immediately.
    /// @dev THE oracle write. The moment a lending market prices off
    ///      `uiMultiplier()`, a wrong value mints borrowing power directly, and
    ///      `totalAssets()` is derived from the multiplier rather than measured,
    ///      so there is no on-chain referent to catch a mistake. Bounded by:
    ///
    ///        - monotonicity (`MultiplierCannotDecrease`)
    ///        - `MAX_STEP_BPS` per step (`StepAboveMaximum`)
    ///        - `MAX_MULTIPLIER` cumulative (`MultiplierAboveMaximum`)
    ///        - the guardian halt flag (`AccrualIsHalted`)
    ///
    ///      FEE COVERAGE IS NOT CHECKED HERE, because it cannot fail.
    ///      `SubscriptionModule.setFees` enforces `tin >= MAX_STEP_BPS` and
    ///      `tout >= MAX_STEP_BPS`, and this function enforces
    ///      `stepBps <= MAX_STEP_BPS`, so every admissible step is covered on
    ///      each leg independently, for all time. The earlier design read
    ///      `tin() + tout()` back from the module here and ratcheted a
    ///      high-water mark to stop fees dropping afterwards; the static floor
    ///      makes both redundant and is strictly stronger.
    ///
    ///      NOT pause-gated, by design: correcting the multiplier during an
    ///      incident must always be possible.
    ///
    ///      Arms the post-step sync window unconditionally (when a nonzero
    ///      duration is configured), so a step can never land unfenced. There is
    ///      no separate begin/end protocol: each chain fences itself on its own
    ///      write, and cross-chain parity is verified off-chain by comparing
    ///      multiplier values directly.
    function setOkuMultiplier(uint256 newMultiplier) external onlyRole(Roles.OKU_RATE_SETTER) {
        if (_getOkuMStorage().accrualHalted) revert AccrualIsHalted();
        _stepMultiplier(newMultiplier);
        _armSyncWindow();
    }

    /// @notice Distribute `yieldAmount` of dollar-denominated yield across all
    ///         holders by stepping `M_oku`.
    /// @dev Convenience over `setOkuMultiplier`, and the EVM twin of SVM's
    ///      `distribute_yield`. Both chains therefore expose the same two
    ///      mark-entry shapes: set the index, or hand over a dollar amount and
    ///      let the contract derive the index.
    ///
    ///      `newMultiplier = uiMultiplier() + yieldAmount * PRECISION / totalSupply()`
    ///
    ///      Routes through the identical validation path as `setOkuMultiplier`
    ///      — there is deliberately no second door past the gates. A
    ///      `yieldAmount` too small to move the multiplier by one wei reverts
    ///      rather than silently no-opping, mirroring SVM's `YieldTooSmall`.
    function distributeYield(uint256 yieldAmount)
        external
        onlyRole(Roles.OKU_RATE_SETTER)
        returns (uint256 newMultiplier)
    {
        if (_getOkuMStorage().accrualHalted) {
            revert AccrualIsHalted();
        }
        if (yieldAmount == 0) revert Errors.ZeroAmount();

        uint256 supply = totalSupply();
        if (supply == 0) revert NoSupplyToDistributeTo();

        // Floor: the undistributed remainder stays in the buffer as surplus
        // rather than being conjured into the index.
        uint256 delta = Math.mulDiv(yieldAmount, Constants.PRECISION, supply);
        if (delta == 0) revert YieldTooSmall(yieldAmount, supply);

        newMultiplier = uiMultiplier() + delta;

        // `_stepMultiplier` re-applies monotonicity, `MAX_STEP_BPS` and
        // `MAX_MULTIPLIER`; `delta > 0` already guarantees the first.
        _stepMultiplier(newMultiplier);
        _armSyncWindow();

        emit YieldDistributed(yieldAmount, supply, newMultiplier);
    }

    /// @notice Block further multiplier steps, immediately.
    /// @dev No timelock — this is the guardian's emergency lever against a
    ///      compromised rate setter. Monotone-safe: stops growth without
    ///      reducing anything already accrued. Not pause-gated.
    ///
    ///      Deliberately does NOT arm the sync window: nothing about the current
    ///      multiplier changes, so there is nothing to fence, and arming would
    ///      hand the warm guardian key a repeatable mint/redeem block the RBAC
    ///      model denies it.
    function haltAccrual() external onlyRole(Roles.OKU_GUARDIAN) {
        _getOkuMStorage().accrualHalted = true;
        emit AccrualHalted(uiMultiplier());
    }

    /// @notice Lift the guardian halt. Cold-only.
    function resumeAccrual() external onlyRole(Roles.OKU_CAP_MANAGER) {
        _getOkuMStorage().accrualHalted = false;
        emit AccrualResumed(uiMultiplier());
    }

    // ============ Post-step sync window ============
    //
    // `M_oku` steps on every chain in the same orchestrator tick, and the tick
    // is not atomic across chains. Every `setOkuMultiplier` write arms a
    // bounded, auto-expiring window recording that fact. There is no close
    // call, no epoch, and no cross-chain bookkeeping; off-chain parity
    // verification compares the multiplier VALUES (`check-sync-parity.ts`),
    // which equal epochs never actually proved.
    //
    // WHAT IT GATES ON THIS CHAIN TODAY: NOTHING. Stated plainly because the
    // alternative is protection that looks present and is not.
    //
    // The window's purpose is to fence value crossing a multiplier boundary
    // between chains. Raw is conserved per-instruction, but a cross-chain PAIR
    // prices: burning 100 raw where M=1.04 destroys $104 of claim while minting
    // 100 raw where M=1.05 creates $105, conjuring $1 from a mid-tick
    // divergence. On SVM that pair has dedicated instructions
    // (`mint_oku_m_direct` / `burn_oku_m_direct`) and they ARE gated.
    //
    // EVM has no such instruction. `mint` and `burn` here are the shared supply
    // hooks the module and the queue use for ordinary local subscription and
    // redemption, so gating them would gate the entire PSM — a 60-second outage
    // on every mint and redeem after every mark, to protect a bridge that does
    // not exist yet. An earlier draft of this refactor did exactly that before
    // the transitive effect was noticed.
    //
    // So on EVM the window is an ADVISORY SIGNAL: `isSyncLocked()` and
    // `syncLockedUntil()` are exposed for monitoring and for the bridge adapter
    // that will consult them. WHEN AN EVM BRIDGE IS BUILT IT MUST GATE ON
    // `isSyncLocked()`, and it should do so in its own contract rather than by
    // adding the modifier back here. Tracked in TRACKER.md.
    //
    // A time lock is the right tool for cross-chain divergence and the wrong
    // tool for step arbitrage, because the two edges differ in kind: divergence
    // is transient and self-correcting (once the lagging chain ticks the edge is
    // zero), whereas a step's gain is permanent and waiting costs the attacker
    // nothing. Hence a lock for the bridge, a fee floor for the steps.

    /// @notice True while the post-step sync window is engaged.
    /// @dev Exclusive upper bound. A zero-length window is therefore genuinely
    ///      inert rather than blocking the remainder of the current second.
    function isSyncLocked() public view returns (bool) {
        return block.timestamp < uint256(_getSyncWindowStorage().lockedUntil);
    }

    /// @notice Exclusive timestamp at which the current window lifts.
    function syncLockedUntil() external view returns (uint256) {
        return uint256(_getSyncWindowStorage().lockedUntil);
    }

    /// @notice Configured window length in seconds. `0` = inert.
    function syncWindowDuration() external view returns (uint256) {
        return uint256(_getSyncWindowStorage().duration);
    }

    /// @notice Set the sync-window length in seconds. `0` disables the window.
    /// @dev `OKU_CAP_MANAGER` (cold) — this is economic/safety policy, the same
    ///      class as `setMaxSupply`, so it reuses that role rather than adding
    ///      one. Bounded by `MAX_SYNC_WINDOW`, so no key can turn this into an
    ///      indefinite block: worst case, a compromised rate setter re-arming on
    ///      every write still cannot hold a single window longer than 15 minutes.
    function setSyncWindowDuration(uint256 newDuration) external onlyRole(Roles.OKU_CAP_MANAGER) {
        if (newDuration > Constants.MAX_SYNC_WINDOW) {
            revert SyncWindowTooLong(newDuration, Constants.MAX_SYNC_WINDOW);
        }
        SyncWindowStorage storage $ = _getSyncWindowStorage();
        uint256 old = uint256($.duration);
        // casting to 'uint64' is safe because the bound check immediately above
        // caps `newDuration` at `MAX_SYNC_WINDOW` (15 minutes).
        // forge-lint: disable-next-line(unsafe-typecast)
        $.duration = uint64(newDuration);
        emit SyncWindowDurationUpdated(old, newDuration);
    }

    /// @dev Arm the window. Writes nothing when `duration == 0`, so an inert
    ///      configuration never emits a window event.
    function _armSyncWindow() internal {
        SyncWindowStorage storage $ = _getSyncWindowStorage();
        if ($.duration == 0) return;
        $.lockedUntil = uint64(block.timestamp + $.duration);
        emit SyncWindowArmed($.lockedUntil);
    }

    // ============ ERC-20 hook: pause + blacklist + UI event ============

    /// @dev The ONLY override of OZ's transfer machinery, and it does not touch
    ///      the ledger — it applies the guards, delegates to `super`, then emits
    ///      the ERC-8056 event. The raw layer remains stock OpenZeppelin.
    ///
    ///      Guards live here rather than on `transfer`/`transferFrom` so that
    ///      `_mint` and `_burn` cannot bypass them.
    ///
    ///      Pause blocks peer-to-peer transfers and minting; burning is
    ///      deliberately NOT gated, so a holder can still exit while paused and
    ///      the pause-then-blacklist protocol works. Minting has its own
    ///      `whenNotPaused` on `mint()`.
    ///
    ///      `TransferWithUIAmount` is emitted only for genuine transfers. The
    ///      ERC-8056 reference implementation emits it from `_update`
    ///      unconditionally, including on mint and burn where the counterparty
    ///      UI amount is meaningless.
    function _update(address from, address to, uint256 value) internal override {
        OkuMStorage storage $ = _getOkuMStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        bool isTransfer = from != address(0) && to != address(0);
        if (isTransfer) _requireNotPaused();

        super._update(from, to, value);

        if (isTransfer) {
            emit TransferWithUIAmount(from, to, value, MathLib.toUiAmount(value, uiMultiplier()));
        }
    }

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
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Mint / burn ============

    /// @inheritdoc IOkuM
    /// @dev Minting `amount` raw at `uiMultiplier() = 1.05e18` creates $1.05*amount
    ///      of displayed value. The module handles the USDC conversion.
    ///
    function mint(address to, uint256 amount) external onlyRole(Roles.OKU_MINTER) whenNotPaused {
        OkuMStorage storage $ = _getOkuMStorage();

        uint256 cap = $.maxSupply;
        if (totalSupply() + amount > cap) revert ExceedsSupplyCap(totalSupply() + amount, cap);

        uint256 available = $.minterAllowance[msg.sender];
        if (available < amount) revert ExceedsAllowance(amount, available);

        // Effects before interactions: debit the allowance before minting.
        $.minterAllowance[msg.sender] = available - amount;

        _mint(to, amount);
    }

    /// @inheritdoc IOkuM
    /// @dev Burns the caller's own balance. Allowed while paused. Burning does
    ///      NOT restore minter allowance.
    ///
    function burn(uint256 amount) external onlyRole(Roles.OKU_BURNER) {
        _burn(msg.sender, amount);
    }

    // ============ Minter allowance ============

    /// @notice Set the minter allowance for `minter_`, in raw units.
    function configureMinterAllowance(
        address minter_,
        uint256 newAllowance
    )
        external
        onlyRole(Roles.OKU_ALLOWANCE_MANAGER)
    {
        if (minter_ == address(0)) revert Errors.ZeroAddress();
        OkuMStorage storage $ = _getOkuMStorage();
        uint256 oldAllowance = $.minterAllowance[minter_];
        $.minterAllowance[minter_] = newAllowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, newAllowance);
    }

    // ============ Supply cap ============

    /// @notice Update the global supply cap.
    /// @dev Bounded ABOVE by `MAX_TOTAL_SUPPLY` as well as below by
    ///      `totalSupply()`. The upper bound MUST be enforced here and not only
    ///      in `initialize`: `maxSupply` is mutable by this role, so an
    ///      init-only assertion would evaporate the first time the cap moved,
    ///      taking the overflow invariant with it.
    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKU_CAP_MANAGER) {
        uint256 supply = totalSupply();
        if (newMaxSupply < supply) revert BelowCurrentSupply(newMaxSupply, supply);
        if (newMaxSupply > Constants.MAX_TOTAL_SUPPLY) {
            revert AboveMaxTotalSupply(newMaxSupply, Constants.MAX_TOTAL_SUPPLY);
        }
        OkuMStorage storage $ = _getOkuMStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (works while paused) ============

    /// @notice Add `account` to the blacklist. Works while paused.
    function blacklist(address account) external onlyRole(Roles.OKU_BLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist. Works while paused.
    function unblacklist(address account) external onlyRole(Roles.OKU_UNBLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause ============

    /// @notice Pause transfers and minting. Burning remains available.
    function pause() external onlyRole(Roles.OKU_PAUSER) {
        _pause();
    }

    /// @notice Unpause.
    function unpause() external onlyRole(Roles.OKU_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKU_UPGRADER) {}
}
