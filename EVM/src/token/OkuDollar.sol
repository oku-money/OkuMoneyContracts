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
import {YieldSandwichGuard} from "../lib/YieldSandwichGuard.sol";

/**
 * @title OkuDollar
 * @notice Rebasing $1-pegged stablecoin with independent yield rate, backed by OkuMoney reserves
 * @dev NOT an ERC-4626 vault. Custom rebasing token with its own shares/multiplier.
 *      Holds OkuMoney as reserves. Independent yield rate enables revenue extraction
 *      (OkuM rate > USD rate) or forward-facing yield (USD rate > OkuM rate).
 *
 *      Wrap/unwrap are multiplier-aware: they use okuMMultiplier() and usdMultiplier() to convert
 *      between OkuMoney token amounts and OkuDollar amounts at their respective dollar values.
 *
 *      See Constants.sol for terminology legend.
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
    YieldSandwichGuard,
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
        0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900;

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
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = 9e17; // 90% minimum floor (matches SVM)

    // ============ Events ============

    event TransferValue(
        address indexed from, address indexed to, uint256 shares, uint256 dollarValue
    );

    /// @notice Emitted when OkuMoney is wrapped into OkuDollar
    /// @param user Address wrapping tokens
    /// @param okuMAmount OkuMoney deposited (18 decimals)
    /// @param usdMinted OkuDollar minted (18 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of wrap
    /// @param usdMultiplier OkuDollar multiplier at time of wrap
    event Wrapped(
        address indexed user,
        address indexed receiver,
        uint256 okuMAmount,
        uint256 usdMinted,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );

    /// @notice Emitted when OkuDollar is unwrapped back to OkuMoney
    /// @param user Address unwrapping tokens
    /// @param usdAmount OkuDollar redeemed (18 decimals)
    /// @param okuMReturned OkuMoney returned (18 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of unwrap
    /// @param usdMultiplier OkuDollar multiplier at time of unwrap
    event Unwrapped(
        address indexed user,
        address indexed receiver,
        uint256 usdAmount,
        uint256 okuMReturned,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );

    /// @notice Emitted when the USD multiplier is directly overridden (emergency path)
    /// @param oldMultiplier Previous multiplier value
    /// @param newMultiplier New multiplier value
    /// @param totalSupply Total OkuDollar supply at time of update
    event UsdMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply);

    /// @notice Emitted when yield rate is updated
    /// @param oldRatePerSecond Previous rate per second
    /// @param newRatePerSecond New rate per second
    /// @param endTimestamp When the rate expires (0 = never)
    /// @param snapshotMultiplier Multiplier snapshot at time of update
    event UsdYieldRateUpdated(
        uint256 oldRatePerSecond,
        uint256 newRatePerSecond,
        uint256 endTimestamp,
        uint256 snapshotMultiplier
    );
    event NextUsdYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);

    /// @notice Emitted when reserves are deposited without minting shares
    /// @param depositor Address depositing
    /// @param okuMAmount OkuMoney deposited (18 decimals)
    /// @param dollarValue Dollar value of deposit at current okuMMultiplier
    /// @param collateralizationRatio Ratio after deposit
    event ReservesDeposited(
        address indexed depositor,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 collateralizationRatio
    );

    /// @notice Emitted when surplus reserves are withdrawn
    /// @param to Recipient address
    /// @param okuMAmount OkuMoney withdrawn (18 decimals)
    /// @param dollarValue Dollar value of withdrawal at current okuMMultiplier
    /// @param collateralizationRatio Ratio after withdrawal
    event SurplusWithdrawn(
        address indexed to, uint256 okuMAmount, uint256 dollarValue, uint256 collateralizationRatio
    );

    // ============ Custom Errors ============

    error ZeroAddress();
    error RatioExceedsMax();
    error RatioBelowFloor();
    error ZeroAmount();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    /// @dev Share balance is below the amount being moved/burned (unrelated to vault collateral).
    error InsufficientBalance();
    /// @dev Vault OkuMoney reserves are below the amount required to cover user obligations on unwrap.
    error InsufficientCollateral();
    error BelowMinimumCollateral();
    error InvalidRate();
    error RateTooHigh();
    error EndTimestampInPast();
    error RateAlreadyExpired();
    error NoRateEndSet();
    error MultiplierCannotDecrease();

    // YieldDistributionInProgress is inherited from YieldSandwichGuard.

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
        if (_minCollateralRatio < MIN_COLLATERAL_RATIO_FLOOR) revert RatioBelowFloor();

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

        // Grant the full role set to admin at deployment (see OkuMoney.initialize).
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_UPGRADER, admin);
        _grantRole(VAULT_REBASER, admin);
        _grantRole(VAULT_RESERVE_MANAGER, admin);
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
     * @dev Uses MathLib.rpow for continuous exponential accrual. Unlike OkuMoney
     *      (which has a discrete setter), OkuDollar's multiplier is a function of
     *      the per-second rate and elapsed time since the last rate update.
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
        if (fromBalance < shares) revert InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        uint256 dollarValue = (shares * usdMultiplier()) / PRECISION;
        emit TransferValue(from, to, shares, dollarValue);
        // NOTE: Transfer event is emitted by the calling public function (transfer / transferFrom)
        // with the original token amount. Do not emit here to avoid double-emitting.
    }

    // ============ Yield Distribution Lock ============

    /// @inheritdoc YieldSandwichGuard
    function _yieldSandwichOkuMoney() internal view override returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /**
     * @notice Wrap OkuMoney into OkuDollar (multiplier-aware)
     * @dev usdMinted = okuMAmount × okuMMultiplier() / usdMultiplier()
     *      100 OkuM tokens at okuMMultiplier=$1.05, usdMultiplier=1.0 → 105 usdOku.
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
        whenYieldNotDistributing
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

        // Multiplier-aware: convert OkuM token value to OkuDollar shares
        // shares = actualReceived × okuMMultiplier / usdMultiplier
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 usdMult = usdMultiplier();
        uint256 sharesToMint = (actualReceived * okuMMult) / usdMult;
        if (sharesToMint == 0) revert AmountTooSmall();

        // Calculate dollar value for event (from shares × multiplier)
        usdMinted = (sharesToMint * usdMult) / PRECISION;

        // Slippage protection
        if (usdMinted < minAmountOut) {
            revert OutputBelowMinimum(usdMinted, minAmountOut);
        }

        $.totalUsdShares += sharesToMint;
        $.usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
        emit TransferValue(address(0), receiver, sharesToMint, usdMinted);
        emit Wrapped(msg.sender, receiver, actualReceived, usdMinted, okuMMult, usdMult);
    }

    /**
     * @notice Unwrap OkuDollar back to OkuMoney (multiplier-aware)
     * @dev okuMReturned = usdAmount × PRECISION / okuMMultiplier()
     *      105 usdOku at okuMMultiplier=$1.05 → 100 OkuM tokens (regardless of usdMultiplier).
     *      The usdMultiplier converts shares ↔ dollars, not dollars ↔ OkuMoney.
     *      Reverts if vault holds insufficient OkuMoney.
     * @param usdAmount Amount of OkuDollar to unwrap (in dollar terms)
     * @param receiver Address to receive OkuMoney
     * @return okuMReturned Amount of OkuMoney tokens returned
     */
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();

        // Multiplier-aware: convert OkuDollar amount to OkuM token count
        // usdAmount is in dollar terms. To convert dollars to OkuMoney:
        // okuMReturned = usdAmount × PRECISION / okuMMultiplier
        // Note: usdMultiplier converts shares ↔ dollars, NOT dollars ↔ OkuMoney
        uint256 usdMult = usdMultiplier();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        okuMReturned = (usdAmount * PRECISION) / okuMMult;

        // Calculate shares to burn (round UP to favor vault)
        // Ceiling division: (a + b - 1) / b
        uint256 sharesToBurn = ((usdAmount * PRECISION) + usdMult - 1) / usdMult;
        if ($.usdShares[msg.sender] < sharesToBurn) revert InsufficientBalance();

        // Check vault has enough OkuMoney
        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        // Burn user's shares
        $.totalUsdShares -= sharesToBurn;
        $.usdShares[msg.sender] -= sharesToBurn;

        // Transfer OkuMoney to receiver
        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        emit Transfer(msg.sender, address(0), usdAmount);
        emit TransferValue(msg.sender, address(0), sharesToBurn, usdAmount);
        emit Unwrapped(msg.sender, receiver, usdAmount, okuMReturned, okuMMult, usdMult);
    }

    // ============ Reserve Management ============

    /**
     * @notice Deposit OkuMoney without minting OkuDollar shares (top up reserves)
     * @dev Used when USD rate > OkuM rate (vault undercollateralized).
     *      Since OkuMoney is non-rebasing, OkuM tokens are NOT dollar-denominated —
     *      their value depends on okuMMultiplier().
     * @param okuMAmount Amount of OkuMoney tokens to deposit
     */
    function depositReserves(uint256 okuMAmount)
        external
        whenNotPaused
        onlyRole(VAULT_RESERVE_MANAGER)
    {
        if (okuMAmount == 0) revert ZeroAmount();
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue = (actualReceived * okuMMult) / PRECISION;
        emit ReservesDeposited(msg.sender, actualReceived, dollarValue, collateralizationRatio());
    }

    /**
     * @notice Withdraw surplus OkuMoney without burning OkuDollar shares
     * @dev Used when USD rate < OkuM rate (vault overcollateralized).
     *      Enforces collateralizationRatio() >= minCollateralRatio AFTER withdrawal.
     * @param okuMAmount Amount of OkuMoney tokens to withdraw
     */
    function withdrawSurplus(uint256 okuMAmount)
        external
        whenNotPaused
        onlyRole(VAULT_RESERVE_MANAGER)
    {
        if (okuMAmount == 0) revert ZeroAmount();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        IERC20(address($.okuMoney)).safeTransfer(msg.sender, okuMAmount);

        // Enforce collateralization floor AFTER withdrawal
        uint256 ratio = collateralizationRatio();
        if (ratio < $.minCollateralRatio) revert BelowMinimumCollateral();

        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue = (okuMAmount * okuMMult) / PRECISION;
        emit SurplusWithdrawn(msg.sender, okuMAmount, dollarValue, ratio);
    }

    // ============ Admin ============

    function setMinCollateralRatio(uint256 newRatio) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRatio > PRECISION) revert RatioExceedsMax();
        if (newRatio < MIN_COLLATERAL_RATIO_FLOOR) revert RatioBelowFloor();
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
     * @notice Multiplier-aware collateralization ratio
     * @dev collateralizationRatio = (okuMBalance × okuMMultiplier / PRECISION) × PRECISION / totalSupply
     *      The numerator converts OkuM token count to dollar value via okuMMultiplier().
     *      The denominator (totalSupply) is already in dollar terms (usdShares × usdMultiplier).
     */
    function collateralizationRatio() public view returns (uint256) {
        uint256 obligations = totalUsdObligations();
        if (obligations == 0) return type(uint256).max;
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 reservesDollarValue =
            (totalOkuMReserves() * $.okuMoney.okuMMultiplier()) / PRECISION;
        return (reservesDollarValue * PRECISION) / obligations;
    }

    /**
     * @notice Extractable surplus as OkuMoney tokens (0 if undercollateralized)
     * @dev Calculates dollar surplus, then converts back to OkuM tokens via okuMMultiplier()
     */
    function surplus() public view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (totalOkuMReserves() * okuMMult) / PRECISION;
        uint256 obligations = totalUsdObligations();
        if (reservesDollarValue > obligations) {
            // Convert dollar surplus back to OkuM token count
            uint256 dollarSurplus = reservesDollarValue - obligations;
            return (dollarSurplus * PRECISION) / okuMMult;
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
        uint256 oldRate = $.usdRatePerSecond;
        $.usdBaseMultiplier = usdMultiplier();
        $.usdLastAccrualTime = block.timestamp;

        $.usdRatePerSecond = newRate;
        $.usdRateEnd = endTimestamp;
        $.usdPendingRatePerSecond = PRECISION;

        emit UsdYieldRateUpdated(oldRate, newRate, endTimestamp, $.usdBaseMultiplier);
    }

    function setNextUsdYieldRate(uint256 newRate) external onlyRole(VAULT_REBASER) {
        if (newRate < PRECISION) revert InvalidRate();
        if (newRate > MAX_RATE) revert RateTooHigh();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.usdRateEnd == 0) revert NoRateEndSet();
        // Staging a pending rate after the current rate has already expired would let
        // the pending rate accrue from the (past) usdRateEnd timestamp the moment it
        // activates, snapshotting an arbitrary amount of unearned yield at that
        // boundary. Force the operator to call setUsdYieldRate() with a fresh end
        // timestamp instead.
        if (block.timestamp >= $.usdRateEnd) revert RateAlreadyExpired();

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

        emit UsdMultiplierUpdated(currentMultiplier, newMultiplier, totalSupply());
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
