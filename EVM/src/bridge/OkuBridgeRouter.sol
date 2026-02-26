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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuUSD} from "../interfaces/IOkuUSD.sol";

interface IwOkuUSD {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
}

interface IOkuBridgeNative {
    function bridgeBurn(
        uint256 destChainId,
        address recipient,
        uint256 shares
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
        external;
}

/**
 * @title OkuBridgeRouter
 * @notice Entry point for bridging OkuUSD and wOkuUSD across chains
 * @dev Provides two explicit bridge paths:
 *
 *   NATIVE PATH — delegates to OkuBridge directly. OkuBridge owns its own burn lifecycle
 *   (burn, fee collection, nonce, EIP-712 signed mint on destination). The router only
 *   normalizes the input token (redeeming wOkuUSD if needed) before handing off.
 *     bridgeWrapped(wOkuUsdAmount, destChain, recipient)
 *     bridgeDirect(okuUsdAmount, destChain, recipient)
 *
 *   ADAPTER PATH — router is the burn authority. It burns OkuUSD then calls a message-only
 *   adapter shim (NTT, CCIP, etc.) that delivers the cross-chain message. The third-party
 *   protocol handles destination minting natively.
 *     bridgeWrappedVia(wOkuUsdAmount, adapter, destChain, recipient)
 *     bridgeDirectVia(okuUsdAmount, adapter, destChain, recipient)
 */
contract OkuBridgeRouter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
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

    IwOkuUSD public wOkuUsd;
    IOkuUSD public okuUsd;

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
        address recipient
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
        address _wOkuUsd,
        address _okuUsd,
        address _okuBridge,
        address admin
    )
        public
        initializer
    {
        if (_wOkuUsd == address(0)) revert ZeroAddress();
        if (_okuUsd == address(0)) revert ZeroAddress();
        if (_okuBridge == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();

        wOkuUsd = IwOkuUSD(_wOkuUsd);
        okuUsd = IOkuUSD(_okuUsd);
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
    // (redeeming wOkuUSD if needed) before handing off to OkuBridge.bridgeBurn().
    // OkuBridge (as a MINTER on OkuUSD) burns totalShares from this contract, deducts
    // feeShares, and emits netShares = totalShares - feeShares as the bridge amount.

    /**
     * @notice Bridge wOkuUSD to another chain via the native OkuBridge
     * @dev wOkuUSD is redeemed to OkuUSD; OkuBridge then burns from this contract.
     * @param wOkuUsdAmount Amount of wOkuUSD to bridge
     * @param destinationChain Destination chain ID (must be configured in OkuBridge)
     * @param recipient Recipient address on destination chain
     * @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
     */
    function bridgeWrapped(
        uint256 wOkuUsdAmount,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
        returns (bytes32 requestId)
    {
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address(wOkuUsd)).safeTransferFrom(msg.sender, address(this), wOkuUsdAmount);
        uint256 okuUsdAmount = wOkuUsd.redeem(wOkuUsdAmount, address(this), address(this));
        uint256 totalShares = okuUsd.tokensToShares(okuUsdAmount);

        // Approve OkuBridge to pull OkuUSD (bridgeBurn uses safeTransferFrom)
        IERC20(address(okuUsd)).approve(address(okuBridge), okuUsdAmount);

        // OkuBridge pulls OkuUSD, self-burns, deducts fee, emits BridgeBurn
        requestId = okuBridge.bridgeBurn(destinationChain, recipient, totalShares);

        // Revoke any remaining approval
        IERC20(address(okuUsd)).approve(address(okuBridge), 0);

        emit NativeBridgeInitiated(msg.sender, requestId, okuUsdAmount, destinationChain, recipient);
    }

    /**
     * @notice Bridge OkuUSD directly to another chain via the native OkuBridge
     * @dev OkuUSD is converted to shares; OkuBridge pulls and self-burns.
     * @param okuUsdAmount Amount of OkuUSD to bridge (token units, not shares)
     * @param destinationChain Destination chain ID (must be configured in OkuBridge)
     * @param recipient Recipient address on destination chain
     * @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
     */
    function bridgeDirect(
        uint256 okuUsdAmount,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
        returns (bytes32 requestId)
    {
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address(okuUsd)).safeTransferFrom(msg.sender, address(this), okuUsdAmount);
        uint256 totalShares = okuUsd.tokensToShares(okuUsdAmount);

        // Approve OkuBridge to pull OkuUSD (bridgeBurn uses safeTransferFrom)
        IERC20(address(okuUsd)).approve(address(okuBridge), okuUsdAmount);

        // OkuBridge pulls OkuUSD, self-burns, deducts fee, emits BridgeBurn
        requestId = okuBridge.bridgeBurn(destinationChain, recipient, totalShares);

        // Revoke any remaining approval
        IERC20(address(okuUsd)).approve(address(okuBridge), 0);

        emit NativeBridgeInitiated(msg.sender, requestId, okuUsdAmount, destinationChain, recipient);
    }

    // ============ Adapter Bridge Path ============
    // The router is the burn authority. It burns OkuUSD then calls a message-only adapter
    // shim. The third-party protocol (NTT, CCIP, etc.) handles destination minting natively.

    /**
     * @notice Bridge wOkuUSD to another chain via a registered third-party adapter
     * @dev wOkuUSD is redeemed and OkuUSD burned by this contract; adapter delivers the
     *      cross-chain message only. The third-party protocol handles destination minting.
     * @param wOkuUsdAmount Amount of wOkuUSD to bridge
     * @param adapter Registered IBridgeAdapter address (e.g. NttAdapter, CcipAdapter)
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeWrappedVia(
        uint256 wOkuUsdAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
    {
        if (!supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address(wOkuUsd)).safeTransferFrom(msg.sender, address(this), wOkuUsdAmount);
        uint256 okuUsdAmount = wOkuUsd.redeem(wOkuUsdAmount, address(this), address(this));

        okuUsd.burn(okuUsdAmount);
        IBridgeAdapter(adapter).bridge(address(okuUsd), okuUsdAmount, destinationChain, recipient);

        emit BridgeInitiated(msg.sender, adapter, okuUsdAmount, destinationChain, recipient);
    }

    /**
     * @notice Bridge OkuUSD directly to another chain via a registered third-party adapter
     * @dev OkuUSD is burned by this contract; adapter delivers the cross-chain message only.
     * @param okuUsdAmount Amount of OkuUSD to bridge
     * @param adapter Registered IBridgeAdapter address (e.g. NttAdapter, CcipAdapter)
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeDirectVia(
        uint256 okuUsdAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
    {
        if (!supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address(okuUsd)).safeTransferFrom(msg.sender, address(this), okuUsdAmount);

        okuUsd.burn(okuUsdAmount);
        IBridgeAdapter(adapter).bridge(address(okuUsd), okuUsdAmount, destinationChain, recipient);

        emit BridgeInitiated(msg.sender, adapter, okuUsdAmount, destinationChain, recipient);
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
}
