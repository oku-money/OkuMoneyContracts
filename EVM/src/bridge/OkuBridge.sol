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
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {OkuBridgeEvents} from "../lib/events/OkuBridgeEvents.sol";
import {IOkuBridgeNative} from "../interfaces/IOkuBridgeNative.sol";

/**
 * @title OkuBridge
 * @notice Orchestrator-signed cross-chain bridge for OkuMoney using burn-and-mint
 * @dev Operates on raw token amounts (OkuMoney is non-rebasing — no share conversion needed).
 *
 * Architecture:
 * 1. Source chain: user calls `bridgeBurn` -> burn tokens, collect fee, emit event
 * 2. Off-chain: orchestrator observes event, waits for finality, signs with EIP-712
 * 3. Destination chain: orchestrator (or user) calls `bridgeMint` -> verify sig, mint tokens
 *
 * Key design:
 * - Raw token amounts (standard ERC-20, no share conversion)
 * - EIP-712 typed-data signatures
 * - Sequential nonces per destination on source chain
 * - Request-id tracking on destination prevents replay
 * - Fee collected in tokens on source chain (subtractive model — `quoteFee` is the
 *   single source of truth)
 * - Two-step refund (BRIDGE_REFUND_INITIATOR + BRIDGE_REFUND_CONFIRMER) defeats single-key
 *   double-mint
 *
 * The burn pattern (`safeTransferFrom` from caller followed by self-burn) follows the Circle
 * FiatToken model — the bridge contract burns only its own balance.
 * Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 * IMPORTANT: BRIDGE_REFUND_INITIATOR and BRIDGE_REFUND_CONFIRMER are both granted to admin
 * at init for deployment convenience; operators MUST delegate one of them to a separate key
 * before the bridge goes live so no single compromised key can complete a refund alone.
 *
 * Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 * See https://eips.ethereum.org/EIPS/eip-7201
 */
contract OkuBridge is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    OkuBridgeEvents,
    IOkuBridgeNative
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

    // ============ EIP-712 Constants ============

    /// @dev MUST stay byte-for-byte aligned with the {BridgeRequest} struct below;
    ///      drift between the typehash literal and the struct silently breaks signatures.
    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // ============ Structs ============

    /// @notice Bridge request structure. All fields are included in the EIP-712 signature.
    struct BridgeRequest {
        uint256 sourceChainId;
        uint256 destChainId;
        address sender;
        bytes32 recipient; // bytes32 to support non-EVM destinations (e.g. Solana 32-byte pubkeys)
        uint256 amount; // Raw token amount (OkuMoney is non-rebasing)
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Init-time configuration grouped to keep `initialize` under stack-depth limits.
    struct InitConfig {
        uint128 minBridgeAmount;
        uint128 maxBridgeAmount;
        uint256 feeBps; // basis points; must be <= Constants.BASIS_POINTS
        uint256 bridgeDeadline; // seconds; must be > 0
    }

    // ============ Errors ============

    // Common errors (ZeroAddress, ZeroAmount) live in lib/Errors.sol.
    error UnsupportedChain(uint256 chainId);
    error CannotBridgeToSelf();
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error AmountAboveMaximum(uint256 amount, uint256 maximum);
    error InvalidSignature();
    error SignatureExpired();
    error WrongChain(uint256 expected, uint256 actual);
    error WrongSourceChain(uint256 expected, uint256 actual);
    error AlreadyProcessed(bytes32 requestId);
    error InvalidRecipient();
    error InvalidFee(uint256 fee);
    error InvalidLimits(uint128 min, uint128 max);
    error AlreadyRefunded(bytes32 requestId);
    error MintWindowStillOpen();
    error RefundNotInitiated(bytes32 requestId);
    error InitiatorCannotConfirm();
    error DeadlineMustBePositive();
    error ChainAlreadySupported();
    error ChainNotSupported();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initialization ============

    /// @notice Initialize the bridge contract.
    /// @dev Chain-specific defaults (limits, fee, deadline) are constructor-supplied so the
    ///      bridge can target any EVM chain without recompilation. Limits and fee can be
    ///      updated post-init by BRIDGE_LIMITS_MANAGER / BRIDGE_FEE_MANAGER.
    ///      See {OkuMoney.initialize} for the unified role-grant policy.
    /// @param _okuMoney OkuMoney token address
    /// @param _authorizedSigner Orchestrator's authorized signer address
    /// @param _feeRecipient Address to receive bridge fees
    /// @param _admin Admin address for role management
    /// @param initialChains Chain IDs to support at initialization
    /// @param config Initial limits / fee / deadline parameters
    function initialize(
        address _okuMoney,
        address _authorizedSigner,
        address _feeRecipient,
        address _admin,
        uint256[] calldata initialChains,
        InitConfig calldata config
    )
        external
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_authorizedSigner == address(0)) revert Errors.ZeroAddress();
        if (_feeRecipient == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (config.minBridgeAmount > config.maxBridgeAmount) {
            revert InvalidLimits(config.minBridgeAmount, config.maxBridgeAmount);
        }
        if (config.feeBps > Constants.BASIS_POINTS) revert InvalidFee(config.feeBps);
        if (config.bridgeDeadline == 0) revert DeadlineMustBePositive();

        __AccessControl_init();
        __Pausable_init();
        // Chain-namespaced EIP-712 domain name. The domain separator already
        // includes `block.chainid`, so cross-chain signature replay is not
        // possible regardless of the name, but namespacing the human-readable
        // domain (e.g. "OkuBridge_Sepolia", "OkuBridge_Base", or
        // "OkuBridge_<chainid>" for chains without a friendly name) prevents
        // wallet UIs from rendering the same prompt on different chains and
        // gives auditors an unambiguous label.
        __EIP712_init(_eip712Name(), "1");
        __ReentrancyGuard_init();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.authorizedSigner = _authorizedSigner;
        $.feeRecipient = _feeRecipient;
        $.limits = BridgeLimits({min: config.minBridgeAmount, max: config.maxBridgeAmount});
        $.bridgeFee = config.feeBps;
        $.bridgeDeadline = config.bridgeDeadline;

        // Note: BRIDGE_REFUND_INITIATOR and BRIDGE_REFUND_CONFIRMER must be reassigned to
        // DIFFERENT keys post-deployment. See contract NatSpec.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.BRIDGE_SIGNER_MANAGER, _admin);
        _grantRole(Roles.BRIDGE_PAUSER, _admin);
        _grantRole(Roles.BRIDGE_UNPAUSER, _admin);
        _grantRole(Roles.BRIDGE_CHAIN_MANAGER, _admin);
        _grantRole(Roles.BRIDGE_LIMITS_MANAGER, _admin);
        _grantRole(Roles.BRIDGE_NONCE_ADMIN, _admin);
        _grantRole(Roles.BRIDGE_REFUND_INITIATOR, _admin);
        _grantRole(Roles.BRIDGE_REFUND_CONFIRMER, _admin);
        _grantRole(Roles.BRIDGE_FEE_MANAGER, _admin);
        _grantRole(Roles.BRIDGE_UPGRADER, _admin);

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

    /// @notice Single source of truth for bridge fee accounting.
    /// @dev Consumed by {bridgeBurn} and by the router when emitting feeAmount on its
    ///      auxiliary events.
    /// @return fee Fee deducted from `amount`
    /// @return net Net amount the destination chain will mint
    function quoteFee(uint256 amount) public view returns (uint256 fee, uint256 net) {
        fee = (amount * _getOkuBridgeStorage().bridgeFee) / Constants.BASIS_POINTS;
        net = amount - fee;
    }

    // ============ Core Bridge Functions ============

    /// @notice Burn tokens on source chain to initiate bridge transfer.
    /// @param destChainId Destination chain ID
    /// @param recipient Recipient address on destination chain
    /// @param amount Number of tokens to bridge (gross, fee is subtracted)
    /// @return requestId Unique identifier for this bridge request
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 amount
    )
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 requestId)
    {
        if (recipient == bytes32(0)) revert Errors.ZeroAddress();
        // Same-chain bridges are nonsensical — defended here even though `addSupportedChain`
        // also rejects them.
        if (destChainId == block.chainid) revert CannotBridgeToSelf();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        if (!$.supportedChains[destChainId]) revert UnsupportedChain(destChainId);

        BridgeLimits memory lim = $.limits;
        if (amount < lim.min) revert AmountBelowMinimum(amount, lim.min);
        if (amount > lim.max) revert AmountAboveMaximum(amount, lim.max);

        (uint256 feeAmount, uint256 netAmount) = quoteFee(amount);

        // Pull tokens from caller, then self-burn (Circle FiatToken model: burn only own balance).
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), amount);
        $.okuMoney.burn(amount);

        if (feeAmount > 0) {
            $.okuMoney.mint($.feeRecipient, feeAmount);
        }

        uint256 nonce = $.outboundNonce[destChainId];
        $.outboundNonce[destChainId] = nonce + 1;

        BridgeRequest memory request = BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: msg.sender,
            recipient: recipient,
            amount: netAmount,
            nonce: nonce,
            deadline: block.timestamp + $.bridgeDeadline
        });

        requestId = keccak256(abi.encode(request));

        emit BridgeBurn(
            requestId,
            msg.sender,
            recipient,
            block.chainid,
            destChainId,
            amount,
            netAmount,
            feeAmount,
            nonce,
            request.deadline
        );
    }

    /// @notice Mint tokens on destination chain with valid orchestrator signature.
    function bridgeMint(
        BridgeRequest calldata request,
        bytes calldata signature
    )
        external
        nonReentrant
        whenNotPaused
    {
        if (request.destChainId != block.chainid) {
            revert WrongChain(request.destChainId, block.chainid);
        }
        if (request.sourceChainId == block.chainid) revert CannotBridgeToSelf();
        // A signed zero-amount mint is a no-op that still permanently marks the requestId
        // as processed — refuse to record it.
        if (request.amount == 0) revert Errors.ZeroAmount();
        // For EVM destinations the recipient must fit in 20 bytes; reject any bytes32
        // that has non-zero high bytes to avoid silent address truncation.
        if (uint256(request.recipient) >> 160 != 0) revert InvalidRecipient();

        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        if (!$.supportedChains[request.sourceChainId]) {
            revert UnsupportedChain(request.sourceChainId);
        }
        if (block.timestamp > request.deadline) revert SignatureExpired();

        bytes32 requestId = keccak256(abi.encode(request));
        if ($.processedRequests[requestId]) revert AlreadyProcessed(requestId);
        $.processedRequests[requestId] = true;

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
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != $.authorizedSigner) revert InvalidSignature();

        address mintTo = address(uint160(uint256(request.recipient)));
        if (mintTo == address(0)) revert Errors.ZeroAddress();

        $.okuMoney.mint(mintTo, request.amount);

        emit BridgeMint(
            requestId, request.recipient, request.sourceChainId, request.destChainId, request.amount
        );
    }

    // ============ Two-Step Refund Functions ============

    /// @notice Step 1: Propose a refund for a failed bridge request.
    /// @dev Called by BRIDGE_REFUND_INITIATOR after independently verifying the destination
    ///      mint did not occur. Records the proposal on-chain; a separate key must confirm.
    function initiateRefund(BridgeRequest calldata request)
        external
        whenNotPaused
        onlyRole(Roles.BRIDGE_REFUND_INITIATOR)
    {
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }
        if (block.timestamp <= request.deadline) revert MintWindowStillOpen();

        bytes32 requestId = keccak256(abi.encode(request));
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        if ($.processedRequests[requestId]) revert AlreadyProcessed(requestId);
        if ($.refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        // Record the initiator — confirmRefund verifies msg.sender differs.
        $.pendingRefundInitiator[requestId] = msg.sender;

        emit RefundInitiated(requestId, msg.sender, request.sender, request.amount);
    }

    /// @notice Step 2: Confirm and execute a proposed refund.
    /// @dev Called by BRIDGE_REFUND_CONFIRMER after independently verifying the destination
    ///      mint did not occur. Caller must be a different address than the initiator.
    ///
    ///      Check ordering is deliberate:
    ///      1. processedRequests  — primary double-mint guard, evaluated first
    ///      2. refundedRequests   — replay protection on the refund itself
    ///      3. pending proposal   — dual-role defense-in-depth on top of the above
    ///      4. key separation     — confirmer != initiator address
    function confirmRefund(BridgeRequest calldata request)
        external
        nonReentrant
        whenNotPaused
        onlyRole(Roles.BRIDGE_REFUND_CONFIRMER)
    {
        if (request.sourceChainId != block.chainid) {
            revert WrongSourceChain(block.chainid, request.sourceChainId);
        }

        bytes32 requestId = keccak256(abi.encode(request));
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        if ($.processedRequests[requestId]) revert AlreadyProcessed(requestId);
        if ($.refundedRequests[requestId]) revert AlreadyRefunded(requestId);

        address initiator = $.pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);
        if (msg.sender == initiator) revert InitiatorCannotConfirm();

        $.refundedRequests[requestId] = true;
        delete $.pendingRefundInitiator[requestId];

        $.okuMoney.mint(request.sender, request.amount);

        emit RefundConfirmed(requestId, request.sender, request.amount);
    }

    /// @notice Cancel a pending refund proposal.
    /// @dev The original initiator may withdraw their own proposal; admins may cancel any.
    ///      Cancellation only applies to pending proposals; confirmed refunds are immutable.
    function cancelRefund(BridgeRequest calldata request) external whenNotPaused {
        bytes32 requestId = keccak256(abi.encode(request));
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();

        address initiator = $.pendingRefundInitiator[requestId];
        if (initiator == address(0)) revert RefundNotInitiated(requestId);

        // Use AccessControl semantics: admins always allowed, and the initiator may
        // cancel their own proposal. Non-admins who weren't the initiator are rejected
        // via the standard AccessControlUnauthorizedAccount revert.
        if (msg.sender != initiator) {
            _checkRole(DEFAULT_ADMIN_ROLE);
        }

        delete $.pendingRefundInitiator[requestId];

        emit RefundCancelled(requestId, initiator, msg.sender);
    }

    // ============ Admin Recovery Functions ============

    /// @notice Skip a nonce for stuck requests so subsequent bridges can proceed.
    function skipNonce(uint256 destChainId) external onlyRole(Roles.BRIDGE_NONCE_ADMIN) {
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 skippedNonce = $.outboundNonce[destChainId];
        $.outboundNonce[destChainId] = skippedNonce + 1;
        emit NonceSkipped(destChainId, skippedNonce);
    }

    // ============ Admin Configuration Functions ============

    function updateAuthorizedSigner(address newSigner)
        external
        onlyRole(Roles.BRIDGE_SIGNER_MANAGER)
    {
        if (newSigner == address(0)) revert Errors.ZeroAddress();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        address oldSigner = $.authorizedSigner;
        $.authorizedSigner = newSigner;
        emit SignerUpdated(oldSigner, newSigner);
    }

    function updateFee(uint256 newFee) external onlyRole(Roles.BRIDGE_FEE_MANAGER) {
        if (newFee > Constants.BASIS_POINTS) revert InvalidFee(newFee);
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 oldFee = $.bridgeFee;
        $.bridgeFee = newFee;
        emit FeeUpdated(oldFee, newFee);
    }

    function updateFeeRecipient(address newRecipient) external onlyRole(Roles.BRIDGE_FEE_MANAGER) {
        if (newRecipient == address(0)) revert Errors.ZeroAddress();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        address oldRecipient = $.feeRecipient;
        $.feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    function addSupportedChain(uint256 chainId) external onlyRole(Roles.BRIDGE_CHAIN_MANAGER) {
        if (chainId == block.chainid) revert CannotBridgeToSelf();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        if ($.supportedChains[chainId]) revert ChainAlreadySupported();
        $.supportedChains[chainId] = true;
        emit ChainAdded(chainId);
    }

    function removeSupportedChain(uint256 chainId) external onlyRole(Roles.BRIDGE_CHAIN_MANAGER) {
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        if (!$.supportedChains[chainId]) revert ChainNotSupported();
        $.supportedChains[chainId] = false;
        emit ChainRemoved(chainId);
    }

    /// @notice Atomically update minimum/maximum bridge limits.
    function updateLimits(uint128 min, uint128 max) external onlyRole(Roles.BRIDGE_LIMITS_MANAGER) {
        if (min > max) revert InvalidLimits(min, max);
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        BridgeLimits memory oldLimits = $.limits;
        $.limits = BridgeLimits({min: min, max: max});
        emit LimitsUpdated(oldLimits.min, oldLimits.max, min, max);
    }

    function updateDeadline(uint256 newDeadline) external onlyRole(Roles.BRIDGE_LIMITS_MANAGER) {
        if (newDeadline == 0) revert DeadlineMustBePositive();
        OkuBridgeStorage storage $ = _getOkuBridgeStorage();
        uint256 oldDeadline = $.bridgeDeadline;
        $.bridgeDeadline = newDeadline;
        emit DeadlineUpdated(oldDeadline, newDeadline);
    }

    function pause() external onlyRole(Roles.BRIDGE_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.BRIDGE_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.BRIDGE_UPGRADER)
    {}

    // ============ View Functions ============

    /// @notice EIP-712 domain separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 typed-data hash.
    /// @dev Exposed publicly so off-chain orchestrator implementations and tests can verify
    ///      digests without re-implementing the domain. Revisit before production if there
    ///      is a desire to reduce the public surface.
    function hashTypedDataV4(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    /// @dev Build the chain-namespaced EIP-712 domain name at init time.
    ///      Returns `OkuBridge_<friendly-name>` for chains in the canonical
    ///      protocol set, or `OkuBridge_<chainid>` for any other chain. The
    ///      result is baked into the EIP-712 domain separator and never
    ///      changes for the life of the proxy.
    ///
    ///      Keep this list in sync with `scripts/config/chains.ts`. Adding a
    ///      new chain here is forward-compatible: existing deployments keep
    ///      their old domain (frozen by `__EIP712_init`); only fresh deploys
    ///      pick up the new label.
    function _eip712Name() private view returns (string memory) {
        uint256 cid = block.chainid;
        if (cid == 1) return "OkuBridge_Mainnet";
        if (cid == 11_155_111) return "OkuBridge_Sepolia";
        if (cid == 10) return "OkuBridge_Optimism";
        if (cid == 11_155_420) return "OkuBridge_OpSepolia";
        if (cid == 42_161) return "OkuBridge_Arbitrum";
        if (cid == 8453) return "OkuBridge_Base";
        if (cid == 84_532) return "OkuBridge_BaseSepolia";
        if (cid == 56) return "OkuBridge_Bsc";
        if (cid == 97) return "OkuBridge_BscTestnet";
        // Unrecognised chain — fall back to the raw chain id so the domain
        // remains unique and human-readable without a code change.
        return string.concat("OkuBridge_", Strings.toString(cid));
    }
}
