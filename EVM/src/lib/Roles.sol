// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for the OkuDollar contracts.
 * @dev Prefix-namespaced (`OKU_`, `PSM_`, `QUEUE_`) so a grant on one contract
 *      cannot be mistaken for a grant on another. Note that AccessControl
 *      mappings are per-contract regardless: a role must be granted on each
 *      contract that gates on it.
 *
 *      Named `OKU_RATE_SETTER`, not `REBASER` — nothing rebases.
 */
library Roles {
    // ============ OkuDollar (token) ============

    bytes32 internal constant OKU_UPGRADER = keccak256("OKU_UPGRADER");
    bytes32 internal constant OKU_PAUSER = keccak256("OKU_PAUSER");
    bytes32 internal constant OKU_UNPAUSER = keccak256("OKU_UNPAUSER");
    bytes32 internal constant OKU_MINTER = keccak256("OKU_MINTER");
    /// @dev Split from `OKU_MINTER` so the burn surface can be locked down
    ///      independently of the mint-allowance system. Granted to BOTH the
    ///      LitePSM proxy (instant redemptions) and the RedemptionQueue proxy
    ///      (queued redemptions) — both burn.
    bytes32 internal constant OKU_BURNER = keccak256("OKU_BURNER");
    /// @dev Sets the accrual rate. Bounded by `MAX_IMPLIED_APR`,
    ///      `MAX_RATE_DURATION`, monotonicity, and `MAX_MULTIPLIER`.
    bytes32 internal constant OKU_RATE_SETTER = keccak256("OKU_RATE_SETTER");
    /// @dev Can only *withhold* yield via `haltAccrual()` — cannot set a rate and
    ///      cannot reduce an already-accrued multiplier. Monotone-safe, which is
    ///      why it sits on the warm multisig: the abuse ceiling is "yield pauses
    ///      until cold overrides", which is strictly better than being unable to
    ///      stop a compromised rate setter for as long as it takes to convene cold.
    bytes32 internal constant OKU_GUARDIAN = keccak256("OKU_GUARDIAN");
    bytes32 internal constant OKU_BLACKLISTER = keccak256("OKU_BLACKLISTER");
    bytes32 internal constant OKU_UNBLACKLISTER = keccak256("OKU_UNBLACKLISTER");
    bytes32 internal constant OKU_CAP_MANAGER = keccak256("OKU_CAP_MANAGER");
    bytes32 internal constant OKU_ALLOWANCE_MANAGER = keccak256("OKU_ALLOWANCE_MANAGER");

    // ============ LitePSM ============

    bytes32 internal constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 internal constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 internal constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 internal constant PSM_QUEUE_PROCESSOR = keccak256("PSM_QUEUE_PROCESSOR");
    bytes32 internal constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    bytes32 internal constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");

    // ============ RedemptionQueue ============

    bytes32 internal constant QUEUE_UPGRADER = keccak256("QUEUE_UPGRADER");
    /// @dev Granted post-deploy to the LitePSM proxy. Deliberately NOT granted in
    ///      `initialize`: it avoids a circular constructor dependency and stops
    ///      the deploy admin from calling `enqueue`/`processQueue` directly.
    bytes32 internal constant QUEUE_PSM = keccak256("QUEUE_PSM");
    bytes32 internal constant QUEUE_RESCUER = keccak256("QUEUE_RESCUER");
}
