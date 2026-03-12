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
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

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
 */
contract OkuBridge is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    // ============ State Variables ============

    /// @notice OkuMoney token contract
    IOkuMoney public okuMoney;

    /// @notice Authorized signer address (orchestrator's KMS public key)
    address public authorizedSigner;

    /// @notice Address that receives bridge fees
    address public feeRecipient;

    /// @notice Bridge fee in basis points (10 = 0.1%, 100 = 1%)
    uint256 public bridgeFee;

    /// @notice Minimum token amount that can be bridged
    uint256 public minBridgeAmount;

    /// @notice Maximum token amount that can be bridged
    uint256 public maxBridgeAmount;

    /// @notice Supported destination chains
    mapping(uint256 => bool) public supportedChains;

    /// @notice Outbound nonce tracking per destination chain (source chain only)
    mapping(uint256 => uint256) public outboundNonce;

    /// @notice Processed request IDs (destination chain only)
    mapping(bytes32 => bool) public processedRequests;

    /// @notice Refunded request IDs (prevents replay of refunds)
    mapping(bytes32 => bool) public refundedRequests;

    /// @notice Configurable bridge deadline for requests
    uint256 public bridgeDeadline;

    /// @notice Pending refund proposals (requestId => initiator address)
    /// @dev Set by BRIDGE_REFUND_INITIATOR; cleared and acted on by BRIDGE_REFUND_CONFIRMER
    mapping(bytes32 => address) public pendingRefundInitiator;

    // ============ Role Constants ============

    bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
    bytes32 public constant BRIDGE_PAUSER = keccak256("BRIDGE_PAUSER");
    bytes32 public constant BRIDGE_UNPAUSER = keccak256("BRIDGE_UNPAUSER");
    bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");
    bytes32 public constant BRIDGE_NONCE_ADMIN = keccak256("BRIDGE_NONCE_ADMIN");
    bytes32 public constant BRIDGE_CHAIN_MANAGER = keccak256("BRIDGE_CHAIN_MANAGER");
    bytes32 public constant BRIDGE_LIMITS_MANAGER = keccak256("BRIDGE_LIMITS_MANAGER");
    bytes32 public constant BRIDGE_UPGRADER = keccak256("BRIDGE_UPGRADER");
    bytes32 public constant BRIDGE_DUST_SWEEPER = keccak256("BRIDGE_DUST_SWEEPER");

    /// @notice First step of two-step refund: proposes a refund after independent verification
    bytes32 public constant BRIDGE_REFUND_INITIATOR = keccak256("BRIDGE_REFUND_INITIATOR");

    /// @notice Second step of two-step refund: confirms and executes after independent verification
    /// @dev Must be held by a different key than BRIDGE_REFUND_INITIATOR
    bytes32 public constant BRIDGE_REFUND_CONFIRMER = keccak256("BRIDGE_REFUND_CONFIRMER");

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

    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    );

    event BridgeMint(
        bytes32 indexed requestId, bytes32 indexed recipient, uint256 sourceChainId, uint256 amount
    );

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);
    event LimitsUpdated(uint256 minAmount, uint256 maxAmount);
    event NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce);
    event DustSwept(address indexed recipient, uint256 amount);
    event DeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    /// @notice Emitted when BRIDGE_REFUND_INITIATOR proposes a refund
    event RefundInitiated(bytes32 indexed requestId, address indexed initiator);

    /// @notice Emitted when BRIDGE_REFUND_CONFIRMER executes a proposed refund
    event RefundConfirmed(bytes32 indexed requestId, address indexed sender, uint256 amount);

    /// @notice Emitted when a pending refund proposal is cancelled by the initiator or an admin
    event RefundCancelled(
        bytes32 indexed requestId, address indexed initiator, address indexed cancelledBy
    );

    // ============ Constants ============

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant DEFAULT_MIN_AMOUNT = 1e18;
    uint256 public constant DEFAULT_MAX_AMOUNT = 1_000_000e18;
    uint256 public constant DEFAULT_FEE_BPS = 10;
    uint256 public constant DEFAULT_DEADLINE = 1 hours;

    // ============ Errors ============

    error UnsupportedChain(uint256 chainId);
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error AmountAboveMaximum(uint256 amount, uint256 maximum);
    error InvalidSignature();
    error SignatureExpired();
    error WrongChain(uint256 expected, uint256 actual);
    error WrongSourceChain(uint256 expected, uint256 actual);
    error AlreadyProcessed(bytes32 requestId);
    error ZeroAddress();
    error InvalidFee(uint256 fee);
    error InvalidLimits(uint256 min, uint256 max);
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

        okuMoney = IOkuMoney(_okuMoney);
        authorizedSigner = _authorizedSigner;
        feeRecipient = _feeRecipient;

        // Default limits (can be updated later)
        minBridgeAmount = DEFAULT_MIN_AMOUNT;
        maxBridgeAmount = DEFAULT_MAX_AMOUNT;
        bridgeFee = DEFAULT_FEE_BPS;
        bridgeDeadline = DEFAULT_DEADLINE;

        // Grant all roles to admin
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
                supportedChains[chainId] = true;
                emit ChainAdded(chainId);
            }
        }
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
        if (destChainId == block.chainid) revert UnsupportedChain(destChainId);

        // Validate destination chain
        if (!supportedChains[destChainId]) {
            revert UnsupportedChain(destChainId);
        }

        // Validate amount
        if (amount < minBridgeAmount) {
            revert AmountBelowMinimum(amount, minBridgeAmount);
        }
        if (amount > maxBridgeAmount) {
            revert AmountAboveMaximum(amount, maxBridgeAmount);
        }

        // Calculate fee in tokens (subtractive model: fee comes out of bridged amount)
        uint256 feeAmount = (amount * bridgeFee) / 10_000;
        // Net amount the recipient will receive on destination
        uint256 netAmount = amount - feeAmount;

        // Transfer tokens from caller, then self-burn (Circle model: burn only own tokens)
        IERC20(address(okuMoney)).safeTransferFrom(msg.sender, address(this), amount);
        okuMoney.burn(amount);

        // Mint fee to fee recipient
        if (feeAmount > 0) {
            okuMoney.mint(feeRecipient, feeAmount);
        }

        // Get and increment nonce
        uint256 nonce = outboundNonce[destChainId];
        outboundNonce[destChainId] = nonce + 1;

        // Construct request (encodes netAmount — what destination will mint)
        BridgeRequest memory request = BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: msg.sender,
            recipient: recipient,
            amount: netAmount,
            nonce: nonce,
            deadline: block.timestamp + bridgeDeadline
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
            netAmount,
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

        // Validate that the source chain is a known supported chain
        if (!supportedChains[request.sourceChainId]) {
            revert UnsupportedChain(request.sourceChainId);
        }

        // Validate deadline
        if (block.timestamp > request.deadline) {
            revert SignatureExpired();
        }

        // Calculate request ID
        bytes32 requestId = keccak256(abi.encode(request));

        // Prevent replay
        if (processedRequests[requestId]) {
            revert AlreadyProcessed(requestId);
        }
        processedRequests[requestId] = true;

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

        if (signer != authorizedSigner) {
            revert InvalidSignature();
        }

        // Extract EVM address from bytes32 recipient
        address mintTo = address(uint160(uint256(request.recipient)));
        if (mintTo == address(0)) revert ZeroAddress();

        // Mint tokens directly (OkuMoney is non-rebasing, no share conversion)
        okuMoney.mint(mintTo, request.amount);

        // Emit event
        emit BridgeMint(requestId, request.recipient, request.sourceChainId, request.amount);
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
        onlyRole(BRIDGE_REFUND_INITIATOR)
    {
        // Refund must be initiated on the source chain (where tokens were burned)
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }

        // Refund only valid after mint window has closed
        if (block.timestamp <= request.deadline) revert MintWindowStillOpen();

        bytes32 requestId = keccak256(abi.encode(request));

        // Cannot refund a request that was already minted on destination
        if (processedRequests[requestId]) revert AlreadyProcessed(requestId);

        // Cannot re-initiate if already refunded
        if (refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        // Record the initiator — confirmRefund will verify msg.sender differs
        pendingRefundInitiator[requestId] = msg.sender;

        emit RefundInitiated(requestId, msg.sender);
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
        onlyRole(BRIDGE_REFUND_CONFIRMER)
    {
        // Refund must be confirmed on the source chain (where tokens were burned)
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }

        bytes32 requestId = keccak256(abi.encode(request));

        // Primary double-mint guard: reject if bridgeMint already executed on destination.
        // This is the most important check — evaluated first so it cannot be bypassed by
        // proposal state or role manipulation.
        if (processedRequests[requestId]) revert AlreadyProcessed(requestId);

        // Replay protection: cannot refund the same request twice
        if (refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        // Require a pending proposal recorded by the initiator step
        address initiator = pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);

        // Enforce key separation: confirmer must be a different address than the initiator.
        // Prevents a single compromised key from completing the full refund flow unilaterally.
        if (msg.sender == initiator) revert InitiatorCannotConfirm();

        // Mark refunded and clear pending proposal atomically
        refundedRequests[requestId] = true;
        delete pendingRefundInitiator[requestId];

        // Mint tokens back to original sender (raw amount, no share conversion)
        okuMoney.mint(request.sender, request.amount);

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
    function cancelRefund(BridgeRequest calldata request) external {
        bytes32 requestId = keccak256(abi.encode(request));

        address initiator = pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);

        // Only the original initiator or an admin can cancel
        bool isInitiator = msg.sender == initiator;
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!isInitiator && !isAdmin) revert NotInitiatorOrAdmin();

        delete pendingRefundInitiator[requestId];

        emit RefundCancelled(requestId, initiator, msg.sender);
    }

    // ============ Admin Recovery Functions ============

    /**
     * @notice Skip a nonce for stuck requests
     * @dev Allows subsequent bridges to proceed even if one request fails
     * @param destChainId Destination chain to skip nonce for
     */
    function skipNonce(uint256 destChainId) external onlyRole(BRIDGE_NONCE_ADMIN) {
        uint256 skippedNonce = outboundNonce[destChainId];
        outboundNonce[destChainId] = skippedNonce + 1;
        emit NonceSkipped(destChainId, skippedNonce);
    }

    // ============ Admin Configuration Functions ============

    /**
     * @notice Update the authorized signer address
     * @param newSigner New signer address
     */
    function updateAuthorizedSigner(address newSigner) external onlyRole(BRIDGE_SIGNER_MANAGER) {
        if (newSigner == address(0)) revert ZeroAddress();
        address oldSigner = authorizedSigner;
        authorizedSigner = newSigner;
        emit SignerUpdated(oldSigner, newSigner);
    }

    /**
     * @notice Update the bridge fee
     * @param newFee New fee in basis points (max 10000 = 100%)
     */
    function updateFee(uint256 newFee) external onlyRole(BRIDGE_FEE_MANAGER) {
        if (newFee > 10_000) revert InvalidFee(newFee);
        uint256 oldFee = bridgeFee;
        bridgeFee = newFee;
        emit FeeUpdated(oldFee, newFee);
    }

    /**
     * @notice Update the fee recipient address
     * @param newRecipient New fee recipient address
     */
    function updateFeeRecipient(address newRecipient) external onlyRole(BRIDGE_FEE_MANAGER) {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /**
     * @notice Add a supported destination chain
     * @param chainId Chain ID to add
     */
    function addSupportedChain(uint256 chainId) external onlyRole(BRIDGE_CHAIN_MANAGER) {
        // Prevent adding the current chain as a destination (no same-chain bridges)
        if (chainId == block.chainid) revert UnsupportedChain(chainId);
        // Only emit if chain wasn't already supported
        if (supportedChains[chainId]) revert ChainAlreadySupported();
        supportedChains[chainId] = true;
        emit ChainAdded(chainId);
    }

    /**
     * @notice Remove a supported destination chain
     * @param chainId Chain ID to remove
     */
    function removeSupportedChain(uint256 chainId) external onlyRole(BRIDGE_CHAIN_MANAGER) {
        // Only emit if chain was actually supported
        if (!supportedChains[chainId]) revert ChainNotSupported();
        supportedChains[chainId] = false;
        emit ChainRemoved(chainId);
    }

    /**
     * @notice Update minimum and maximum bridge limits
     * @param min New minimum token amount
     * @param max New maximum token amount
     */
    function updateLimits(uint256 min, uint256 max) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        if (min > max) revert InvalidLimits(min, max);
        minBridgeAmount = min;
        maxBridgeAmount = max;
        emit LimitsUpdated(min, max);
    }

    /**
     * @notice Update the bridge deadline for new requests
     * @param newDeadline New deadline duration in seconds
     */
    function updateDeadline(uint256 newDeadline) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        if (newDeadline == 0) revert DeadlineMustBePositive();
        uint256 oldDeadline = bridgeDeadline;
        bridgeDeadline = newDeadline;
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
        uint256 balance = IERC20(address(okuMoney)).balanceOf(address(this));
        if (balance > 0) {
            IERC20(address(okuMoney)).safeTransfer(feeRecipient, balance);
            emit DustSwept(feeRecipient, balance);
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

    // ============ Storage Gap ============

    /**
     * Storage layout:
     * - okuMoney: 1 slot
     * - authorizedSigner: 1 slot
     * - feeRecipient: 1 slot
     * - bridgeFee: 1 slot
     * - minBridgeAmount: 1 slot
     * - maxBridgeAmount: 1 slot
     * - supportedChains mapping: 1 slot (mapping head)
     * - outboundNonce mapping: 1 slot (mapping head)
     * - processedRequests mapping: 1 slot (mapping head)
     * - refundedRequests mapping: 1 slot (mapping head)
     * - bridgeDeadline: 1 slot
     * - pendingRefundInitiator mapping: 1 slot (mapping head)
     * Total: 12 slots used
     * Gap: 50 - 12 = 38 slots
     */
    uint256[38] private __gap;
}
