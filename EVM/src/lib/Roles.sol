// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for the Oku Money contract suite.
 * @dev Contract-specific prefixes (`OKUM_`, `VAULT_`, `PSM_`) prevent accidental
 *      collisions across contracts sharing an AccessControl surface.
 *
 *      Pause vs. unpause is deliberately split everywhere: halting is a warm-key
 *      action taken under time pressure, resuming is a cold-key action taken after
 *      review. A compromised warm key can stop the protocol but cannot restart it.
 */
library Roles {
    // ============ OkuM ============
    bytes32 public constant OKUM_UPGRADER = keccak256("OKUM_UPGRADER");
    bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
    bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
    bytes32 public constant OKUM_MINTER = keccak256("OKUM_MINTER");
    /// @dev Split from `OKUM_MINTER` so the burn surface can be locked down
    ///      independently of the mint-allowance system. Both are granted to LitePSM
    ///      at deploy time because both flows route through the PSM.
    bytes32 public constant OKUM_BURNER = keccak256("OKUM_BURNER");
    /// @dev Declares OkuM rate segments via `setOkuMRate`. This key sets the price
    ///      every permissionless PSM conversion executes at, so it is the single
    ///      highest-value key in the system. Bounded by `MAX_IMPLIED_APR_BPS`,
    ///      `MAX_RATE_DURATION` and flatline-on-expiry.
    bytes32 public constant OKUM_RATE_SETTER = keccak256("OKUM_RATE_SETTER");
    bytes32 public constant OKUM_BLACKLISTER = keccak256("OKUM_BLACKLISTER");
    bytes32 public constant OKUM_UNBLACKLISTER = keccak256("OKUM_UNBLACKLISTER");
    bytes32 public constant OKUM_CAP_MANAGER = keccak256("OKUM_CAP_MANAGER");
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");

    // ============ USDOku (vault) ============
    bytes32 public constant VAULT_UPGRADER = keccak256("VAULT_UPGRADER");
    /// @dev Declares USDOku's forward-looking rate. Cannot outrun the OkuM backing:
    ///      `setUsdOkuRate` enforces pre-funding against vault reserves.
    bytes32 public constant VAULT_RATE_SETTER = keccak256("VAULT_RATE_SETTER");
    bytes32 public constant VAULT_RESERVE_MANAGER = keccak256("VAULT_RESERVE_MANAGER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");

    // ============ LitePSM ============
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    bytes32 public constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");
    /// @dev The KMS back-end's routine lever: toggles permissionless mint and redeem
    ///      independently, without the ceremony of a full pause. Deliberately separate
    ///      from `PSM_PAUSER` — closing the window to publish a rate is an everyday
    ///      operation, whereas pausing is an incident response.
    bytes32 public constant PSM_GATEKEEPER = keccak256("PSM_GATEKEEPER");
}
