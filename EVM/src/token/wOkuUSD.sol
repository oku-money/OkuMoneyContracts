// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title wOkuUSD
 * @notice Non-rebasing ERC4626 wrapper for OkuUSD
 * @dev Holds OkuUSD as underlying asset. Exchange rate grows as OkuUSD rebases.
 *      Used for integrations with external protocols (Uniswap V3, lending, etc.)
 */
contract wOkuUSD is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant UPGRADER = keccak256("UPGRADER");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 asset_,
        string memory name,
        string memory symbol,
        address admin
    )
        public
        initializer
    {
        __ERC20_init(name, symbol);
        __ERC4626_init(asset_);
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
    }

    /**
     * @notice Returns the total assets held by the vault
     * @dev This grows as the underlying OkuUSD rebases
     */
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER)
    {}
}
