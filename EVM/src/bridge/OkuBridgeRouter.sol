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
import {IBridgeAdapter} from "./adapters/IBridgeAdapter.sol";
import {Roles} from "../lib/Roles.sol";
import {Errors} from "../lib/Errors.sol";
import {SafeApprove} from "../lib/SafeApprove.sol";
import {OkuBridgeRouterEvents} from "../lib/events/OkuBridgeRouterEvents.sol";

/**
 * @title OkuBridgeRouter
 * @notice Entry point for bridging OkuMoney and OkuDollar across chains
 * @dev Two explicit bridge paths:
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
 *   OkuMoney is a standard non-rebasing ERC-20 — no share conversion is needed.
 *
 *   Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract OkuBridgeRouter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    OkuBridgeRouterEvents
{
    using SafeERC20 for IERC20;
    using SafeApprove for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuBridgeRouter
    struct OkuBridgeRouterStorage {
        IOkuDollar okuDollar;
        IOkuMoney okuMoney;
        IOkuBridgeNative okuBridge;
        mapping(address => bool) supportedAdapters;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuBridgeRouter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUBRIDGEROUTER_STORAGE_LOCATION =
        0x4f590e9f7334aab7dee655e65a71a07de1bfe97ca02ea9a7eef6211d166e8300;

    function _getOkuBridgeRouterStorage() private pure returns (OkuBridgeRouterStorage storage $) {
        assembly {
            $.slot := OKUBRIDGEROUTER_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    // Common errors (ZeroAddress, InsufficientBalance) live in lib/Errors.sol.
    error UnsupportedAdapter(address adapter);
    error InvalidRecipient();
    error CannotSweepOperationalToken(address token);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuDollar,
        address _okuMoney,
        address _okuBridge,
        address _admin
    )
        public
        initializer
    {
        if (_okuDollar == address(0)) revert Errors.ZeroAddress();
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_okuBridge == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        $.okuDollar = IOkuDollar(_okuDollar);
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuBridge = IOkuBridgeNative(_okuBridge);

        // See {OkuMoney.initialize} for the unified role-grant policy.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.ROUTER_UPGRADER, _admin);
        _grantRole(Roles.ROUTER_PAUSER, _admin);
        _grantRole(Roles.ROUTER_UNPAUSER, _admin);
        _grantRole(Roles.ROUTER_ADAPTER_MANAGER, _admin);
        _grantRole(Roles.ROUTER_BRIDGE_MANAGER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuDollar() public view returns (IOkuDollar) {
        return _getOkuBridgeRouterStorage().okuDollar;
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
    // OkuBridge owns its own burn lifecycle. The router only normalizes the input token
    // (unwrapping OkuDollar if needed) before handing off to OkuBridge.bridgeBurn.

    /// @notice Bridge OkuDollar to another chain via the native OkuBridge.
    /// @dev OkuDollar is unwrapped to OkuMoney (price-aware); OkuBridge then burns the tokens.
    /// @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
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

        IERC20(address($.okuDollar)).safeTransferFrom(msg.sender, address(this), usdAmount);
        // Router holds okuDollar shares from safeTransferFrom; unwrap burns from this contract.
        uint256 okuMAmount = $.okuDollar.unwrap(usdAmount, address(this));

        requestId = _bridgeNative($, usdAmount, okuMAmount, destinationChain, recipient);
    }

    /// @notice Bridge OkuMoney directly to another chain via the native OkuBridge.
    /// @return requestId Bridge request ID from OkuBridge (for orchestrator tracking)
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

        requestId = _bridgeNative($, okuMAmount, okuMAmount, destinationChain, recipient);
    }

    /// @dev Shared core for the native path. Caller must have already deposited `okuMAmount`
    ///      OkuMoney into this contract. Approves OkuBridge, calls bridgeBurn (which pulls,
    ///      self-burns, deducts fee), revokes any leftover allowance, emits the auxiliary
    ///      event with the canonical fee returned by OkuBridge.quoteFee.
    /// @param inputAmount The user-facing input (OkuMoney or OkuDollar amount, used in event)
    function _bridgeNative(
        OkuBridgeRouterStorage storage $,
        uint256 inputAmount,
        uint256 okuMAmount,
        uint256 destinationChain,
        bytes32 recipient
    )
        internal
        returns (bytes32 requestId)
    {
        // OkuBridge.quoteFee is the single source of truth for fee accounting; matches
        // the deduction inside bridgeBurn.
        (uint256 feeAmount, uint256 bridgedAmount) = $.okuBridge.quoteFee(okuMAmount);

        IERC20 okuMoneyToken = IERC20(address($.okuMoney));
        okuMoneyToken.setExactAllowance(address($.okuBridge), okuMAmount);
        // OkuBridge pulls OkuMoney, self-burns, deducts fee, emits BridgeBurn.
        requestId = $.okuBridge.bridgeBurn(destinationChain, recipient, okuMAmount);
        okuMoneyToken.revokeAllowance(address($.okuBridge));

        emit NativeBridgeInitiated(
            msg.sender,
            requestId,
            inputAmount,
            bridgedAmount,
            feeAmount,
            destinationChain,
            recipient
        );
    }

    // ============ Adapter Bridge Path ============
    // The router is the burn authority. It burns OkuMoney then calls a message-only adapter
    // shim. The third-party protocol (NTT, CCIP, etc.) handles destination minting.

    /// @notice Bridge OkuDollar via a registered third-party adapter.
    /// @dev OkuDollar is unwrapped (price-aware) and the resulting OkuMoney is burned by
    ///      this contract; the adapter delivers the cross-chain message only.
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

        IERC20(address($.okuDollar)).safeTransferFrom(msg.sender, address(this), usdAmount);
        // Reverts if vault undercollateralized.
        uint256 okuMAmount = $.okuDollar.unwrap(usdAmount, address(this));

        _bridgeAdapter($, adapter, okuMAmount, destinationChain, recipient);
    }

    /// @notice Bridge OkuMoney via a registered third-party adapter.
    /// @dev OkuMoney is burned by this contract; the adapter delivers the cross-chain message.
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

        _bridgeAdapter($, adapter, okuMAmount, destinationChain, recipient);
    }

    /// @dev Shared core for the adapter path. Caller must have already deposited
    ///      `okuMAmount` OkuMoney into this contract. Burns and forwards to adapter.
    function _bridgeAdapter(
        OkuBridgeRouterStorage storage $,
        address adapter,
        uint256 okuMAmount,
        uint256 destinationChain,
        address recipient
    )
        internal
    {
        $.okuMoney.burn(okuMAmount);
        IBridgeAdapter(adapter).bridge{value: msg.value}(
            address($.okuMoney), okuMAmount, destinationChain, recipient
        );

        emit BridgeInitiated(
            msg.sender, adapter, address($.okuMoney), okuMAmount, destinationChain, recipient
        );
    }

    // ============ Admin Functions ============

    function configureAdapter(
        address adapter,
        bool supported
    )
        external
        onlyRole(Roles.ROUTER_ADAPTER_MANAGER)
    {
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        $.supportedAdapters[adapter] = supported;
        emit AdapterConfigured(adapter, supported);
    }

    function updateOkuBridge(address newBridge) external onlyRole(Roles.ROUTER_BRIDGE_MANAGER) {
        if (newBridge == address(0)) revert Errors.ZeroAddress();
        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        address old = address($.okuBridge);
        $.okuBridge = IOkuBridgeNative(newBridge);
        emit OkuBridgeUpdated(old, newBridge);
    }

    function pause() external onlyRole(Roles.ROUTER_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.ROUTER_UNPAUSER) {
        _unpause();
    }

    /// @notice Sweep stuck non-operational tokens from the router.
    /// @dev Cannot sweep OkuMoney or OkuDollar (operational tokens). Use only for
    ///      accidentally sent ERC-20s.
    function sweep(
        address token,
        address to,
        uint256 amount
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert Errors.ZeroAddress();

        OkuBridgeRouterStorage storage $ = _getOkuBridgeRouterStorage();
        if (token == address($.okuMoney)) revert CannotSweepOperationalToken(token);
        if (token == address($.okuDollar)) revert CannotSweepOperationalToken(token);

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert Errors.InsufficientBalance();
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.ROUTER_UPGRADER)
    {}
}
