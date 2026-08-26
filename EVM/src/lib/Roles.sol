// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Roles
 * @notice Centralized role constants for the OkuMoney contracts.
 * @dev Prefix-namespaced (`OKU_`, `PSM_`, `QUEUE_`, `WRAPPER_`) so a grant on
 *      one contract cannot be mistaken for a grant on another. Note that
 *      AccessControl mappings are per-contract regardless: a role must be
 *      granted on each contract that gates on it. The `OKU_*` set is used by
 *      BOTH tokens (OkuM and USDOku) — the same constant, granted per contract.
 *
 *      Named `OKU_RATE_SETTER`, not `REBASER`. USDOku *does* rebase, so unlike
 *      the single-token design this name is a scoping choice rather than a
 *      factual one — the role sets rates on both tokens, and only one of them
 *      rebases.
 */
library Roles {
    // ============ Tokens (OkuM and USDOku — granted per contract) ============

    bytes32 internal constant OKU_UPGRADER = keccak256("OKU_UPGRADER");
    bytes32 internal constant OKU_PAUSER = keccak256("OKU_PAUSER");
    bytes32 internal constant OKU_UNPAUSER = keccak256("OKU_UNPAUSER");
    /// @dev On OkuM: held by the SubscriptionModule proxy (subscription path).
    ///      On USDOku: held by the USDOkuWrapper proxy (wrap path).
    bytes32 internal constant OKU_MINTER = keccak256("OKU_MINTER");
    /// @dev Split from `OKU_MINTER` so the burn surface can be locked down
    ///      independently of the mint-allowance system. On OkuM: granted to the
    ///      SubscriptionModule proxy (instant redemptions) and the
    ///      RedemptionQueue proxy (queued redemptions). On USDOku: granted to
    ///      the USDOkuWrapper proxy (unwrap path). All burn only their own
    ///      balance.
    bytes32 internal constant OKU_BURNER = keccak256("OKU_BURNER");
    /// @dev The multiplier authority. On OkuM: `setOkuMultiplier` (stepwise,
    ///      bounded by `MAX_STEP_BPS`, step coverage, monotonicity and
    ///      `MAX_MULTIPLIER`). On USDOku: `setUsdOkuRate` (continuous, bounded
    ///      by `MAX_IMPLIED_APR`, `MAX_RATE_DURATION`, monotonicity,
    ///      `MAX_MULTIPLIER` and the solvency bound).
    bytes32 internal constant OKU_RATE_SETTER = keccak256("OKU_RATE_SETTER");
    /// @dev Can only *withhold* yield: `haltAccrual()` on OkuM (blocks further
    ///      steps until cold resumes) and `haltUsdOkuAccrual()` on USDOku
    ///      (freezes the index). Cannot set a rate and cannot reduce anything
    ///      already accrued. Monotone-safe, which is why it sits on the warm
    ///      multisig: the abuse ceiling is "yield pauses until cold overrides",
    ///      which is strictly better than being unable to stop a compromised
    ///      rate setter for as long as it takes to convene cold.
    bytes32 internal constant OKU_GUARDIAN = keccak256("OKU_GUARDIAN");
    bytes32 internal constant OKU_BLACKLISTER = keccak256("OKU_BLACKLISTER");
    bytes32 internal constant OKU_UNBLACKLISTER = keccak256("OKU_UNBLACKLISTER");
    /// @dev On OkuM also: `setSyncWindowDuration`, `setStepFeeSource`,
    ///      `resetStepHighWaterMark`, `resumeAccrual` — cold economic/safety
    ///      policy of the same class as `setMaxSupply`.
    bytes32 internal constant OKU_CAP_MANAGER = keccak256("OKU_CAP_MANAGER");
    bytes32 internal constant OKU_ALLOWANCE_MANAGER = keccak256("OKU_ALLOWANCE_MANAGER");

    // ============ SubscriptionModule ============

    bytes32 internal constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 internal constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 internal constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 internal constant PSM_QUEUE_PROCESSOR = keccak256("PSM_QUEUE_PROCESSOR");
    bytes32 internal constant PSM_BUFFER_DEPOSITOR = keccak256("PSM_BUFFER_DEPOSITOR");
    bytes32 internal constant PSM_BUFFER_WITHDRAWER = keccak256("PSM_BUFFER_WITHDRAWER");
    /// @dev Sets the `tin` / `tout` fee schedule. Economic policy, so it belongs
    ///      on the same cold key as `OKU_CAP_MANAGER` — but it must be a
    ///      PSM-namespaced constant, not `OKU_CAP_MANAGER` itself: AccessControl
    ///      mappings are per-contract, and reusing the token's role identifier to
    ///      gate a module function would defeat the prefix convention that keeps
    ///      a grant on one contract from being mistaken for a grant on another.
    ///
    ///      Same key, distinct capability. Bounded by `MAX_FEE_BPS` and floored
    ///      by OkuM's `stepHighWaterMark` (step coverage).
    ///
    ///      The `PSM_` prefix is kept although the contract is now named
    ///      `SubscriptionModule` — renaming role constants breaks every
    ///      deployed-grant audit trail for zero semantic gain.
    bytes32 internal constant PSM_FEE_MANAGER = keccak256("PSM_FEE_MANAGER");

    // ============ RedemptionQueue ============

    bytes32 internal constant QUEUE_UPGRADER = keccak256("QUEUE_UPGRADER");
    /// @dev Granted post-deploy to the SubscriptionModule proxy. Deliberately NOT
    ///      granted in `initialize`: it avoids a circular constructor dependency
    ///      and stops the deploy admin from calling `enqueue`/`processQueue`
    ///      directly.
    bytes32 internal constant QUEUE_PSM = keccak256("QUEUE_PSM");
    bytes32 internal constant QUEUE_RESCUER = keccak256("QUEUE_RESCUER");

    // ============ USDOkuWrapper ============

    bytes32 internal constant WRAPPER_UPGRADER = keccak256("WRAPPER_UPGRADER");
    bytes32 internal constant WRAPPER_PAUSER = keccak256("WRAPPER_PAUSER");
    bytes32 internal constant WRAPPER_UNPAUSER = keccak256("WRAPPER_UNPAUSER");
    /// @dev Sunset control: can disable `wrap` (step 1 of the USDOku sunset).
    ///      CANNOT disable `unwrap` — there is no code path for it, deliberately.
    bytes32 internal constant WRAPPER_ADMIN = keccak256("WRAPPER_ADMIN");
    /// @dev Withdraws genuinely excess OkuM backing (`surplus()`) once realized
    ///      marks overtake declared liability. Separate from `WRAPPER_ADMIN`
    ///      because moving capital out is a materially different capability
    ///      than gating the sunset switch, even though both are cold in
    ///      practice.
    bytes32 internal constant WRAPPER_RESERVE_MANAGER = keccak256("WRAPPER_RESERVE_MANAGER");
}
