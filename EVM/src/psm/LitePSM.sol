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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {MathLib} from "../lib/MathLib.sol";

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
 * @notice Multiplier-aware Peg Stability Module for USDC <-> OkuMoney/OkuDollar swaps
 * @dev OkuMoney is non-rebasing — okuMMultiplier() tracks appreciation separately.
 *      PSM converts at dollar-value via okuMMultiplier(): depositing 100 USDC when
 *      okuMMultiplier=$1.05 gives ~95.24 OkuM. Redeeming those OkuM returns ~100 USDC.
 *      Includes PoR oracle checks and redemption queue for when buffer is depleted.
 *      Provides convenience functions for OkuDollar mint/redeem via the vault.
 *
 *      See Constants.sol for terminology legend.
 *
 *      Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        IOkuMoney okuMoney;
        IOkuDollar usdOku;
        IERC20 usdc;
        RedemptionQueue redemptionQueue;
        // Oracle configuration
        IAggregatorV3 porOracle;
        uint256 stalenessThreshold;
        bool oracleEnabled;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.LitePSM")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LITEPSM_STORAGE_LOCATION =
        0x3d9e0f1a4b5c6d7e8a9f0e1d2c3b4a5e6f7d8c9b0a1e2f3d4c5b6a7e8f9d0c00;

    function _getLitePSMStorage() private pure returns (LitePSMStorage storage $) {
        assembly {
            $.slot := LITEPSM_STORAGE_LOCATION
        }
    }

    // ============ Constants (from shared library) ============

    uint256 private constant DECIMAL_MULTIPLIER = Constants.DECIMAL_MULTIPLIER;
    uint256 private constant PRECISION = Constants.PRECISION;

    // ============ Role Constants (from shared library) ============

    bytes32 public constant PSM_UPGRADER = Roles.PSM_UPGRADER;
    bytes32 public constant PSM_PAUSER = Roles.PSM_PAUSER;
    bytes32 public constant PSM_UNPAUSER = Roles.PSM_UNPAUSER;
    bytes32 public constant PSM_QUEUE_PROCESSOR = Roles.PSM_QUEUE_PROCESSOR;
    bytes32 public constant PSM_BUFFER_DEPOSITOR = Roles.PSM_BUFFER_DEPOSITOR;
    bytes32 public constant PSM_BUFFER_WITHDRAWER = Roles.PSM_BUFFER_WITHDRAWER;
    bytes32 public constant PSM_ORACLE_MANAGER = Roles.PSM_ORACLE_MANAGER;

    // ============ Events ============

    /// @notice Emitted when user mints OkuMoney by depositing USDC
    /// @param user Address of the user
    /// @param usdcAmount USDC deposited (6 decimals)
    /// @param okuMAmount OkuMoney minted (18 decimals)
    /// @param okuMMultiplier Multiplier at time of mint (allows rate reconstruction)
    event MintNote(
        address indexed user, uint256 usdcAmount, uint256 okuMAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when user redeems OkuMoney for USDC (instant or queued path emits different events)
    /// @param user Address of the user
    /// @param okuMIn OkuMoney redeemed (18 decimals)
    /// @param usdcOut USDC received (6 decimals)
    /// @param okuMMultiplier Multiplier at time of redemption
    event RedeemNote(address indexed user, uint256 okuMIn, uint256 usdcOut, uint256 okuMMultiplier);

    /// @notice Emitted when user mints OkuDollar by depositing USDC
    /// @param user Address of the user
    /// @param usdcAmount USDC deposited (6 decimals)
    /// @param usdAmount OkuDollar minted (18 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of mint
    event MintUSD(
        address indexed user, uint256 usdcAmount, uint256 usdAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when user redeems OkuDollar for USDC
    /// @param user Address of the user
    /// @param usdIn OkuDollar redeemed (18 decimals)
    /// @param usdcOut USDC received (6 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of redemption
    event RedeemUSD(address indexed user, uint256 usdIn, uint256 usdcOut, uint256 okuMMultiplier);

    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);

    /// @notice Emitted after queue processing completes
    /// @param newBufferBalance Remaining USDC in buffer after processing
    /// @param processedStart First index processed (inclusive)
    /// @param processedEnd Last index processed (exclusive)
    event BufferRefilled(uint256 newBufferBalance, uint256 processedStart, uint256 processedEnd);

    /// @notice Emitted when admin deposits USDC to buffer
    /// @param depositor Address that deposited
    /// @param amount USDC deposited
    /// @param newBufferBalance Total buffer balance after deposit
    event BufferDeposited(address indexed depositor, uint256 amount, uint256 newBufferBalance);

    /// @notice Emitted when admin withdraws USDC from buffer
    /// @param to Recipient address
    /// @param amount USDC withdrawn
    /// @param newBufferBalance Total buffer balance after withdrawal
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBufferBalance);

    // ============ Custom Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error OracleNotConfigured();
    error IncompleteOracleRound();
    error StaleOracleData();
    error InvalidOracleResponse();
    error ExceedsReserves(uint256 newSupply, uint256 reserves);
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
    error YieldDistributionInProgress();

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
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (_usdOku == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_redemptionQueue == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.usdOku = IOkuDollar(_usdOku);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);
        $.stalenessThreshold = 1 hours;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PSM_UPGRADER, admin);
        _grantRole(PSM_PAUSER, admin);
        _grantRole(PSM_QUEUE_PROCESSOR, admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    function usdOku() public view returns (IOkuDollar) {
        return _getLitePSMStorage().usdOku;
    }

    function usdc() public view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    function redemptionQueue() public view returns (RedemptionQueue) {
        return _getLitePSMStorage().redemptionQueue;
    }

    function porOracle() public view returns (IAggregatorV3) {
        return _getLitePSMStorage().porOracle;
    }

    function stalenessThreshold() public view returns (uint256) {
        return _getLitePSMStorage().stalenessThreshold;
    }

    function oracleEnabled() public view returns (bool) {
        return _getLitePSMStorage().oracleEnabled;
    }

    // ============ Yield Distribution Lock ============

    /**
     * @notice Modifier to prevent sandwich attacks during yield distribution
     * @dev Blocks PSM operations in the same block as yield distribution.
     *      This prevents arbitrageurs from frontrunning distributeYield() with mintOkuM()
     *      and backrunning with redeemOkuM() to capture unearned yield.
     */
    modifier whenYieldNotDistributing() {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (block.number == $.okuMoney.lastYieldDistributionBlock()) {
            revert YieldDistributionInProgress();
        }
        _;
    }

    // ============ OkuMoney Swap Functions (Multiplier-Aware) ============

    /**
     * @notice Mint OkuMoney by depositing USDC (multiplier-aware)
     * @dev okuMAmount = usdcValue × PRECISION / okuMMultiplier()
     *      If okuMMultiplier=$1.05, depositing 100 USDC gives ~95.24 OkuM.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mintOkuM(uint256 usdcAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        if (usdcAmount == 0) revert ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount);

        // Multiplier-aware conversion: okuMAmount = dollarValue × PRECISION / okuMMultiplier
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();

        // Slippage protection: verify output USDC value is within 1 unit of input
        // The dollarsToOkuM conversion truncates, losing up to 1 USDC unit of value.
        // This is always in the protocol's favor (user gets slightly fewer OkuMoney).
        // We allow 1 unit tolerance to prevent reverts at non-even multipliers like $1.05.
        uint256 roundTripUsdc = MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMAmount, okuMMult));
        if (roundTripUsdc + 1 < usdcAmount) {
            revert OutputBelowMinimum(roundTripUsdc, usdcAmount);
        }

        // Check PoR oracle if enabled
        if ($.oracleEnabled && address($.porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        // Transfer USDC from user
        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuMoney to user (raw token amount, multiplier-adjusted)
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit MintNote(msg.sender, usdcAmount, okuMAmount, okuMMult);
    }

    /**
     * @notice Redeem OkuMoney for USDC (multiplier-aware)
     * @dev usdcAmount = okuMAmount × okuMMultiplier() / PRECISION (scaled to 6 decimals)
     *      If okuMMultiplier=$1.05, redeeming 95.24 OkuM returns ~100 USDC.
     * @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
     */
    function redeemOkuM(uint256 okuMAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
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
    function redeemOkuMWithPermit(
        uint256 okuMAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        IERC20Permit(address($.okuMoney))
            .permit(msg.sender, address(this), okuMAmount, deadline, v, r, s);
        _redeemOkuM(msg.sender, okuMAmount);
    }

    function _redeemOkuM(address user, uint256 okuMAmount) internal {
        if (okuMAmount == 0) revert ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();

        // Multiplier-aware conversion: dollarValue = okuMAmount × okuMMultiplier / PRECISION
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue18 = MathLib.okuMToDollars(okuMAmount, okuMMult);

        // Convert to USDC (6 decimals) — truncates sub-USDC dust
        uint256 usdcAmount = MathLib.dollarsToUsdc(dollarValue18);
        if (usdcAmount == 0) revert AmountTooSmall();

        // Slippage protection: truncate input to USDC-representable floor
        uint256 okuMFloor = (okuMAmount / DECIMAL_MULTIPLIER) * DECIMAL_MULTIPLIER;
        uint256 minUsdcExpected = MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMFloor, okuMMult));
        if (usdcAmount < minUsdcExpected) {
            revert OutputBelowMinimum(usdcAmount, minUsdcExpected);
        }

        uint256 usdcBalance = $.usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - transfer-then-burn (Circle model: self-burn only)
            IERC20(address($.okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
            $.okuMoney.burn(okuMAmount);
            $.usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, okuMAmount, usdcAmount, okuMMult);
        } else {
            // Insufficient buffer - queue redemption
            // Pull OkuMoney from user to PSM
            IERC20(address($.okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
            // Transfer from PSM to queue, then record
            IERC20(address($.okuMoney)).safeTransfer(address($.redemptionQueue), okuMAmount);
            $.redemptionQueue.enqueue(user, okuMAmount);
        }
    }

    // ============ OkuDollar Convenience Functions ============

    /**
     * @notice Mint OkuDollar by depositing USDC (USDC → mint OkuM → wrap → usdOku to user)
     * @dev Multiplier-aware: USDC converted to OkuM via okuMMultiplier(), then wrapped into vault.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mintUsdOku(uint256 usdcAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        if (usdcAmount == 0) revert ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount);

        // Multiplier-aware conversion: okuMAmount = dollarValue × PRECISION / okuMMultiplier
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();

        // Check PoR oracle if enabled
        if ($.oracleEnabled && address($.porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        // Transfer USDC from user
        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuMoney to PSM (self)
        $.okuMoney.mint(address(this), okuMAmount);

        // Approve vault to pull OkuMoney
        IERC20(address($.okuMoney)).approve(address($.usdOku), okuMAmount);

        // Wrap OkuMoney into OkuDollar, delivering directly to user
        // Pass 0 for minAmountOut as we check slippage after
        uint256 usdMinted = $.usdOku.wrap(okuMAmount, msg.sender, 0);

        // Revoke any remaining approval
        IERC20(address($.okuMoney)).approve(address($.usdOku), 0);

        // Slippage protection: usdOku minted must be >= input dollar value
        if (usdMinted < usdcValue18) {
            revert OutputBelowMinimum(usdMinted, usdcValue18);
        }

        emit MintUSD(msg.sender, usdcAmount, usdMinted, okuMMult);
    }

    /**
     * @notice Redeem OkuDollar for USDC (usdOku → unwrap to OkuM → burn → USDC to user)
     * @param usdAmount Amount of OkuDollar to redeem (18 decimals)
     * @dev Reverts if vault is undercollateralized (unwrap fails).
     *      If USDC buffer insufficient, OkuM goes to queue (user earns yield while queued
     *      via okuMMultiplier() appreciation).
     */
    function redeemUsdOku(uint256 usdAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
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
    function redeemUsdOkuWithPermit(
        uint256 usdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        IERC20Permit(address($.usdOku))
            .permit(msg.sender, address(this), usdAmount, deadline, v, r, s);
        _redeemUsdOku(msg.sender, usdAmount);
    }

    function _redeemUsdOku(address user, uint256 usdAmount) internal {
        if (usdAmount == 0) revert ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();

        // Pull OkuDollar from user
        IERC20(address($.usdOku)).safeTransferFrom(user, address(this), usdAmount);

        // Unwrap OkuDollar → get OkuMoney back to PSM (multiplier-aware)
        // NOTE: Reverts if vault undercollateralized (distinct failure mode)
        uint256 okuMReturned = $.usdOku.unwrap(usdAmount, address(this));

        // Now redeem the OkuMoney for USDC (same path as redeemOkuM)
        // _redeemOkuMInternal will calculate usdcOut and emit RedeemNote
        uint256 usdcOut = _redeemOkuMInternal(user, okuMReturned);

        // Emit RedeemUSD with the actual USDC output
        emit RedeemUSD(user, usdAmount, usdcOut, $.okuMoney.okuMMultiplier());
    }

    /**
     * @dev Internal OkuMoney redemption (OkuM already held by PSM)
     *      Multiplier-aware: USDC output = okuMAmount × okuMMultiplier() / PRECISION (scaled to 6 decimals)
     * @return usdcAmount The USDC amount transferred (0 if queued)
     */
    function _redeemOkuMInternal(
        address user,
        uint256 okuMAmount
    )
        internal
        returns (uint256 usdcAmount)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();

        // Multiplier-aware conversion: dollarValue = okuMAmount × okuMMultiplier / PRECISION
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue18 = MathLib.okuMToDollars(okuMAmount, okuMMult);

        // Convert to USDC (6 decimals)
        usdcAmount = MathLib.dollarsToUsdc(dollarValue18);
        if (usdcAmount == 0) revert AmountTooSmall();

        // Slippage protection: truncate input to USDC-representable floor
        uint256 okuMFloor = (okuMAmount / DECIMAL_MULTIPLIER) * DECIMAL_MULTIPLIER;
        uint256 minUsdcExpected = MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMFloor, okuMMult));
        if (usdcAmount < minUsdcExpected) {
            revert OutputBelowMinimum(usdcAmount, minUsdcExpected);
        }

        uint256 usdcBalance = $.usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - burn OkuMoney, transfer USDC
            $.okuMoney.burn(okuMAmount);
            $.usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, okuMAmount, usdcAmount, okuMMult);
        } else {
            // Insufficient buffer - queue redemption
            // Transfer OkuMoney from PSM to queue, then record
            IERC20(address($.okuMoney)).safeTransfer(address($.redemptionQueue), okuMAmount);
            $.redemptionQueue.enqueue(user, okuMAmount);
            usdcAmount = 0; // Signal that redemption was queued, not instant
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
        onlyRole(PSM_QUEUE_PROCESSOR)
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();

        // Approve exact amount needed for queue processing
        $.usdc.approve(address($.redemptionQueue), approveAmount);

        // Process queue
        $.redemptionQueue.processQueue(startIndex, endIndex, address($.usdc), address($.okuMoney));

        // Revoke approval for remaining USDC
        $.usdc.approve(address($.redemptionQueue), 0);

        emit BufferRefilled($.usdc.balanceOf(address(this)), startIndex, endIndex);
    }

    // ============ Oracle Management ============

    function configureOracle(
        address _oracle,
        uint256 _stalenessThreshold,
        bool _enabled
    )
        external
        onlyRole(PSM_ORACLE_MANAGER)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.porOracle = IAggregatorV3(_oracle);
        $.stalenessThreshold = _stalenessThreshold;
        $.oracleEnabled = _enabled;
        emit OracleConfigured(_oracle, _stalenessThreshold, _enabled);
    }

    function _checkReserves(uint256 mintAmount) internal view {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (address($.porOracle) == address(0)) revert OracleNotConfigured();

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            $.porOracle.latestRoundData();

        if (answeredInRound < roundId) revert IncompleteOracleRound();
        if (block.timestamp - updatedAt >= $.stalenessThreshold) revert StaleOracleData();
        if (answer < 0) revert InvalidOracleResponse();

        uint256 newSupply = $.okuMoney.totalSupply() + mintAmount;
        // Safe cast: answer >= 0 checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 reserves = uint256(answer);
        if (reserves < newSupply) revert ExceedsReserves(newSupply, reserves);
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(PSM_UNPAUSER) {
        _unpause();
    }

    function withdrawUsdc(address to, uint256 amount) external onlyRole(PSM_BUFFER_WITHDRAWER) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
        uint256 queueObligation = $.redemptionQueue.totalQueuedUsdc();
        uint256 remainingBalance = balance - amount;
        if (remainingBalance < queueObligation) {
            revert WouldStrandQueue(remainingBalance, queueObligation);
        }
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, remainingBalance);
    }

    /**
     * @notice Deposit USDC to PSM buffer for redemptions
     * @param amount Amount of USDC to deposit
     */
    function depositBuffer(uint256 amount) external onlyRole(PSM_BUFFER_DEPOSITOR) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(PSM_UPGRADER)
    {}
}
