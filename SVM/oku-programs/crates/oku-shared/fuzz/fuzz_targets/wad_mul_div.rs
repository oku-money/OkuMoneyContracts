//! cargo-fuzz target: the 256-bit WAD multiply-divide primitives, checked
//! against an independently-shaped oracle.
//!
//! Properties:
//!   1. No panic over the whole `(u128, u128)` domain.
//!   2. Agreement with a 32-bit-limb schoolbook oracle.
//!   3. `half_up >= floor`, differing by at most 1.
//!   4. Commutativity.
//!   5. `mul_div_wad_floor(a, PRECISION) == a`.
//!
//! Run: cargo +nightly fuzz run wad_mul_div -- -max_total_time=300

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_wad_floor, mul_div_wad_half_up, PRECISION};

/// Schoolbook 128x128 -> 256 over 32-bit limbs, then long division by
/// `PRECISION`; deliberately shaped differently from the implementation.
fn oracle(a: u128, b: u128, half: bool) -> Option<u128> {
    let limbs = |v: u128| -> [u64; 4] {
        [
            (v & 0xFFFF_FFFF) as u64,
            ((v >> 32) & 0xFFFF_FFFF) as u64,
            ((v >> 64) & 0xFFFF_FFFF) as u64,
            ((v >> 96) & 0xFFFF_FFFF) as u64,
        ]
    };

    let mut acc = [0u64; 8];
    let (a32, b32) = (limbs(a), limbs(b));
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
        let mut carry = PRECISION / 2;
        let mut k = 0usize;
        while carry > 0 {
            if k >= 8 {
                return None;
            }
            let cur = acc[k] as u128 + (carry & 0xFFFF_FFFF);
            acc[k] = (cur & 0xFFFF_FFFF) as u64;
            carry = (carry >> 32) + (cur >> 32);
            k += 1;
        }
    }

    let mut rem: u128 = 0;
    let mut q = [0u64; 8];
    for i in (0..8).rev() {
        let cur = (rem << 32) | acc[i] as u128;
        q[i] = (cur / PRECISION) as u64;
        rem = cur % PRECISION;
    }
    if q[4..].iter().any(|&x| x != 0) {
        return None;
    }
    Some(q[0] as u128 | (q[1] as u128) << 32 | (q[2] as u128) << 64 | (q[3] as u128) << 96)
}

fuzz_target!(|data: (u128, u128)| {
    let (a, b) = data;

    let f = mul_div_wad_floor(a, b);
    let h = mul_div_wad_half_up(a, b);

    // Property 2
    assert_eq!(f, oracle(a, b, false), "floor mismatch (a={a}, b={b})");
    assert_eq!(h, oracle(a, b, true), "half_up mismatch (a={a}, b={b})");

    // Property 3
    if let (Some(fv), Some(hv)) = (f, h) {
        assert!(hv >= fv, "half_up < floor (a={a}, b={b})");
        assert!(hv - fv <= 1, "half_up exceeded floor by {} (a={a}, b={b})", hv - fv);
    }

    // Property 4
    assert_eq!(f, mul_div_wad_floor(b, a), "floor not commutative (a={a}, b={b})");
    assert_eq!(h, mul_div_wad_half_up(b, a), "half_up not commutative (a={a}, b={b})");

    // Property 5
    assert_eq!(
        mul_div_wad_floor(a, PRECISION),
        Some(a),
        "identity at PRECISION failed for a={a}"
    );
});
