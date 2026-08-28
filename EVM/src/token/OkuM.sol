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
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {ScaledUIAmountUpgradeable} from "../lib/ScaledUIAmountUpgradeable.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";

/**
 * @title OkuM
 * @notice Fully-backed share token (ticker `OkuM`) backed by US Treasury Bills.
 * @dev Raw ERC-20 balances are FIXED — yield is expressed entirely through the
 *      ERC-8056 `uiMultiplier()` (`M_oku`), written discretely by `OKU_RATE_SETTER`
 *      via {setOkuMultiplier}. `M_oku` is exposed twice: through the ERC-8056
 *      display layer (`uiMultiplier`, `balanceOfUI`, ...) and through 4626-shaped
 *      value views (`convertToAssets`, `totalAssets`, ...) — both read the
 *      identical stored value. OkuM does NOT claim ERC-4626 or ERC-7540; see
 *      `EVM/README.md § Token surfaces / OkuM`.
 *
 *      Conversion (USDC <-> OkuM) is reviewed, not permissionless — see
 *      `SubscriptionModule`. OkuM itself only knows how to mint/burn against a
 *      per-minter allowance; it has no swap surface.
 *
 *      The minter-allowance design (per-minter cap in `minterAllowance`,
 *      decremented on `mint`) is modeled on Circle's FiatToken minter-controller
 *      pattern: https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 *      Storage uses the ERC-7201 namespaced storage pattern for upgrade safety:
 *      https://eips.ethereum.org/EIPS/eip-7201
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
        address asset; // USDC. Single source of truth for the decimal binding;
        uint256 usdcDecimalMultiplier; // every consumer cross-asserts against this.
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

    // ============ Custom Errors ============

    // Shared errors (ZeroAddress, MultiplierCannotDecrease, MultiplierAboveMaximum)
    // live in lib/Errors.sol.
    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsMaxTotalSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @dev Oracle-sanity bound, not an arbitrage control — see `Constants.MAX_STEP_BPS`.
    error StepAboveMaximum();
    error EpochNotIncreasing();
    error AccrualIsHalted();
    error UsdcDecimalsTooLarge(uint8 reported);

    // ============ Events ============
    // `UIMultiplierUpdated` and `TransferWithUIAmount` are declared on
    // `IScaledUIAmount` (inherited via ScaledUIAmountUpgradeable).

    /// @notice Richer than the spec event — carries the epoch for cross-chain
    ///         reconciliation and the step size for monitoring.
    event OkuMultiplierStepped(
        uint256 oldMultiplier, uint256 newMultiplier, uint256 epoch, uint256 stepBps
    );
    event AccrualHalted(uint256 atMultiplier);
    event AccrualResumed(uint256 atMultiplier);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol (canonical ticker is `OkuM`).
    /// @param _admin Admin address; receives the full role set. See
    ///        `EVM/README.md § Roles` for the post-deploy redistribution policy.
    /// @param initialMaxSupply Initial supply cap, in raw token units. Must be
    ///        `<= Constants.MAX_TOTAL_SUPPLY`.
    /// @param _asset USDC address. Must implement `IERC20Metadata.decimals()`.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _admin,
        uint256 initialMaxSupply,
        address _asset
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (_asset == address(0)) revert Errors.ZeroAddress();
        if (initialMaxSupply > Constants.MAX_TOTAL_SUPPLY) revert ExceedsMaxTotalSupply();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ScaledUIAmount_init();

        OkuMStorage storage $ = _getOkuMStorage();
        $.maxSupply = initialMaxSupply;
        $.asset = _asset;

        uint8 usdcDecimals = IERC20Metadata(_asset).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKU_UPGRADER, _admin);
        _grantRole(Roles.OKU_PAUSER, _admin);
        _grantRole(Roles.OKU_UNPAUSER, _admin);
        _grantRole(Roles.OKU_MINTER, _admin);
        _grantRole(Roles.OKU_BURNER, _admin);
        _grantRole(Roles.OKU_BLACKLISTER, _admin);
        _grantRole(Roles.OKU_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKU_CAP_MANAGER, _admin);
        _grantRole(Roles.OKU_ALLOWANCE_MANAGER, _admin);
        _grantRole(Roles.OKU_RATE_SETTER, _admin);
        _grantRole(Roles.OKU_GUARDIAN, _admin);
        _grantRole(Roles.OKU_ACCRUAL_RESUMER, _admin);
    }

    // ============ ERC20 Overrides ============

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

    // ============ ScaledUIAmountUpgradeable hooks ============

    function _scaledUIRawBalanceOf(address account) internal view override returns (uint256) {
        return super.balanceOf(account);
    }

    function _scaledUIRawTotalSupply() internal view override returns (uint256) {
        return super.totalSupply();
    }

    // ============ Storage Accessor Views ============

    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuMStorage().minterAllowance[minter_];
    }

    function maxSupply() external view returns (uint256) {
        return _getOkuMStorage().maxSupply;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuMStorage().isBlacklisted[account];
    }

    /// @inheritdoc IOkuM
    function asset() external view returns (address) {
        return _getOkuMStorage().asset;
    }

    /// @inheritdoc IOkuM
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getOkuMStorage().usdcDecimalMultiplier;
    }

    // ============ Value views (4626-shaped, NOT ERC-4626-compliant) ============

    /// @inheritdoc IOkuM
    /// @dev `deposit`/`mint`/`withdraw`/`redeem` are deliberately absent —
    ///      conversion runs through `SubscriptionModule` and is asynchronous. A
    ///      `deposit()` that reverts for everyone is worse than an absent one.
    function totalAssets() external view returns (uint256) {
        return
            MathLib.dollarsToUsdc(
                toUIAmount(totalSupply()), _getOkuMStorage().usdcDecimalMultiplier
            );
    }

    /// @inheritdoc IOkuM
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return MathLib.dollarsToUsdc(toUIAmount(shares), _getOkuMStorage().usdcDecimalMultiplier);
    }

    /// @inheritdoc IOkuM
    /// @dev NOT the inverse of {convertToAssets} — a round trip quantizes to USDC
    ///      granularity, losing up to 1e12 in 18dp terms. See `EVM/README.md`.
    function convertToShares(uint256 assets) external view returns (uint256) {
        return fromUIAmount(MathLib.usdcToDollars(assets, _getOkuMStorage().usdcDecimalMultiplier));
    }

    // ============ Beyond the EIP ============

    /// @notice Dollar value of the remaining allowance `owner` has granted `spender`.
    /// @dev Allowances are raw-denominated, so a bounded approval's dollar value
    ///      grows with `M_oku` (Limitation 7 in `EVM/README.md`). Exposed on-chain
    ///      rather than only in the SDK so an explorer or wallet can warn about a
    ///      drifted approval without importing anything.
    ///
    ///      SATURATES rather than reverting. `toUIAmount` would overflow for an
    ///      allowance near `type(uint256).max` once `M_oku > PRECISION`, and an
    ///      infinite approval is the single most common approval pattern there is
    ///      — a drift-monitoring view that reverts on it would be useless. An
    ///      unbounded raw approval is an unbounded dollar approval, so
    ///      `type(uint256).max` is also the honest answer.
    function allowanceUI(address owner, address spender) external view returns (uint256) {
        uint256 raw = allowance(owner, spender);
        uint256 multiplier = uiMultiplier();
        if (multiplier > Constants.PRECISION) {
            // Largest raw allowance whose UI value still fits in uint256. Safe to
            // compute: with multiplier > PRECISION the quotient is below
            // type(uint256).max, and mulDiv carries the 512-bit intermediate.
            uint256 maxRaw = Math.mulDiv(type(uint256).max, Constants.PRECISION, multiplier);
            if (raw > maxRaw) return type(uint256).max;
        }
        return MathLib.toUIAmount(raw, multiplier);
    }

    // ============ Multiplier Logic (OKU_RATE_SETTER) ============

    /// @notice Write a new `M_oku` step.
    /// @param newMultiplier New multiplier value. Must strictly increase, its step
    ///        size must be `<= Constants.MAX_STEP_BPS`, and it must not exceed
    ///        `Constants.MAX_MULTIPLIER`.
    /// @param epoch Orchestrator-assigned mark number. Must strictly increase.
    /// @dev Takes effect immediately (`effectiveAt = block.timestamp`) — see
    ///      `ScaledUIAmountUpgradeable` NatSpec on scheduling.
    ///
    ///      DELIBERATELY NOT PAUSE-GATED. A mark is an oracle write, not a user
    ///      operation: pause exists to freeze transfers and minting during an
    ///      incident, not to stop the issuer publishing a truthful multiplier.
    ///      More concretely, raising `M_oku` raises `USDOkuWrapper.realizedBacking()`
    ///      and is therefore the primary lever for closing a solvency gap — so
    ///      gating it on pause would remove the remedy exactly when an incident
    ///      makes it necessary. `haltAccrual()` is the dedicated way to stop
    ///      marks, and it is independent of pause in both directions.
    function setOkuMultiplier(
        uint256 newMultiplier,
        uint256 epoch
    )
        external
        onlyRole(Roles.OKU_RATE_SETTER)
    {
        if (_getScaledUIAmountStorage().accrualHalted) revert AccrualIsHalted();

        uint256 currentMultiplier = uiMultiplier();
        if (newMultiplier <= currentMultiplier) revert Errors.MultiplierCannotDecrease();
        if (newMultiplier > Constants.MAX_MULTIPLIER) revert Errors.MultiplierAboveMaximum();

        uint256 stepBps = Math.mulDiv(
            newMultiplier - currentMultiplier,
            Constants.BASIS_POINTS,
            currentMultiplier,
            Math.Rounding.Floor
        );
        if (stepBps > Constants.MAX_STEP_BPS) revert StepAboveMaximum();

        uint256 currentEpoch = _getScaledUIAmountStorage().epoch;
        if (epoch <= currentEpoch) revert EpochNotIncreasing();

        _setUIMultiplier(newMultiplier, block.timestamp, epoch);
        emit OkuMultiplierStepped(currentMultiplier, newMultiplier, epoch, stepBps);
    }

    /// @notice Freeze further `setOkuMultiplier` writes. Warm.
    /// @dev Monotone-safe: stops growth without reducing anything accrued.
    function haltAccrual() external onlyRole(Roles.OKU_GUARDIAN) {
        _setAccrualHalted(true);
        emit AccrualHalted(uiMultiplier());
    }

    /// @notice Reverse a halt and allow `setOkuMultiplier` writes again. Cold-only —
    ///         deliberately a different role than `haltAccrual`, so a compromised
    ///         warm `OKU_GUARDIAN` key can stop the protocol but never restart it.
    function resumeAccrual() external onlyRole(Roles.OKU_ACCRUAL_RESUMER) {
        _setAccrualHalted(false);
        emit AccrualResumed(uiMultiplier());
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
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause + ERC-8056 event) ============

    /// @dev Pause blocks peer-to-peer transfers and mint; burn always proceeds.
    ///      Blacklist applies to the non-zero side(s). `TransferWithUIAmount` is
    ///      gated on `from != 0 && to != 0` — the reference implementation emits
    ///      unconditionally including mint/burn, where the counterparty UI amount
    ///      is meaningless; this contract deviates deliberately (see README).
    function _update(address from, address to, uint256 amount) internal override {
        OkuMStorage storage $ = _getOkuMStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);

        if (from != address(0) && to != address(0)) {
            emit TransferWithUIAmount(from, to, amount, toUIAmount(amount));
        }
    }

    // ============ Minting & Burning ============

    /// @notice Mint raw tokens to an address.
    /// @dev The only mint surface — `SubscriptionModule` and `USDOkuWrapper` hold
    ///      `OKU_MINTER` as contracts; no EOA should.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKU_MINTER) whenNotPaused {
        OkuMStorage storage $ = _getOkuMStorage();

        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        $.minterAllowance[msg.sender] -= amount;

        _mint(to, amount);
    }

    /// @notice Burn raw tokens from the caller's balance. Allowed while paused.
    function burn(uint256 amount) external onlyRole(Roles.OKU_BURNER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

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

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKU_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        if (newMaxSupply > Constants.MAX_TOTAL_SUPPLY) revert ExceedsMaxTotalSupply();
        OkuMStorage storage $ = _getOkuMStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(Roles.OKU_BLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKU_UNBLACKLISTER) {
        OkuMStorage storage $ = _getOkuMStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(Roles.OKU_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.OKU_UNPAUSER) {
        _unpause();
    }

    // ============ ERC-165 ============

    /// @dev Combines AccessControl's ERC-165 with the four ERC-8056 IDs. Does NOT
    ///      claim ERC-4626 or ERC-7540 — any interfaceId not explicitly matched
    ///      falls through to `super.supportsInterface`, which returns false for
    ///      both.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return isScaledUIAmountInterface(interfaceId) || super.supportsInterface(interfaceId);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKU_UPGRADER) {}
}
