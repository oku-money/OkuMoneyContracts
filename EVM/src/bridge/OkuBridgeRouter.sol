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
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";

interface IOkuBridgeNative {
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 amount
    )
        external
        returns (bytes32 requestId);
}

interface IBridgeAdapter {
    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        payable;
}

/**
 * @title OkuBridgeRouter
 * @notice Entry point for bridging OkuMoney and OkuDollar across chains
 * @dev Provides two explicit bridge paths:
 *
 *   NATIVE PATH — delegates to OkuBridge directly. OkuBridge owns its own burn lifecycle
 *   (burn, fee collection, nonce, EIP-712 signed mint on destination). The router only
 *   normalizes the input token (unwrapping OkuDollar if needed) before handing off.
 *     bridge_usdOku(usdAmount, destChain, recipient)
 *     bridge_OkuM(okuMAmount, destChain, recipient)
 *
 *   ADAPTER PATH — router is the burn authority. It burns OkuMoney then calls a message-only
 *   adapter shim (NTT, CCIP, etc.) that delivers the cross-chain message. The third-party
 *   protocol handles destination minting natively.
 *     bridgeWrappedVia(usdAmount, adapter, destChain, recipient)
 *     bridgeVia(okuMAmount, adapter, destChain, recipient)
 *
 *   Since OkuMoney is a standard non-rebasing ERC-20, no share conversion is needed.
 *   Token amounts are passed directly to the bridge.
 */
contract OkuBridgeRouter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ Roles ============

    bytes32 public constant ROUTER_UPGRADER = keccak256("ROUTER_UPGRADER");
    bytes32 public constant ROUTER_PAUSER = keccak256("ROUTER_PAUSER");
    bytes32 public constant ROUTER_UNPAUSER = keccak256("ROUTER_UNPAUSER");
    bytes32 public constant ADAPTER_MANAGER = keccak256("ADAPTER_MANAGER");
    bytes32 public constant BRIDGE_MANAGER = keccak256("BRIDGE_MANAGER");

    // ============ State ============

    IOkuDollar public usdOku;
    IOkuMoney public okuMoney;

    /// @notice The native OkuBridge contract — handles its own burn, fee, nonce, and event
    IOkuBridgeNative public okuBridge;

    /// @notice Registered third-party bridge adapters (message-only shims)
    mapping(address => bool) public supportedAdapters;

    // ============ Events ============

    /// @notice Emitted when a bridge is initiated via the adapter path
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );

    /// @notice Emitted when a bridge is initiated via the native OkuBridge path
    event NativeBridgeInitiated(
        address indexed user,
        bytes32 indexed requestId,
        uint256 amount,
        uint256 destinationChain,
        bytes32 recipient
    );

    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);

    // ============ Errors ============

    error UnsupportedAdapter(address adapter);
    error InvalidRecipient();
    error ZeroAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _usdOku,
        address _okuMoney,
        address _okuBridge,
        address admin
    )
        public
        initializer
    {
        if (_usdOku == address(0)) revert ZeroAddress();
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (_okuBridge == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();

        usdOku = IOkuDollar(_usdOku);
        okuMoney = IOkuMoney(_okuMoney);
        okuBridge = IOkuBridgeNative(_okuBridge);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_UPGRADER, admin);
        _grantRole(ROUTER_PAUSER, admin);
        _grantRole(ROUTER_UNPAUSER, admin);
        _grantRole(ADAPTER_MANAGER, admin);
        _grantRole(BRIDGE_MANAGER, admin);
    }

    // ============ Native Bridge Path ============
    // OkuBridge owns its own burn lifecycle. The router only normalizes the token
    // (unwrapping OkuDollar if needed) before handing off to OkuBridge.bridgeBurn().
    // OkuBridge burns the full amount, deducts feeAmount, and emits netAmount.

    /**
     * @notice Bridge OkuDollar to another chain via the native OkuBridge
     * @dev OkuDollar is unwrapped to OkuMoney (price-aware); OkuBridge then burns the tokens.
     *      Destination: mint OkuMoney → wrap → deliver OkuDollar.
     * @param usdAmount Amount of OkuDollar to bridge
     * @param destinationChain Destination chain ID (must be configured in OkuBridge)
     * @param recipient Recipient address on destination chain
     * @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
     */
    function bridge_usdOku(
        uint256 usdAmount,
        uint256 destinationChain,
        bytes32 recipient
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        if (recipient == bytes32(0)) revert InvalidRecipient();

        // Pull OkuDollar from user
        IERC20(address(usdOku)).safeTransferFrom(msg.sender, address(this), usdAmount);

        // Unwrap OkuDollar → get OkuMoney (price-aware, reverts if vault undercollateralized)
        uint256 okuMAmount = usdOku.unwrap(usdAmount, address(this));

        // Approve OkuBridge to pull OkuMoney (bridgeBurn uses safeTransferFrom)
        IERC20(address(okuMoney)).approve(address(okuBridge), okuMAmount);

        // OkuBridge pulls OkuMoney, self-burns, deducts fee, emits BridgeBurn
        // No share conversion needed — pass raw token amount directly
        requestId = okuBridge.bridgeBurn(destinationChain, recipient, okuMAmount);

        // Revoke any remaining approval
        IERC20(address(okuMoney)).approve(address(okuBridge), 0);

        emit NativeBridgeInitiated(msg.sender, requestId, usdAmount, destinationChain, recipient);
    }

    /**
     * @notice Bridge OkuMoney directly to another chain via the native OkuBridge
     * @dev Standard ERC-20 token amounts — no share conversion needed.
     * @param okuMAmount Amount of OkuMoney to bridge (token units)
     * @param destinationChain Destination chain ID (must be configured in OkuBridge)
     * @param recipient Recipient address on destination chain
     * @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
     */
    function bridge_OkuM(
        uint256 okuMAmount,
        uint256 destinationChain,
        bytes32 recipient
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        if (recipient == bytes32(0)) revert InvalidRecipient();

        IERC20(address(okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);

        // Approve OkuBridge to pull OkuMoney (bridgeBurn uses safeTransferFrom)
        IERC20(address(okuMoney)).approve(address(okuBridge), okuMAmount);

        // OkuBridge pulls OkuMoney, self-burns, deducts fee, emits BridgeBurn
        // No share conversion needed — pass raw token amount directly
        requestId = okuBridge.bridgeBurn(destinationChain, recipient, okuMAmount);

        // Revoke any remaining approval
        IERC20(address(okuMoney)).approve(address(okuBridge), 0);

        emit NativeBridgeInitiated(msg.sender, requestId, okuMAmount, destinationChain, recipient);
    }

    // ============ Adapter Bridge Path ============
    // The router is the burn authority. It burns OkuMoney then calls a message-only adapter
    // shim. The third-party protocol (NTT, CCIP, etc.) handles destination minting natively.

    /**
     * @notice Bridge OkuDollar to another chain via a registered third-party adapter
     * @dev OkuDollar is unwrapped (price-aware) and OkuMoney burned by this contract;
     *      adapter delivers the cross-chain message only. The third-party protocol
     *      handles destination minting.
     * @param usdAmount Amount of OkuDollar to bridge
     * @param adapter Registered IBridgeAdapter address (e.g. NttAdapter, CcipAdapter)
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeWrappedVia(
        uint256 usdAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (!supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        // Pull OkuDollar from user
        IERC20(address(usdOku)).safeTransferFrom(msg.sender, address(this), usdAmount);

        // Unwrap OkuDollar → get OkuMoney (price-aware, reverts if vault undercollateralized)
        uint256 okuMAmount = usdOku.unwrap(usdAmount, address(this));

        okuMoney.burn(okuMAmount);
        IBridgeAdapter(adapter).bridge{value: msg.value}(
            address(okuMoney), okuMAmount, destinationChain, recipient
        );

        emit BridgeInitiated(msg.sender, adapter, okuMAmount, destinationChain, recipient);
    }

    /**
     * @notice Bridge OkuMoney directly to another chain via a registered third-party adapter
     * @dev OkuMoney is burned by this contract; adapter delivers the cross-chain message only.
     * @param okuMAmount Amount of OkuMoney to bridge
     * @param adapter Registered IBridgeAdapter address (e.g. NttAdapter, CcipAdapter)
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeVia(
        uint256 okuMAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (!supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address(okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);

        okuMoney.burn(okuMAmount);
        IBridgeAdapter(adapter).bridge{value: msg.value}(
            address(okuMoney), okuMAmount, destinationChain, recipient
        );

        emit BridgeInitiated(msg.sender, adapter, okuMAmount, destinationChain, recipient);
    }

    // ============ Admin Functions ============

    function configureAdapter(address adapter, bool supported) external onlyRole(ADAPTER_MANAGER) {
        supportedAdapters[adapter] = supported;
        emit AdapterConfigured(adapter, supported);
    }

    function updateOkuBridge(address newBridge) external onlyRole(BRIDGE_MANAGER) {
        if (newBridge == address(0)) revert ZeroAddress();
        address old = address(okuBridge);
        okuBridge = IOkuBridgeNative(newBridge);
        emit OkuBridgeUpdated(old, newBridge);
    }

    function pause() external onlyRole(ROUTER_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(ROUTER_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(ROUTER_UPGRADER)
    {}

    // ============ Storage Gap ============

    uint256[46] private __gap;
}
