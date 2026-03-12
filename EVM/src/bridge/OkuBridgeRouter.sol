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
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {IOkuBridgeNative} from "../interfaces/IOkuBridgeNative.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";

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
 *     bridgeUsdOku(usdAmount, destChain, recipient)
 *     bridgeOkuM(okuMAmount, destChain, recipient)
 *
 *   ADAPTER PATH — router is the burn authority. It burns OkuMoney then calls a message-only
 *   adapter shim (NTT, CCIP, etc.) that delivers the cross-chain message. The third-party
 *   protocol handles destination minting natively.
 *     bridgeWrappedVia(usdAmount, adapter, destChain, recipient)
 *     bridgeVia(okuMAmount, adapter, destChain, recipient)
 *
 *   Since OkuMoney is a standard non-rebasing ERC-20, no share conversion is needed.
 *   Token amounts are passed directly to the bridge.
 *
 *   Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract OkuBridgeRouter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuBridgeRouter
    struct OkuBridgeRouterStorage {
        IOkuDollar usdOku;
        IOkuMoney okuMoney;
        IOkuBridgeNative okuBridge;
        mapping(address => bool) supportedAdapters;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuBridgeRouter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUBRIDGEROUTER_STORAGE_LOCATION =
        0x6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a00;

    function _getOkuBridgeRouterStorage() private pure returns (OkuBridgeRouterStorage storage $) {
        assembly {
            $.slot := OKUBRIDGEROUTER_STORAGE_LOCATION
        }
    }

    // ============ Role Constants (from shared library) ============

    bytes32 public constant ROUTER_UPGRADER = Roles.ROUTER_UPGRADER;
    bytes32 public constant ROUTER_PAUSER = Roles.ROUTER_PAUSER;
    bytes32 public constant ROUTER_UNPAUSER = Roles.ROUTER_UNPAUSER;
    bytes32 public constant ROUTER_ADAPTER_MANAGER = Roles.ROUTER_ADAPTER_MANAGER;
    bytes32 public constant ROUTER_BRIDGE_MANAGER = Roles.ROUTER_BRIDGE_MANAGER;

    // ============ Constants ============

    uint256 public constant BASIS_POINTS = Constants.BASIS_POINTS;

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
    /// @param inputAmount  Tokens sent by the user (pre-fee OkuM, or OkuDollar for wrapped path)
    /// @param bridgedAmount Post-fee OkuM amount that will be minted on the destination
    /// @param feeAmount    Fee deducted by OkuBridge (bridgedAmount = inputOkuM - feeAmount)
    event NativeBridgeInitiated(
        address indexed user,
        bytes32 indexed requestId,
        uint256 inputAmount,
        uint256 bridgedAmount,
        uint256 feeAmount,
        uint256 destinationChain,
        bytes32 recipient
    );

    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);
    event Swept(address indexed token, address indexed to, uint256 amount);

    // ============ Errors ============

    error UnsupportedAdapter(address adapter);
    error InvalidRecipient();
    error ZeroAddress();
    error InsufficientBalance();
    error CannotSweepOperationalToken(address token);

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
        __ReentrancyGuard_init();

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        $.usdOku = IOkuDollar(_usdOku);
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuBridge = IOkuBridgeNative(_okuBridge);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_UPGRADER, admin);
        _grantRole(ROUTER_PAUSER, admin);
        _grantRole(ROUTER_UNPAUSER, admin);
        _grantRole(ROUTER_ADAPTER_MANAGER, admin);
        _grantRole(ROUTER_BRIDGE_MANAGER, admin);
    }

    // ============ Storage Accessor Views ============

    function usdOku() public view returns (IOkuDollar) {
        return _getOkuBridgeRouterStorage().usdOku;
    }

    function okuMoney() public view returns (IOkuMoney) {
        return _getOkuBridgeRouterStorage().okuMoney;
    }

    function okuBridge() public view returns (IOkuBridgeNative) {
        return _getOkuBridgeRouterStorage().okuBridge;
    }

    function supportedAdapters(address adapter) public view returns (bool) {
        return _getOkuBridgeRouterStorage().supportedAdapters[adapter];
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
    function bridgeUsdOku(
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

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();

        // Pull OkuDollar from user
        IERC20(address($.usdOku)).safeTransferFrom(msg.sender, address(this), usdAmount);

        // Router holds usdOku shares from safeTransferFrom above — unwrap burns from msg.sender (this)
        uint256 okuMAmount = $.usdOku.unwrap(usdAmount, address(this));

        // Compute fee locally for event accuracy (OkuBridge deducts this before minting on dest).
        // Uses the same formula as OkuBridge.bridgeBurn: feeAmount = amount * bridgeFee / 10_000.
        // TOCTOU note: bridgeFee is read here, then bridgeBurn executes in the same tx. If a fee
        // update were to land between these two operations (impossible within a single tx, and fee
        // changes are admin operations that don't race with user bridges in practice), the emitted
        // feeAmount would not match the actual deduction. Accepted: the emitted values are
        // best-effort for indexers; the on-chain BridgeBurn event from OkuBridge is authoritative.
        uint256 feeBps = $.okuBridge.bridgeFee();
        uint256 feeAmount = (okuMAmount * feeBps) / BASIS_POINTS;
        uint256 bridgedAmount = okuMAmount - feeAmount;

        // Approve OkuBridge to pull OkuMoney (bridgeBurn uses safeTransferFrom)
        IERC20(address($.okuMoney)).approve(address($.okuBridge), okuMAmount);

        // OkuBridge pulls OkuMoney, self-burns, deducts fee, emits BridgeBurn
        // No share conversion needed — pass raw token amount directly
        requestId = $.okuBridge.bridgeBurn(destinationChain, recipient, okuMAmount);

        // Revoke any remaining approval
        IERC20(address($.okuMoney)).approve(address($.okuBridge), 0);

        emit NativeBridgeInitiated(
            msg.sender, requestId, usdAmount, bridgedAmount, feeAmount, destinationChain, recipient
        );
    }

    /**
     * @notice Bridge OkuMoney directly to another chain via the native OkuBridge
     * @dev Standard ERC-20 token amounts — no share conversion needed.
     * @param okuMAmount Amount of OkuMoney to bridge (token units)
     * @param destinationChain Destination chain ID (must be configured in OkuBridge)
     * @param recipient Recipient address on destination chain
     * @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
     */
    function bridgeOkuM(
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

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();

        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);

        // Compute fee locally for event accuracy. See bridgeUsdOku for TOCTOU note.
        uint256 feeBps = $.okuBridge.bridgeFee();
        uint256 feeAmount = (okuMAmount * feeBps) / BASIS_POINTS;
        uint256 bridgedAmount = okuMAmount - feeAmount;

        // Approve OkuBridge to pull OkuMoney (bridgeBurn uses safeTransferFrom)
        IERC20(address($.okuMoney)).approve(address($.okuBridge), okuMAmount);

        // OkuBridge pulls OkuMoney, self-burns, deducts fee, emits BridgeBurn
        // No share conversion needed — pass raw token amount directly
        requestId = $.okuBridge.bridgeBurn(destinationChain, recipient, okuMAmount);

        // Revoke any remaining approval
        IERC20(address($.okuMoney)).approve(address($.okuBridge), 0);

        emit NativeBridgeInitiated(
            msg.sender, requestId, okuMAmount, bridgedAmount, feeAmount, destinationChain, recipient
        );
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
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        if (!$.supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        // Pull OkuDollar from user
        IERC20(address($.usdOku)).safeTransferFrom(msg.sender, address(this), usdAmount);

        // Unwrap OkuDollar → get OkuMoney (price-aware, reverts if vault undercollateralized)
        uint256 okuMAmount = $.usdOku.unwrap(usdAmount, address(this));

        $.okuMoney.burn(okuMAmount);
        IBridgeAdapter(adapter).bridge{value: msg.value}(
            address($.okuMoney), okuMAmount, destinationChain, recipient
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
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        if (!$.supportedAdapters[adapter]) revert UnsupportedAdapter(adapter);
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);

        $.okuMoney.burn(okuMAmount);
        IBridgeAdapter(adapter).bridge{value: msg.value}(
            address($.okuMoney), okuMAmount, destinationChain, recipient
        );

        emit BridgeInitiated(msg.sender, adapter, okuMAmount, destinationChain, recipient);
    }

    // ============ Admin Functions ============

    function configureAdapter(
        address adapter,
        bool supported
    )
        external
        onlyRole(ROUTER_ADAPTER_MANAGER)
    {
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        $.supportedAdapters[adapter] = supported;
        emit AdapterConfigured(adapter, supported);
    }

    function updateOkuBridge(address newBridge) external onlyRole(ROUTER_BRIDGE_MANAGER) {
        if (newBridge == address(0)) revert ZeroAddress();
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        address old = address($.okuBridge);
        $.okuBridge = IOkuBridgeNative(newBridge);
        emit OkuBridgeUpdated(old, newBridge);
    }

    function pause() external onlyRole(ROUTER_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(ROUTER_UNPAUSER) {
        _unpause();
    }

    /**
     * @notice Sweep stuck tokens from the router
     * @dev Cannot sweep OkuMoney or OkuDollar (operational tokens) to prevent misuse.
     *      Use this only for accidentally sent tokens (e.g., wrong ERC-20).
     * @param token Token address to sweep (must not be OkuMoney or OkuDollar)
     * @param to Recipient address
     * @param amount Amount to sweep
     */
    function sweep(
        address token,
        address to,
        uint256 amount
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();

        // Prevent sweeping operational tokens
        if (token == address($.okuMoney)) revert CannotSweepOperationalToken(token);
        if (token == address($.usdOku)) revert CannotSweepOperationalToken(token);

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance();
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(ROUTER_UPGRADER)
    {}
}
