// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for the reviewed-conversion contract suite
 *         (OkuM, USDOku, USDOkuWrapper, SubscriptionModule).
 * @dev Contract-specific prefixes (OKU_, WRAPPER_, SUB_) avoid accidental role
 *      collisions across contracts. See `EVM/README.md § Roles` for who holds
 *      each role and the warm/cold/orchestrator custody split.
 */
library Roles {
    // ============ OkuM roles ============
    bytes32 public constant OKU_UPGRADER = keccak256("OKU_UPGRADER");
    bytes32 public constant OKU_PAUSER = keccak256("OKU_PAUSER");
    bytes32 public constant OKU_UNPAUSER = keccak256("OKU_UNPAUSER");
    bytes32 public constant OKU_MINTER = keccak256("OKU_MINTER");
    bytes32 public constant OKU_BURNER = keccak256("OKU_BURNER");
    bytes32 public constant OKU_BLACKLISTER = keccak256("OKU_BLACKLISTER");
    bytes32 public constant OKU_UNBLACKLISTER = keccak256("OKU_UNBLACKLISTER");
    bytes32 public constant OKU_CAP_MANAGER = keccak256("OKU_CAP_MANAGER");
    bytes32 public constant OKU_ALLOWANCE_MANAGER = keccak256("OKU_ALLOWANCE_MANAGER");
    /// @dev Sets `setOkuMultiplier` / `setUsdOkuRate`. Held by the orchestrator on
    ///      both OkuM and USDOku.
    bytes32 public constant OKU_RATE_SETTER = keccak256("OKU_RATE_SETTER");
    /// @dev `haltAccrual()` (OkuM) / `haltUsdOkuAccrual()` (USDOku). Warm — can only
    ///      stop growth, never set a rate or move a multiplier down.
    bytes32 public constant OKU_GUARDIAN = keccak256("OKU_GUARDIAN");
    /// @dev Cold-only reversal of `haltAccrual()` / `haltUsdOkuAccrual()`. Deliberately
    ///      split from `OKU_GUARDIAN` so a compromised warm key can halt but never
    ///      resume — mirrors the OKU_PAUSER / OKU_UNPAUSER split.
    bytes32 public constant OKU_ACCRUAL_RESUMER = keccak256("OKU_ACCRUAL_RESUMER");

    // ============ USDOku roles ============
    bytes32 public constant USD_UPGRADER = keccak256("USD_UPGRADER");
    bytes32 public constant USD_PAUSER = keccak256("USD_PAUSER");
    bytes32 public constant USD_UNPAUSER = keccak256("USD_UNPAUSER");

    // ============ USDOkuWrapper roles ============
    bytes32 public constant WRAPPER_UPGRADER = keccak256("WRAPPER_UPGRADER");
    /// @dev Disables `wrap()` (sunset step 1). Cannot disable `unwrap()`.
    bytes32 public constant WRAPPER_ADMIN = keccak256("WRAPPER_ADMIN");

    // ============ SubscriptionModule roles ============
    bytes32 public constant SUB_UPGRADER = keccak256("SUB_UPGRADER");
    bytes32 public constant SUB_PAUSER = keccak256("SUB_PAUSER");
    bytes32 public constant SUB_UNPAUSER = keccak256("SUB_UNPAUSER");
    /// @dev `fulfillSubscription` / `fulfillRedemption` / `rejectRequest`. Held by
    ///      the orchestrator, deliberately separate from `OKU_RATE_SETTER` — see
    ///      `EVM/README.md § Rate authority`.
    bytes32 public constant REQUEST_FULFILLER = keccak256("REQUEST_FULFILLER");
    bytes32 public constant SUB_FEE_MANAGER = keccak256("SUB_FEE_MANAGER");
    bytes32 public constant SUB_TREASURY_MANAGER = keccak256("SUB_TREASURY_MANAGER");
    bytes32 public constant SUB_SWEEPER = keccak256("SUB_SWEEPER");
}
