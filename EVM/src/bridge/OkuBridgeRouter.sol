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

interface IwOkuUSD {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
}

interface IOkuUSD {
    function burn(address from, uint256 amount) external;
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
 * @notice Convenience wrapper for bridging wOkuUsd across chains
 * @dev Unwraps wOkuUsd -> burns OkuUSD -> bridges -> mints on destination
 */
contract OkuBridgeRouter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Granular RBAC roles (contract-specific prefixes)
    bytes32 public constant ROUTER_UPGRADER_ROLE = keccak256("ROUTER_UPGRADER_ROLE");
    bytes32 public constant ROUTER_PAUSER_ROLE = keccak256("ROUTER_PAUSER_ROLE");
    bytes32 public constant ROUTER_UNPAUSER_ROLE = keccak256("ROUTER_UNPAUSER_ROLE");
    bytes32 public constant ADAPTER_MANAGER_ROLE = keccak256("ADAPTER_MANAGER_ROLE");

    IwOkuUSD public wOkuUsd;
    IOkuUSD public okuUsd;

    // Supported bridge adapters
    mapping(address => bool) public supportedAdapters;

    // Events
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );
    event AdapterConfigured(address indexed adapter, bool supported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _wOkuUsd, address _okuUsd, address admin) public initializer {
        __AccessControl_init();
        __Pausable_init();

        wOkuUsd = IwOkuUSD(_wOkuUsd);
        okuUsd = IOkuUSD(_okuUsd);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_UPGRADER_ROLE, admin);
        _grantRole(ROUTER_PAUSER_ROLE, admin);
    }

    // ============ Bridge Functions ============

    /**
     * @notice Bridge wrapped OkuUSD to another chain (unwraps first)
     * @param wOkuUsdAmount Amount of wOkuUsd to bridge
     * @param adapter Bridge adapter to use
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeWrapped(
        uint256 wOkuUsdAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
    {
        require(supportedAdapters[adapter], "Unsupported adapter");
        require(recipient != address(0), "Invalid recipient");

        // Transfer wOkuUsd from user
        IERC20(address(wOkuUsd)).safeTransferFrom(msg.sender, address(this), wOkuUsdAmount);

        // Unwrap wOkuUsd to OkuUSD
        uint256 okuUsdAmount = wOkuUsd.redeem(wOkuUsdAmount, address(this), address(this));

        // Burn OkuUSD
        okuUsd.burn(address(this), okuUsdAmount);

        // Bridge via adapter
        IBridgeAdapter(adapter).bridge(address(okuUsd), okuUsdAmount, destinationChain, recipient);

        emit BridgeInitiated(msg.sender, adapter, okuUsdAmount, destinationChain, recipient);
    }

    /**
     * @notice Bridge OkuUSD directly (no unwrapping needed)
     * @param okuUsdAmount Amount of OkuUSD to bridge
     * @param adapter Bridge adapter to use
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridgeDirect(
        uint256 okuUsdAmount,
        address adapter,
        uint256 destinationChain,
        address recipient
    )
        external
        whenNotPaused
    {
        require(supportedAdapters[adapter], "Unsupported adapter");
        require(recipient != address(0), "Invalid recipient");

        // Transfer OkuUSD from user
        IERC20(address(okuUsd)).safeTransferFrom(msg.sender, address(this), okuUsdAmount);

        // Burn OkuUSD
        okuUsd.burn(address(this), okuUsdAmount);

        // Bridge via adapter
        IBridgeAdapter(adapter).bridge(address(okuUsd), okuUsdAmount, destinationChain, recipient);

        emit BridgeInitiated(msg.sender, adapter, okuUsdAmount, destinationChain, recipient);
    }

    // ============ Admin Functions ============

    function configureAdapter(
        address adapter,
        bool supported
    )
        external
        onlyRole(ADAPTER_MANAGER_ROLE)
    {
        supportedAdapters[adapter] = supported;
        emit AdapterConfigured(adapter, supported);
    }

    function pause() external onlyRole(ROUTER_PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ROUTER_UNPAUSER_ROLE) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(ROUTER_UPGRADER_ROLE)
    {}
}
