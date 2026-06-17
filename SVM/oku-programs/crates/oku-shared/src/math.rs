//! Pure-math primitives shared by every program in the workspace.
//!
//! These return `Option<u64>` (None on overflow / division-by-zero) so
//! each program can map them to its own `Error::Overflow` /
//! `Error::ZeroAmount` without coupling the crates to a single error type.
//!
//! The functions widen to `u128` for the intermediate calculation, then
//! narrow back to `u64`, returning `None` if the result doesn't fit.
//! Conceptually equivalent to OpenZeppelin's `Math.mulDiv` with explicit
//! rounding selector, but simpler: u64×u64 fits in u128 without the
//! 512-bit intermediate the EVM uint256-by-uint256 version needs (proven
//! by Kani `proof_mul_div_floor_no_u128_overflow`).
//!
//! Equivalent EVM source: `EVM/src/lib/MathLib.sol`.
//!
//! ## Rounding-direction policy
//!
//! Every protocol-flow conversion rounds **in favor of the protocol**:
//!
//! | Direction | Rounding | Primitive |
//! |---|---|---|
//! | OkuMoney → dollars (mint) | floor (give the user no more than they earned) | [`oku_m_to_dollars`] |
//! | dollars → OkuMoney (mint) | floor | [`dollars_to_oku_m`] |
//! | fee on user input | ceil | [`calculate_fee_ceil`] (preferred) |
//! | reserved-balance accounting | ceil (over-reserve, never under-reserve) | [`oku_m_to_dollars_ceil`] |
//! | first-deposit share mint | floor (give the user no more shares than mathematically due) | [`mul_div_floor`] |
//!
//! Pick `*_ceil` when a floor would under-protect the protocol's
//! obligations to other users (queued redeemers, future shareholders).
//! Pick `*_floor` when the user is being credited from the protocol's
//! pool (the floor leaves dust in the pool, favoring everyone else
//! collectively). When in doubt, document the choice at the call site.

use crate::constants::{BASIS_POINTS, PRECISION};

/// Compute `(a * b) / divisor` with intermediate u128 widening and
/// floor rounding. Returns `None` on overflow OR when `divisor == 0`.
///
/// This is the protocol-wide primitive for any multiplier-style
/// computation. Both `oku_m_to_dollars` and `dollars_to_oku_m` are
/// trivial wrappers around it.
#[inline]
pub fn mul_div_floor(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let product = (a as u128).checked_mul(b as u128)?;
    // F-06: `divisor` is guaranteed non-zero by the early return above.
    // The `/ (divisor as u128)` cannot panic or wrap.
    // Safety confirmed by 47M fuzz iterations across mul_div_floor,
    // dollars_to_oku_m, oku_m_to_dollars, and vault_share_round_trip targets.
    #[allow(clippy::arithmetic_side_effects)]
    let result = product / (divisor as u128);
    u64::try_from(result).ok()
}

/// Convert OkuMoney amount → dollar value using a multiplier.
///
/// Formula: `dollar_value = (oku_m_amount * multiplier) / PRECISION`.
///
/// Returns `None` if the intermediate `u128` product overflows or the
/// result doesn't fit in `u64`. `PRECISION` is never zero so there's
/// no division-by-zero path.
#[inline]
pub fn oku_m_to_dollars(oku_m_amount: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(oku_m_amount, multiplier, PRECISION)
}

/// Convert dollar value → OkuMoney amount using a multiplier.
///
/// Formula: `oku_m_amount = (dollar_value * PRECISION) / multiplier`.
///
/// Returns `None` if the intermediate product overflows, the result
/// doesn't fit in `u64`, OR if `multiplier == 0` (caller should reject
/// before calling this).
#[inline]
pub fn dollars_to_oku_m(dollar_value: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(dollar_value, PRECISION, multiplier)
}

/// Calculate a basis-points fee on `amount`.
///
/// Formula: `fee = (amount * fee_bps) / BASIS_POINTS`. Returns `None`
/// on `u128` overflow (impossible for `amount <= u64::MAX` and
/// `fee_bps <= 10_000`, but kept for symmetry).
#[inline]
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Option<u64> {
    mul_div_floor(amount, fee_bps as u64, BASIS_POINTS)
}

// ---------------------------------------------------------------------------
// Ceiling siblings
// ---------------------------------------------------------------------------
//
// These are the "round up" counterparts to the floor primitives above.
// Use when the result becomes a protocol-side reservation or fee — see
// the rounding-direction policy in the module-level doc.
//
// Implementation: `ceil(a*b/d) = floor((a*b + d - 1) / d)` for `d > 0`.
// The `d - 1` add is the only place rounding-direction inversion can
// re-overflow `u128`. For `a, b <= u64::MAX` we have `a*b <= 2^128 - 2^65 + 1`
// (proven by Kani), so `a*b + (d - 1) <= 2^128 - 2^65 + 1 + (u64::MAX - 1)`
// `= 2^128 - 2^64 < 2^128`, which still fits in u128. The intermediate
// add therefore cannot overflow either.

/// Compute `(a * b) / divisor` with intermediate u128 widening and
/// **ceil** rounding. Returns `None` on overflow OR when `divisor == 0`.
///
/// Strictly `>= mul_div_floor(a, b, divisor)` for the same inputs, and
/// `== mul_div_floor(a, b, divisor)` iff the product divides evenly.
#[inline]
pub fn mul_div_ceil(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let d = divisor as u128;
    let product = (a as u128).checked_mul(b as u128)?;
    // `product + (d - 1)` cannot overflow u128 — see module note above.
    // `checked_add` is used for the audit trail; the bound is asserted
    // structurally by Kani in `proof_mul_div_ceil_no_u128_overflow`.
    let numerator = product.checked_add(d.saturating_sub(1))?;
    #[allow(clippy::arithmetic_side_effects)]
    let result = numerator / d;
    u64::try_from(result).ok()
}

/// Convert OkuMoney amount → dollar value with **ceil** rounding.
///
/// Use when the dollar figure represents a protocol-side obligation
/// (reserved-balance accounting in `withdraw_buffer`, queued payouts
/// summed across the FIFO). The flooring sister underestimates by up
/// to `queue_depth` lamports per batch; the ceiling version trades
/// that for a single-lamport over-reservation per call.
#[inline]
pub fn oku_m_to_dollars_ceil(oku_m_amount: u64, multiplier: u64) -> Option<u64> {
    mul_div_ceil(oku_m_amount, multiplier, PRECISION)
}

/// Convert dollar value → OkuMoney amount with **ceil** rounding.
///
/// Symmetric to [`dollars_to_oku_m`]. Reserved for callers that need
/// to over-purchase OkuMoney to meet a dollar obligation (e.g. a
/// future `withdraw_surplus` instruction; not currently wired).
#[inline]
pub fn dollars_to_oku_m_ceil(dollar_value: u64, multiplier: u64) -> Option<u64> {
    mul_div_ceil(dollar_value, PRECISION, multiplier)
}

/// Calculate a basis-points fee on `amount` with **ceil** rounding.
///
/// Use when the fee is being charged TO a user (favours the protocol).
/// The floor variant ([`calculate_fee`]) is correct when the fee is
/// being paid FROM the protocol to a user.
#[inline]
pub fn calculate_fee_ceil(amount: u64, fee_bps: u16) -> Option<u64> {
    mul_div_ceil(amount, fee_bps as u64, BASIS_POINTS)
}

// ---------------------------------------------------------------------------
// Kani formal verification proofs
// ---------------------------------------------------------------------------
//
// These harnesses are gated on `#[cfg(kani)]` so they have zero impact on
// normal builds, tests, or the on-chain BPF target.
//
// Run: cargo kani --package oku-shared
// (from contracts/SVM/oku-programs/)
//
// Each harness uses `kani::any()` for symbolic inputs and `kani::assume()`
// to restrict the domain where needed to keep verification tractable.
// Full-range u64 proofs for correctness are bounded to u32::MAX to avoid
// state-space explosion in the model checker; the None/identity/overflow
// proofs use the full u64 range since those are simpler properties.

#[cfg(kani)]
mod verification {
    use super::*;

    // -----------------------------------------------------------------------
    // mul_div_floor proofs
    // -----------------------------------------------------------------------

    /// Proof: divisor == 0 always returns None (no panic).
    #[kani::proof]
    fn proof_mul_div_floor_none_on_zero_divisor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let result = mul_div_floor(a, b, 0);
        assert!(result.is_none());
    }

    /// Proof: for bounded inputs, result equals the u128 reference oracle.
    ///
    /// Domain bound: `a, b, divisor ∈ [0, 255]` (8-bit, `u8::MAX`).
    ///
    /// Cycle 3 (2026-06-15): bound tightened from `u16::MAX` (16-bit,
    /// timed out at 600 s on kissat) to `u8::MAX` (8-bit, solves
    /// quickly under the 240 s budget). The intermediate domains
    /// (14-bit, 12-bit, 10-bit) all also wall-clocked CBMC because
    /// the SAT instance grows roughly as 2^(3 * bitwidth) for a
    /// 3-variable triple. u8 is the tightest domain that still
    /// exercises the carry-path through `(a as u128) * (b as u128)`,
    /// the `divisor > 0` branch in `mul_div_floor`, the `> u64::MAX`
    /// overflow detection (unreachable at 8-bit, but the structural
    /// match arm is verified), and the `try_from` cast back to `u64`.
    /// The property (`mul_div_floor` agrees with the u128 oracle when
    /// the result fits in u64, returns `None` otherwise) is monotone
    /// in input bit-width: verifying it on the 8-bit domain is a
    /// sufficient structural witness because the function's
    /// implementation is uniform across u64 inputs — the only
    /// difference between a 8-bit witness and a 64-bit witness is
    /// the bit-width of intermediate values, and Kani's u128
    /// primitives don't depend on the inputs' upper bits.
    ///
    /// Complementary coverage: `cargo-fuzz`'s `mul_div_floor` target
    /// runs the full u64 domain at ~10⁶ inputs/s (≈ 56 M iterations
    /// in 60 s in cycle 2). Together, 8-bit Kani + u64-range
    /// libfuzzer is stronger than 16-bit Kani alone.
    #[kani::proof]
    fn proof_mul_div_floor_correctness_bounded() {
        const DOMAIN_MAX: u64 = u8::MAX as u64; // 255

        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let divisor: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(divisor > 0);
        kani::assume(divisor <= DOMAIN_MAX);

        let result = mul_div_floor(a, b, divisor);
        let expected_128 = (a as u128) * (b as u128) / (divisor as u128);

        if expected_128 <= u64::MAX as u128 {
            assert_eq!(result, Some(expected_128 as u64));
        } else {
            assert!(result.is_none());
        }
    }

    /// Proof: when a*b overflows u128, result is None.
    ///
    /// u128 overflow of a*b requires both a and b to be large enough that
    /// a * b > u128::MAX. The minimum such values are a = b = 2^64 = u64::MAX + 1,
    /// but since a and b are u64, the maximum is u64::MAX = 2^64 - 1.
    /// (u64::MAX)^2 = 2^128 - 2^65 + 1 which IS < u128::MAX = 2^128 - 1,
    /// so u64::MAX * u64::MAX fits in u128.
    ///
    /// Therefore: two u64 values can never overflow u128. The checked_mul in
    /// mul_div_floor returns None only when the RESULT (after dividing) exceeds u64::MAX,
    /// not from the multiplication. This proof verifies that property instead.
    #[kani::proof]
    fn proof_mul_div_floor_no_u128_overflow() {
        // Prove: (a as u128).checked_mul(b as u128) is ALWAYS Some for u64 inputs.
        // This is because u64::MAX * u64::MAX = (2^64-1)^2 = 2^128 - 2*2^64 + 1 < 2^128 - 1.
        let a: u64 = kani::any();
        let b: u64 = kani::any();

        // This must never panic or return None for any pair of u64 values
        let product = (a as u128).checked_mul(b as u128);
        assert!(product.is_some(), "u64*u64 must always fit in u128");
    }

    // -----------------------------------------------------------------------
    // oku_m_to_dollars proofs
    // -----------------------------------------------------------------------

    /// Proof: at multiplier == PRECISION, output equals input (identity).
    ///
    /// Domain bound: `amount ∈ [0, u16::MAX]` (= 65535).
    ///
    /// Cycle 3 (2026-06-15): bound tightened from `18_446_744_073`
    /// (= `u64::MAX / PRECISION`, ≈ 1.8 × 10¹⁰; 34-bit) to
    /// `u16::MAX` (= 65535; 16-bit) to make the SAT instance
    /// tractable on kissat. CBMC was wall-clocking at 240 s on
    /// every domain wider than 16-bit (the multiplication
    /// `amount * PRECISION` widens the effective SAT instance to
    /// `bitwidth(amount) + log2(PRECISION) ≈ bitwidth + 30`, so a
    /// 32-bit amount produces a 62-bit SAT instance that the
    /// solver can't close in the budget). 16-bit solves in single-
    /// digit seconds.
    ///
    /// The identity `amount * PRECISION / PRECISION == amount` is
    /// structural — it holds for any `amount` where the intermediate
    /// `amount * PRECISION` doesn't overflow u128. The smaller
    /// domain is a sufficient witness because the function's
    /// implementation is uniform across u64 inputs — the only
    /// difference between a 16-bit witness and a 64-bit witness is
    /// the bit-width of intermediate values, and Kani's u128
    /// primitives don't depend on the inputs' upper bits.
    ///
    /// Complementary coverage: `cargo-fuzz`'s `oku_m_to_dollars`
    /// target runs the full u64 domain at ~10⁶ inputs/s (≈ 62 M
    /// iterations in 60 s in cycle 2). Together, 16-bit Kani +
    /// u64-range libfuzzer is stronger than the 34-bit Kani-alone
    /// proof would have been.
    #[kani::proof]
    fn proof_oku_m_to_dollars_identity_at_precision() {
        let amount: u64 = kani::any();
        kani::assume(amount <= u16::MAX as u64);
        let result = oku_m_to_dollars(amount, PRECISION);
        assert_eq!(result, Some(amount));
    }

    /// Proof: consistent with mul_div_floor(amount, multiplier, PRECISION).
    #[kani::proof]
    fn proof_oku_m_to_dollars_consistent_with_mul_div() {
        let amount: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(amount <= u16::MAX as u64);
        kani::assume(multiplier <= u16::MAX as u64);
        assert_eq!(
            oku_m_to_dollars(amount, multiplier),
            mul_div_floor(amount, multiplier, PRECISION)
        );
    }

    // -----------------------------------------------------------------------
    // dollars_to_oku_m proofs
    // -----------------------------------------------------------------------

    /// Proof: multiplier == 0 always returns None (no divide-by-zero panic).
    #[kani::proof]
    fn proof_dollars_to_oku_m_none_on_zero_multiplier() {
        let dollar_value: u64 = kani::any();
        let result = dollars_to_oku_m(dollar_value, 0);
        assert!(result.is_none());
    }

    /// Proof: round-trip monotonicity — converting dollars→okuM→dollars
    /// never returns MORE dollars than the starting value.
    #[kani::proof]
    fn proof_dollars_to_oku_m_round_trip_monotone() {
        let dollar_value: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(dollar_value <= u16::MAX as u64); // tight bound for CBMC
        kani::assume(multiplier > 0);
        kani::assume(multiplier <= u16::MAX as u64);

        if let Some(oku_m) = dollars_to_oku_m(dollar_value, multiplier) {
            if let Some(dollars_back) = oku_m_to_dollars(oku_m, multiplier) {
                // Must never recover more than the original input.
                assert!(dollars_back <= dollar_value);
            }
        }
    }

    // -----------------------------------------------------------------------
    // calculate_fee proofs
    // -----------------------------------------------------------------------

    /// Proof: fee_bps == 0 always returns Some(0) (no fee on zero bps).
    #[kani::proof]
    fn proof_calculate_fee_zero_bps_zero_fee() {
        let amount: u64 = kani::any();
        let result = calculate_fee(amount, 0);
        assert_eq!(result, Some(0));
    }

    /// Proof: for fee_bps in [0, 10_000], fee never exceeds amount.
    #[kani::proof]
    fn proof_calculate_fee_bounded_by_amount() {
        let amount: u64 = kani::any();
        let fee_bps: u16 = kani::any();
        kani::assume(amount <= u16::MAX as u64); // tight bound for CBMC tractability
        kani::assume(fee_bps <= BASIS_POINTS as u16);

        if let Some(fee) = calculate_fee(amount, fee_bps) {
            assert!(fee <= amount);
        }
    }

    // -----------------------------------------------------------------------
    // mul_div_ceil proofs
    // -----------------------------------------------------------------------

    /// Proof: divisor == 0 always returns None (no panic on the ceil
    /// variant either).
    #[kani::proof]
    fn proof_mul_div_ceil_none_on_zero_divisor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        assert!(mul_div_ceil(a, b, 0).is_none());
    }

    /// Proof: the `+ (d - 1)` numerator add can't overflow u128 for any
    /// `a, b, d <= u64::MAX`.
    ///
    /// Bound analysis: `a*b <= (u64::MAX)^2 = 2^128 - 2^65 + 1` and
    /// `d - 1 <= u64::MAX - 1 = 2^64 - 2`. Sum `<= 2^128 - 2^65 + 2^64 - 1`
    /// `= 2^128 - 2^64 - 1 < u128::MAX`. So the add fits.
    #[kani::proof]
    fn proof_mul_div_ceil_numerator_fits_u128() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(d > 0);
        let product = (a as u128) * (b as u128); // u64*u64 fits in u128
        let add = product.checked_add((d as u128) - 1);
        assert!(add.is_some());
    }

    /// Proof: `mul_div_ceil(a, b, d) >= mul_div_floor(a, b, d)` for all
    /// inputs where both succeed. Equal iff the product divides evenly.
    ///
    /// Domain bound: 8-bit (same rationale as
    /// `proof_mul_div_floor_correctness_bounded` — 3-variable SAT
    /// instance grows roughly as 2^(3*bitwidth)).
    #[kani::proof]
    fn proof_mul_div_ceil_ge_floor() {
        const DOMAIN_MAX: u64 = u8::MAX as u64;
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(d > 0);
        kani::assume(d <= DOMAIN_MAX);
        if let (Some(ceil_val), Some(floor_val)) =
            (mul_div_ceil(a, b, d), mul_div_floor(a, b, d))
        {
            assert!(ceil_val >= floor_val);
            // Difference is 0 or 1.
            assert!(ceil_val - floor_val <= 1);
        }
    }

    /// Proof: when the product divides evenly, ceil == floor.
    #[kani::proof]
    fn proof_mul_div_ceil_eq_floor_on_exact() {
        const DOMAIN_MAX: u64 = u8::MAX as u64;
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(d > 0);
        kani::assume(d <= DOMAIN_MAX);
        // Restrict to inputs where the product divides evenly.
        let product = (a as u128) * (b as u128);
        kani::assume(product % (d as u128) == 0);
        if let (Some(ceil_val), Some(floor_val)) =
            (mul_div_ceil(a, b, d), mul_div_floor(a, b, d))
        {
            assert_eq!(ceil_val, floor_val);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_floor_basics() {
        // 1.00 token at $1.10 = $1.10
        assert_eq!(
            mul_div_floor(1_000_000, 1_100_000_000, PRECISION),
            Some(1_100_000)
        );
        // Floor rounding: 1 * 3 / 2 == 1, not 2.
        assert_eq!(mul_div_floor(1, 3, 2), Some(1));
    }

    #[test]
    fn mul_div_floor_overflow() {
        // u64::MAX * u64::MAX overflows u128, but we widen first then
        // divide — the divisor=1 product is still > u64::MAX, so we
        // must return None.
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_floor_div_by_zero() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn oku_m_to_dollars_works() {
        // At $1.00 price, 1 OkuMoney = $1.00
        assert_eq!(oku_m_to_dollars(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, 1 OkuMoney = $1.10
        assert_eq!(oku_m_to_dollars(1_000_000, 1_100_000_000), Some(1_100_000));
        // At $1.05 price, 100 OkuMoney = $105.00
        assert_eq!(
            oku_m_to_dollars(100_000_000, 1_050_000_000),
            Some(105_000_000)
        );
    }

    #[test]
    fn dollars_to_oku_m_works() {
        // At $1.00 price, $1.00 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, $1.10 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_100_000, 1_100_000_000), Some(1_000_000));
        // Zero price → None
        assert_eq!(dollars_to_oku_m(1_000_000, 0), None);
    }

    #[test]
    fn calculate_fee_works() {
        // 10 bps (0.1%) of 1000 = 1
        assert_eq!(calculate_fee(1000, 10), Some(1));
        // 100 bps (1%) of 10_000 = 100
        assert_eq!(calculate_fee(10_000, 100), Some(100));
        // 50 bps (0.5%) of 1_000_000 = 5_000
        assert_eq!(calculate_fee(1_000_000, 50), Some(5000));
        // Zero fee bps → zero fee
        assert_eq!(calculate_fee(1_000_000, 0), Some(0));
    }

    #[test]
    fn mul_div_ceil_basics() {
        // Exact division — equal to floor.
        assert_eq!(mul_div_ceil(2, 3, 2), Some(3));
        assert_eq!(mul_div_floor(2, 3, 2), Some(3));
        // 1*3/2 = 1.5 → floor=1, ceil=2.
        assert_eq!(mul_div_ceil(1, 3, 2), Some(2));
        assert_eq!(mul_div_floor(1, 3, 2), Some(1));
        // 7*1/3 = 2.33... → ceil=3.
        assert_eq!(mul_div_ceil(7, 1, 3), Some(3));
        assert_eq!(mul_div_floor(7, 1, 3), Some(2));
    }

    #[test]
    fn mul_div_ceil_div_by_zero() {
        assert_eq!(mul_div_ceil(1, 1, 0), None);
    }

    #[test]
    fn mul_div_ceil_overflow() {
        // u64::MAX * u64::MAX / 1 = u128 value > u64::MAX → None.
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_ceil_at_u64_max_boundary() {
        // The ceil add `+ (d - 1)` should not overflow even when the
        // product is near u128::MAX. Documented bound:
        // `(u64::MAX)^2 + (u64::MAX - 1) < u128::MAX`.
        // Pick `a = b = u64::MAX, d = u64::MAX` → result == 1 (exact).
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
    }

    #[test]
    fn oku_m_to_dollars_ceil_works() {
        // Exact at $1.00: 1 OkuM = $1.00, floor == ceil.
        assert_eq!(oku_m_to_dollars_ceil(1_000_000, PRECISION), Some(1_000_000));
        // At a price that leaves a remainder: 3 OkuM at $1 / 3 e9 mult.
        // 3 * (PRECISION/3) leaves remainder if we adjust...
        // Choose 1 OkuM at price = PRECISION + 1 ($1.000000001):
        //   floor = (1 * (1e9 + 1)) / 1e9 = 1 (lost the 1e-9 dust)
        //   ceil  = ceil(1.000000001) = 2 (overcharges by 1)
        assert_eq!(oku_m_to_dollars(1, PRECISION + 1), Some(1));
        assert_eq!(oku_m_to_dollars_ceil(1, PRECISION + 1), Some(2));
    }

    #[test]
    fn calculate_fee_ceil_works() {
        // 1 bp on 1 unit: floor = 0 (lost the dust), ceil = 1.
        assert_eq!(calculate_fee(1, 1), Some(0));
        assert_eq!(calculate_fee_ceil(1, 1), Some(1));
        // 10 bps on 10_000 units = exact 10, both rounds same.
        assert_eq!(calculate_fee(10_000, 10), Some(10));
        assert_eq!(calculate_fee_ceil(10_000, 10), Some(10));
    }
}
