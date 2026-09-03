// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for all OkuMoney contracts
 * @dev All roles use contract-specific prefixes (OKUM_, VAULT_, PSM_, QUEUE_)
 *      to prevent accidental role collisions across contracts.
 */
library Roles {
    // ============ OkuMoney Roles ============
    bytes32 public constant OKUM_UPGRADER = keccak256("OKUM_UPGRADER");
    bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
    bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
    bytes32 public constant OKUM_MINTER = keccak256("OKUM_MINTER");
    /// @dev Split from `OKUM_MINTER` so the burn surface can be locked
    ///      down independently of the mint allowance system. Granted to
    ///      LitePSM at deploy time alongside `OKUM_MINTER` because both
    ///      flows route through the PSM.
    bytes32 public constant OKUM_BURNER = keccak256("OKUM_BURNER");
    bytes32 public constant OKUM_REBASER = keccak256("OKUM_REBASER");
    bytes32 public constant OKUM_BLACKLISTER = keccak256("OKUM_BLACKLISTER");
    bytes32 public constant OKUM_UNBLACKLISTER = keccak256("OKUM_UNBLACKLISTER");
    bytes32 public constant OKUM_CAP_MANAGER = keccak256("OKUM_CAP_MANAGER");
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");

    // ============ OkuDollar (Vault) Roles ============
    bytes32 public constant VAULT_UPGRADER = keccak256("VAULT_UPGRADER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");
    /// @dev Withdraws OkuM donated directly to the vault. Donations accrue to nobody
    ///      under the single-multiplier design (conversions use the multiplier, not
    ///      totalAssets/totalSupply), so without this they would be locked forever.
    ///      Cannot touch OkuM backing outstanding shares.
    bytes32 public constant VAULT_RESCUER = keccak256("VAULT_RESCUER");
    // REMOVED (single-multiplier refactor): VAULT_REBASER — OkuDollar has no rate of
    // its own; accrual is set on OkuMoney via OKUM_REBASER. VAULT_RESERVE_MANAGER and
    // VAULT_ADMIN — collateralization is 1.0 by construction, so there is no surplus
    // to manage and no min-ratio to configure.

    // ============ LitePSM Roles ============
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant PSM_QUEUE_PROCESSOR = keccak256("PSM_QUEUE_PROCESSOR");
    bytes32 public constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    bytes32 public constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");

    // ============ RedemptionQueue Roles ============
    bytes32 public constant QUEUE_UPGRADER = keccak256("QUEUE_UPGRADER");
    bytes32 public constant QUEUE_PSM = keccak256("QUEUE_PSM");
    bytes32 public constant QUEUE_RESCUER = keccak256("QUEUE_RESCUER");
}
