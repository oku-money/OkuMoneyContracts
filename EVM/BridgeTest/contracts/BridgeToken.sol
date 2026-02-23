// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title BridgeToken
 * @notice Simple ERC-20 token with MINTER for burn/mint bridging
 * @dev Minimal implementation for testing NTT and LayerZero bridging
 */
contract BridgeToken is ERC20, AccessControl {
    bytes32 public constant MINTER = keccak256("MINTER");

    error ZeroAddress();

    constructor(
        string memory name,
        string memory symbol,
        address admin
    ) ERC20(name, symbol) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER, admin);
    }

    /**
     * @notice Mint tokens to an address
     * @param to Recipient address
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER) {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from an address
     * @dev Used by bridge adapters to burn before cross-chain transfer
     * @param from Address to burn from
     * @param amount Amount to burn
     */
    function burn(address from, uint256 amount) external onlyRole(MINTER) {
        _burn(from, amount);
    }
}
