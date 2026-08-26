//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/README.md` § "EVM vs SVM —
//! divergence catalogue").
//!
//! ## Why 1e9 on SVM vs 1e18 on EVM
//!
//! EVM has 256-bit native integers, so 1e18 fits comfortably and matches
//! Solidity's ERC-20 18-decimal convention. SVM uses `u64` for token
//! amounts and BPF natively widens to `u128` for intermediates.
//! `1e9 × u64` peaks around `1.8e28`, well within `u128::MAX (≈ 3.4e38)`.
//! A 1e18 precision would require either `u128` token amounts (no SPL
//! Token-2022 support) or aggressive precision loss on every operation.
//!
//! In other words: 1e9 is the largest decimal-power scale that keeps
//! the canonical `u64 × u64 / divisor → u64` math pattern safe for
//! all realistic supply / multiplier combinations.

// ---------------------------------------------------------------------------
// Precision / basis points
// ---------------------------------------------------------------------------

/// Standard precision for multipliers (1e9 = $1.00).
///
/// SVM equivalent of EVM's `Constants.PRECISION = 1e18`. Used by the
/// OkuM multiplier and all dollar-conversion math in `lite-psm`.
pub const PRECISION: u64 = 1_000_000_000;

/// Basis-points denominator (10_000 = 100%). Mirrors EVM
/// `Constants.BASIS_POINTS`.
///
/// Consumed by the `tin`/`tout` fee math and the step-coverage
/// primitives (`step_is_covered`, `step_bps_ceil`).
pub const BASIS_POINTS: u64 = 10_000;

// ---------------------------------------------------------------------------
// Multiplier ceiling
// ---------------------------------------------------------------------------

/// Absolute maximum allowed value for the OkuM multiplier.
///
/// Set to `1e15` (≈ $1,000,000.00 per raw token), which is far above any
/// realistic yield trajectory and keeps subsequent `u64 * u64 -> u128`
/// multiplications away from the overflow region.
///
/// EVM mirror: `Constants.MAX_MULTIPLIER = 1e24`.
pub const MAX_MULTIPLIER: u64 = 1_000_000_000_000_000;

// ---------------------------------------------------------------------------
// Token decimals
// ---------------------------------------------------------------------------

/// OkuM uses 6 decimals on SVM (matching USDC's representation on
/// Solana). EVM uses 18 decimals; the off-chain orchestrator handles
/// the cross-chain scale conversion.
pub const TOKEN_DECIMALS: u8 = 6;

// ---------------------------------------------------------------------------
// Cross-chain multiplier sync window
// ---------------------------------------------------------------------------
//
// The sync window closes the *cross-chain* arbitrage surface: while a
// multiplier tick is propagating, EVM and SVM briefly disagree on the
// price, and any conversion through the multiplier during that interval
// transacts at a stale price on one side. Every multiplier write arms an
// auto-expiring lock on exactly the price-sensitive instructions; the lock
// releases on its own after `sync_window_secs` — there is no close
// instruction and no epoch protocol. Cross-chain parity is verified
// off-chain by comparing the multiplier VALUES directly
// (`scripts/admin/check-sync-parity.ts`).
//
// It does NOT address the *local* step-arbitrage surface (holding raw
// across a discrete step) — that is what the fees exist for. See the
// module note on fees below.
//
// The ceiling is a compile-time constant, not a config field, so a warm
// key cannot widen the window. Wall-clock seconds rather than slots:
// Solana slot times stretch under congestion, which is precisely when
// cross-chain propagation is slowest, so a slot-denominated window would
// shrink exactly when it needs to be longest.

/// Hard ceiling on a single sync window, in seconds.
///
/// Auto-expiry is the liveness backstop: if the orchestrator dies
/// mid-tick, redemption resumes on its own after at most this long. A
/// window can never be extended past this bound, so the mechanism can
/// never become an indefinite pause on a warmer key than
/// `PSM_UNPAUSER`'s.
///
/// EVM mirror: `Constants.MAX_SYNC_WINDOW`.
pub const MAX_SYNC_WINDOW_SECS: i64 = 900;

/// Sync window length written at `initialize`, in seconds.
///
/// Deployments ship with the window ON. A zero default would mean the
/// protection is installed but inert, and therefore dependent on someone
/// remembering to enable it — which is exactly the class of dependency this
/// design is trying to remove.
///
/// 60s is a cross-chain propagation budget, not an economic parameter: the
/// lock only needs to outlast "the tick has landed on every chain". It
/// expires on its own — there is no close instruction. Adjustable within
/// `MAX_SYNC_WINDOW_SECS` via `set_sync_window_secs`.
///
/// EVM mirror: `Constants.DEFAULT_SYNC_WINDOW`.
pub const DEFAULT_SYNC_WINDOW_SECS: i64 = 60;

/// Hard ceiling on a single multiplier step, in basis points (100 = 1%).
///
/// A single write can never move the multiplier more than 1%, however much
/// combined fee coverage (`tin + tout`, up to 2%) is configured. That
/// implies a MINIMUM rebase cadence: a long outage cannot be caught up in
/// one jump, it has to be walked in bounded steps, each of which arms the
/// sync window and is individually covered by fees.
///
/// EVM mirror: `Constants.MAX_STEP_BPS` (enforced in `_stepMultiplier`).
pub const MAX_STEP_BPS: u64 = 100;

// ---------------------------------------------------------------------------
// PSM fees (tin / tout)
// ---------------------------------------------------------------------------
//
// Restores the `tin`/`tout` parameters from the upstream this PSM was
// ported from (`makerdao/dss-lite-psm`), which the original port dropped.
//
// The fees are the fix for *local* step arbitrage: SVM's multiplier steps
// discretely (Token-2022 rejects `ScaledUiAmount` + `InterestBearingConfig`
// on one mint, so continuous accrual is unavailable), and a discrete step
// lets anyone mint at `M0`, hold across the step, and redeem at `M1` for
// a risk-free profit equal to the whole step. A window cannot prevent
// this — the attacker simply transacts outside it. A round trip pays
// `tin` on the way in and `tout` on the way out, so a COMBINED
// `tin + tout` exceeding the single-step yield makes it unprofitable by
// construction, permanently and independently of rebase cadence. That
// combined figure is what the step-coverage invariant enforces,
// mirroring EVM (`OkuM.setOkuMultiplier` / `SubscriptionModule.setFees`).
//
// Both default to 0, so the mechanism ships audited but economically
// inert and is enabled by configuration.

/// Hard ceiling on `tin_bps` / `tout_bps`, in basis points (100 = 1%).
///
/// Anti-confiscation bound: the fee setter sits on the cold multisig
/// (`cap_manager`), but a bounded parameter is still strictly better than
/// an unbounded one — this caps the worst case of a compromised cold key
/// at 1% rather than total seizure of every redemption.
///
/// EVM mirror: `Constants.MAX_FEE_BPS`.
pub const MAX_FEE_BPS: u64 = 100;
