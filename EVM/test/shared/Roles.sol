// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Roles as SrcRoles} from "../../src/lib/Roles.sol";

/**
 * @title TestRoles
 * @notice Re-exports all role keccaks from source + DEFAULT_ADMIN_ROLE
 * @dev Single source of truth for all role constants used in tests.
 *      Import from here instead of duplicating keccak256 calls.
 */
library TestRoles {
    // ============ OpenZeppelin Default ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // ============ OkuMoney Roles (OKUM_ prefix) ============

    bytes32 public constant OKUM_UPGRADER = SrcRoles.OKUM_UPGRADER;
    bytes32 public constant OKUM_PAUSER = SrcRoles.OKUM_PAUSER;
    bytes32 public constant OKUM_UNPAUSER = SrcRoles.OKUM_UNPAUSER;
    bytes32 public constant OKUM_MINTER = SrcRoles.OKUM_MINTER;
    /// @dev Cycle 4 (EVM-15): burn role split from `OKUM_MINTER`.
    bytes32 public constant OKUM_BURNER = SrcRoles.OKUM_BURNER;
    bytes32 public constant OKUM_REBASER = SrcRoles.OKUM_REBASER;
    bytes32 public constant OKUM_BLACKLISTER = SrcRoles.OKUM_BLACKLISTER;
    bytes32 public constant OKUM_UNBLACKLISTER = SrcRoles.OKUM_UNBLACKLISTER;
    bytes32 public constant OKUM_CAP_MANAGER = SrcRoles.OKUM_CAP_MANAGER;
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = SrcRoles.OKUM_ALLOWANCE_MANAGER;

    // ============ OkuDollar Vault Roles (VAULT_ prefix) ============

    bytes32 public constant VAULT_UPGRADER = SrcRoles.VAULT_UPGRADER;
    bytes32 public constant VAULT_REBASER = SrcRoles.VAULT_REBASER;
    bytes32 public constant VAULT_RESERVE_MANAGER = SrcRoles.VAULT_RESERVE_MANAGER;
    bytes32 public constant VAULT_PAUSER = SrcRoles.VAULT_PAUSER;
    bytes32 public constant VAULT_UNPAUSER = SrcRoles.VAULT_UNPAUSER;
    bytes32 public constant VAULT_ADMIN = SrcRoles.VAULT_ADMIN;

    // ============ LitePSM Roles (PSM_ prefix) ============

    bytes32 public constant PSM_UPGRADER = SrcRoles.PSM_UPGRADER;
    bytes32 public constant PSM_PAUSER = SrcRoles.PSM_PAUSER;
    bytes32 public constant PSM_UNPAUSER = SrcRoles.PSM_UNPAUSER;
    bytes32 public constant PSM_QUEUE_PROCESSOR = SrcRoles.PSM_QUEUE_PROCESSOR;
    bytes32 public constant PSM_BUFFER_DEPOSITOR = SrcRoles.PSM_BUFFER_DEPOSITOR;
    bytes32 public constant PSM_BUFFER_WITHDRAWER = SrcRoles.PSM_BUFFER_WITHDRAWER;

    // ============ RedemptionQueue Roles (QUEUE_ prefix) ============

    bytes32 public constant QUEUE_UPGRADER = SrcRoles.QUEUE_UPGRADER;
    bytes32 public constant QUEUE_PSM = SrcRoles.QUEUE_PSM;
    bytes32 public constant QUEUE_RESCUER = SrcRoles.QUEUE_RESCUER;
}
