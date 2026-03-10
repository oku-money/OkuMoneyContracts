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
import {IOkuNote} from "../interfaces/IOkuNote.sol";
import {IOkuUSD} from "../interfaces/IOkuUSD.sol";

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
 * @notice Price-aware Peg Stability Module for USDC <-> OkuNote/OkuUSD swaps
 * @dev OkuNote is non-rebasing — notePrice() tracks appreciation separately.
 *      PSM converts at dollar-value via notePrice(): depositing 100 USDC when
 *      notePrice=$1.05 gives ~95.24 notes. Redeeming those notes returns ~100 USDC.
 *      Includes PoR oracle checks and redemption queue for when buffer is depleted.
 *      Provides convenience functions for OkuUSD mint/redeem via the vault.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuNote/OkuUSD is 18 decimals)
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

    IOkuNote public okuNote;
    IOkuUSD public okuUsd;
    IERC20 public usdc;
    RedemptionQueue public redemptionQueue;

    // Oracle configuration
    IAggregatorV3 public porOracle;
    uint256 public stalenessThreshold;
    bool public oracleEnabled;

    // Events
    event MintNote(address indexed user, uint256 usdcAmount, uint256 noteAmount);
    event RedeemNote(address indexed user, uint256 noteIn, uint256 usdcOut);
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
        address _okuNote,
        address _okuUsd,
        address _usdc,
        address _redemptionQueue,
        address admin
    )
        public
        initializer
    {
        __AccessControl_init();
        __Pausable_init();

        okuNote = IOkuNote(_okuNote);
        okuUsd = IOkuUSD(_okuUsd);
        usdc = IERC20(_usdc);
        redemptionQueue = RedemptionQueue(_redemptionQueue);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PSM_UPGRADER, admin);
        _grantRole(PSM_PAUSER, admin);
        _grantRole(QUEUE_PROCESSOR, admin);

        stalenessThreshold = 1 hours;
    }

    // ============ OkuNote Swap Functions (Price-Aware) ============

    /**
     * @notice Mint OkuNote by depositing USDC (price-aware)
     * @dev noteAmount = usdcValue × PRECISION / notePrice()
     *      If notePrice=$1.05, depositing 100 USDC gives ~95.24 notes.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mint_OkuNote(uint256 usdcAmount) external whenNotPaused nonReentrant {
        require(usdcAmount > 0, "Amount must be positive");

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;

        // Price-aware conversion: noteAmount = dollarValue × PRECISION / notePrice
        uint256 price = okuNote.notePrice();
        uint256 noteAmount = (usdcValue18 * PRECISION) / price;
        require(noteAmount > 0, "Amount too small");

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(noteAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuNote to user (raw token amount, price-adjusted)
        okuNote.mint(msg.sender, noteAmount);

        emit MintNote(msg.sender, usdcAmount, noteAmount);
    }

    /**
     * @notice Redeem OkuNote for USDC (price-aware)
     * @dev usdcAmount = noteAmount × notePrice() / PRECISION (scaled to 6 decimals)
     *      If notePrice=$1.05, redeeming 95.24 notes returns ~100 USDC.
     * @param noteAmount Amount of OkuNote to redeem (18 decimals)
     */
    function redeem_OkuNote(uint256 noteAmount) external whenNotPaused nonReentrant {
        _redeemNote(msg.sender, noteAmount);
    }

    /**
     * @notice Redeem OkuNote for USDC using EIP-2612 permit (single transaction)
     * @param noteAmount Amount of OkuNote to redeem (18 decimals)
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function redeem_OkuNoteWithPermit(
        uint256 noteAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        nonReentrant
    {
        IERC20Permit(address(okuNote))
            .permit(msg.sender, address(this), noteAmount, deadline, v, r, s);
        _redeemNote(msg.sender, noteAmount);
    }

    function _redeemNote(address user, uint256 noteAmount) internal {
        require(noteAmount > 0, "Amount must be positive");

        // Price-aware conversion: dollarValue = noteAmount × notePrice / PRECISION
        uint256 price = okuNote.notePrice();
        uint256 dollarValue18 = (noteAmount * price) / PRECISION;

        // Convert to USDC (6 decimals) — truncates sub-USDC dust
        uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - transfer-then-burn (Circle model: self-burn only)
            IERC20(address(okuNote)).safeTransferFrom(user, address(this), noteAmount);
            okuNote.burn(noteAmount);
            usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, noteAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            // Pull OkuNote from user to PSM
            IERC20(address(okuNote)).safeTransferFrom(user, address(this), noteAmount);
            // Transfer from PSM to queue, then record
            IERC20(address(okuNote)).safeTransfer(address(redemptionQueue), noteAmount);
            redemptionQueue.enqueue(user, noteAmount);
        }
    }

    // ============ OkuUSD Convenience Functions ============

    /**
     * @notice Mint OkuUSD by depositing USDC (USDC → mint note → wrap → OkuUSD to user)
     * @dev Price-aware: USDC converted to notes via notePrice(), then wrapped into vault.
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mint_OkuUSD(uint256 usdcAmount) external whenNotPaused nonReentrant {
        require(usdcAmount > 0, "Amount must be positive");

        // Convert USDC (6 decimals) to 18-decimal dollar value
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;

        // Price-aware conversion: noteAmount = dollarValue × PRECISION / notePrice
        uint256 price = okuNote.notePrice();
        uint256 noteAmount = (usdcValue18 * PRECISION) / price;
        require(noteAmount > 0, "Amount too small");

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(noteAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuNote to PSM (self)
        okuNote.mint(address(this), noteAmount);

        // Approve vault to pull notes
        IERC20(address(okuNote)).approve(address(okuUsd), noteAmount);

        // Wrap notes into OkuUSD, delivering directly to user
        uint256 usdMinted = okuUsd.wrap(noteAmount, msg.sender);

        // Revoke any remaining approval
        IERC20(address(okuNote)).approve(address(okuUsd), 0);

        emit MintUSD(msg.sender, usdcAmount, usdMinted);
    }

    /**
     * @notice Redeem OkuUSD for USDC (OkuUSD → unwrap to notes → burn notes → USDC to user)
     * @param usdAmount Amount of OkuUSD to redeem (18 decimals)
     * @dev Reverts if vault is undercollateralized (unwrap fails).
     *      If USDC buffer insufficient, notes go to queue (user earns yield while queued
     *      via notePrice() appreciation).
     */
    function redeem_OkuUSD(uint256 usdAmount) external whenNotPaused nonReentrant {
        _redeemUSD(msg.sender, usdAmount);
    }

    /**
     * @notice Redeem OkuUSD for USDC using EIP-2612 permit (single transaction)
     * @param usdAmount Amount of OkuUSD to redeem (18 decimals)
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function redeem_OkuUSDWithPermit(
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
        IERC20Permit(address(okuUsd))
            .permit(msg.sender, address(this), usdAmount, deadline, v, r, s);
        _redeemUSD(msg.sender, usdAmount);
    }

    function _redeemUSD(address user, uint256 usdAmount) internal {
        require(usdAmount > 0, "Amount must be positive");

        // Pull OkuUSD from user
        IERC20(address(okuUsd)).safeTransferFrom(user, address(this), usdAmount);

        // Unwrap OkuUSD → get notes back to PSM (price-aware)
        // NOTE: Reverts if vault undercollateralized (distinct failure mode)
        uint256 notesReturned = okuUsd.unwrap(usdAmount, address(this));

        // Now redeem the notes for USDC (same path as redeem_OkuNote)
        _redeemNoteInternal(user, notesReturned);
    }

    /**
     * @dev Internal note redemption (notes already held by PSM)
     *      Price-aware: USDC output = noteAmount × notePrice() / PRECISION (scaled to 6 decimals)
     */
    function _redeemNoteInternal(address user, uint256 noteAmount) internal {
        // Price-aware conversion: dollarValue = noteAmount × notePrice / PRECISION
        uint256 price = okuNote.notePrice();
        uint256 dollarValue18 = (noteAmount * price) / PRECISION;

        // Convert to USDC (6 decimals)
        uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - burn notes, transfer USDC
            okuNote.burn(noteAmount);
            usdc.safeTransfer(user, usdcAmount);
            emit RedeemNote(user, noteAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            // Transfer notes from PSM to queue, then record
            IERC20(address(okuNote)).safeTransfer(address(redemptionQueue), noteAmount);
            redemptionQueue.enqueue(user, noteAmount);
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
        redemptionQueue.processQueue(startIndex, endIndex, address(usdc), address(okuNote));

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

        uint256 newSupply = okuNote.totalSupply() + mintAmount;
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
