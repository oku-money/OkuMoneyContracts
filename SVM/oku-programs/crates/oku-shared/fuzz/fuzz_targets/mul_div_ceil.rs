//! cargo-fuzz target: `mul_div_ceil`
//!
//! Coverage for the new `oku_shared::mul_div_ceil` primitive (cycle 4,
//! PSM-05). Cross-checks against `mul_div_floor` and against an in-test
//! u128 reference implementation.
//!
//! Properties verified:
//!
//!   1. No panic for any `(a, b, divisor)` triple.
//!   2. `divisor == 0` → result == None (no divide-by-zero panic).
//!   3. `ceil >= floor` always — never returns less than `mul_div_floor`.
//!   4. `ceil - floor ∈ {0, 1}` — the rounding difference is at most one
//!      unit (or both are None when the rest of the math overflows).
//!   5. `ceil == floor` iff the product divides evenly.
//!   6. Result matches the u128 reference when it fits in u64.
//!
//! Run: `cargo +nightly fuzz run mul_div_ceil -- -max_total_time=60`

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_ceil, mul_div_floor};

fuzz_target!(|data: (u64, u64, u64)| {
    let (a, b, divisor) = data;

    let ceil = mul_div_ceil(a, b, divisor);
    let floor = mul_div_floor(a, b, divisor);

    // Property 2: divisor == 0 → None.
    if divisor == 0 {
        assert!(ceil.is_none(), "divisor=0 must return None");
        assert!(floor.is_none(), "divisor=0 must return None (floor sibling)");
        return;
    }

    // Reference oracle in u128.
    let product = (a as u128) * (b as u128); // u64×u64 always fits
    let d = divisor as u128;
    let floor_128 = product / d;
    let ceil_128 = if product % d == 0 {
        floor_128
    } else {
        floor_128 + 1
    };

    // Property 6 (oracle agreement).
    match (floor, floor_128 <= u64::MAX as u128) {
        (Some(v), true) => assert_eq!(v as u128, floor_128, "floor disagrees with oracle"),
        (None, true) => panic!("floor returned None but oracle fits"),
        (Some(_), false) => panic!("floor returned Some but oracle doesn't fit u64"),
        (None, false) => {}
    }
    match (ceil, ceil_128 <= u64::MAX as u128) {
        (Some(v), true) => assert_eq!(v as u128, ceil_128, "ceil disagrees with oracle"),
        (None, true) => panic!("ceil returned None but oracle fits"),
        (Some(_), false) => panic!("ceil returned Some but oracle doesn't fit u64"),
        (None, false) => {}
    }

    // Properties 3, 4, 5.
    if let (Some(c), Some(f)) = (ceil, floor) {
        assert!(c >= f, "ceil < floor: {c} < {f}");
        assert!(c - f <= 1, "ceil-floor > 1: {c}-{f}={}", c - f);
        // Property 5
        if product % d == 0 {
            assert_eq!(c, f, "exact division: ceil != floor");
        } else {
            assert_eq!(c - f, 1, "non-exact division: ceil-floor != 1");
        }
    }
});
