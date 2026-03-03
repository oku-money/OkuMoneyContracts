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
import {IOkuUSD} from "../interfaces/IOkuUSD.sol";

/**
 * @title OkuBridge
 * @notice Orchestrator-signed cross-chain bridge for OkuUSD using burn-and-mint pattern
 * @dev Operates on shares (not token amounts) to avoid rebasing complications during transit
 *
 * Architecture:
 * 1. Source Chain: User calls bridgeBurn() → burns shares, collects fee, emits event
 * 2. Off-Chain: Orchestrator observes event, waits for finality, signs with EIP-712
 * 3. Destination Chain: Orchestrator (or user) calls bridgeMint() → validates signature, mints shares
 *
 * Key Design:
 * - Uses shares to preserve value across rebasing events
 * - EIP-712 signatures for structured data signing
 * - Sequential nonces per destination on source chain
 * - Request ID tracking on destination to prevent replay
 * - Fee collected in shares on source chain
 * - Admin recovery mechanisms for edge cases
 */
contract OkuBridge is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    // ============ State Variables ============

    /// @notice OkuUSD token contract
    IOkuUSD public okuUsd;

    /// @notice Authorized signer address (orchestrator's KMS public key)
    address public authorizedSigner;

    /// @notice Address that receives bridge fees
    address public feeRecipient;

    /// @notice Bridge fee in basis points (10 = 0.1%, 100 = 1%)
    uint256 public bridgeFee;

    /// @notice Minimum shares that can be bridged
    uint256 public minBridgeShares;

    /// @notice Maximum shares that can be bridged
    uint256 public maxBridgeShares;

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

    // ============ Role Constants ============

    bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
    bytes32 public constant BRIDGE_PAUSER = keccak256("BRIDGE_PAUSER");
    bytes32 public constant BRIDGE_UNPAUSER = keccak256("BRIDGE_UNPAUSER");
    bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");
    bytes32 public constant BRIDGE_NONCE_ADMIN = keccak256("BRIDGE_NONCE_ADMIN");
    bytes32 public constant BRIDGE_CHAIN_MANAGER = keccak256("BRIDGE_CHAIN_MANAGER");
    bytes32 public constant BRIDGE_LIMITS_MANAGER = keccak256("BRIDGE_LIMITS_MANAGER");
    bytes32 public constant BRIDGE_REFUND_ADMIN = keccak256("BRIDGE_REFUND_ADMIN");
    bytes32 public constant BRIDGE_UPGRADER = keccak256("BRIDGE_UPGRADER");

    // ============ EIP-712 Constants ============

    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 shares,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant DUST_SWEEPER = keccak256("DUST_SWEEPER");

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
        uint256 shares; // Shares, not token amounts!
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
        uint256 shares,
        uint256 nonce,
        uint256 deadline
    );

    event BridgeMint(
        bytes32 indexed requestId, bytes32 indexed recipient, uint256 sourceChainId, uint256 shares
    );

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);
    event LimitsUpdated(uint256 minShares, uint256 maxShares);
    event NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce);
    event RefundProcessed(bytes32 indexed requestId, address indexed sender, uint256 shares);
    event DustSwept(address indexed recipient, uint256 amount);
    event DeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    // ============ Errors ============

    error UnsupportedChain(uint256 chainId);
    error AmountBelowMinimum(uint256 shares, uint256 minimum);
    error AmountAboveMaximum(uint256 shares, uint256 maximum);
    error InvalidSignature();
    error SignatureExpired();
    error WrongChain(uint256 expected, uint256 actual);
    error AlreadyProcessed(bytes32 requestId);
    error ZeroAddress();
    error InvalidFee(uint256 fee);
    error InvalidLimits(uint256 min, uint256 max);
    error AlreadyRefunded(bytes32 requestId);
    error MintWindowStillOpen();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initialization ============

    /**
     * @notice Initialize the bridge contract
     * @param _okuUsd OkuUSD token address
     * @param _authorizedSigner Orchestrator's authorized signer address
     * @param _feeRecipient Address to receive bridge fees
     * @param _admin Admin address for role management
     */
    function initialize(
        address _okuUsd,
        address _authorizedSigner,
        address _feeRecipient,
        address _admin
    )
        external
        initializer
    {
        if (_okuUsd == address(0)) revert ZeroAddress();
        if (_authorizedSigner == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("OkuBridge", "1");

        okuUsd = IOkuUSD(_okuUsd);
        authorizedSigner = _authorizedSigner;
        feeRecipient = _feeRecipient;

        // Default limits (can be updated later)
        minBridgeShares = 1e18; // 1 share minimum
        maxBridgeShares = 1_000_000e18; // 1M shares maximum
        bridgeFee = 10; // 0.1% (10 basis points)
        bridgeDeadline = 1 hours;

        // Grant all roles to admin
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(BRIDGE_SIGNER_MANAGER, _admin);
        _grantRole(BRIDGE_PAUSER, _admin);
        _grantRole(BRIDGE_UNPAUSER, _admin);
        _grantRole(BRIDGE_CHAIN_MANAGER, _admin);
        _grantRole(BRIDGE_LIMITS_MANAGER, _admin);
        _grantRole(BRIDGE_NONCE_ADMIN, _admin);
        _grantRole(BRIDGE_REFUND_ADMIN, _admin);
        _grantRole(BRIDGE_FEE_MANAGER, _admin);
        _grantRole(BRIDGE_UPGRADER, _admin);
        _grantRole(DUST_SWEEPER, _admin);

        // Configure common chains
        supportedChains[1] = true; // Ethereum
        supportedChains[10] = true; // Optimism
        supportedChains[8453] = true; // Base
        supportedChains[42_161] = true; // Arbitrum
    }

    // ============ Core Bridge Functions ============

    /**
     * @notice Burn shares on source chain to initiate bridge transfer
     * @param destChainId Destination chain ID
     * @param recipient Recipient address on destination chain
     * @param shares Number of shares to bridge
     * @return requestId Unique identifier for this bridge request
     */
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 shares
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        // Validate recipient
        if (recipient == bytes32(0)) revert ZeroAddress();

        // Validate destination chain
        if (!supportedChains[destChainId]) {
            revert UnsupportedChain(destChainId);
        }

        // Validate amount
        if (shares < minBridgeShares) {
            revert AmountBelowMinimum(shares, minBridgeShares);
        }
        if (shares > maxBridgeShares) {
            revert AmountAboveMaximum(shares, maxBridgeShares);
        }

        // Calculate fee in shares (subtractive model: fee comes out of bridged amount)
        uint256 feeShares = (shares * bridgeFee) / 10_000;
        // Net shares the recipient will receive on destination
        uint256 netShares = shares - feeShares;

        // Transfer tokens from caller, then self-burn (Circle model: burn only own tokens)
        uint256 burnTokenAmount = okuUsd.sharesToTokens(shares);
        IERC20(address(okuUsd)).safeTransferFrom(msg.sender, address(this), burnTokenAmount);
        okuUsd.burn(burnTokenAmount);

        // Mint fee to fee recipient (OkuUSD.mint takes token amount)
        if (feeShares > 0) {
            okuUsd.mint(feeRecipient, okuUsd.sharesToTokens(feeShares));
        }

        // Get and increment nonce
        uint256 nonce = outboundNonce[destChainId];
        outboundNonce[destChainId] = nonce + 1;

        // Construct request (encodes netShares — what destination will mint)
        BridgeRequest memory request = BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: msg.sender,
            recipient: recipient,
            shares: netShares,
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
            netShares,
            nonce,
            request.deadline
        );
    }

    /**
     * @notice Mint shares on destination chain with valid orchestrator signature
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
                request.shares,
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

        // Convert shares to tokens and mint (OkuUSD.mint takes token amount)
        uint256 tokensToMint = okuUsd.sharesToTokens(request.shares);
        okuUsd.mint(mintTo, tokensToMint);

        // Emit event
        emit BridgeMint(requestId, request.recipient, request.sourceChainId, request.shares);
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

    /**
     * @notice Refund shares for failed bridge request
     * @dev Used when destination mint fails and cannot be completed
     * @param request Original bridge request
     */
    function refundFailedRequest(
        BridgeRequest calldata request,
        bytes calldata /* proof */
    )
        external
        onlyRole(BRIDGE_REFUND_ADMIN)
    {
        // Deadline-based safety: refund only after mint window has closed.
        // bridgeMint requires block.timestamp <= request.deadline, so once the
        // deadline passes, the mint window is closed and refund is safe.
        if (block.timestamp <= request.deadline) revert MintWindowStillOpen();

        // Calculate request ID
        bytes32 requestId = keccak256(abi.encode(request));

        // Prevent refund replay
        if (refundedRequests[requestId]) revert AlreadyRefunded(requestId);
        refundedRequests[requestId] = true;

        // Convert shares to tokens and mint back to original sender
        uint256 tokensToMint = okuUsd.sharesToTokens(request.shares);
        okuUsd.mint(request.sender, tokensToMint);

        emit RefundProcessed(requestId, request.sender, request.shares);
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
        supportedChains[chainId] = true;
        emit ChainAdded(chainId);
    }

    /**
     * @notice Remove a supported destination chain
     * @param chainId Chain ID to remove
     */
    function removeSupportedChain(uint256 chainId) external onlyRole(BRIDGE_CHAIN_MANAGER) {
        supportedChains[chainId] = false;
        emit ChainRemoved(chainId);
    }

    /**
     * @notice Update minimum and maximum bridge limits
     * @param min New minimum shares
     * @param max New maximum shares
     */
    function updateLimits(uint256 min, uint256 max) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        if (min > max) revert InvalidLimits(min, max);
        minBridgeShares = min;
        maxBridgeShares = max;
        emit LimitsUpdated(min, max);
    }

    /**
     * @notice Update the bridge deadline for new requests
     * @param newDeadline New deadline duration in seconds
     */
    function updateDeadline(uint256 newDeadline) external onlyRole(BRIDGE_LIMITS_MANAGER) {
        require(newDeadline > 0, "Deadline must be positive");
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
     * @dev Transfers the bridge's entire OkuUSD balance to feeRecipient
     */
    function sweepDust() external onlyRole(DUST_SWEEPER) {
        uint256 balance = IERC20(address(okuUsd)).balanceOf(address(this));
        if (balance > 0) {
            IERC20(address(okuUsd)).safeTransfer(feeRecipient, balance);
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

    uint256[39] private __gap;
}
