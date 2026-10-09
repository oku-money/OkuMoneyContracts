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
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {OkuMoneyErrors} from "../lib/errors/OkuMoneyErrors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OverrideBlockGuard} from "../lib/OverrideBlockGuard.sol";
import {OkuDollarEvents} from "../lib/events/OkuDollarEvents.sol";
import {OkuDollarErrors} from "../lib/errors/OkuDollarErrors.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";

/**
 * @title OkuDollar
 * @notice Rebasing $1-pegged stablecoin (ticker `UsdOku`) wrapping OkuMoney.
 * @dev SINGLE MULTIPLIER: `usdMultiplier()` is exactly `okuMoney.okuMMultiplier()`; see
 *      README § Dual-Token Shared-Multiplier Model. Does not inherit `ERC4626Upgradeable` (see "ERC-4626 Surface").
 *
 *      TERMINOLOGY HAZARD: internal `usdShares` (non-rebasing accounting unit) are NOT
 *      ERC-4626 "shares" (the rebasing displayed balance); `convertToShares` returns the latter.
 *
 *      See Constants.sol for the terminology legend and {OkuMoney.initialize} for role
 *      policy. Storage is ERC-7201 namespaced.
 */
contract OkuDollar is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    OverrideBlockGuard,
    UUPSUpgradeable,
    OkuDollarEvents,
    OkuDollarErrors,
    IOkuDollar,
    IERC4626
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollar
    struct OkuDollarStorage {
        // The backing token; set once in `initialize`.
        IOkuMoney okuMoney;
        // Internal accounting units, NOT ERC-4626 "shares" (see contract NatSpec);
        // numerically equal to raw OkuM deposited.
        mapping(address => uint256) usdShares;
        // Sum of every `usdShares` entry = the OkuM that backs all UsdOku. Anything the
        // vault holds above this is a donation (see `rescueDonation`).
        uint256 totalUsdShares;
        // Separate from OkuMoney's list; a blacklisted address cannot hold or move UsdOku.
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollar")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the OkuDollar proxy.
    /// @param _okuMoney OkuMoney token address (backing reserve asset).
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol (canonical ticker is `usdOku`).
    /// @param _admin Receives every role; see {OkuMoney.initialize}.
    function initialize(
        address _okuMoney,
        string memory name_,
        string memory symbol_,
        address _admin
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert OkuMoneyErrors.ZeroAddress();
        if (_admin == address(0)) revert OkuMoneyErrors.ZeroAddress();

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
        // Same role hashes as OkuMoney, but granted per contract.
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
    }

    // ============ ERC-20 Metadata ============

    /// @notice Fixed at {Constants.OKU_M_DECIMALS} (18), matching {OkuMoney.decimals}; no
    ///         decimals offset against `asset()`.
    function decimals() public pure override(ERC20Upgradeable, IERC20Metadata) returns (uint8) {
        return Constants.OKU_M_DECIMALS;
    }

    // ============ Storage Accessor Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    /// @notice Total internal share tokens across all holders.
    /// @dev NOT the ERC-4626 `totalSupply()`; equals the raw OkuM held as reserves.
    function totalUsdShares() external view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    /// @notice Internal share balance for `account`.
    function usdSharesOf(address account) external view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    /// @notice Whether `account` is blocked here: on the OkuDollar list or on OkuMoney's.
    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted(account);
    }

    /// @dev Blocked on either list. OkuDollar honours OkuMoney's blacklist (an external
    ///      read) so a single OkuMoney blacklisting also freezes the address's UsdOku.
    function _blacklisted(address account) internal view returns (bool) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        return $.isBlacklisted[account] || $.okuMoney.isBlacklisted(account);
    }

    // ============ USD Multiplier (Delegated to OkuMoney) ============

    /// @notice Dollar value per UsdOku share, 1e18 = $1.00.
    /// @dev Exactly `okuMoney.okuMMultiplier()`; no rate state of its own, so OkuM and
    ///      UsdOku cannot diverge.
    function usdMultiplier() public view returns (uint256) {
        return _getOkuDollarStorage().okuMoney.okuMMultiplier();
    }

    // ============ ERC20 Overrides (USD Share-based) ============
    // Balances are stored as shares and reported in dollars, so they grow as the
    // multiplier grows without any transfer (a rebasing token).

    /// @notice Total UsdOku in dollars: all shares at the current multiplier, rounded down.
    /// @dev Can exceed the sum of `balanceOf` by < 1 wei per holder (each floors separately).
    function totalSupply()
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return _toDollars(_getOkuDollarStorage().totalUsdShares, usdMultiplier());
    }

    /// @notice `account`'s UsdOku in dollars: its shares at the current multiplier,
    ///         rounded down. Grows over time with no transfer.
    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return _toDollars(_getOkuDollarStorage().usdShares[account], usdMultiplier());
    }

    /// @notice Send `amount` dollars of UsdOku. Moves the equivalent shares, rounded down,
    ///         so the recipient may receive up to 1 wei less than `amount`.
    /// @dev Pause-gated; both sides are blacklist-checked in `_transferUsdShares`. Reverts
    ///      `AmountTooSmall` if a non-zero `amount` is worth zero shares.
    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        returns (bool)
    {
        _transferDollars(msg.sender, to, amount);
        return true;
    }

    /// @dev Allowance is debited by `amount` while at most `amount` dollars move (shares
    ///      floor), so the <=1 wei gap is consumed from the allowance, in the protocol's
    ///      favor. Also checks the spender (as Circle FiatToken), which `_transferUsdShares`
    ///      cannot see; an existing allowance survives blacklisting.
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
        if (_blacklisted(_msgSender())) revert OkuMoneyErrors.SenderBlacklisted();
        _spendAllowance(from, msg.sender, amount);
        _transferDollars(from, to, amount);
        return true;
    }

    /// @dev `Transfer.value` is the post-rounding dollar amount and advisory only: balances
    ///      floor per account, so read `balanceOf`. Likewise `totalSupply() >= sum(balanceOf)`
    ///      (gap < holders wei); invariants must use `>=`.
    function _transferDollars(address from, address to, uint256 amount) private {
        uint256 multiplier = usdMultiplier();
        uint256 shares = _toShares(amount, multiplier);
        // A nonzero `amount` flooring to zero shares would move nothing yet emit Transfer.
        if (amount != 0 && shares == 0) revert OkuMoneyErrors.AmountTooSmall();
        _transferUsdShares(from, to, shares, multiplier);
        emit Transfer(from, to, _toDollars(shares, multiplier));
    }

    /// @dev `multiplier` is passed in to avoid a second cross-contract `okuMMultiplier()` read.
    function _transferUsdShares(
        address from,
        address to,
        uint256 shares,
        uint256 multiplier
    )
        internal
    {
        if (from == address(0)) revert OkuMoneyErrors.ZeroAddress();
        if (to == address(0)) revert OkuMoneyErrors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if (_blacklisted(from)) revert OkuMoneyErrors.SenderBlacklisted();
        if (_blacklisted(to)) revert OkuMoneyErrors.RecipientBlacklisted();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert OkuMoneyErrors.InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        emit TransferValue(from, to, shares, _toDollars(shares, multiplier));
    }

    /// @dev Floor conversions between internal shares and dollars at `multiplier`.
    function _toShares(uint256 amount, uint256 multiplier) private pure returns (uint256) {
        return Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
    }

    /// @dev See {_toShares}.
    function _toDollars(uint256 shares, uint256 multiplier) private pure returns (uint256) {
        return Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
    }

    // ============ Allowances, Permit and Nonces ============
    // Use OZ's inherited storage unchanged: allowances are dollar-denominated like
    // `transfer`'s `amount`, so unlike balances they need no share conversion. Only
    // `permit` and `approve` are overridden, to add the blacklist gate.

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @notice EIP-2612 permit with blacklist enforcement.
    /// @dev `value` is in dollars but balances are shares, and `transferFrom` floors the
    ///      share conversion: when `usdMultiplier > 1e18`, repeated `transferFrom` against one
    ///      allowance may under-consume ~1 share per call; integrators should budget for that
    ///      dust. Not pause-gated.
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
        if (_blacklisted(owner)) revert OkuMoneyErrors.SenderBlacklisted();
        if (_blacklisted(spender)) revert OkuMoneyErrors.RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    /// @dev Blocks a blacklisted owner or spender from creating allowances (as Circle
    ///      FiatToken). Existing allowances are not revoked; {transferFrom} blocks their use.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        if (_blacklisted(_msgSender())) revert OkuMoneyErrors.SenderBlacklisted();
        if (_blacklisted(spender)) revert OkuMoneyErrors.RecipientBlacklisted();
        return super.approve(spender, value);
    }

    // ============ Inherited ERC20 guard ============

    /// @dev Tripwire: supply changes go through `wrap`/`unwrap` and moves through
    ///      `transfer`/`transferFrom`, so the inherited `_balances` (never read by
    ///      `balanceOf`) must stay untouched. Reverts unconditionally.
    function _update(address from, address to, uint256) internal pure override {
        if (from == address(0)) revert UseWrapInstead();
        if (to == address(0)) revert UseUnwrapInstead();
        revert OkuDollarDoesNotUseInternalUpdate();
    }

    // ============ Override-Block Guard Hook ============

    /// @inheritdoc OverrideBlockGuard
    function _overrideBlockOkuMoney() internal view override returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /// @notice Wrap OkuMoney into OkuDollar.
    /// @dev usdMinted = okuMAmount * multiplier / PRECISION; shares minted equal the OkuM received.
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
        whenNoOverrideThisBlock
        returns (uint256 usdMinted)
    {
        if (okuMAmount == 0) revert OkuMoneyErrors.ZeroAmount();
        if (receiver == address(0)) revert OkuMoneyErrors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if (_blacklisted(msg.sender)) revert OkuMoneyErrors.SenderBlacklisted();
        if (_blacklisted(receiver)) revert OkuMoneyErrors.RecipientBlacklisted();

        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;

        // Shares track raw OkuM 1:1 because `usdMultiplier()` delegates to `okuMMultiplier()`.
        uint256 multiplier = $.okuMoney.okuMMultiplier();
        if (actualReceived == 0) revert OkuMoneyErrors.AmountTooSmall();

        // Dollars minted = OkuM received at the current multiplier; enforce the caller's
        // minimum.
        usdMinted = MathLib.okuMToDollars(actualReceived, multiplier);
        if (usdMinted < minAmountOut) revert OutputBelowMinimum(usdMinted, minAmountOut);

        // Credit the receiver one share per raw OkuM received.
        $.totalUsdShares += actualReceived;
        $.usdShares[receiver] += actualReceived;

        // ERC-20 `Transfer` (mint, in dollars), our share-level `TransferValue`, the
        // protocol `Wrapped`, and ERC-4626 `Deposit`: each audience has its own event.
        emit Transfer(address(0), receiver, usdMinted);
        emit TransferValue(address(0), receiver, actualReceived, usdMinted);
        emit Wrapped(msg.sender, receiver, actualReceived, usdMinted, multiplier);
        emit Deposit(msg.sender, receiver, actualReceived, usdMinted);
    }

    /// @notice Unwrap OkuDollar back to OkuMoney.
    /// @dev okuMReturned = floor(usdAmount * PRECISION / multiplier); shares burned use the
    ///      same ratio rounded UP, favouring the vault.
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
        whenNoOverrideThisBlock
        returns (uint256 okuMReturned)
    {
        return _unwrap(msg.sender, usdAmount, receiver);
    }

    /// @dev Shared core for {unwrap} and the ERC-4626 {withdraw}/{redeem}. `owner`'s shares
    ///      are burned; `_msgSender()` only populates the `Withdraw` event's `sender`.
    function _unwrap(
        address owner,
        uint256 usdAmount,
        address receiver
    )
        internal
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert OkuMoneyErrors.ZeroAmount();
        if (receiver == address(0)) revert OkuMoneyErrors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        // Receiver too: stops a user blacklisted only on OkuDollar from routing OkuM onward.
        if (_blacklisted(owner)) revert OkuMoneyErrors.SenderBlacklisted();
        if (_blacklisted(receiver)) revert OkuMoneyErrors.RecipientBlacklisted();

        // Floor on OkuM returned, ceil on shares burned: both favor the vault.
        uint256 multiplier = $.okuMoney.okuMMultiplier();
        okuMReturned = _toShares(usdAmount, multiplier);
        uint256 sharesToBurn =
            Math.mulDiv(usdAmount, Constants.PRECISION, multiplier, Math.Rounding.Ceil);
        if ($.usdShares[owner] < sharesToBurn) revert OkuMoneyErrors.InsufficientBalance();

        // Defensive: reserves back every share, so this should never fire.
        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        // Burn the shares before sending OkuM (checks-effects-interactions).
        $.totalUsdShares -= sharesToBurn;
        $.usdShares[owner] -= sharesToBurn;

        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        // Same four audiences as `wrap`. `Transfer.value` is the dollar amount requested.
        emit Transfer(owner, address(0), usdAmount);
        emit TransferValue(owner, address(0), sharesToBurn, usdAmount);
        emit Unwrapped(owner, receiver, usdAmount, okuMReturned, multiplier);
        emit Withdraw(_msgSender(), receiver, owner, okuMReturned, usdAmount);
    }

    // ============ ERC-4626 Surface ============
    // OkuM = `asset`, UsdOku = `shares`. Not OZ's ERC4626Upgradeable: its conversions assume
    // a static share balance with a floating ratio, whereas UsdOku rebases at a pinned $1.
    // Conversions use the multiplier directly, which makes the vault immune to the 4626
    // inflation attack.

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

    /// @dev Zero while this vault or OkuMoney is paused, or when `receiver` is blacklisted
    ///      (`wrap` would revert).
    function maxDeposit(address receiver) public view returns (uint256) {
        if (_wrapHalted() || _blacklisted(receiver)) return 0;
        return type(uint256).max;
    }

    /// @dev Same `0` / `type(uint256).max` sentinels as {maxDeposit}, valid in either unit.
    function maxMint(address receiver) public view returns (uint256) {
        return maxDeposit(receiver);
    }

    /// @dev OkuM equivalent of the balance (the spec wants assets); zero in the same cases as
    ///      {maxDeposit} for `owner`. `whenNoOverrideThisBlock` is deliberately not modelled
    ///      (one-block window on the emergency override); {maxDeposit} omits it too.
    function maxWithdraw(address owner) public view returns (uint256) {
        if (_wrapHalted() || _blacklisted(owner)) return 0;
        return convertToAssets(balanceOf(owner));
    }

    /// @dev See {maxWithdraw}; share units.
    function maxRedeem(address owner) public view returns (uint256) {
        if (_wrapHalted() || _blacklisted(owner)) return 0;
        return balanceOf(owner);
    }

    /// @dev Either pause stops wrap/unwrap: OkuMoney's blocks the OkuM transfer leg.
    function _wrapHalted() private view returns (bool) {
        return paused() || _getOkuDollarStorage().okuMoney.paused();
    }

    /// @notice Dollars of UsdOku `deposit(assets)` would mint now (= {convertToShares}).
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

    /// @notice OkuM `redeem(shares)` would return now (= {convertToAssets}).
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    /// @notice Deposit `assets` OkuM, minting UsdOku to `receiver`.
    /// @param assets   OkuM to deposit (18 decimals).
    /// @param receiver Address credited with the UsdOku.
    /// @return Dollars of UsdOku minted.
    /// @dev Alias for {wrap} with `minAmountOut == 0`; prefer {wrap}. Carries no modifiers:
    ///      `wrap` already enforces them, and `nonReentrant` here would re-enter its guard.
    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return wrap(assets, receiver, 0);
    }

    /// @notice Mint `shares` dollars of UsdOku to `receiver`.
    /// @dev See {deposit}; no modifiers here either.
    /// @param shares   Dollars of UsdOku wanted.
    /// @param receiver Address credited with the UsdOku.
    /// @return OkuM pulled from the caller ({previewMint}, rounded up).
    function mint(uint256 shares, address receiver) external returns (uint256) {
        uint256 assets = previewMint(shares);
        wrap(assets, receiver, 0);
        return assets;
    }

    /// @notice Withdraw `assets` OkuM to `receiver`, burning `owner`'s UsdOku.
    /// @param assets   OkuM to receive (18 decimals).
    /// @param receiver Recipient of the OkuM.
    /// @param owner    Holder whose UsdOku is burned; a different caller spends `owner`'s
    ///                 allowance.
    /// @return shares The number of UsdOku shares burned.
    /// @dev Returns SHARES burned, per EIP-4626; `_redeemShares` returns assets, discarded here.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        _redeemShares(shares, receiver, owner);
        return shares;
    }

    /// @notice Redeem `shares` dollars of UsdOku from `owner` for OkuM to `receiver`.
    /// @param shares   Dollars of UsdOku to burn.
    /// @param receiver Recipient of the OkuM.
    /// @param owner    Holder whose UsdOku is burned; a different caller spends `owner`'s
    ///                 allowance.
    /// @return OkuM sent to `receiver`.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256)
    {
        return _redeemShares(shares, receiver, owner);
    }

    /// @dev Shared 4626 withdraw/redeem path. Acting for another owner also checks the
    ///      caller's blacklist status (see {transferFrom}) and spends allowance.
    function _redeemShares(
        uint256 shares,
        address receiver,
        address owner
    )
        internal
        returns (uint256 assets)
    {
        if (owner != _msgSender()) {
            if (_blacklisted(_msgSender())) revert OkuMoneyErrors.SenderBlacklisted();
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
    /// @dev Conversions use the multiplier, not totalAssets/totalSupply, so a direct OkuM
    ///      transfer accrues to nobody; this is the escape hatch. Backing is `totalUsdShares`
    ///      (shares track raw OkuM 1:1), so only the surplus above it is rescuable. Each
    ///      unwrap can leave up to 1 wei above backing (ceil shares, floor OkuM), which counts
    ///      as rescuable donation: favors the protocol.
    function rescueDonation(
        uint256 amount,
        address receiver
    )
        external
        nonReentrant
        onlyRole(Roles.VAULT_RESCUER)
    {
        if (amount == 0) revert OkuMoneyErrors.ZeroAmount();
        if (receiver == address(0)) revert OkuMoneyErrors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        // Only the surplus above what backs outstanding shares can leave.
        uint256 backing = $.totalUsdShares;
        uint256 held = totalOkuMReserves();
        if (held <= backing) revert NoDonationAvailable();

        // Safe: `held > backing` was just checked.
        uint256 available;
        unchecked {
            available = held - backing;
        }
        if (amount > available) revert NoDonationAvailable();

        IERC20(address($.okuMoney)).safeTransfer(receiver, amount);
        emit DonationRescued(receiver, amount);
    }

    // ============ Blacklist (Works While Paused) ============
    // Same OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role hashes as OkuMoney, but AccessControl
    // is per-contract: grant them on each.

    /// @notice Add `account` to the OkuDollar blacklist.
    /// @dev Blacklisted accounts cannot send or receive UsdOku.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[account]) revert OkuMoneyErrors.AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the OkuDollar blacklist.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if (!$.isBlacklisted[account]) revert OkuMoneyErrors.NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause wrap, unwrap, ERC-4626 entry/exit and transfers. Approvals, blacklist
    ///         changes and {rescueDonation} still work.
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
