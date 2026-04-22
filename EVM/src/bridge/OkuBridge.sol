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
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";

/**
 * @title OkuBridge
 * @notice Orchestrator-signed cross-chain bridge for OkuMoney using burn-and-mint pattern
 * @dev Operates on raw token amounts (OkuMoney is non-rebasing — no share conversion needed).
 *
 * Architecture:
 * 1. Source Chain: User calls bridgeBurn() → burns tokens, collects fee, emits event
 * 2. Off-Chain: Orchestrator observes event, waits for finality, signs with EIP-712
 * 3. Destination Chain: Orchestrator (or user) calls bridgeMint() → validates signature, mints tokens
 *
 * Key Design:
 * - Uses raw token amounts (standard ERC-20, no share conversion)
 * - EIP-712 signatures for structured data signing
 * - Sequential nonces per destination on source chain
 * - Request ID tracking on destination to prevent replay
 * - Fee collected in tokens on source chain (subtractive model)
 * - Two-step refund (BRIDGE_REFUND_INITIATOR + BRIDGE_REFUND_CONFIRMER) prevents single-key double-mint
 *
 * IMPORTANT: BRIDGE_REFUND_INITIATOR and BRIDGE_REFUND_CONFIRMER must be assigned to DIFFERENT keys
 * post-deployment. At initialization, both are granted to admin for convenience, but operators
 * MUST delegate one of these roles to a separate key before the bridge goes live. This ensures
 * no single compromised key can complete a refund unilaterally.
 *
 * Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract OkuBridge is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @notice Packed bridge limits (2 x uint128 in 1 slot)
    struct BridgeLimits {
        uint128 min;
        uint128 max;
    }

    /// @custom:storage-location erc7201:okumoney.storage.OkuBridge
    struct OkuBridgeStorage {
        IOkuMoney okuMoney;
        address authorizedSigner;
        address feeRecipient;
        uint256 bridgeFee;
        BridgeLimits limits;
        mapping(uint256 => bool) supportedChains;
        mapping(uint256 => uint256) outboundNonce;
        mapping(bytes32 => bool) processedRequests;
        mapping(bytes32 => bool) refundedRequests;
        uint256 bridgeDeadline;
        mapping(bytes32 => address) pendingRefundInitiator;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuBridge")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUBRIDGE_STORAGE_LOCATION =
        0x16d568c6a143129546d6ac053036120b950e13328eeec5c3350b809aaf072c00;

    function _getOkuBridgeStorage() private pure returns (OkuBridgeStorage storage $) {
        assembly {
            $.slot := OKUBRIDGE_STORAGE_LOCATION
        }
    }

    // ============ Role Constants (from shared library) ============

    bytes32 public constant BRIDGE_SIGNER_MANAGER = Roles.BRIDGE_SIGNER_MANAGER;
    bytes32 public constant BRIDGE_PAUSER = Roles.BRIDGE_PAUSER;
    bytes32 public constant BRIDGE_UNPAUSER = Roles.BRIDGE_UNPAUSER;
    bytes32 public constant BRIDGE_FEE_MANAGER = Roles.BRIDGE_FEE_MANAGER;
    bytes32 public constant BRIDGE_NONCE_ADMIN = Roles.BRIDGE_NONCE_ADMIN;
    bytes32 public constant BRIDGE_CHAIN_MANAGER = Roles.BRIDGE_CHAIN_MANAGER;
    bytes32 public constant BRIDGE_LIMITS_MANAGER = Roles.BRIDGE_LIMITS_MANAGER;
    bytes32 public constant BRIDGE_UPGRADER = Roles.BRIDGE_UPGRADER;
    bytes32 public constant BRIDGE_DUST_SWEEPER = Roles.BRIDGE_DUST_SWEEPER;
    bytes32 public constant BRIDGE_REFUND_INITIATOR = Roles.BRIDGE_REFUND_INITIATOR;
    bytes32 public constant BRIDGE_REFUND_CONFIRMER = Roles.BRIDGE_REFUND_CONFIRMER;

    // ============ Constants ============

    uint256 public constant BASIS_POINTS = Constants.BASIS_POINTS;
    uint128 public constant DEFAULT_MIN_AMOUNT = 1e18;
    uint128 public constant DEFAULT_MAX_AMOUNT = 1_000_000e18;
    uint256 public constant DEFAULT_FEE_BPS = 10;
    uint256 public constant DEFAULT_DEADLINE = 1 hours;

    // ============ EIP-712 Constants ============

    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // ============ Structs ============

    /**
     * @notice Bridge request structure
     * @dev All fields are included in EIP-712 signature
     */
    struct BridgeRequest {
        uint256 sourceChainId;
        uint256 destChainId;
        address sender;
        bytes32 recipient; // bytes32 to support non-EVM destinations (e.g. Solana 32-byte pubkeys)
        uint256 amount; // Raw token amount (OkuMoney is non-rebasing)
        uint256 nonce;
        uint256 deadline;
    }

    // ============ Events ============

    /// @notice Emitted when tokens are burned to initiate a bridge transfer
    /// @param requestId Unique identifier for this bridge request
    /// @param sender Address that initiated the bridge
    /// @param recipient Recipient address on destination (bytes32 for non-EVM compatibility)
    /// @param sourceChainId Chain ID where burn occurred
    /// @param destChainId Destination chain ID
    /// @param grossAmount Total tokens sent by user (before fees)
    /// @param netAmount Tokens that will be minted on destination (after fees)
    /// @param feeAmount Fee deducted (grossAmount - netAmount)
    /// @param nonce Sequential nonce for this destination
    /// @param deadline Timestamp after which signature expires
    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount,
        uint256 nonce,
        uint256 deadline
    );

    /// @notice Emitted when tokens are minted on destination chain
    /// @param requestId Unique identifier for this bridge request
    /// @param recipient Recipient address (bytes32 for consistency with BridgeBurn)
    /// @param sourceChainId Chain where tokens were burned
    /// @param destChainId Chain where tokens are being minted (current chain)
    /// @param amount Tokens minted
    event BridgeMint(
        bytes32 indexed requestId,
        bytes32 indexed recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 amount
    );

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);

    /// @notice Emitted when bridge limits are updated
    /// @param oldMinAmount Previous minimum amount
    /// @param oldMaxAmount Previous maximum amount
    /// @param newMinAmount New minimum amount
    /// @param newMaxAmount New maximum amount
    event LimitsUpdated(
        uint128 oldMinAmount, uint128 oldMaxAmount, uint128 newMinAmount, uint128 newMaxAmount
    );
    event NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce);
    event DustSwept(address indexed recipient, uint256 amount);
    event DeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    /// @notice Emitted when a refund is initiated (step 1 of 2)
    /// @param requestId Bridge request being refunded
    /// @param initiator Address that initiated the refund
    /// @param sender Original sender from the bridge request
    /// @param amount Amount that will be refunded if confirmed
    event RefundInitiated(
        bytes32 indexed requestId, address indexed initiator, address sender, uint256 amount
    );
    event RefundConfirmed(bytes32 indexed requestId, address indexed sender, uint256 amount);
    event RefundCancelled(
        bytes32 indexed requestId, address indexed initiator, address indexed cancelledBy
    );

    // ============ Errors ============

    error UnsupportedChain(uint256 chainId);
    error CannotBridgeToSelf();
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error AmountAboveMaximum(uint256 amount, uint256 maximum);
    error InvalidSignature();
    error SignatureExpired();
    error WrongChain(uint256 expected, uint256 actual);
    error WrongSourceChain(uint256 expected, uint256 actual);
    error AlreadyProcessed(bytes32 requestId);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error InvalidFee(uint256 fee);
    error InvalidLimits(uint128 min, uint128 max);
    error AlreadyRefunded(bytes32 requestId);
    error MintWindowStillOpen();
    error RefundNotInitiated(bytes32 requestId);
    error InitiatorCannotConfirm();
    error NotInitiatorOrAdmin();
    error DeadlineMustBePositive();
    error ChainAlreadySupported();
    error ChainNotSupported();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initialization ============

    /**
     * @notice Initialize the bridge contract
     * @param _okuMoney OkuMoney token address
     * @param _authorizedSigner Orchestrator's authorized signer address
     * @param _feeRecipient Address to receive bridge fees
     * @param _admin Admin address for role management
     * @param initialChains Array of chain IDs to support at initialization
     */
    function initialize(
        address _okuMoney,
        address _authorizedSigner,
        address _feeRecipient,
        address _admin,
        uint256[] calldata initialChains
    )
        external
        initializer
    {
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (_authorizedSigner == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("OkuBridge", "1");
        __ReentrancyGuard_init();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.authorizedSigner = _authorizedSigner;
        $.feeRecipient = _feeRecipient;
        $.limits = BridgeLimits({min: DEFAULT_MIN_AMOUNT, max: DEFAULT_MAX_AMOUNT});
        $.bridgeFee = DEFAULT_FEE_BPS;
        $.bridgeDeadline = DEFAULT_DEADLINE;

        // Grant all roles to admin
        // NOTE: BRIDGE_REFUND_INITIATOR and BRIDGE_REFUND_CONFIRMER must be reassigned to
        // DIFFERENT keys post-deployment for proper security. See contract NatSpec.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(BRIDGE_SIGNER_MANAGER, _admin);
        _grantRole(BRIDGE_PAUSER, _admin);
        _grantRole(BRIDGE_UNPAUSER, _admin);
        _grantRole(BRIDGE_CHAIN_MANAGER, _admin);
        _grantRole(BRIDGE_LIMITS_MANAGER, _admin);
        _grantRole(BRIDGE_NONCE_ADMIN, _admin);
        _grantRole(BRIDGE_REFUND_INITIATOR, _admin);
        _grantRole(BRIDGE_REFUND_CONFIRMER, _admin);
        _grantRole(BRIDGE_FEE_MANAGER, _admin);
        _grantRole(BRIDGE_UPGRADER, _admin);
        _grantRole(BRIDGE_DUST_SWEEPER, _admin);

        // Configure initial supported chains (excluding self-chain)
        for (uint256 i = 0; i < initialChains.length; i++) {
            uint256 chainId = initialChains[i];
            if (chainId != block.chainid) {
                $.supportedChains[chainId] = true;
                emit ChainAdded(chainId);
            }
        }
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getOkuBridgeStorage().okuMoney;
    }

    function authorizedSigner() public view returns (address) {
        return _getOkuBridgeStorage().authorizedSigner;
    }

    function feeRecipient() public view returns (address) {
        return _getOkuBridgeStorage().feeRecipient;
    }

    function bridgeFee() public view returns (uint256) {
        return _getOkuBridgeStorage().bridgeFee;
    }

    function minBridgeAmount() public view returns (uint128) {
        return _getOkuBridgeStorage().limits.min;
    }

    function maxBridgeAmount() public view returns (uint128) {
        return _getOkuBridgeStorage().limits.max;
    }

    function limits() public view returns (BridgeLimits memory) {
        return _getOkuBridgeStorage().limits;
    }

    function supportedChains(uint256 chainId) public view returns (bool) {
        return _getOkuBridgeStorage().supportedChains[chainId];
    }

    function outboundNonce(uint256 destChainId) public view returns (uint256) {
        return _getOkuBridgeStorage().outboundNonce[destChainId];
    }

    function processedRequests(bytes32 requestId) public view returns (bool) {
        return _getOkuBridgeStorage().processedRequests[requestId];
    }

    function refundedRequests(bytes32 requestId) public view returns (bool) {
        return _getOkuBridgeStorage().refundedRequests[requestId];
    }

    function bridgeDeadline() public view returns (uint256) {
        return _getOkuBridgeStorage().bridgeDeadline;
    }

    function pendingRefundInitiator(bytes32 requestId) public view returns (address) {
        return _getOkuBridgeStorage().pendingRefundInitiator[requestId];
    }

    // ============ Core Bridge Functions ============

    /**
     * @notice Burn tokens on source chain to initiate bridge transfer
     * @param destChainId Destination chain ID
     * @param recipient Recipient address on destination chain
     * @param amount Number of tokens to bridge
     * @return requestId Unique identifier for this bridge request
     */
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 amount
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        // Validate recipient
        if (recipient == bytes32(0)) revert ZeroAddress();

        // Prevent bridging to the same chain (belt-and-suspenders with addSupportedChain guard)
        if (destChainId == block.chainid) revert CannotBridgeToSelf();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        // Validate destination chain
        if (!$.supportedChains[destChainId]) {
            revert UnsupportedChain(destChainId);
        }

        // Validate amount against packed limits
        BridgeLimits memory lim = $.limits;
        if (amount < lim.min) {
            revert AmountBelowMinimum(amount, lim.min);
        }
        if (amount > lim.max) {
            revert AmountAboveMaximum(amount, lim.max);
        }

        // Calculate fee in tokens (subtractive model: fee comes out of bridged amount)
        uint256 feeAmount = (amount * $.bridgeFee) / BASIS_POINTS;
        // Net amount the recipient will receive on destination
        uint256 netAmount = amount - feeAmount;

        // Transfer tokens from caller, then self-burn (Circle model: burn only own tokens)
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), amount);
        $.okuMoney.burn(amount);

        // Mint fee to fee recipient
        if (feeAmount > 0) {
            $.okuMoney.mint($.feeRecipient, feeAmount);
        }

        // Get and increment nonce
        uint256 nonce = $.outboundNonce[destChainId];
        $.outboundNonce[destChainId] = nonce + 1;

        // Construct request (encodes netAmount — what destination will mint)
        BridgeRequest memory request = BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: msg.sender,
            recipient: recipient,
            amount: netAmount,
            nonce: nonce,
            deadline: block.timestamp + $.bridgeDeadline
        });

        // Calculate request ID
        requestId = keccak256(abi.encode(request));

        // Emit event for orchestrator to observe
        emit BridgeBurn(
            requestId,
            msg.sender,
            recipient,
            block.chainid,
            destChainId,
            amount, // grossAmount (user sent)
            netAmount, // netAmount (after fee)
            feeAmount,
            nonce,
            request.deadline
        );
    }

    /**
     * @notice Mint tokens on destination chain with valid orchestrator signature
     * @param request Bridge request details
     * @param signature EIP-712 signature from authorized signer
     */
    function bridgeMint(
        BridgeRequest calldata request,
        bytes calldata signature
    )
        external
        whenNotPaused
        nonReentrant
    {
        // Validate destination chain
        if (request.destChainId != block.chainid) {
            revert WrongChain(request.destChainId, block.chainid);
        }

        // Prevent minting with source == destination (should never happen with valid orchestrator)
        if (request.sourceChainId == block.chainid) {
            revert CannotBridgeToSelf();
        }

        // A signed zero-amount mint is a no-op that still permanently marks the
        // requestId as processed — refuse to record it.
        if (request.amount == 0) revert ZeroAmount();

        // For EVM destinations the recipient must fit in 20 bytes — reject any
        // bytes32 that has non-zero high bytes to avoid silent address truncation
        // from an orchestrator bug.
        if (uint256(request.recipient) >> 160 != 0) revert InvalidRecipient();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        // Validate that the source chain is a known supported chain
        if (!$.supportedChains[request.sourceChainId]) {
            revert UnsupportedChain(request.sourceChainId);
        }

        // Validate deadline
        if (block.timestamp > request.deadline) {
            revert SignatureExpired();
        }

        // Calculate request ID
        bytes32 requestId = keccak256(abi.encode(request));

        // Prevent replay
        if ($.processedRequests[requestId]) {
            revert AlreadyProcessed(requestId);
        }
        $.processedRequests[requestId] = true;

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.amount,
                request.nonce,
                request.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        if (signer != $.authorizedSigner) {
            revert InvalidSignature();
        }

        // Extract EVM address from bytes32 recipient
        address mintTo = address(uint160(uint256(request.recipient)));
        if (mintTo == address(0)) revert ZeroAddress();

        // Mint tokens directly (OkuMoney is non-rebasing, no share conversion)
        $.okuMoney.mint(mintTo, request.amount);

        // Emit event
        emit BridgeMint(
            requestId, request.recipient, request.sourceChainId, request.destChainId, request.amount
        );
    }

    // ============ Two-Step Refund Functions ============

    /**
     * @notice Step 1: Propose a refund for a failed bridge request
     * @dev Called by BRIDGE_REFUND_INITIATOR after independently verifying the destination
     *      mint did not occur. Records the proposal on-chain; a separate key must confirm.
     * @param request Original bridge request
     */
    function initiateRefund(BridgeRequest calldata request)
        external
        whenNotPaused
        onlyRole(BRIDGE_REFUND_INITIATOR)
    {
        // Refund must be initiated on the source chain (where tokens were burned)
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }

        // Refund only valid after mint window has closed
        if (block.timestamp <= request.deadline) revert MintWindowStillOpen();

        bytes32 requestId = keccak256(abi.encode(request));

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        // Cannot refund a request that was already minted on destination
        if ($.processedRequests[requestId]) revert AlreadyProcessed(requestId);

        // Cannot re-initiate if already refunded
        if ($.refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        // Record the initiator — confirmRefund will verify msg.sender differs
        $.pendingRefundInitiator[requestId] = msg.sender;

        emit RefundInitiated(requestId, msg.sender, request.sender, request.amount);
    }

    /**
     * @notice Step 2: Confirm and execute a proposed refund
     * @dev Called by BRIDGE_REFUND_CONFIRMER after independently verifying the destination
     *      mint did not occur. Caller must be a different address than the initiator.
     *
     *      Check ordering is deliberate:
     *      1. processedRequests  — primary double-mint guard; checked first regardless of proposal state
     *      2. refundedRequests   — replay protection on the refund itself
     *      3. pending proposal   — dual-role defense-in-depth on top of the above
     *      4. key separation     — confirmer != initiator address
     * @param request Original bridge request
     */
    function confirmRefund(BridgeRequest calldata request)
        external
        whenNotPaused
        nonReentrant
        onlyRole(BRIDGE_REFUND_CONFIRMER)
    {
        // Refund must be confirmed on the source chain (where tokens were burned)
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }

        bytes32 requestId = keccak256(abi.encode(request));

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        // Primary double-mint guard: reject if bridgeMint already executed on destination.
        // This is the most important check — evaluated first so it cannot be bypassed by
        // proposal state or role manipulation.
        if ($.processedRequests[requestId]) revert AlreadyProcessed(requestId);

        // Replay protection: cannot refund the same request twice
        if ($.refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        // Require a pending proposal recorded by the initiator step
        address initiator = $.pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);

        // Enforce key separation: confirmer must be a different address than the initiator.
        // Prevents a single compromised key from completing the full refund flow unilaterally.
        if (msg.sender == initiator) revert InitiatorCannotConfirm();

        // Mark refunded and clear pending proposal atomically
        $.refundedRequests[requestId] = true;
        delete $.pendingRefundInitiator[requestId];

        // Mint tokens back to original sender (raw amount, no share conversion)
        $.okuMoney.mint(request.sender, request.amount);

        emit RefundConfirmed(requestId, request.sender, request.amount);
    }

    /**
     * @notice Cancel a pending refund proposal
     * @dev Allows the original initiator or any DEFAULT_ADMIN_ROLE holder to withdraw a stale
     *      or erroneous proposal before it is confirmed. This is a safety valve — if the
     *      initiator made an error (e.g., the destination mint actually succeeded after the
     *      proposal was recorded), the proposal can be cancelled before the confirmer acts.
     *      Only pending proposals can be cancelled; already-confirmed refunds are immutable.
     * @param request Original bridge request whose pending proposal should be cancelled
     */
    function cancelRefund(BridgeRequest calldata request) external whenNotPaused {
        bytes32 requestId = keccak256(abi.encode(request));

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        address initiator = $.pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);

        // Only the original initiator or an admin can cancel
        bool isInitiator = msg.sender == initiator;
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!isInitiator && !isAdmin) revert NotInitiatorOrAdmin();

        delete $.pendingRefundInitiator[requestId];

        emit RefundCancelled(requestId, initiator, msg.sender);
    }

    // ============ Admin Recovery Functions ============

    /**
     * @notice Skip a nonce for stuck requests
     * @dev Allows subsequent bridges to proceed even if one request fails
     * @param destChainId Destination chain to skip nonce for
     */
    function skipNonce(uint256 destChainId) external onlyRole(BRIDGE_NONCE_ADMIN) {
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 skippedNonce = $.outboundNonce[destChainId];
        $.outboundNonce[destChainId] = skippedNonce + 1;
        emit NonceSkipped(destChainId, skippedNonce);
    }

    // ============ Admin Configuration Functions ============

    /**
     * @notice Update the authorized signer address
     * @param newSigner New signer address
     */
    function updateAuthorizedSigner(address newSigner) external onlyRole(BRIDGE_SIGNER_MANAGER) {
        if (newSigner == address(0)) revert ZeroAddress();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        address oldSigner = $.authorizedSigner;
        $.authorizedSigner = newSigner;
        emit SignerUpdated(oldSigner, newSigner);
    }

    /**
     * @notice Update the bridge fee
     * @param newFee New fee in basis points (max 10000 = 100%)
     */
    function updateFee(uint256 newFee) external onlyRole(BRIDGE_FEE_MANAGER) {
        if (newFee > BASIS_POINTS) revert InvalidFee(newFee);
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 oldFee = $.bridgeFee;
        $.bridgeFee = newFee;
        emit FeeUpdated(oldFee, newFee);
    }

    /**
     * @notice Update the fee recipient address
     * @param newRecipient New fee recipient address
     */
    function updateFeeRecipient(address newRecipient) external onlyRole(BRIDGE_FEE_MANAGER) {
        if (newRecipient == address(0)) revert ZeroAddress();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        address oldRecipient = $.feeRecipient;
        $.feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /**
     * @notice Add a supported destination chain
     * @param chainId Chain ID to add
     */
    function addSupportedChain(uint256 chainId) external onlyRole(BRIDGE_CHAIN_MANAGER) {
        // Prevent adding the current chain as a destination (no same-chain bridges)
        if (chainId == block.chainid) revert CannotBridgeToSelf();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        // Only emit if chain wasn't already supported
        if ($.supportedChains[chainId]) revert ChainAlreadySupported();
        $.supportedChains[chainId] = true;
        emit ChainAdded(chainId);
    }

    /**
     * @notice Remove a supported destination chain
     * @param chainId Chain ID to remove
     */
    function removeSupportedChain(uint256 chainId) external onlyRole(BRIDGE_CHAIN_MANAGER) {
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        // Only emit if chain was actually supported
        if (!$.supportedChains[chainId]) revert ChainNotSupported();
        $.supportedChains[chainId] = false;
        emit ChainRemoved(chainId);
    }

    /**
     * @notice Update minimum and maximum bridge limits (atomically)
     * @param min New minimum token amount (uint128)
     * @param max New maximum token amount (uint128)
     */
    function updateLimits(uint128 min, uint128 max) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        if (min > max) revert InvalidLimits(min, max);
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        BridgeLimits memory oldLimits = $.limits;
        $.limits = BridgeLimits({min: min, max: max});
        emit LimitsUpdated(oldLimits.min, oldLimits.max, min, max);
    }

    /**
     * @notice Update the bridge deadline for new requests
     * @param newDeadline New deadline duration in seconds
     */
    function updateDeadline(uint256 newDeadline) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        if (newDeadline == 0) revert DeadlineMustBePositive();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 oldDeadline = $.bridgeDeadline;
        $.bridgeDeadline = newDeadline;
        emit DeadlineUpdated(oldDeadline, newDeadline);
    }

    /**
     * @notice Pause the bridge
     */
    function pause() external onlyRole(BRIDGE_PAUSER) {
        _pause();
    }

    /**
     * @notice Unpause the bridge
     */
    function unpause() external onlyRole(BRIDGE_UNPAUSER) {
        _unpause();
    }

    // ============ Dust Recovery ============

    /**
     * @notice Sweep accumulated rounding dust (at most 1 wei per bridge tx)
     * @dev Transfers the bridge's entire OkuMoney balance to feeRecipient
     */
    function sweepDust() external onlyRole(BRIDGE_DUST_SWEEPER) {
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 balance = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (balance > 0) {
            IERC20(address($.okuMoney)).safeTransfer($.feeRecipient, balance);
            emit DustSwept($.feeRecipient, balance);
        }
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(BRIDGE_UPGRADER)
    {}

    // ============ View Functions ============

    /**
     * @notice Get the EIP-712 domain separator
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Hash typed data for EIP-712 (exposed for testing)
     */
    function hashTypedDataV4(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }
}
