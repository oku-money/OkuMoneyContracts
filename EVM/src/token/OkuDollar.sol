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
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {IScaledUIAmount} from "../interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title OkuDollar
 * @notice rUSDOku — a yield-bearing, dollar-denominated token backed by US T-Bills.
 *
 * @dev **One token. One multiplier. Fixed raw balances.**
 *
 *      A standard, non-rebasing ERC-20. Raw balances move only on transfer, mint
 *      and burn. Yield accrues in a single UI multiplier that grows continuously
 *      with elapsed time; a holding's dollar value is
 *      `rawBalance * uiMultiplier() / 1e18`.
 *
 *      Same construction as Solana's Token-2022 `ScaledUiAmount` extension, which
 *      ERC-8056 standardizes for EVM.
 *
 *      THREE LAYERS:
 *        - ERC-20     — raw, stock OpenZeppelin. The accounting layer.
 *        - ERC-4626   — conversion views only. The value layer, what protocols price against.
 *        - ERC-8056   — the display layer, what humans see.
 *
 *      NOT ERC-4626 COMPLIANT, and `supportsInterface` does not claim to be.
 *      `deposit`/`mint`/`withdraw`/`redeem` are absent: subscription and
 *      redemption run through `LitePSM` and may queue rather than settle. A
 *      `deposit()` that reverted for everyone would be worse than an absent one,
 *      because integrators detect the interface and assume it works. Redemption
 *      capacity is exposed on the PSM (`redeemableNow()`), where it lives.
 *
 *      VALUE LAYER IS COARSER THAN THE DISPLAY LAYER, BY CONSTRUCTION.
 *      `convertToAssets` returns USDC (6 dp) per ERC-4626 semantics, while
 *      `uiMultiplier()` is 18 dp. They are related by a floor, not an equality:
 *
 *        convertToAssets(1e18) * usdcDecimalMultiplier
 *            <= uiMultiplier()
 *            <  (convertToAssets(1e18) + 1) * usdcDecimalMultiplier
 *
 *      `convertToAssets` and `convertToShares` are therefore NOT inverses — a
 *      round trip quantizes to USDC granularity, losing up to `1e12` in 18-dp
 *      terms. Fine for a lending market; written down here rather than discovered.
 *
 *      HARD RULE: the multiplier is an input to *pricing*, never to *accounting*.
 *      Every ledger in the system is denominated in raw units.
 *
 *      Storage uses ERC-7201 namespaced storage. See https://eips.ethereum.org/EIPS/eip-7201
 */
contract OkuDollar is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ScaledUIAmountUpgradeable,
    IOkuDollar
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollarV2
    struct OkuDollarStorage {
        /// @dev USDC on this chain. Single source of truth — the PSM and queue
        ///      assert against this at `initialize` rather than deriving their own.
        address asset;
        /// @dev `10 ** (18 - usdcDecimals)`. `1e12` for Circle USDC.
        uint256 usdcDecimalMultiplier;
        /// @dev Per-minter cap, decremented on `mint` (Circle FiatToken pattern).
        mapping(address => uint256) minterAllowance;
        /// @dev Global supply cap in raw units. Bounded by `MAX_TOTAL_SUPPLY`.
        uint256 maxSupply;
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollarV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x6befa17dca3cfb17c3f7e06c05462b39c1519ffa5ecf80eb3bf9bf86626ce300;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
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

    // ============ Events ============

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

    /// @notice Initialize the OkuDollar proxy.
    /// @param name_ ERC-20 name (canonical: "Oku Dollar").
    /// @param symbol_ ERC-20 symbol (canonical: "rUSDOku").
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

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.asset = _asset;

        uint8 assetDecimals = IERC20Metadata(_asset).decimals();
        if (assetDecimals > Constants.MAX_USDC_DECIMALS) {
            revert AssetDecimalsTooLarge(assetDecimals);
        }
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(assetDecimals));

        $.maxSupply = initialMaxSupply;

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
    ///      Limitation 7.
    function allowanceUI(address owner, address spender) external view returns (uint256) {
        return MathLib.toUiAmount(allowance(owner, spender), uiMultiplier());
    }

    // ============ ERC-4626 conversion subset (value layer) ============

    /// @inheritdoc IOkuDollar
    function asset() external view returns (address) {
        return _getOkuDollarStorage().asset;
    }

    /// @inheritdoc IOkuDollar
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getOkuDollarStorage().usdcDecimalMultiplier;
    }

    /// @notice Asset-denominated value of `shares` raw tokens. Floors.
    /// @dev Returns USDC native decimals (6), per ERC-4626 semantics. Not the
    ///      inverse of `convertToShares` — see contract NatSpec.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return MathLib.dollarsToUsdc(
            MathLib.toUiAmount(shares, uiMultiplier()), _getOkuDollarStorage().usdcDecimalMultiplier
        );
    }

    /// @notice Raw tokens corresponding to `assets` USDC. Floors.
    function convertToShares(uint256 assets) public view returns (uint256) {
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars(assets, _getOkuDollarStorage().usdcDecimalMultiplier),
            uiMultiplier()
        );
    }

    /// @notice Asset-denominated value of the entire supply.
    /// @dev Derived from the multiplier, not measured. There is no on-chain
    ///      referent for off-chain T-Bill backing; the value interface is exactly
    ///      as trustworthy as the multiplier authority. README Limitation 2.
    function totalAssets() external view returns (uint256) {
        return convertToAssets(totalSupply());
    }

    // ============ Storage accessors ============

    /// @notice Remaining minter allowance for `minter_`, in raw units.
    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuDollarStorage().minterAllowance[minter_];
    }

    /// @notice Global supply cap in raw units.
    function maxSupply() external view returns (uint256) {
        return _getOkuDollarStorage().maxSupply;
    }

    /// @notice Whether `account` is blacklisted.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuDollarStorage().isBlacklisted[account];
    }

    // ============ Rate management ============

    /// @notice Set the continuous accrual rate and its halt boundary.
    /// @param ratePerSecond_ Compound per-second rate (`1e18` == no yield).
    /// @param endTimestamp Accrual halts here. Mandatory, strictly future,
    ///        within `MAX_RATE_DURATION`.
    /// @dev Re-anchors `baseMultiplier` to the live value first, so calling this
    ///      before `rateEnd` extends accrual with no gap and no step.
    ///
    ///      NOT pause-gated, by design: an operator may need to zero the rate
    ///      during an incident response, and pausing this setter would defeat
    ///      that. The companion emergency lever `haltAccrual` is likewise
    ///      ungated.
    ///
    ///      This is an ORACLE WRITE. The moment a lending market prices off
    ///      `uiMultiplier()`, a wrong value mints borrowing power directly, and
    ///      `totalAssets()` is derived from the multiplier rather than measured,
    ///      so it is not an independent check. Bounded by `MAX_IMPLIED_APR`,
    ///      `MAX_RATE_DURATION`, monotonicity and `MAX_MULTIPLIER`.
    function setYieldRate(
        uint256 ratePerSecond_,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKU_RATE_SETTER)
    {
        _setYieldRate(ratePerSecond_, endTimestamp);
    }

    /// @notice Freeze the multiplier at its current value, immediately.
    /// @dev No timelock — this is the guardian's emergency lever against a
    ///      compromised rate setter. Monotone-safe: stops growth without
    ///      reducing anything already accrued. Not pause-gated.
    function haltAccrual() external onlyRole(Roles.OKU_GUARDIAN) {
        _haltAccrual();
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
        OkuDollarStorage storage $ = _getOkuDollarStorage();

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
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Mint / burn ============

    /// @inheritdoc IOkuDollar
    /// @dev Minting `amount` raw at `uiMultiplier() = 1.05e18` creates $1.05*amount
    ///      of displayed value. The PSM handles the USDC conversion.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKU_MINTER) whenNotPaused {
        OkuDollarStorage storage $ = _getOkuDollarStorage();

        uint256 cap = $.maxSupply;
        if (totalSupply() + amount > cap) revert ExceedsSupplyCap(totalSupply() + amount, cap);

        uint256 available = $.minterAllowance[msg.sender];
        if (available < amount) revert ExceedsAllowance(amount, available);

        // Effects before interactions: debit the allowance before minting.
        $.minterAllowance[msg.sender] = available - amount;

        _mint(to, amount);
    }

    /// @inheritdoc IOkuDollar
    /// @dev Burns the caller's own balance. Allowed while paused. Burning does
    ///      NOT restore minter allowance.
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
        OkuDollarStorage storage $ = _getOkuDollarStorage();
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
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (works while paused) ============

    /// @notice Add `account` to the blacklist. Works while paused.
    function blacklist(address account) external onlyRole(Roles.OKU_BLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist. Works while paused.
    function unblacklist(address account) external onlyRole(Roles.OKU_UNBLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
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
