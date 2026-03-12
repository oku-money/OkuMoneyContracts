// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {MathLib} from "../lib/MathLib.sol";

/**
 * @title OkuDollar
 * @notice Rebasing $1-pegged stablecoin with independent yield rate, backed by OkuMoney reserves
 * @dev NOT an ERC-4626 vault. Custom rebasing token with its own shares/multiplier.
 *      Holds OkuMoney as reserves. Independent yield rate enables revenue extraction
 *      (OkuM rate > USD rate) or forward-facing yield (USD rate > OkuM rate).
 *
 *      Wrap/unwrap are price-aware: they use okuMPrice() and usdMultiplier() to convert
 *      between OkuMoney token amounts and OkuDollar amounts at their respective dollar values.
 *
 *      Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract OkuDollar is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollar
    struct OkuDollarStorage {
        IOkuMoney okuMoney;
        // USD rebasing mechanism (mirrors OkuMoney pattern)
        mapping(address => uint256) usdShares;
        uint256 totalUsdShares;
        uint256 usdBaseMultiplier;
        uint256 usdRatePerSecond;
        uint256 usdLastAccrualTime;
        uint256 usdRateEnd;
        uint256 usdPendingRatePerSecond;
        // Collateralization
        uint256 minCollateralRatio;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollar")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x2c8d9f0a3e4b5c6d7a8f9e0d1c2b3a4e5f6d7c8b9a0e1f2d3c4b5a6e7f8d9c00;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
        }
    }

    // ============ Role Constants (from shared library) ============

    bytes32 public constant VAULT_UPGRADER = Roles.VAULT_UPGRADER;
    bytes32 public constant VAULT_REBASER = Roles.VAULT_REBASER;
    bytes32 public constant VAULT_RESERVE_MANAGER = Roles.VAULT_RESERVE_MANAGER;
    bytes32 public constant VAULT_PAUSER = Roles.VAULT_PAUSER;
    bytes32 public constant VAULT_UNPAUSER = Roles.VAULT_UNPAUSER;

    // ============ Constants (from shared library) ============

    uint256 public constant PRECISION = Constants.PRECISION;
    uint256 public constant MAX_RATE = Constants.MAX_RATE;

    // ============ Events ============

    event UsdRebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event UsdYieldRateUpdated(
        uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextUsdYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event ReservesDeposited(address indexed depositor, uint256 okuMAmount);
    event SurplusWithdrawn(address indexed to, uint256 okuMAmount);

    // ============ Custom Errors ============

    error ZeroAddress();
    error RatioExceedsMax();
    error ZeroAmount();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    error InsufficientCollateral();
    error BelowMinimumCollateral();
    error InvalidRate();
    error RateTooHigh();
    error EndTimestampInPast();
    error NoRateEndSet();
    error MultiplierCannotDecrease();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuMoney,
        string memory name,
        string memory symbol,
        address admin,
        uint256 _minCollateralRatio
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (_minCollateralRatio > PRECISION) revert RatioExceedsMax();

        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.minCollateralRatio = _minCollateralRatio;
        $.usdBaseMultiplier = PRECISION;
        $.usdRatePerSecond = PRECISION;
        $.usdLastAccrualTime = block.timestamp;
        $.usdPendingRatePerSecond = PRECISION;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_UPGRADER, admin);
        _grantRole(VAULT_PAUSER, admin);
        _grantRole(VAULT_UNPAUSER, admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    function usdRatePerSecond() public view returns (uint256) {
        return _getOkuDollarStorage().usdRatePerSecond;
    }

    function usdLastAccrualTime() public view returns (uint256) {
        return _getOkuDollarStorage().usdLastAccrualTime;
    }

    function usdRateEnd() public view returns (uint256) {
        return _getOkuDollarStorage().usdRateEnd;
    }

    function usdPendingRatePerSecond() public view returns (uint256) {
        return _getOkuDollarStorage().usdPendingRatePerSecond;
    }

    function minCollateralRatio() public view returns (uint256) {
        return _getOkuDollarStorage().minCollateralRatio;
    }

    function totalUsdShares() public view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    function usdSharesOf(address account) public view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    function usdBaseMultiplier() public view returns (uint256) {
        return _getOkuDollarStorage().usdBaseMultiplier;
    }

    // ============ USD Multiplier (Continuous Accrual) ============

    /**
     * @notice Computed USD multiplier with continuous yield accrual
     * @dev Same MathLib.rpow pattern as OkuMoney.okuMPrice()
     */
    function usdMultiplier() public view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 rate = $.usdRatePerSecond;

        if (rate <= PRECISION) {
            if ($.usdRateEnd != 0 && block.timestamp > $.usdRateEnd) {
                uint256 pendingRate = $.usdPendingRatePerSecond;
                if (pendingRate > PRECISION) {
                    uint256 elapsedPending = block.timestamp - $.usdRateEnd;
                    return ($.usdBaseMultiplier
                            * MathLib.rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return $.usdBaseMultiplier;
        }

        uint256 base = $.usdBaseMultiplier;

        if ($.usdRateEnd != 0 && block.timestamp > $.usdRateEnd) {
            uint256 elapsedCurrent = $.usdRateEnd - $.usdLastAccrualTime;
            if (elapsedCurrent > 0) {
                base = (base * MathLib.rpow(rate, elapsedCurrent, PRECISION)) / PRECISION;
            }
            uint256 pendingRate = $.usdPendingRatePerSecond;
            if (pendingRate > PRECISION) {
                uint256 elapsedPending = block.timestamp - $.usdRateEnd;
                if (elapsedPending > 0) {
                    base = (base * MathLib.rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return base;
        }

        uint256 elapsed = block.timestamp - $.usdLastAccrualTime;
        if (elapsed == 0) return base;
        return (base * MathLib.rpow(rate, elapsed, PRECISION)) / PRECISION;
    }

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply() public view override returns (uint256) {
        return (_getOkuDollarStorage().totalUsdShares * usdMultiplier()) / PRECISION;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return (_getOkuDollarStorage().usdShares[account] * usdMultiplier()) / PRECISION;
    }

    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        uint256 shares = (amount * PRECISION) / usdMultiplier();
        _transferUsdShares(msg.sender, to, shares);
        // Emit the caller-specified amount — not the share-reconverted value, which can
        // diverge by 1 wei due to integer truncation and confuse ERC-20 indexers.
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        uint256 shares = (amount * PRECISION) / usdMultiplier();
        _transferUsdShares(from, to, shares);
        // Emit the caller-specified amount — not the share-reconverted value.
        emit Transfer(from, to, amount);
        return true;
    }

    function _transferUsdShares(address from, address to, uint256 shares) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert InsufficientCollateral();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        // NOTE: Transfer event is emitted by the calling public function (transfer / transferFrom)
        // with the original token amount. Do not emit here to avoid double-emitting.
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /**
     * @notice Wrap OkuMoney into OkuDollar (price-aware)
     * @dev usdMinted = okuMAmount × okuMPrice() / usdMultiplier()
     *      100 OkuM tokens at okuMPrice=$1.05, usdMultiplier=1.0 → 105 usdOku.
     *      The OkuM dollar value is converted to OkuDollar at the current usdMultiplier.
     * @param okuMAmount Amount of OkuMoney tokens to wrap
     * @param receiver Address to receive OkuDollar
     * @param minAmountOut Minimum OkuDollar to receive (slippage protection)
     * @return usdMinted Amount of OkuDollar minted
     */
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        external
        whenNotPaused
        nonReentrant
        returns (uint256 usdMinted)
    {
        if (okuMAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();

        // Measure actual tokens received (handles fee-on-transfer edge cases)
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;

        // Price-aware: convert OkuM token value to OkuDollar shares
        // shares = actualReceived × okuMPrice / usdMultiplier
        uint256 price = $.okuMoney.okuMPrice();
        uint256 mult = usdMultiplier();
        uint256 sharesToMint = (actualReceived * price) / mult;
        if (sharesToMint == 0) revert AmountTooSmall();

        // Calculate dollar value for event (from shares × multiplier)
        usdMinted = (sharesToMint * mult) / PRECISION;

        // Slippage protection
        if (usdMinted < minAmountOut) {
            revert OutputBelowMinimum(usdMinted, minAmountOut);
        }

        $.totalUsdShares += sharesToMint;
        $.usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
    }

    /**
     * @notice Unwrap OkuDollar back to OkuMoney (price-aware)
     * @dev okuMReturned = usdAmount × usdMultiplier() / okuMPrice()
     *      105 usdOku at usdMultiplier=1.0, okuMPrice=$1.05 → 100 OkuM tokens.
     *      Reverts if vault holds insufficient OkuMoney.
     * @param usdAmount Amount of OkuDollar to unwrap
     * @param receiver Address to receive OkuMoney
     * @return okuMReturned Amount of OkuMoney tokens returned
     */
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        external
        whenNotPaused
        nonReentrant
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();

        // Price-aware: convert OkuDollar amount to OkuM token count
        // okuMReturned = usdAmount × usdMultiplier / okuMPrice
        uint256 mult = usdMultiplier();
        uint256 price = $.okuMoney.okuMPrice();
        okuMReturned = (usdAmount * mult) / price;

        // Calculate shares to burn
        uint256 sharesToBurn = (usdAmount * PRECISION) / mult;
        if ($.usdShares[msg.sender] < sharesToBurn) revert InsufficientCollateral();

        // Check vault has enough OkuMoney
        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        // Burn user's shares
        $.totalUsdShares -= sharesToBurn;
        $.usdShares[msg.sender] -= sharesToBurn;

        // Transfer OkuMoney to receiver
        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        emit Transfer(msg.sender, address(0), usdAmount);
    }

    // ============ Reserve Management ============

    /**
     * @notice Deposit OkuMoney without minting OkuDollar shares (top up reserves)
     * @dev Used when USD rate > OkuM rate (vault undercollateralized).
     *      Since OkuMoney is non-rebasing, OkuM tokens are NOT dollar-denominated —
     *      their value depends on okuMPrice().
     * @param okuMAmount Amount of OkuMoney tokens to deposit
     */
    function depositReserves(uint256 okuMAmount) external onlyRole(VAULT_RESERVE_MANAGER) {
        if (okuMAmount == 0) revert ZeroAmount();
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;
        emit ReservesDeposited(msg.sender, actualReceived);
    }

    /**
     * @notice Withdraw surplus OkuMoney without burning OkuDollar shares
     * @dev Used when USD rate < OkuM rate (vault overcollateralized).
     *      Enforces collateralizationRatio() >= minCollateralRatio AFTER withdrawal.
     * @param okuMAmount Amount of OkuMoney tokens to withdraw
     */
    function withdrawSurplus(uint256 okuMAmount) external onlyRole(VAULT_RESERVE_MANAGER) {
        if (okuMAmount == 0) revert ZeroAmount();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        IERC20(address($.okuMoney)).safeTransfer(msg.sender, okuMAmount);

        // Enforce collateralization floor AFTER withdrawal
        if (collateralizationRatio() < $.minCollateralRatio) revert BelowMinimumCollateral();

        emit SurplusWithdrawn(msg.sender, okuMAmount);
    }

    // ============ Admin ============

    function setMinCollateralRatio(uint256 newRatio) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRatio > PRECISION) revert RatioExceedsMax();
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 oldRatio = $.minCollateralRatio;
        $.minCollateralRatio = newRatio;
        emit MinCollateralRatioUpdated(oldRatio, newRatio);
    }

    // ============ Collateralization Views (Price-Aware) ============

    /**
     * @notice Total OkuMoney tokens held as reserves
     */
    function totalOkuMReserves() public view returns (uint256) {
        return IERC20(address(_getOkuDollarStorage().okuMoney)).balanceOf(address(this));
    }

    /**
     * @notice Total OkuDollar obligations (in dollar terms)
     */
    function totalUsdObligations() public view returns (uint256) {
        return totalSupply();
    }

    /**
     * @notice Price-aware collateralization ratio
     * @dev collateralizationRatio = (okuMBalance × okuMPrice / PRECISION) × PRECISION / totalSupply
     *      The numerator converts OkuM token count to dollar value via okuMPrice().
     *      The denominator (totalSupply) is already in dollar terms (usdShares × usdMultiplier).
     */
    function collateralizationRatio() public view returns (uint256) {
        uint256 obligations = totalUsdObligations();
        if (obligations == 0) return type(uint256).max;
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 reservesDollarValue = (totalOkuMReserves() * $.okuMoney.okuMPrice()) / PRECISION;
        return (reservesDollarValue * PRECISION) / obligations;
    }

    /**
     * @notice Extractable surplus as OkuMoney tokens (0 if undercollateralized)
     * @dev Calculates dollar surplus, then converts back to OkuM tokens via okuMPrice()
     */
    function surplus() public view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 price = $.okuMoney.okuMPrice();
        uint256 reservesDollarValue = (totalOkuMReserves() * price) / PRECISION;
        uint256 obligations = totalUsdObligations();
        if (reservesDollarValue > obligations) {
            // Convert dollar surplus back to OkuM token count
            uint256 dollarSurplus = reservesDollarValue - obligations;
            return (dollarSurplus * PRECISION) / price;
        }
        return 0;
    }

    // ============ Rate Management (VAULT_REBASER) ============

    function setUsdYieldRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(VAULT_REBASER)
    {
        if (newRate < PRECISION) revert InvalidRate();
        if (newRate > MAX_RATE) revert RateTooHigh();
        if (endTimestamp != 0 && endTimestamp <= block.timestamp) revert EndTimestampInPast();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.usdBaseMultiplier = usdMultiplier();
        $.usdLastAccrualTime = block.timestamp;

        $.usdRatePerSecond = newRate;
        $.usdRateEnd = endTimestamp;
        $.usdPendingRatePerSecond = PRECISION;

        emit UsdYieldRateUpdated(newRate, endTimestamp, $.usdBaseMultiplier);
    }

    function setNextUsdYieldRate(uint256 newRate) external onlyRole(VAULT_REBASER) {
        if (newRate < PRECISION) revert InvalidRate();
        if (newRate > MAX_RATE) revert RateTooHigh();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.usdRateEnd == 0) revert NoRateEndSet();

        $.usdPendingRatePerSecond = newRate;

        emit NextUsdYieldRateSet(newRate, $.usdRateEnd);
    }

    /**
     * @notice Emergency override — snapshots computed multiplier, resets rate to zero yield
     */
    function updateUsdMultiplier(uint256 newMultiplier) external onlyRole(VAULT_REBASER) {
        uint256 currentMultiplier = usdMultiplier();
        if (newMultiplier < currentMultiplier) revert MultiplierCannotDecrease();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.usdBaseMultiplier = newMultiplier;
        $.usdRatePerSecond = PRECISION;
        $.usdRateEnd = 0;
        $.usdPendingRatePerSecond = PRECISION;
        $.usdLastAccrualTime = block.timestamp;

        emit UsdRebaseEvent(currentMultiplier, newMultiplier);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(VAULT_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(VAULT_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(VAULT_UPGRADER)
    {}
}
