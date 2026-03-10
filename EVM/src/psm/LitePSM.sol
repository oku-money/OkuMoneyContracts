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
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * @title LitePSM
 * @notice Price-aware Peg Stability Module for USDC <-> OkuMoney/OkuDollar swaps
 * @dev OkuMoney is non-rebasing — okuMPrice() tracks appreciation separately.
 *      PSM converts at dollar-value via okuMPrice(): depositing 100 USDC when
 *      okuMPrice=$1.05 gives ~95.24 OkuM. Redeeming those OkuM returns ~100 USDC.
 *      Includes PoR oracle checks and redemption queue for when buffer is depleted.
 *      Provides convenience functions for OkuDollar mint/redeem via the vault.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuMoney/OkuDollar is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12
    uint256 private constant PRECISION = 1e18;

    // Granular RBAC roles (contract-specific prefixes)
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant QUEUE_PROCESSOR = keccak256("QUEUE_PROCESSOR");
    bytes32 public constant BUFFER_DEPOSITOR = keccak256("BUFFER_DEPOSITOR");
    bytes32 public constant BUFFER_WITHDRAWER = keccak256("BUFFER_WITHDRAWER");
    bytes32 public constant ORACLE_MANAGER = keccak256("ORACLE_MANAGER");

    IOkuMoney public okuMoney;
    IOkuDollar public usdOku;
    IERC20 public usdc;
    RedemptionQueue public redemptionQueue;

    // Oracle configuration
    IAggregatorV3 public porOracle;
    uint256 public stalenessThreshold;
    bool public oracleEnabled;

    // Events
    event MintNote(address indexed user, uint256 usdcAmount, uint256 okuMAmount);
    event RedeemNote(address indexed user, uint256 okuMIn, uint256 usdcOut);
    event MintUSD(address indexed user, uint256 usdcAmount, uint256 usdAmount);
    event RedeemUSD(address indexed user, uint256 usdIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);
    event BufferDeposited(address indexed depositor, uint256 amount);
    event BufferWithdrawn(address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuMoney,
        address _usdOku,
        address _usdc,
        address _redemptionQueue,
        address admin
    )
        public
        initializer
    {
        __AccessControl_init();
        __Pausable_init();

        okuMoney = IOkuMoney(_okuMoney);
        usdOku = IOkuDollar(_usdOku);
        usdc = IERC20(_usdc);
        redemptionQueue = RedemptionQueue(_redemptionQueue);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PSM_UPGRADER, admin);
        _grantRole(PSM_PAUSER, admin);
        _grantRole(QUEUE_PROCESSOR, admin);

        stalenessThreshold = 1 hours;
    }

    // ============ OkuMoney Swap Functions (Price-Aware) ============

    /**
     * @notice Mint OkuMoney by depositing USDC (price-aware)
     * @dev okuMAmount = usdcValue × PRECISION / okuMPrice()
     *      If okuMPrice=$1.05, depositing 100 USDC gives ~95.24 OkuM.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mint_OkuM(uint256 usdcAmount) external whenNotPaused nonReentrant {
        require(usdcAmount > 0, "Amount must be positive");

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;

        // Price-aware conversion: okuMAmount = dollarValue × PRECISION / okuMPrice
        uint256 price = okuMoney.okuMPrice();
        uint256 okuMAmount = (usdcValue18 * PRECISION) / price;
        require(okuMAmount > 0, "Amount too small");

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuMoney to user (raw token amount, price-adjusted)
        okuMoney.mint(msg.sender, okuMAmount);

        emit MintNote(msg.sender, usdcAmount, okuMAmount);
    }

    /**
     * @notice Redeem OkuMoney for USDC (price-aware)
     * @dev usdcAmount = okuMAmount × okuMPrice() / PRECISION (scaled to 6 decimals)
     *      If okuMPrice=$1.05, redeeming 95.24 OkuM returns ~100 USDC.
     * @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
     */
    function redeem_OkuM(uint256 okuMAmount) external whenNotPaused nonReentrant {
        _redeemOkuM(msg.sender, okuMAmount);
    }

    /**
     * @notice Redeem OkuMoney for USDC using EIP-2612 permit (single transaction)
     * @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function redeem_OkuMWithPermit(
        uint256 okuMAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        nonReentrant
    {
        IERC20Permit(address(okuMoney))
            .permit(msg.sender, address(this), okuMAmount, deadline, v, r, s);
        _redeemOkuM(msg.sender, okuMAmount);
    }

    function _redeemOkuM(address user, uint256 okuMAmount) internal {
        require(okuMAmount > 0, "Amount must be positive");

        // Price-aware conversion: dollarValue = okuMAmount × okuMPrice / PRECISION
        uint256 price = okuMoney.okuMPrice();
        uint256 dollarValue18 = (okuMAmount * price) / PRECISION;

        // Convert to USDC (6 decimals) — truncates sub-USDC dust
        uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - transfer-then-burn (Circle model: self-burn only)
            IERC20(address(okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
            okuMoney.burn(okuMAmount);
            usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, okuMAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            // Pull OkuMoney from user to PSM
            IERC20(address(okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
            // Transfer from PSM to queue, then record
            IERC20(address(okuMoney)).safeTransfer(address(redemptionQueue), okuMAmount);
            redemptionQueue.enqueue(user, okuMAmount);
        }
    }

    // ============ OkuDollar Convenience Functions ============

    /**
     * @notice Mint OkuDollar by depositing USDC (USDC → mint OkuM → wrap → usdOku to user)
     * @dev Price-aware: USDC converted to OkuM via okuMPrice(), then wrapped into vault.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mint_usdOku(uint256 usdcAmount) external whenNotPaused nonReentrant {
        require(usdcAmount > 0, "Amount must be positive");

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;

        // Price-aware conversion: okuMAmount = dollarValue × PRECISION / okuMPrice
        uint256 price = okuMoney.okuMPrice();
        uint256 okuMAmount = (usdcValue18 * PRECISION) / price;
        require(okuMAmount > 0, "Amount too small");

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuMoney to PSM (self)
        okuMoney.mint(address(this), okuMAmount);

        // Approve vault to pull OkuMoney
        IERC20(address(okuMoney)).approve(address(usdOku), okuMAmount);

        // Wrap OkuMoney into OkuDollar, delivering directly to user
        uint256 usdMinted = usdOku.wrap(okuMAmount, msg.sender);

        // Revoke any remaining approval
        IERC20(address(okuMoney)).approve(address(usdOku), 0);

        emit MintUSD(msg.sender, usdcAmount, usdMinted);
    }

    /**
     * @notice Redeem OkuDollar for USDC (usdOku → unwrap to OkuM → burn → USDC to user)
     * @param usdAmount Amount of OkuDollar to redeem (18 decimals)
     * @dev Reverts if vault is undercollateralized (unwrap fails).
     *      If USDC buffer insufficient, OkuM goes to queue (user earns yield while queued
     *      via okuMPrice() appreciation).
     */
    function redeem_usdOku(uint256 usdAmount) external whenNotPaused nonReentrant {
        _redeemUsdOku(msg.sender, usdAmount);
    }

    /**
     * @notice Redeem OkuDollar for USDC using EIP-2612 permit (single transaction)
     * @param usdAmount Amount of OkuDollar to redeem (18 decimals)
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function redeem_usdOkuWithPermit(
        uint256 usdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        nonReentrant
    {
        IERC20Permit(address(usdOku))
            .permit(msg.sender, address(this), usdAmount, deadline, v, r, s);
        _redeemUsdOku(msg.sender, usdAmount);
    }

    function _redeemUsdOku(address user, uint256 usdAmount) internal {
        require(usdAmount > 0, "Amount must be positive");

        // Pull OkuDollar from user
        IERC20(address(usdOku)).safeTransferFrom(user, address(this), usdAmount);

        // Unwrap OkuDollar → get OkuMoney back to PSM (price-aware)
        // NOTE: Reverts if vault undercollateralized (distinct failure mode)
        uint256 okuMReturned = usdOku.unwrap(usdAmount, address(this));

        // Now redeem the OkuMoney for USDC (same path as redeem_OkuM)
        _redeemOkuMInternal(user, okuMReturned);
    }

    /**
     * @dev Internal OkuMoney redemption (OkuM already held by PSM)
     *      Price-aware: USDC output = okuMAmount × okuMPrice() / PRECISION (scaled to 6 decimals)
     */
    function _redeemOkuMInternal(address user, uint256 okuMAmount) internal {
        // Price-aware conversion: dollarValue = okuMAmount × okuMPrice / PRECISION
        uint256 price = okuMoney.okuMPrice();
        uint256 dollarValue18 = (okuMAmount * price) / PRECISION;

        // Convert to USDC (6 decimals)
        uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - burn OkuMoney, transfer USDC
            okuMoney.burn(okuMAmount);
            usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, okuMAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            // Transfer OkuMoney from PSM to queue, then record
            IERC20(address(okuMoney)).safeTransfer(address(redemptionQueue), okuMAmount);
            redemptionQueue.enqueue(user, okuMAmount);
        }
    }

    /**
     * @notice Process queued redemptions (called by operator when buffer refilled)
     * @param startIndex First queue index to process (inclusive)
     * @param endIndex Last queue index to process (exclusive)
     * @param approveAmount USDC amount to approve for processing (backend calculates by summing entries)
     */
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        onlyRole(QUEUE_PROCESSOR)
        nonReentrant
    {
        // Approve exact amount needed for queue processing
        usdc.approve(address(redemptionQueue), approveAmount);

        // Process queue
        redemptionQueue.processQueue(startIndex, endIndex, address(usdc), address(okuMoney));

        // Revoke approval for remaining USDC
        usdc.approve(address(redemptionQueue), 0);

        emit BufferRefilled(usdc.balanceOf(address(this)));
    }

    // ============ Oracle Management ============

    function configureOracle(
        address _oracle,
        uint256 _stalenessThreshold,
        bool _enabled
    )
        external
        onlyRole(ORACLE_MANAGER)
    {
        porOracle = IAggregatorV3(_oracle);
        stalenessThreshold = _stalenessThreshold;
        oracleEnabled = _enabled;
        emit OracleConfigured(_oracle, _stalenessThreshold, _enabled);
    }

    function _checkReserves(uint256 mintAmount) internal view {
        require(address(porOracle) != address(0), "Oracle not configured");

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            porOracle.latestRoundData();

        require(answeredInRound >= roundId, "Incomplete oracle round");
        require(block.timestamp - updatedAt < stalenessThreshold, "Stale oracle data");
        require(answer >= 0, "Invalid oracle response");

        uint256 newSupply = okuMoney.totalSupply() + mintAmount;
        // Safe cast: answer >= 0 checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        require(uint256(answer) >= newSupply, "Exceeds reserves");
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(PSM_UNPAUSER) {
        _unpause();
    }

    function withdrawUsdc(address to, uint256 amount) external onlyRole(BUFFER_WITHDRAWER) {
        uint256 balance = usdc.balanceOf(address(this));
        require(balance >= amount, "Insufficient USDC balance");
        uint256 queueObligation = redemptionQueue.totalQueuedUsdc();
        require(balance - amount >= queueObligation, "Would strand queue");
        usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount);
    }

    /**
     * @notice Deposit USDC to PSM buffer for redemptions
     * @param amount Amount of USDC to deposit
     */
    function depositBuffer(uint256 amount) external onlyRole(BUFFER_DEPOSITOR) {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(PSM_UPGRADER)
    {}

    // ============ Storage Gap ============

    uint256[43] private __gap;
}
