// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title wOkuUSD
 * @notice Non-rebasing ERC4626 wrapper for OkuUSD
 * @dev Holds OkuUSD as underlying asset. Exchange rate grows as OkuUSD rebases.
 *      Used for integrations with external protocols (Uniswap V3, lending, etc.)
 *      Pause blocks transfers but allows deposit (wrap) and withdraw (unwrap) —
 *      users must always be able to exit, and the vault must always accept deposits.
 */
contract wOkuUSD is
    Initializable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");

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
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
        _grantRole(VAULT_PAUSER, admin);
        _grantRole(VAULT_UNPAUSER, admin);
    }

    /**
     * @notice Returns the total assets held by the vault
     * @dev This grows as the underlying OkuUSD rebases
     */
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    // ============ Pause Management ============

    function pause() external onlyRole(VAULT_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(VAULT_UNPAUSER) {
        _unpause();
    }

    /**
     * @dev Override _update to block transfers when paused.
     *      Mints (from == address(0)) and burns (to == address(0)) are always allowed
     *      so that deposit/withdraw (wrap/unwrap) remain functional during pause.
     *      Only peer-to-peer transfers are blocked.
     */
    function _update(
        address from,
        address to,
        uint256 amount
    )
        internal
        override(ERC20Upgradeable)
    {
        if (from != address(0) && to != address(0)) {
            require(!paused(), "wOkuUSD: transfers paused");
        }
        super._update(from, to, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    uint256[50] private __gap;
}
