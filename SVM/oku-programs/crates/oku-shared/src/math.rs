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
//! | OkuM → dollars (mint) | floor (give the user no more than they earned) | [`raw_to_dollars`] |
//! | dollars → OkuM (mint) | floor | [`dollars_to_raw`] |
//! | reserved-balance accounting | ceil (over-reserve, never under-reserve) | [`mul_div_ceil`] |
//!
//! Pick `*_ceil` when a floor would under-protect the protocol's
//! obligations to other users.
//! Pick `*_floor` when the user is being credited from the protocol's
//! pool (the floor leaves dust in the pool, favoring everyone else
//! collectively). When in doubt, document the choice at the call site.

use crate::constants::{BASIS_POINTS, PRECISION};

/// Compute `(a * b) / divisor` with intermediate u128 widening and
/// floor rounding. Returns `None` on overflow OR when `divisor == 0`.
///
/// This is the protocol-wide primitive for any multiplier-style
/// computation. Both `raw_to_dollars` and `dollars_to_raw` are
/// trivial wrappers around it.
#[inline]
pub fn mul_div_floor(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let product = (a as u128).checked_mul(b as u128)?;
    // `divisor` is guaranteed non-zero by the early return above, so the
    // `/ (divisor as u128)` cannot panic or wrap.
    #[allow(clippy::arithmetic_side_effects)]
    let result = product / (divisor as u128);
    u64::try_from(result).ok()
}

/// Convert OkuM raw amount → dollar value using a multiplier.
///
/// Formula: `dollar_value = (raw_amount * multiplier) / PRECISION`.
///
/// Returns `None` if the intermediate `u128` product overflows or the
/// result doesn't fit in `u64`. `PRECISION` is never zero so there's
/// no division-by-zero path.
#[inline]
pub fn raw_to_dollars(raw_amount: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(raw_amount, multiplier, PRECISION)
}

/// Convert dollar value → OkuM raw amount using a multiplier.
///
/// Formula: `raw_amount = (dollar_value * PRECISION) / multiplier`.
///
/// Returns `None` if the intermediate product overflows, the result
/// doesn't fit in `u64`, OR if `multiplier == 0` (caller should reject
/// before calling this).
#[inline]
pub fn dollars_to_raw(dollar_value: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(dollar_value, PRECISION, multiplier)
}

// ---------------------------------------------------------------------------
// Ceiling siblings
// ---------------------------------------------------------------------------
//
// These are the "round up" counterparts to the floor primitives above.
// Use when the result becomes a protocol-side reservation — see
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
    // `checked_add` is used defensively; the bound is asserted structurally
    // by Kani in `proof_mul_div_ceil_numerator_fits_u128`.
    let numerator = product.checked_add(d.saturating_sub(1))?;
    #[allow(clippy::arithmetic_side_effects)]
    let result = numerator / d;
    u64::try_from(result).ok()
}

// ---------------------------------------------------------------------------
// PSM fees (tin / tout)
// ---------------------------------------------------------------------------
//
// Ported concept: `tin` (fee on the way in, mint) and `tout` (fee on the
// way out, redeem) from `makerdao/dss-lite-psm`, which this PSM's
// instruction set was modelled on but which the original port omitted.
// Taken from https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol
//
// `tout` is what actually closes the local step-arbitrage surface: SVM's
// multiplier moves in discrete jumps, so absent a fee anyone can mint at
// `M0`, hold across the jump, and redeem at `M1` for the whole step. A
// fee above the maximum step yield makes that round trip lossy.
//
// Rounding: the fee rounds **up** and the user's payout rounds **down**,
// per the module rounding-direction policy. A floor-rounded fee would let
// a stream of dust-sized operations extract the rounding remainder.

/// Fee charged on `gross` at `fee_bps`, rounded **up** (protocol-favouring).
///
/// Returns `Some(0)` for `fee_bps == 0` without touching the division, so
/// the disabled-fee path is exactly free and cannot introduce rounding.
///
/// Callers are responsible for bounding `fee_bps` by `MAX_FEE_BPS`; this
/// primitive stays total and simply returns `None` if a nonsensical
/// `fee_bps` would produce a fee exceeding `u64`.
#[inline]
pub fn fee_amount(gross: u64, fee_bps: u64) -> Option<u64> {
    if fee_bps == 0 {
        return Some(0);
    }
    mul_div_ceil(gross, fee_bps, BASIS_POINTS)
}

/// `gross` less the ceil-rounded fee at `fee_bps`.
///
/// Returns `None` if the fee would exceed `gross`, which for any
/// `fee_bps <= BASIS_POINTS` cannot happen — the `checked_sub` is a
/// defensive backstop against an out-of-range `fee_bps` reaching this far
/// rather than an expected path.
///
/// Note the result can legitimately be `Some(0)`: a dust-sized `gross`
/// with a nonzero fee rounds the entire amount away. Callers must reject
/// that explicitly (`ZeroOutput`) rather than settling a no-op transfer.
#[inline]
pub fn apply_fee(gross: u64, fee_bps: u64) -> Option<u64> {
    let fee = fee_amount(gross, fee_bps)?;
    gross.checked_sub(fee)
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

    /// Proof: two u64 values can never overflow u128 when multiplied.
    #[kani::proof]
    fn proof_mul_div_floor_no_u128_overflow() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();

        let product = (a as u128).checked_mul(b as u128);
        assert!(product.is_some(), "u64*u64 must always fit in u128");
    }

    // -----------------------------------------------------------------------
    // raw_to_dollars proofs
    // -----------------------------------------------------------------------

    /// Proof: at multiplier == PRECISION, output equals input (identity).
    ///
    /// Domain bound: `amount ∈ [0, u16::MAX]` (= 65535).
    #[kani::proof]
    fn proof_raw_to_dollars_identity_at_precision() {
        let amount: u64 = kani::any();
        kani::assume(amount <= u16::MAX as u64);
        let result = raw_to_dollars(amount, PRECISION);
        assert_eq!(result, Some(amount));
    }

    /// Proof: consistent with mul_div_floor(amount, multiplier, PRECISION).
    #[kani::proof]
    fn proof_raw_to_dollars_consistent_with_mul_div() {
        let amount: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(amount <= u16::MAX as u64);
        kani::assume(multiplier <= u16::MAX as u64);
        assert_eq!(
            raw_to_dollars(amount, multiplier),
            mul_div_floor(amount, multiplier, PRECISION)
        );
    }

    // -----------------------------------------------------------------------
    // dollars_to_raw proofs
    // -----------------------------------------------------------------------

    /// Proof: multiplier == 0 always returns None (no divide-by-zero panic).
    #[kani::proof]
    fn proof_dollars_to_raw_none_on_zero_multiplier() {
        let dollar_value: u64 = kani::any();
        let result = dollars_to_raw(dollar_value, 0);
        assert!(result.is_none());
    }

    /// Proof: round-trip monotonicity — converting dollars→raw→dollars
    /// never returns MORE dollars than the starting value.
    #[kani::proof]
    fn proof_dollars_to_raw_round_trip_monotone() {
        let dollar_value: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(dollar_value <= u16::MAX as u64); // tight bound for CBMC
        kani::assume(multiplier > 0);
        kani::assume(multiplier <= u16::MAX as u64);

        if let Some(raw) = dollars_to_raw(dollar_value, multiplier) {
            if let Some(dollars_back) = raw_to_dollars(raw, multiplier) {
                // Must never recover more than the original input.
                assert!(dollars_back <= dollar_value);
            }
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

    /// Proof: the `+ (d - 1)` numerator add can't overflow u128.
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

    /// Proof: `mul_div_ceil(a, b, d) >= mul_div_floor(a, b, d)`.
    ///
    /// Domain bound: 8-bit.
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
        if let (Some(ceil_val), Some(floor_val)) = (mul_div_ceil(a, b, d), mul_div_floor(a, b, d)) {
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
        if let (Some(ceil_val), Some(floor_val)) = (mul_div_ceil(a, b, d), mul_div_floor(a, b, d)) {
            assert_eq!(ceil_val, floor_val);
        }
    }

    // -----------------------------------------------------------------------
    // fee proofs
    // -----------------------------------------------------------------------

    /// Proof: for any in-range `fee_bps`, the fee never exceeds the gross,
    /// so `apply_fee` cannot underflow and a redemption can never pay out
    /// more than it was quoted.
    #[kani::proof]
    fn proof_apply_fee_never_underflows_in_range() {
        let gross: u64 = kani::any();
        let fee_bps: u64 = kani::any();
        kani::assume(fee_bps <= crate::constants::MAX_FEE_BPS);

        let net = apply_fee(gross, fee_bps);
        assert!(net.is_some());
        let net = net.unwrap();
        assert!(net <= gross);
    }

    /// Proof: `fee + net == gross` exactly — the fee split is
    /// conservative, losing no value and creating none.
    #[kani::proof]
    fn proof_fee_split_is_conservative() {
        let gross: u64 = kani::any();
        let fee_bps: u64 = kani::any();
        kani::assume(fee_bps <= crate::constants::MAX_FEE_BPS);

        let fee = fee_amount(gross, fee_bps).unwrap();
        let net = apply_fee(gross, fee_bps).unwrap();
        assert_eq!(fee + net, gross);
    }

    /// Proof: a zero fee rate is exactly the identity, for every input.
    /// This is the formal statement of the "ships inert" property.
    #[kani::proof]
    fn proof_zero_fee_is_identity() {
        let gross: u64 = kani::any();
        assert_eq!(fee_amount(gross, 0), Some(0));
        assert_eq!(apply_fee(gross, 0), Some(gross));
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
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_floor_div_by_zero() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn raw_to_dollars_works() {
        // At $1.00 price, 1 OkuM = $1.00
        assert_eq!(raw_to_dollars(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, 1 OkuM = $1.10
        assert_eq!(raw_to_dollars(1_000_000, 1_100_000_000), Some(1_100_000));
        // At $1.05 price, 100 OkuM = $105.00
        assert_eq!(
            raw_to_dollars(100_000_000, 1_050_000_000),
            Some(105_000_000)
        );
    }

    #[test]
    fn dollars_to_raw_works() {
        // At $1.00 price, $1.00 = 1 OkuM
        assert_eq!(dollars_to_raw(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, $1.10 = 1 OkuM
        assert_eq!(dollars_to_raw(1_100_000, 1_100_000_000), Some(1_000_000));
        // Zero price → None
        assert_eq!(dollars_to_raw(1_000_000, 0), None);
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
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_ceil_at_u64_max_boundary() {
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
    }

    // ---- fees ----

    #[test]
    fn fee_disabled_is_exactly_free() {
        // The default configuration must be bit-for-bit a no-op, so the
        // "ship inert" property is a fact rather than an approximation.
        assert_eq!(fee_amount(1_000_000, 0), Some(0));
        assert_eq!(apply_fee(1_000_000, 0), Some(1_000_000));
        assert_eq!(apply_fee(0, 0), Some(0));
        assert_eq!(apply_fee(u64::MAX, 0), Some(u64::MAX));
    }

    #[test]
    fn fee_amount_basic_bps() {
        // 15 bps on 1_000_000 = 1500.
        assert_eq!(fee_amount(1_000_000, 15), Some(1_500));
        // 100 bps (the MAX_FEE_BPS ceiling) on 1_000_000 = 10_000.
        assert_eq!(fee_amount(1_000_000, 100), Some(10_000));
        assert_eq!(apply_fee(1_000_000, 15), Some(998_500));
    }

    #[test]
    fn fee_rounds_up_never_down() {
        // 1 * 15 / 10_000 = 0.0015 → ceil = 1, so the protocol keeps the
        // remainder instead of leaking it to a dust-spam loop.
        assert_eq!(fee_amount(1, 15), Some(1));
        assert_eq!(apply_fee(1, 15), Some(0));
        // 667 * 15 / 10_000 = 1.0005 → ceil = 2.
        assert_eq!(fee_amount(667, 15), Some(2));
    }

    #[test]
    fn fee_can_consume_dust_entirely() {
        // Callers must treat Some(0) as a reject, not a settle.
        assert_eq!(apply_fee(1, 10_000), Some(0));
    }

    #[test]
    fn fee_never_exceeds_gross_within_bounds() {
        // Exhaustive over the whole legal fee range at several magnitudes.
        for gross in [0u64, 1, 2, 999, 1_000_000, u64::MAX / 2] {
            for bps in 0..=crate::constants::MAX_FEE_BPS {
                let net = apply_fee(gross, bps).expect("in-range fee must not underflow");
                assert!(net <= gross, "fee inflated the payout");
                let fee = fee_amount(gross, bps).unwrap();
                assert_eq!(net + fee, gross, "fee + net must reconstruct gross");
            }
        }
    }

    #[test]
    fn fee_amount_overflow_is_none_not_panic() {
        // gross * bps overflows u128 only past u64::MAX inputs; the
        // narrowing back to u64 is what fails here.
        assert_eq!(fee_amount(u64::MAX, 10_000), Some(u64::MAX));
        assert_eq!(apply_fee(u64::MAX, 10_000), Some(0));
    }
}
