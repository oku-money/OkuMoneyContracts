// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for all OkuMoney contracts
 * @dev All roles use contract-specific prefixes (OKUM_, VAULT_, PSM_, QUEUE_, BRIDGE_, ROUTER_)
 *      to prevent accidental role collisions across contracts.
 */
library Roles {
    // ============ OkuMoney Roles ============
    bytes32 public constant OKUM_UPGRADER = keccak256("OKUM_UPGRADER");
    bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
    bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
    bytes32 public constant OKUM_MINTER = keccak256("OKUM_MINTER");
    bytes32 public constant OKUM_REBASER = keccak256("OKUM_REBASER");
    bytes32 public constant OKUM_BLACKLISTER = keccak256("OKUM_BLACKLISTER");
    bytes32 public constant OKUM_UNBLACKLISTER = keccak256("OKUM_UNBLACKLISTER");
    bytes32 public constant OKUM_CAP_MANAGER = keccak256("OKUM_CAP_MANAGER");
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");

    // ============ OkuDollar (Vault) Roles ============
    bytes32 public constant VAULT_UPGRADER = keccak256("VAULT_UPGRADER");
    bytes32 public constant VAULT_REBASER = keccak256("VAULT_REBASER");
    bytes32 public constant VAULT_RESERVE_MANAGER = keccak256("VAULT_RESERVE_MANAGER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");

    // ============ LitePSM Roles ============
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant PSM_QUEUE_PROCESSOR = keccak256("PSM_QUEUE_PROCESSOR");
    bytes32 public constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    bytes32 public constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");
    bytes32 public constant PSM_ORACLE_MANAGER = keccak256("PSM_ORACLE_MANAGER");

    // ============ RedemptionQueue Roles ============
    bytes32 public constant QUEUE_UPGRADER = keccak256("QUEUE_UPGRADER");
    bytes32 public constant QUEUE_PSM = keccak256("QUEUE_PSM");
    bytes32 public constant QUEUE_RESCUER = keccak256("QUEUE_RESCUER");

    // ============ OkuBridge Roles ============
    bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
    bytes32 public constant BRIDGE_PAUSER = keccak256("BRIDGE_PAUSER");
    bytes32 public constant BRIDGE_UNPAUSER = keccak256("BRIDGE_UNPAUSER");
    bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");
    bytes32 public constant BRIDGE_NONCE_ADMIN = keccak256("BRIDGE_NONCE_ADMIN");
    bytes32 public constant BRIDGE_CHAIN_MANAGER = keccak256("BRIDGE_CHAIN_MANAGER");
    bytes32 public constant BRIDGE_LIMITS_MANAGER = keccak256("BRIDGE_LIMITS_MANAGER");
    bytes32 public constant BRIDGE_UPGRADER = keccak256("BRIDGE_UPGRADER");
    bytes32 public constant BRIDGE_REFUND_INITIATOR = keccak256("BRIDGE_REFUND_INITIATOR");
    bytes32 public constant BRIDGE_REFUND_CONFIRMER = keccak256("BRIDGE_REFUND_CONFIRMER");

    // ============ OkuBridgeRouter Roles ============
    bytes32 public constant ROUTER_UPGRADER = keccak256("ROUTER_UPGRADER");
    bytes32 public constant ROUTER_PAUSER = keccak256("ROUTER_PAUSER");
    bytes32 public constant ROUTER_UNPAUSER = keccak256("ROUTER_UNPAUSER");
    bytes32 public constant ROUTER_ADAPTER_MANAGER = keccak256("ROUTER_ADAPTER_MANAGER");
    bytes32 public constant ROUTER_BRIDGE_MANAGER = keccak256("ROUTER_BRIDGE_MANAGER");

    // ============ NttAdapter Roles ============
    bytes32 public constant NTT_CONFIGURATOR = keccak256("NTT_CONFIGURATOR");
    bytes32 public constant NTT_RESCUER = keccak256("NTT_RESCUER");
}
