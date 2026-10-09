// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for all OkuMoney contracts
 * @dev Prefixes (OKUM_, VAULT_, PSM_) name the contract a role belongs to. AccessControl is
 *      per-contract: OkuDollar reuses OKUM_BLACKLISTER / OKUM_UNBLACKLISTER hashes, but the
 *      role must be granted on each contract separately.
 */
library Roles {
    // ============ OkuMoney Roles ============
    /// @dev Can upgrade the OkuMoney implementation (UUPS `_authorizeUpgrade`).
    bytes32 public constant OKUM_UPGRADER = keccak256("OKUM_UPGRADER");
    /// @dev Can pause OkuMoney: blocks transfers between holders and `mint`.
    bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
    /// @dev Can unpause OkuMoney.
    bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
    /// @dev Can mint OkuM, bounded by the holder's `minterAllowance`. In production held only
    ///      by LitePSM; `initialize` also grants it (with OKUM_ALLOWANCE_MANAGER) to the admin,
    ///      which renounces both in `grantRolesMainnet`.
    bytes32 public constant OKUM_MINTER = keccak256("OKUM_MINTER");
    /// @dev Separate from `OKUM_MINTER` so burn can be locked down independently.
    bytes32 public constant OKUM_BURNER = keccak256("OKUM_BURNER");
    /// @dev Sets the yield-rate schedule (`setOkuMYieldRate`, `setNextOkuMYieldRate`,
    ///      `setOkuMYieldRateWithSuccessor`) and the emergency `setOkuMMultiplier`.
    bytes32 public constant OKUM_RATE_MANAGER = keccak256("OKUM_RATE_MANAGER");
    /// @dev Can blacklist an address (on whichever contract grants it).
    bytes32 public constant OKUM_BLACKLISTER = keccak256("OKUM_BLACKLISTER");
    /// @dev Can remove an address from the blacklist.
    bytes32 public constant OKUM_UNBLACKLISTER = keccak256("OKUM_UNBLACKLISTER");
    /// @dev Can change OkuMoney's `maxSupply` (`setMaxSupply`).
    bytes32 public constant OKUM_CAP_MANAGER = keccak256("OKUM_CAP_MANAGER");
    /// @dev Can set each minter's remaining allowance (`configureMinterAllowance`).
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");

    // ============ OkuDollar (Vault) Roles ============
    /// @dev Can upgrade the OkuDollar implementation.
    bytes32 public constant VAULT_UPGRADER = keccak256("VAULT_UPGRADER");
    /// @dev Can pause OkuDollar (wrap, unwrap, transfers).
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    /// @dev Can unpause OkuDollar.
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");
    /// @dev Rescues OkuM donated directly to the vault; cannot touch backing.
    bytes32 public constant VAULT_RESCUER = keccak256("VAULT_RESCUER");

    // ============ LitePSM Roles ============
    /// @dev Can upgrade the LitePSM implementation.
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    /// @dev Can pause LitePSM: every mint, redeem and buffer move.
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    /// @dev Can unpause LitePSM.
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    /// @dev Can add USDC to the PSM's redemption buffer (`depositBuffer`).
    bytes32 public constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    /// @dev Can take USDC out of the buffer (`withdrawUsdc`). Trusted: there is no
    ///      solvency check against outstanding OkuM.
    bytes32 public constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");
}
