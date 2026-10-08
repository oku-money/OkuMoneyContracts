//! Full-precision `a * b / 1e18` over `u128` with a 256-bit intermediate
//! (`widening_mul` into `(hi, lo)`, then small-divisor long division by
//! `PRECISION`). Exact over the whole `u128 x u128` domain; `None` only when
//! the true quotient exceeds `u128`. Rationale and algorithm notes:
//! `SVM/README.md` § Precision model.

use crate::constants::PRECISION;

/// Mask for the low 64 bits of a `u128` (splits operands into 64-bit limbs).
const M64: u128 = 0xFFFF_FFFF_FFFF_FFFF;

/// `PRECISION` as a `u64`.
const WAD_U64: u64 = 1_000_000_000_000_000_000;

/// Added before the divide for half-up rounding.
const HALF_WAD: u128 = PRECISION / 2;

// The small-divisor division in `div_wad` requires `PRECISION < 2^64`.
const _: () = assert!(PRECISION == WAD_U64 as u128);
const _: () = assert!(PRECISION < (1u128 << 64));

/// Full 128x128 -> 256-bit product as `(hi, lo)`.
///
/// No intermediate overflows: `hi` tops out at exactly `u128::MAX` (the high
/// half of `(2^128 - 1)^2` is `2^128 - 2`, plus carries), so it saturates but
/// never wraps.
///
/// Limbs are `u64` widened at the multiply, not held as `u128`: on SBF a
/// `u128 * u128` lowers to a `__multi3` libcall, while `(x as u128) * (y as
/// u128)` with `u64` inputs compiles to a native widening multiply.
#[inline]
pub(crate) const fn widening_mul(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a as u64;
    let a_hi = (a >> 64) as u64;
    let b_lo = b as u64;
    let b_hi = (b >> 64) as u64;

    let ll = (a_lo as u128) * (b_lo as u128);
    let lh = (a_lo as u128) * (b_hi as u128);
    let hl = (a_hi as u128) * (b_lo as u128);
    let hh = (a_hi as u128) * (b_hi as u128);

    let mid = (ll >> 64) + (lh & M64) + (hl & M64);

    let lo = (ll & M64) | (mid << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);

    (hi, lo)
}

/// Add a `u128` to a 256-bit `(hi, lo)`; `None` if the 256-bit value overflows.
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

/// Divide a 256-bit `(hi, lo)` by `PRECISION`; `None` if the quotient exceeds `u128`.
///
/// Limb-wise long division, most-significant first. Invariant:
/// `rem < PRECISION < 2^60`, so each `cur = (rem << 64) | limb` is at most
/// `2^124` and each partial quotient fits `u64`.
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

    let mut i = 0;
    while i < 4 {
        let cur = (rem << 64) | (limbs[i] as u128);
        q[i] = (cur / d) as u64;
        rem = cur % d;
        i += 1;
    }

    // Fits `u128` iff the top two limbs are zero.
    if q[0] != 0 || q[1] != 0 {
        return None;
    }

    Some(((q[2] as u128) << 64) | (q[3] as u128))
}

/// `floor(a * b / 1e18)`. EVM: `Math.mulDiv(a, b, PRECISION, Floor)`.
///
/// When `a * b` fits `u128` (nearly every real call) this is one multiply and
/// one division; the 256-bit path only covers the extremes. It is why
/// `mint_oku_m` costs a fraction of the ~150k CU the general path would.
#[inline]
pub const fn mul_div_wad_floor(a: u128, b: u128) -> Option<u128> {
    if let Some(product) = a.checked_mul(b) {
        return Some(product / PRECISION);
    }
    let (hi, lo) = widening_mul(a, b);
    div_wad(hi, lo)
}

/// `floor((a * b + 5e17) / 1e18)`: MakerDAO `rpow`'s half-up rounding, used
/// only by [`crate::rate::rpow`]. The fast path needs both the multiply and
/// the rounding add to stay in `u128`.
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

/// `floor(a * b / divisor)`, **narrow**: requires `a * b` to fit `u128`
/// regardless of `divisor`.
///
/// Unlike the `_wad` siblings there is no 256-bit fallback: it returns `None`
/// on product overflow even when the true quotient is small. The divisor can
/// reach `MAX_MULTIPLIER` (~80 bits), so `div_wad`'s small-divisor algorithm
/// does not apply. The only caller, [`crate::math::dollars_to_raw`], multiplies
/// `u64 * PRECISION` (<= 1.8e37 < `u128::MAX`). Deliberately not re-exported at
/// the crate root; keep the `_narrow` suffix.
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

    const M32: u128 = 0xFFFF_FFFF;

    /// Independent oracle: schoolbook on 32-bit limbs (8 limbs, little-endian),
    /// deliberately shaped differently from the implementation.
    fn oracle_mul_div(a: u128, b: u128, half: bool) -> Option<u128> {
        let mut acc = [0u64; 8];
        let a32 = [
            (a & M32) as u64,
            ((a >> 32) & M32) as u64,
            ((a >> 64) & M32) as u64,
            ((a >> 96) & M32) as u64,
        ];
        let b32 = [
            (b & M32) as u64,
            ((b >> 32) & M32) as u64,
            ((b >> 64) & M32) as u64,
            ((b >> 96) & M32) as u64,
        ];
        for (i, &ai) in a32.iter().enumerate() {
            let mut carry = 0u64;
            for (j, &bj) in b32.iter().enumerate() {
                let cur = acc[i + j] + ai * bj + carry;
                acc[i + j] = cur & M32 as u64;
                carry = cur >> 32;
            }
            let mut k = i + b32.len();
            while carry > 0 {
                let cur = acc[k] + carry;
                acc[k] = cur & M32 as u64;
                carry = cur >> 32;
                k += 1;
            }
        }

        if half {
            let mut carry = HALF_WAD;
            let mut k = 0;
            while carry > 0 && k < 8 {
                let cur = acc[k] as u128 + (carry & M32);
                acc[k] = (cur & M32) as u64;
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
        assert_eq!(hi, u128::MAX - 1);
        assert_eq!(lo, 1);
    }

    /// Random differential against the oracle. Operands are masked
    /// (`a < 2^120`, `b < 2^60`) so the quotient always fits `u128`; unmasked
    /// draws almost always overflow and would compare `None == None`.
    /// `some_count` guards against that regressing.
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
            "only {some_count}/20000 iterations produced a value; operand range drifted"
        );
    }

    #[test]
    fn floor_matches_oracle_in_protocol_domain() {
        // Amounts up to u64::MAX, multipliers up to MAX_MULTIPLIER.
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
        let a = PRECISION / 2;
        assert_eq!(mul_div_wad_floor(a, PRECISION), Some(a));
        // a*b/WAD == 0.5 exactly: half-up gives 1, floor gives 0.
        assert_eq!(mul_div_wad_floor(1, PRECISION / 2), Some(0));
        assert_eq!(mul_div_wad_half_up(1, PRECISION / 2), Some(1));
    }

    #[test]
    fn none_when_quotient_exceeds_u128() {
        assert_eq!(mul_div_wad_floor(u128::MAX, u128::MAX), None);
        assert_eq!(mul_div_wad_half_up(u128::MAX, u128::MAX), None);
    }

    #[test]
    fn largest_representable_quotient_is_not_rejected() {
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

    /// A product overflowing `u128` returns `None` even when the true quotient
    /// is small; `mul_div_wad_floor` answers the same input exactly.
    #[test]
    fn narrow_mul_div_returns_none_when_product_overflows_despite_small_quotient() {
        // a * b = 2^128; true quotient is 4.
        let a = 1u128 << 127;
        let b = 2u128;
        let divisor = 1u128 << 126;
        assert_eq!(mul_div_floor_u128_narrow(a, b, divisor), None);

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

    /// `dollars_to_raw`'s bound: `u64::MAX * PRECISION` fits `u128`.
    #[test]
    fn dollars_to_raw_product_bound_holds() {
        assert!((u64::MAX as u128).checked_mul(PRECISION).is_some());
    }
}

// Run with: cargo kani --package oku-shared

#[cfg(kani)]
mod proofs {
    use super::*;

    /// `u64 * PRECISION` always fits `u128` (the narrow path's precondition).
    #[kani::proof]
    fn proof_narrow_path_safe_for_u64_times_precision() {
        let v: u64 = kani::any();
        assert!((v as u128).checked_mul(PRECISION).is_some());
    }
}
