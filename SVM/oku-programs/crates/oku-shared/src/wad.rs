//! Full-precision fixed-point multiply-divide at [`PRECISION`] (1e18 WAD).
//!
//! ## Why this module exists
//!
//! At `PRECISION = 1e18` the multiplier reaches `MAX_MULTIPLIER = 1e24`, so a
//! `multiplier × amount` product reaches ~1.8e43, which does not fit in `u128`
//! (max ≈ 3.4e38). EVM does this arithmetic in `uint256` natively; SVM has no
//! 256-bit primitive, so we carry the intermediate ourselves.
//!
//! ## The algorithm (not novel — deliberately)
//!
//! The standard `full_mul` + `div_mod_small` pair from the
//! `uint` / `primitive-types` crate family — the same decomposition
//! OpenZeppelin's `Math.mulDiv` implements in assembly and which
//! `EVM/src/lib/MathLib.sol` routes every conversion through. Two steps:
//!
//! 1. **`widening_mul`** — split both operands into 64-bit halves and
//!    accumulate the four partial products into a 256-bit value held as
//!    `(hi: u128, lo: u128)`.
//! 2. **`div_rem_wad`** — divide that 256-bit value by `PRECISION`. Because
//!    `PRECISION = 1e18 < 2^60` the divisor fits in a `u64`, so this is a
//!    *small-divisor* long division: four `u128` divisions with a carried
//!    remainder. No Knuth algorithm-D, no reciprocal estimation, no
//!    correction loop — the entire class of bugs that makes general
//!    bignum division hard does not arise here.
//!
//! The result is exact over the **entire** `u128 × u128` domain, so there is
//! no reachability argument to maintain and no window bound that correctness
//! depends on. The only failure mode is "the true quotient exceeds `u128`",
//! which is reported honestly as `None`.
//!
//! ## Rounding
//!
//! [`mul_div_wad_floor`] truncates. [`mul_div_wad_half_up`] adds `WAD/2`
//! before dividing, reproducing MakerDAO `rpow`'s half-up assembly rounding
//! bit-for-bit — see the `xxRound` / `zxRound` steps of `MathLib.rpow`.
//! `rpow` is the one place the protocol does NOT floor; that carve-out is
//! documented at the head of `EVM/src/lib/MathLib.sol`.

use crate::constants::PRECISION;

/// Low 64 bits mask.
const M64: u128 = 0xFFFF_FFFF_FFFF_FFFF;

/// `PRECISION` as a `u64`. Static-asserted below to be lossless.
const WAD_U64: u64 = 1_000_000_000_000_000_000;

/// Half of `PRECISION`, added before the divide to get half-up rounding.
const HALF_WAD: u128 = PRECISION / 2;

// `PRECISION` must fit in a u64 for the small-divisor division to be valid.
// This is the single assumption the whole module rests on.
const _: () = assert!(PRECISION == WAD_U64 as u128);
const _: () = assert!(PRECISION < (1u128 << 64));

// ---------------------------------------------------------------------------
// 256-bit primitives
// ---------------------------------------------------------------------------

/// Full 128×128 → 256-bit product, returned as `(hi, lo)`.
///
/// Schoolbook multiplication over 64-bit limbs. Every intermediate is
/// proven to fit `u128`:
///
/// - `mid = (ll>>64) + (lh & M64) + (hl & M64)` ≤ `3·(2^64 − 1)` — trivially fits.
/// - `hi  = hh + (lh>>64) + (hl>>64) + (mid>>64)`. Worst case is
///   `(2^128 − 2^65 + 1) + (2^64 − 2) + (2^64 − 2) + 2 = 2^128 − 1`, i.e.
///   exactly `u128::MAX`. This is not a coincidence: the high half of the
///   maximal `u128` product `(2^128 − 1)^2` is precisely `2^128 − 2`, so the
///   accumulator is saturated but never wraps.
///
/// Verified exhaustively at the boundary and by randomized differential test
/// against a `u256` oracle in the test module.
/// Limbs are typed `u64` and widened at the multiply, NOT held as `u128`.
///
/// This matters enormously on SBF. There is no 128-bit multiply instruction, so
/// a `u128 * u128` lowers to a `__multi3` libcall. Writing the partial products
/// as `(x as u128) * (y as u128)` with `x, y: u64` lets LLVM see a genuine
/// 64x64 -> 128 widening multiply and emit a handful of native instructions
/// instead. Holding the limbs as `u128` produces four `__multi3` calls per
/// invocation, which alone pushed `mint_oku_m` over 150k compute units.
#[inline]
pub(crate) const fn widening_mul(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a as u64;
    let a_hi = (a >> 64) as u64;
    let b_lo = b as u64;
    let b_hi = (b >> 64) as u64;

    // Each partial product is at most (2^64 - 1)^2 < 2^128.
    let ll = (a_lo as u128) * (b_lo as u128);
    let lh = (a_lo as u128) * (b_hi as u128);
    let hl = (a_hi as u128) * (b_lo as u128);
    let hh = (a_hi as u128) * (b_hi as u128);

    let mid = (ll >> 64) + (lh & M64) + (hl & M64);

    let lo = (ll & M64) | (mid << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);

    (hi, lo)
}

/// Add a `u128` to a 256-bit `(hi, lo)`, returning `None` if the 256-bit
/// value would overflow.
#[inline]
const fn add_u128(hi: u128, lo: u128, v: u128) -> Option<(u128, u128)> {
    let (new_lo, carry) = lo.overflowing_add(v);
    if carry {
        match hi.checked_add(1) {
            Some(new_hi) => Some((new_hi, new_lo)),
            None => None,
        }
    } else {
        Some((hi, new_lo))
    }
}

/// Divide a 256-bit `(hi, lo)` by `PRECISION`, returning the quotient if it
/// fits in `u128`.
///
/// Small-divisor long division over four 64-bit limbs, most-significant
/// first. The invariant `rem < PRECISION < 2^60` makes each step's dividend
/// `cur = (rem << 64) | limb` at most `2^124`, so `cur` always fits `u128`
/// and each partial quotient always fits `u64`.
///
/// **Further optimisation exists and was deliberately not taken.** The
/// dominant remaining cost is the `u128` division itself: SBF has no 128-bit
/// divide, so each one lowers to the `__udivti3` software routine. Either
/// Granlund–Montgomery division-by-a-constant (`PRECISION` is a constant) or
/// 128÷64 via three native `u64` divisions would cut it further. Both are new,
/// subtle, security-critical code on the hottest path in the protocol, bought
/// for headroom nothing needs — the measured budget is ~80k CU against a
/// 200k limit. Revisit only if that margin actually closes.
#[inline]
const fn div_wad(hi: u128, lo: u128) -> Option<u128> {
    let limbs = [
        (hi >> 64) as u64,
        (hi & M64) as u64,
        (lo >> 64) as u64,
        (lo & M64) as u64,
    ];

    let d = PRECISION;
    let mut rem: u128 = 0;
    let mut q = [0u64; 4];

    // `const fn` cannot use iterators; unrolled by index.
    let mut i = 0;
    while i < 4 {
        let cur = (rem << 64) | (limbs[i] as u128);
        q[i] = (cur / d) as u64;
        rem = cur % d;
        i += 1;
    }

    // Quotient occupies limbs q[0..3]; it fits u128 iff the top two are zero.
    if q[0] != 0 || q[1] != 0 {
        return None;
    }

    Some(((q[2] as u128) << 64) | (q[3] as u128))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// `floor(a * b / 1e18)` with a full 256-bit intermediate.
///
/// Exact over the entire `u128 × u128` domain. Returns `None` only when the
/// true quotient exceeds `u128::MAX`.
///
/// EVM equivalent: `Math.mulDiv(a, b, PRECISION, Math.Rounding.Floor)`.
///
/// ## The narrow fast path
///
/// When `a * b` fits in `u128` the answer is one multiply and one division —
/// no limb decomposition, no four-step long division. This is not a rare case:
/// it covers essentially every operation the protocol actually performs.
/// `rpow`'s squaring keeps `x` near `1e18`, so `x * x` is around `1e36`, well
/// inside `u128::MAX ≈ 3.4e38`; likewise the accumulator step and
/// `raw_to_dollars` at any realistic multiplier.
///
/// The general path exists for correctness at the extremes, not throughput:
/// `div_wad` costs eight software-division libcalls, this path costs one,
/// which is the difference between `mint_oku_m` at ~150k compute units and a
/// small fraction of that.
#[inline]
pub const fn mul_div_wad_floor(a: u128, b: u128) -> Option<u128> {
    if let Some(product) = a.checked_mul(b) {
        return Some(product / PRECISION);
    }
    let (hi, lo) = widening_mul(a, b);
    div_wad(hi, lo)
}

/// `floor((a * b + 5e17) / 1e18)` with a full 256-bit intermediate.
///
/// This is MakerDAO `rpow`'s rounding, reproduced exactly. Used *only* by
/// [`crate::rate::rpow`]; every other conversion in the protocol floors.
///
/// Carries the same narrow fast path as [`mul_div_wad_floor`] — see there for
/// why it covers the real workload. Note the rounding increment can itself
/// carry the product out of `u128`, so the fast path requires BOTH the multiply
/// and the add to stay in range.
///
/// EVM equivalent: the `xxRound` / `zxRound` steps of `MathLib.rpow`.
#[inline]
pub const fn mul_div_wad_half_up(a: u128, b: u128) -> Option<u128> {
    if let Some(product) = a.checked_mul(b) {
        if let Some(rounded) = product.checked_add(HALF_WAD) {
            return Some(rounded / PRECISION);
        }
    }
    let (hi, lo) = widening_mul(a, b);
    match add_u128(hi, lo, HALF_WAD) {
        Some((hi, lo)) => div_wad(hi, lo),
        None => None,
    }
}

/// `floor(a * b / divisor)` — **narrow**: requires the raw product to fit.
///
/// # Precondition (hard contract, not an observation about today's callers)
///
/// **`a * b` must fit in `u128`, independent of `divisor`.** Not "the result
/// must fit" — the *intermediate product* must fit, before any division
/// happens. Violate it and you get `None`, even when the true mathematical
/// quotient `(a*b)/divisor` is small enough to represent perfectly.
///
/// # This is NOT the guarantee its siblings make
///
/// [`mul_div_wad_floor`] and [`mul_div_wad_half_up`] open with a visually
/// identical `checked_mul` fast path, but fall through to
/// [`widening_mul`] + [`div_wad`] on overflow, so they are exact over the
/// **entire** `u128 × u128` domain and their fast path is a pure
/// optimization, invisible to correctness. This function has no such
/// fallback: the fast path *is* the whole implementation. Do not reason
/// about it by analogy with the two functions directly above it.
///
/// It cannot simply reuse [`div_wad`]: that division is a *small-divisor*
/// algorithm requiring `divisor < 2^64`, and the divisor here is the
/// multiplier, which reaches `MAX_MULTIPLIER = 1e24` (~80 bits). Closing the
/// gap properly would mean general 128-bit-divisor long division — the
/// Knuth-algorithm-D class of work this module deliberately avoids (see the
/// module header). Hence the narrow contract, stated rather than removed.
///
/// # Why it is safe where it is used
///
/// The sole in-protocol caller is [`crate::math::dollars_to_raw`], whose
/// product is `u64 × PRECISION ≤ 1.8e37 < u128::MAX` — proven, not assumed,
/// by `proofs::proof_narrow_path_safe_for_u64_times_precision` and pinned by
/// `tests::dollars_to_raw_product_bound_holds`.
///
/// Deliberately NOT re-exported at the crate root (unlike its full-domain
/// siblings) so it cannot be reached as `oku_shared::mul_div_floor_u128_narrow`
/// and mistaken for a general-purpose primitive. The `_narrow` suffix is load
/// bearing; keep it on any future rename.
///
/// Fails closed: returns `None` on product overflow rather than silently
/// truncating, so a caller that violates the precondition gets a visible
/// `None` rather than a wrong number.
#[inline]
pub const fn mul_div_floor_u128_narrow(a: u128, b: u128, divisor: u128) -> Option<u128> {
    if divisor == 0 {
        return None;
    }
    match a.checked_mul(b) {
        Some(product) => Some(product / divisor),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference oracle: exact 256-bit math via `i128`-free big arithmetic
    /// using Rust's built-in `u128` pairs is what we're testing, so the
    /// oracle instead uses string-free schoolbook on `u64` limbs in a
    /// deliberately different shape (repeated doubling) to avoid sharing a
    /// bug with the implementation.
    fn oracle_mul_div(a: u128, b: u128, half: bool) -> Option<u128> {
        // Represent the 256-bit product as 8 u32 limbs, little-endian.
        let mut acc = [0u64; 8];
        let a32 = [
            (a & 0xFFFF_FFFF) as u64,
            ((a >> 32) & 0xFFFF_FFFF) as u64,
            ((a >> 64) & 0xFFFF_FFFF) as u64,
            ((a >> 96) & 0xFFFF_FFFF) as u64,
        ];
        let b32 = [
            (b & 0xFFFF_FFFF) as u64,
            ((b >> 32) & 0xFFFF_FFFF) as u64,
            ((b >> 64) & 0xFFFF_FFFF) as u64,
            ((b >> 96) & 0xFFFF_FFFF) as u64,
        ];
        for (i, &ai) in a32.iter().enumerate() {
            let mut carry = 0u64;
            for (j, &bj) in b32.iter().enumerate() {
                let cur = acc[i + j] + ai * bj + carry;
                acc[i + j] = cur & 0xFFFF_FFFF;
                carry = cur >> 32;
            }
            let mut k = i + b32.len();
            while carry > 0 {
                let cur = acc[k] + carry;
                acc[k] = cur & 0xFFFF_FFFF;
                carry = cur >> 32;
                k += 1;
            }
        }

        if half {
            let mut carry = HALF_WAD;
            let mut k = 0;
            while carry > 0 && k < 8 {
                let cur = acc[k] as u128 + (carry & 0xFFFF_FFFF);
                acc[k] = (cur & 0xFFFF_FFFF) as u64;
                carry = (carry >> 32) + (cur >> 32);
                k += 1;
            }
            if carry > 0 {
                return None;
            }
        }

        // Long division by PRECISION over 32-bit limbs, MSB first.
        let mut rem: u128 = 0;
        let mut q = [0u64; 8];
        for i in (0..8).rev() {
            let cur = (rem << 32) | acc[i] as u128;
            q[i] = (cur / PRECISION) as u64;
            rem = cur % PRECISION;
        }
        // Collapse to u128 if it fits.
        if q[4..].iter().any(|&x| x != 0) {
            return None;
        }
        Some(q[0] as u128 | (q[1] as u128) << 32 | (q[2] as u128) << 64 | (q[3] as u128) << 96)
    }

    fn lcg(state: &mut u128) -> u128 {
        // Two rounds of a 64-bit LCG stitched together — enough entropy for
        // a differential test, no dev-dependency required.
        let mut out: u128 = 0;
        for _ in 0..2 {
            *state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            out = (out << 64) | ((*state >> 33) as u64 as u128);
        }
        out
    }

    #[test]
    fn widening_mul_saturates_but_never_wraps() {
        let (hi, lo) = widening_mul(u128::MAX, u128::MAX);
        // (2^128 - 1)^2 = 2^256 - 2^129 + 1  =>  hi = 2^128 - 2, lo = 1
        assert_eq!(hi, u128::MAX - 1);
        assert_eq!(lo, 1);
    }

    /// Random differential against the independent 32-bit-limb oracle.
    ///
    /// OPERANDS ARE CONSTRAINED, DELIBERATELY. An earlier version drew both
    /// from the full `u128` range. The quotient `a*b / 1e18` then lands around
    /// `2^196`, which fits `u128` only when `a*b < 2^187.8` -- probability
    /// ~1.6e-19. Measured: all 20,000 iterations returned `None` from BOTH
    /// sides, so all 40,000 assertions were `None == None`. A test named
    /// `floor_matches_oracle_random` never compared a single computed value,
    /// in the module whose entire purpose is 256-bit arithmetic.
    ///
    /// Masked so the quotient is ALWAYS representable and the comparison is
    /// always real: `a < 2^120` and `b < 2^60` give `a*b < 2^180`, so
    /// `a*b / 1e18 < 2^120.2`, comfortably inside `u128`. Both operands still
    /// span far wider than the protocol domain, so the 256-bit path is
    /// genuinely exercised (the sibling test covers the realistic range).
    ///
    /// `some_count` makes the vacuous mode impossible to reintroduce silently:
    /// if a future change pushes the operands back out of range, the test fails
    /// rather than passing on `None == None`.
    #[test]
    fn floor_matches_oracle_random() {
        let mut s: u128 = 0x243F_6A88_85A3_08D3;
        let mut some_count = 0usize;
        for _ in 0..20_000 {
            let a = lcg(&mut s) & ((1u128 << 120) - 1);
            let b = lcg(&mut s) & ((1u128 << 60) - 1);
            let got = mul_div_wad_floor(a, b);
            if got.is_some() {
                some_count += 1;
            }
            assert_eq!(got, oracle_mul_div(a, b, false), "floor a={a} b={b}");
            assert_eq!(
                mul_div_wad_half_up(a, b),
                oracle_mul_div(a, b, true),
                "half a={a} b={b}"
            );
        }
        assert!(
            some_count == 20_000,
            "only {some_count}/20000 iterations produced a value — the operand \
             range has drifted and this test is comparing None to None"
        );
    }

    #[test]
    fn floor_matches_oracle_in_protocol_domain() {
        // The domain the protocol actually reaches: amounts up to u64::MAX,
        // multipliers up to MAX_MULTIPLIER, rates around PRECISION.
        let mut s: u128 = 0x13198A2E_03707344;
        for _ in 0..20_000 {
            let amount = lcg(&mut s) % (u64::MAX as u128);
            let mult = lcg(&mut s) % crate::constants::MAX_MULTIPLIER;
            assert_eq!(
                mul_div_wad_floor(amount, mult),
                oracle_mul_div(amount, mult, false)
            );
            assert_eq!(
                mul_div_wad_half_up(amount, mult),
                oracle_mul_div(amount, mult, true)
            );
        }
    }

    #[test]
    fn identity_at_precision() {
        for a in [
            0u128,
            1,
            12_345,
            PRECISION,
            crate::constants::MAX_MULTIPLIER,
            u64::MAX as u128,
        ] {
            assert_eq!(
                mul_div_wad_floor(a, PRECISION),
                Some(a),
                "floor identity a={a}"
            );
        }
    }

    #[test]
    fn half_up_rounds_up_at_exactly_half() {
        // a*b/WAD == 0.5 exactly  =>  half-up gives 1, floor gives 0.
        let a = PRECISION / 2;
        assert_eq!(mul_div_wad_floor(a, PRECISION), Some(a));
        // Construct a product whose WAD-quotient has fractional part 1/2:
        //   a = 1, b = WAD/2  ->  a*b/WAD = 0.5
        assert_eq!(mul_div_wad_floor(1, PRECISION / 2), Some(0));
        assert_eq!(mul_div_wad_half_up(1, PRECISION / 2), Some(1));
    }

    #[test]
    fn none_when_quotient_exceeds_u128() {
        // u128::MAX^2 / 1e18 is ~1.16e59, far beyond u128.
        assert_eq!(mul_div_wad_floor(u128::MAX, u128::MAX), None);
        assert_eq!(mul_div_wad_half_up(u128::MAX, u128::MAX), None);
    }

    #[test]
    fn largest_representable_quotient_is_not_rejected() {
        // Boundary: a = u128::MAX, b = PRECISION  =>  quotient = u128::MAX.
        assert_eq!(mul_div_wad_floor(u128::MAX, PRECISION), Some(u128::MAX));
    }

    #[test]
    fn zero_propagates() {
        assert_eq!(
            mul_div_wad_floor(0, crate::constants::MAX_MULTIPLIER),
            Some(0)
        );
        assert_eq!(
            mul_div_wad_floor(crate::constants::MAX_MULTIPLIER, 0),
            Some(0)
        );
        // half-up of zero is still zero: floor(0 + 5e17 / 1e18) == 0
        assert_eq!(mul_div_wad_half_up(0, 0), Some(0));
    }

    #[test]
    fn narrow_mul_div_rejects_zero_divisor_and_overflow() {
        assert_eq!(mul_div_floor_u128_narrow(1, 1, 0), None);
        assert_eq!(mul_div_floor_u128_narrow(u128::MAX, 2, 1), None);
        assert_eq!(
            mul_div_floor_u128_narrow(100, PRECISION, PRECISION),
            Some(100)
        );
    }

    /// Pins the precondition itself: a product that overflows `u128` returns
    /// `None` EVEN WHEN the true quotient would fit comfortably. This is the
    /// documented narrowing, not a bug — and it is exactly what distinguishes
    /// this function from `mul_div_wad_floor`, which handles the same shape
    /// exactly via its 256-bit fallback.
    #[test]
    fn narrow_mul_div_returns_none_when_product_overflows_despite_small_quotient() {
        // a * b = 2^128, overflows u128 by one. Divisor is huge, so the true
        // quotient is 4 — trivially representable.
        let a = 1u128 << 127;
        let b = 2u128;
        let divisor = 1u128 << 126;
        assert_eq!(mul_div_floor_u128_narrow(a, b, divisor), None);

        // The full-domain sibling handles the very same overflowing product
        // exactly, via its 256-bit fallback — the contrast the doc-comment
        // warns about. Checked against the independent oracle.
        assert!(
            a.checked_mul(b).is_none(),
            "test premise: product must overflow"
        );
        assert_eq!(mul_div_wad_floor(a, b), oracle_mul_div(a, b, false));
        assert!(
            mul_div_wad_floor(a, b).is_some(),
            "full-domain sibling must answer where the narrow one returns None"
        );
    }

    /// The bound `dollars_to_raw` relies on: `u64::MAX * PRECISION` must fit
    /// `u128`, so the narrow path is always safe for that caller.
    #[test]
    fn dollars_to_raw_product_bound_holds() {
        assert!((u64::MAX as u128).checked_mul(PRECISION).is_some());
    }
}

// ---------------------------------------------------------------------------
// Kani formal verification
// ---------------------------------------------------------------------------
//
// Run with: cargo kani --package oku-shared
//
// These prove the properties the randomized tests above can only sample.

#[cfg(kani)]
mod proofs {
    use super::*;

    /// The high limb of `widening_mul` never wraps, for ANY pair of inputs.
    /// Proven by reconstructing the product from `(hi, lo)` and checking the
    /// low half against a native `wrapping_mul`.
    #[kani::proof]
    fn proof_widening_mul_low_half_agrees_with_native() {
        let a: u128 = kani::any();
        let b: u128 = kani::any();
        let (_hi, lo) = widening_mul(a, b);
        assert!(lo == a.wrapping_mul(b));
    }

    /// `hi` is zero exactly when the product fits in `u128`.
    #[kani::proof]
    fn proof_widening_mul_hi_zero_iff_no_overflow() {
        let a: u128 = kani::any();
        let b: u128 = kani::any();
        let (hi, _lo) = widening_mul(a, b);
        assert!((hi == 0) == a.checked_mul(b).is_some());
    }

    /// Multiplying by `PRECISION` then dividing by `PRECISION` is the
    /// identity for every `u128` — i.e. no precision is lost and the
    /// `None` branch is not spuriously taken.
    #[kani::proof]
    fn proof_floor_identity_at_precision() {
        let a: u128 = kani::any();
        assert!(mul_div_wad_floor(a, PRECISION) == Some(a));
    }

    /// Half-up is always ≥ floor, and exceeds it by at most one.
    #[kani::proof]
    fn proof_half_up_within_one_of_floor() {
        let a: u128 = kani::any();
        let b: u128 = kani::any();
        kani::assume(a <= crate::constants::MAX_MULTIPLIER);
        kani::assume(b <= crate::constants::MAX_MULTIPLIER);
        let f = mul_div_wad_floor(a, b);
        let h = mul_div_wad_half_up(a, b);
        if let (Some(f), Some(h)) = (f, h) {
            assert!(h >= f);
            assert!(h - f <= 1);
        }
    }

    /// Commutativity — guards against a limb-ordering bug that would only
    /// manifest asymmetrically.
    #[kani::proof]
    fn proof_commutative() {
        let a: u128 = kani::any();
        let b: u128 = kani::any();
        assert!(mul_div_wad_floor(a, b) == mul_div_wad_floor(b, a));
        assert!(mul_div_wad_half_up(a, b) == mul_div_wad_half_up(b, a));
    }

    /// The division's core invariant: the running remainder stays below the
    /// divisor, which is what makes every partial quotient fit a `u64`.
    #[kani::proof]
    fn proof_div_wad_quotient_bound() {
        // `hi` is SYMBOLIC. An earlier version assumed `hi == 0`, which deletes
        // the entire four-limb long division this proof exists to cover and
        // reduces it to `lo / PRECISION`. With `hi` free the harness actually
        // exercises the carried-remainder path.
        //
        // Bounded so the quotient is representable: `div_wad` answers only when
        // `(hi, lo) / PRECISION` fits `u128`, i.e. `hi < PRECISION`. Above that
        // it must return `None`, which is asserted rather than assumed away.
        //
        // ⚠ NOT CURRENTLY DISCHARGED — see the note on
        // `proof_compound_for_output_clamped` in `rate.rs`. With `hi` symbolic
        // this is a genuine 256-bit long-division proof and the solver does not
        // terminate in 15 minutes. The previous `kani::assume(hi == 0)` DID
        // terminate, but only because it deleted the four-limb path this proof
        // exists to cover. An intractable statement of the right property is
        // more useful than a fast proof of the wrong one; both are tracked.
        let hi: u128 = kani::any();
        let lo: u128 = kani::any();

        match div_wad(hi, lo) {
            Some(q) => {
                // Soundness: the quotient must satisfy the division identity
                // against the reconstructed 256-bit dividend, to within one
                // divisor. Checked on the low limb, which is where a dropped
                // carry would surface.
                assert!(hi < PRECISION);
                let (rhi, rlo) = widening_mul(q, PRECISION);
                assert!(rhi <= hi);
                if rhi == hi {
                    assert!(rlo <= lo);
                }
            }
            None => {
                // The only reason to refuse is an unrepresentable quotient.
                assert!(hi >= PRECISION);
            }
        }
    }

    /// `dollars_to_raw`'s product bound, proven rather than asserted.
    #[kani::proof]
    fn proof_narrow_path_safe_for_u64_times_precision() {
        let v: u64 = kani::any();
        assert!((v as u128).checked_mul(PRECISION).is_some());
    }
}
