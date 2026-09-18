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
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {YieldSandwichGuard} from "../lib/YieldSandwichGuard.sol";
import {OkuDollarEvents} from "../lib/events/OkuDollarEvents.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";

/**
 * @title OkuDollar
 * @notice Rebasing $1-pegged stablecoin (ticker `UsdOku`) wrapping OkuMoney.
 * @dev SINGLE MULTIPLIER DESIGN: `usdMultiplier()` is exactly
 *      `okuMoney.okuMMultiplier()` — OkuDollar has no independent yield rate. See
 *      README.md § Token Model for the full rationale and consequences
 *      (collateralization exactly 1.0, ERC-4626 inflation-attack immunity, why
 *      donations need {rescueDonation}). See the "ERC-4626 Surface" section below
 *      for why `ERC4626Upgradeable` is not inherited.
 *
 *      TERMINOLOGY HAZARD: internal `usdShares` (non-rebasing accounting unit) and
 *      ERC-4626 "shares" (the rebasing displayed balance) are DIFFERENT quantities
 *      in this design. `convertToShares` returns the latter.
 *
 *      See Constants.sol for terminology legend.
 *      See {OkuMoney.initialize} for the unified role-grant policy.
 *      Storage uses ERC-7201 namespaced storage (https://eips.ethereum.org/EIPS/eip-7201).
 */
contract OkuDollar is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    YieldSandwichGuard,
    UUPSUpgradeable,
    OkuDollarEvents,
    IOkuDollar,
    IERC4626
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollar
    struct OkuDollarStorage {
        IOkuMoney okuMoney;
        // Internal share accounting. NOT the ERC-4626 "shares" quantity — see the
        // terminology hazard note in the contract NatSpec. Under the single-multiplier
        // design these are numerically identical to raw OkuM deposited.
        mapping(address => uint256) usdShares;
        uint256 totalUsdShares;
        // Blacklist — uses shared OKUM_BLACKLISTER / OKUM_UNBLACKLISTER roles so a single
        // role grant covers both OkuMoney and OkuDollar. This mirrors regulatory requirements:
        // a blacklisted address should not be able to hold or transfer UsdOku either.
        mapping(address => bool) isBlacklisted;
    }
    // REMOVED (single-multiplier refactor): usdBaseMultiplier, usdRatePerSecond,
    // usdLastAccrualTime, usdRateEnd, usdPendingRatePerSecond — accrual now lives
    // solely on OkuMoney. minCollateralRatio — collateralization is 1.0 by construction.

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollar")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, MultiplierCannotDecrease, ZeroAmount, InsufficientBalance)
    // live in lib/Errors.sol. YieldDistributionInProgress is inherited from YieldSandwichGuard.
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    /// @notice {rescueDonation} would dip into OkuM that backs outstanding shares.
    error NoDonationAvailable();
    /// @notice Defensive guard: direct `_mint` is forbidden; use `wrap()` instead.
    error UseWrapInstead();
    /// @notice Defensive guard: direct `_burn` is forbidden; use `unwrap()` instead.
    error UseUnwrapInstead();
    /// @notice Defensive guard: OkuDollar uses share-based accounting; the inherited
    ///         ERC-20 `_update` path must never execute for any transfer type.
    error OkuDollarDoesNotUseInternalUpdate();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the OkuDollar proxy.
    /// @param _okuMoney OkuMoney token address (backing reserve asset).
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol (canonical ticker is `usdOku`).
    /// @param _admin Admin address (receives full vault role set; see {OkuMoney.initialize}).
    /// @dev The `_minCollateralRatio` parameter was removed in the single-multiplier
    ///      refactor: collateralization is exactly 1.0 by construction.
    function initialize(
        address _okuMoney,
        string memory name_,
        string memory symbol_,
        address _admin
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.okuMoney = IOkuMoney(_okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.VAULT_UPGRADER, _admin);
        _grantRole(Roles.VAULT_PAUSER, _admin);
        _grantRole(Roles.VAULT_UNPAUSER, _admin);
        _grantRole(Roles.VAULT_RESCUER, _admin);
        // Shared blacklist roles: a single grant covers both OkuMoney and OkuDollar.
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    /// @notice Total internal share tokens across all holders.
    /// @dev NOT the ERC-4626 `totalSupply()` of shares — see contract NatSpec
    ///      terminology hazard. Under the single-multiplier design this equals
    ///      the raw OkuM held as reserves.
    function totalUsdShares() external view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    /// @notice Internal share balance for `account`.
    function usdSharesOf(address account) external view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    /// @notice Whether `account` is on the OkuDollar blacklist.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuDollarStorage().isBlacklisted[account];
    }

    // ============ USD Multiplier (Delegated to OkuMoney) ============

    /// @notice Dollar value per UsdOku share, 1e18 = $1.00.
    /// @dev SINGLE MULTIPLIER: this is exactly `okuMoney.okuMMultiplier()`. OkuDollar
    ///      holds no rate state of its own, so OkuM and UsdOku cannot diverge and
    ///      there is only one schedule to keep in sync across chains.
    ///
    ///      Because OkuMoney streams continuously, this inherits that continuity:
    ///      no discrete step, nothing to sandwich.
    function usdMultiplier() public view returns (uint256) {
        return _getOkuDollarStorage().okuMoney.okuMMultiplier();
    }

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply()
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return Math.mulDiv(
            _getOkuDollarStorage().totalUsdShares,
            usdMultiplier(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return Math.mulDiv(
            _getOkuDollarStorage().usdShares[account],
            usdMultiplier(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        returns (bool)
    {
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(msg.sender, to, shares, multiplier);
        // Emit `Transfer` with the effective post-rounding dollar amount
        // (`shares * multiplier / 1e18`) rather than the caller-specified
        // `amount`, keeping the ERC-20 invariant `sum(Transfer.value) ==
        // Δ balanceOf` intact for indexers/accounting.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(msg.sender, to, effective);
        return true;
    }

    /// @dev Allowance is debited by the caller-supplied `amount`, while the
    ///      actual moved value is `effective = floor(shares * multiplier / 1e18)`.
    ///      Because share derivation floors, `effective <= amount` always, and
    ///      the gap (at most 1 wei per call) is consumed from the allowance
    ///      rather than the holder's balance. This is in the protocol's favor
    ///      and mirrors the same flooring direction documented on `wrap` /
    ///      `unwrap`. Indexers should reconstruct the moved value from the
    ///      `Transfer` event payload, not from the allowance delta.
    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(from, to, shares, multiplier);
        // See `transfer` above.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(from, to, effective);
        return true;
    }

    /// @dev Public ERC-20 `Transfer` event is emitted by the calling function with the
    ///      original token amount. This helper only tracks share movement + dollar value.
    ///      `multiplier` is threaded in by the caller (which already read
    ///      `usdMultiplier()` to compute `shares`) rather than re-read here — halves
    ///      the cross-contract `okuMoney.okuMMultiplier()` calls (and the `rpow` behind
    ///      it) per `transfer`/`transferFrom`.
    function _transferUsdShares(
        address from,
        address to,
        uint256 shares,
        uint256 multiplier
    )
        internal
    {
        if (from == address(0)) revert Errors.ZeroAddress();
        if (to == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert Errors.InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        uint256 dollarValue =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit TransferValue(from, to, shares, dollarValue);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @notice EIP-2612 permit with blacklist enforcement.
    /// @dev ALLOWANCE SEMANTICS NOTE: `value` is denominated in dollar terms (same units
    ///      as `balanceOf` and `transferFrom`). Internally OkuDollar stores balances as
    ///      shares; `transferFrom(amount)` floors the share conversion while `unwrap(amount)`
    ///      ceils it. When `usdMultiplier > 1e18`, multiple sequential `transferFrom` calls
    ///      against a single permit-approved allowance may under-consume shares by ~1 share
    ///      per call due to this floor truncation. Integrators that plan batched `transferFrom`
    ///      against a permit allowance should account for this 1-wei per-call dust.
    ///
    ///      Not pause-gated — approvals are allowed while paused (mirrors OkuMoney.permit).
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
        OkuDollarStorage storage $ = _getOkuDollarStorage();
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
        if (_getOkuDollarStorage().isBlacklisted[spender]) revert RecipientBlacklisted();
        return super.approve(spender, value);
    }

    // ============ Inherited ERC20 guard ============

    /// @dev OkuDollar overrides `transfer`/`transferFrom` to use share-based accounting.
    ///      The inherited ERC-20 `_update` hook must never execute — all supply changes
    ///      go through `wrap()`/`unwrap()` which manage `usdShares` directly, and
    ///      peer-to-peer transfers are handled by the overridden `transfer`/`transferFrom`.
    ///
    ///      Unconditional revert (with diagnostic sub-errors for mint/burn) ensures that
    ///      no future code change can accidentally write to the inherited `_balances`
    ///      mapping, which `balanceOf()` never reads.  This matches the hard-revert
    ///      pattern used by stETH and Aave aToken.
    function _update(address from, address to, uint256) internal pure override {
        if (from == address(0)) revert UseWrapInstead();
        if (to == address(0)) revert UseUnwrapInstead();
        revert OkuDollarDoesNotUseInternalUpdate();
    }

    // ============ Yield Distribution Lock ============

    /// @inheritdoc YieldSandwichGuard
    function _yieldSandwichOkuMoney() internal view override returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /// @notice Wrap OkuMoney into OkuDollar.
    /// @dev usdMinted = okuMAmount * okuMMultiplier / usdMultiplier.
    ///      100 OkuM at okuMMultiplier=$1.05, usdMultiplier=1.0 -> 105 UsdOku.
    /// @param okuMAmount Amount of OkuMoney tokens to wrap
    /// @param receiver Address to receive OkuDollar
    /// @param minAmountOut Minimum OkuDollar to receive (slippage protection)
    /// @return usdMinted Amount of OkuDollar minted
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        public
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 usdMinted)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        // Measure actual tokens received (handles fee-on-transfer edge cases)
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;

        // SINGLE MULTIPLIER: usdMultiplier() IS okuMoney.okuMMultiplier() (enforced at
        // LitePSM.initialize / this contract's own asset() wiring), so shares track
        // raw OkuM 1:1 exactly — mulDiv(actualReceived, m, m, Floor) == actualReceived,
        // no rounding loss. One multiplier read instead of the historical two.
        uint256 mult = $.okuMoney.okuMMultiplier();
        uint256 sharesToMint = actualReceived;
        if (sharesToMint == 0) revert AmountTooSmall();

        usdMinted = MathLib.okuMToDollars(actualReceived, mult);
        if (usdMinted < minAmountOut) revert OutputBelowMinimum(usdMinted, minAmountOut);

        $.totalUsdShares += sharesToMint;
        $.usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
        emit TransferValue(address(0), receiver, sharesToMint, usdMinted);
        // `Wrapped`'s last two params are historically (okuMMultiplier, usdMultiplier)
        // from the pre-collapse dual-multiplier design; both are `mult` here since
        // they're now provably identical — kept for indexer/ABI compatibility rather
        // than collapsing to a single param.
        emit Wrapped(msg.sender, receiver, actualReceived, usdMinted, mult, mult);
        emit Deposit(msg.sender, receiver, actualReceived, usdMinted);
    }

    /// @notice Unwrap OkuDollar back to OkuMoney.
    /// @dev okuMReturned = usdAmount * PRECISION / okuMMultiplier.
    ///      105 UsdOku at okuMMultiplier=$1.05 -> 100 OkuM (regardless of usdMultiplier).
    ///      usdMultiplier converts shares <-> dollars; okuMMultiplier converts dollars <-> OkuMoney.
    ///      Reverts if vault holds insufficient OkuMoney.
    /// @param usdAmount Amount of OkuDollar to unwrap (in dollar terms)
    /// @param receiver Address to receive OkuMoney
    /// @return okuMReturned Amount of OkuMoney tokens returned
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        public
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 okuMReturned)
    {
        return _unwrap(msg.sender, usdAmount, receiver);
    }

    /// @dev Shared core for {unwrap} and the ERC-4626 {withdraw}/{redeem} paths.
    ///      `owner` is the share source (whose balance is burned); `msg.sender`
    ///      (recorded via `_msgSender()`) is only relevant for the `Withdraw`
    ///      event's `sender` field when acting on another owner's behalf via
    ///      an allowance — see {_redeemShares}. Burning directly from `owner`
    ///      here (rather than the old two-step "move internal shares to the
    ///      spender, then unwrap as the spender" path) avoids computing the
    ///      ceil-rounded share burn twice against two different balances,
    ///      which could previously leave a third-party `withdraw`/`redeem`
    ///      one share short of what the burn demanded.
    function _unwrap(
        address owner,
        uint256 usdAmount,
        address receiver
    )
        internal
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        // Symmetric with `wrap`: both sides of the principal flow are
        // checked. The receiver gets OkuMoney back, and OkuMoney's `_update`
        // hook independently enforces its own blacklist on the recipient.
        // We add the explicit check here so a user blacklisted only on
        // OkuDollar (but not OkuMoney) cannot route OkuM to a third party
        // via `unwrap(amount, victimAddr)`.
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        // SINGLE MULTIPLIER: one external read instead of the historical two
        // (usdMultiplier() would otherwise re-derive the identical value via its own
        // call to okuMoney.okuMMultiplier()). The two mulDiv calls below still use
        // DIFFERENT rounding directions on purpose — floor on the OkuM returned,
        // ceil on the shares burned — both favor the vault; that asymmetry is a
        // rounding-policy choice, not multiplier redundancy.
        uint256 mult = $.okuMoney.okuMMultiplier();
        okuMReturned = Math.mulDiv(usdAmount, Constants.PRECISION, mult, Math.Rounding.Floor);

        // Ceil to favor vault on share burn.
        uint256 sharesToBurn = Math.mulDiv(usdAmount, Constants.PRECISION, mult, Math.Rounding.Ceil);
        if ($.usdShares[owner] < sharesToBurn) revert Errors.InsufficientBalance();

        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        $.totalUsdShares -= sharesToBurn;
        $.usdShares[owner] -= sharesToBurn;

        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        emit Transfer(owner, address(0), usdAmount);
        emit TransferValue(owner, address(0), sharesToBurn, usdAmount);
        // See `wrap`'s NatSpec on the identical `mult, mult` pattern.
        emit Unwrapped(owner, receiver, usdAmount, okuMReturned, mult, mult);
        emit Withdraw(_msgSender(), receiver, owner, okuMReturned, usdAmount);
    }

    // ============ ERC-4626 Surface ============
    // OkuM = `asset`, UsdOku = `shares`. Deliberately NOT inheriting OZ's
    // ERC4626Upgradeable: its _convertTo* assume a static share balance with a
    // floating ratio, whereas UsdOku shares rebase (balance grows with `m`, price
    // pinned at $1). See contract NatSpec.
    //
    // Conversions use the multiplier directly rather than totalAssets/totalSupply,
    // which is what makes the vault structurally immune to the 4626 inflation attack.

    /// @notice Underlying asset (OkuMoney).
    function asset() public view override(IERC4626, IOkuDollar) returns (address) {
        return address(_getOkuDollarStorage().okuMoney);
    }

    /// @notice Total OkuM managed by the vault.
    function totalAssets() public view returns (uint256) {
        return totalOkuMReserves();
    }

    /// @notice Dollar value of `assets` OkuM at the current multiplier.
    /// @dev Rounds down, per spec (convertTo* MUST always round down).
    function convertToShares(uint256 assets) public view returns (uint256) {
        return MathLib.okuMToDollars(assets, usdMultiplier());
    }

    /// @notice OkuM equivalent of `shares` dollars at the current multiplier.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return MathLib.dollarsToOkuM(shares, usdMultiplier());
    }

    /// @dev Zero while paused or when `receiver` is blacklisted (deposits would
    ///      revert on `wrap`'s own `whenNotPaused` / blacklist checks either way;
    ///      this makes that visible to spec-conforming integrators via `maxDeposit`
    ///      rather than only surfacing as a revert).
    function maxDeposit(address receiver) public view returns (uint256) {
        if (paused() || _getOkuDollarStorage().isBlacklisted[receiver]) return 0;
        return type(uint256).max;
    }

    /// @dev Delegates to {maxDeposit}: both only ever return `0` or
    ///      `type(uint256).max`, which are valid unlimited/blocked sentinels in
    ///      either units (assets here vs. shares per spec), so no unit conversion
    ///      is needed between the two.
    function maxMint(address receiver) public view returns (uint256) {
        return maxDeposit(receiver);
    }

    /// @dev Spec requires the ASSET (OkuM) equivalent, not the raw share/dollar
    ///      balance — `balanceOf(owner)` is dollars, not OkuM.
    function maxWithdraw(address owner) public view returns (uint256) {
        return convertToAssets(balanceOf(owner));
    }

    function maxRedeem(address owner) public view returns (uint256) {
        return balanceOf(owner);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    /// @dev Rounds up — assets the caller must supply to receive `shares`.
    function previewMint(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, Constants.PRECISION, usdMultiplier(), Math.Rounding.Ceil);
    }

    /// @dev Rounds up — dollar amount burned to withdraw `assets` of OkuM.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, usdMultiplier(), Constants.PRECISION, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    /// @notice Deposit `assets` OkuM, minting UsdOku to `receiver`.
    /// @dev Thin alias over {wrap}. The 4626 signature carries no slippage
    ///      parameter, so `minAmountOut` is 0 — EOAs should prefer {wrap}.
    ///
    ///      Deliberately carries NO `nonReentrant` / `whenNotPaused` /
    ///      `whenYieldNotDistributing` of its own — `wrap` (called below) already
    ///      enforces all three. Adding them here too would make this call
    ///      re-enter `wrap`'s own `nonReentrant` guard and revert on every call;
    ///      the asymmetry with {withdraw}/{redeem} (which DO carry explicit
    ///      modifiers, since they route through the internal `_unwrap` rather than
    ///      the public, already-guarded `unwrap`) is intentional, not an oversight.
    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return wrap(assets, receiver, 0);
    }

    /// @notice Mint `shares` dollars of UsdOku to `receiver`.
    /// @dev See {deposit} — no guards here either, for the same reason.
    function mint(uint256 shares, address receiver) external returns (uint256) {
        uint256 assets = previewMint(shares);
        wrap(assets, receiver, 0);
        return assets;
    }

    /// @notice Withdraw `assets` OkuM to `receiver`, burning `owner`'s UsdOku.
    /// @return shares The number of UsdOku shares burned.
    /// @dev Returns SHARES, not assets — EIP-4626 requires `withdraw` to return
    ///      the shares burned, while its counterpart {redeem} returns the assets
    ///      delivered. `_redeemShares` returns ASSETS (it tail-calls `_unwrap`,
    ///      whose return is `okuMReturned`), so its result is deliberately
    ///      discarded here rather than returned.
    ///
    ///      This previously read `return _redeemShares(...)`, which silently
    ///      overwrote the named `shares` return with the OkuM amount — so
    ///      `withdraw` returned approximately its own `assets` input instead of
    ///      `previewWithdraw(assets)`. At a multiplier of 1.33 that is ~25% off.
    ///      No funds were ever at risk (the `Withdraw` event payload and all
    ///      share accounting were correct); it was a wrong ABI return value that
    ///      would mislead any integrating contract. The sibling entry points
    ///      ({deposit}, {mint}, {redeem}) were and remain correct.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        _redeemShares(shares, receiver, owner);
        return shares;
    }

    /// @notice Redeem `shares` dollars of UsdOku from `owner` for OkuM to `receiver`.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256)
    {
        return _redeemShares(shares, receiver, owner);
    }

    /// @dev Shared 4626 withdraw/redeem path, guarded by the caller (`withdraw` /
    ///      `redeem`). Spends `owner`'s allowance when acting on their behalf, then
    ///      burns directly from `owner` via {_unwrap} — see that function's NatSpec
    ///      for why this avoids the prior floor-vs-ceil share mismatch.
    function _redeemShares(
        uint256 shares,
        address receiver,
        address owner
    )
        internal
        returns (uint256 assets)
    {
        if (owner != _msgSender()) {
            _spendAllowance(owner, _msgSender(), shares);
        }
        return _unwrap(owner, shares, receiver);
    }

    // ============ Reserves & Donation Rescue ============

    /// @notice Total OkuMoney tokens held as backing.
    /// @dev Doubles as ERC-4626 `totalAssets()`.
    function totalOkuMReserves() public view returns (uint256) {
        return IERC20(address(_getOkuDollarStorage().okuMoney)).balanceOf(address(this));
    }

    /// @notice Total UsdOku obligations, in dollar terms.
    function totalUsdObligations() public view returns (uint256) {
        return totalSupply();
    }

    /// @notice Rescue OkuM donated directly to the vault.
    /// @param amount Raw OkuM to withdraw.
    /// @param receiver Recipient of the rescued tokens.
    /// @dev Under the single-multiplier design, conversions use `m` rather than
    ///      `totalAssets/totalSupply`. That makes the vault structurally immune to
    ///      the ERC-4626 inflation attack, but the corollary is that a direct OkuM
    ///      transfer to this contract accrues to NOBODY — it would otherwise be
    ///      locked forever. This is the escape hatch.
    ///
    ///      Cannot touch backing: `totalUsdShares` is the OkuM required to honour
    ///      every outstanding share (shares track raw OkuM 1:1), so anything above
    ///      that balance is donation surplus.
    ///
    ///      NOTE (deferred): the 1:1 identity is exact only while `wrap`/`unwrap` are
    ///      the sole mutators. `unwrap` ceils `sharesToBurn` while flooring
    ///      `okuMReturned`, so each unwrap can leave reserves up to 1 wei ABOVE
    ///      `totalUsdShares`. That dust is classified as rescuable donation here.
    ///      Directionally safe (favours the protocol, and the rescuer is trusted),
    ///      but the accounting is 1-wei-per-unwrap optimistic rather than exact.
    function rescueDonation(
        uint256 amount,
        address receiver
    )
        external
        nonReentrant
        onlyRole(Roles.VAULT_RESCUER)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 backing = $.totalUsdShares;
        uint256 held = totalOkuMReserves();
        if (held <= backing) revert NoDonationAvailable();

        uint256 available;
        unchecked {
            available = held - backing;
        }
        if (amount > available) revert NoDonationAvailable();

        IERC20(address($.okuMoney)).safeTransfer(receiver, amount);
        emit DonationRescued(receiver, amount);
    }

    // ============ Blacklist (Works While Paused) ============
    // Reuses the OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role *hashes* so the same
    // role name spans both OkuMoney and OkuDollar — regulatory enforcement is
    // cross-token by design. Note that AccessControl mappings are per-contract,
    // so the role must still be granted on OkuMoney AND OkuDollar separately
    // (handled by initialize() below and by deploy/grantRoles scripts).

    /// @notice Add `account` to the OkuDollar blacklist.
    /// @dev Blacklisted accounts cannot send or receive UsdOku (wrap, unwrap, transfer, transferFrom).
    ///      Reuses the OKUM_BLACKLISTER role hash so the role name spans both tokens;
    ///      the grant itself is per-contract (see header comment above).
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the OkuDollar blacklist.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause the vault (blocks wrap, unwrap, transfers, and reserve management).
    function pause() external onlyRole(Roles.VAULT_PAUSER) {
        _pause();
    }

    /// @notice Unpause the vault.
    function unpause() external onlyRole(Roles.VAULT_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.VAULT_UPGRADER) {}
}
