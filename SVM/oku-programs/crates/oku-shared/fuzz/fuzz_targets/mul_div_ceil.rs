//! cargo-fuzz target: `mul_div_ceil`, cross-checked against `mul_div_floor`
//! and a `u128` reference.
//!
//! Properties:
//!   1. No panic for any `(a, b, divisor)`.
//!   2. `divisor == 0` returns `None`.
//!   3. `ceil >= floor`, and `ceil - floor` is 0 or 1.
//!   4. `ceil == floor` iff the product divides evenly.
//!   5. Matches the `u128` reference whenever it fits `u64`.
//!
//! Run: `cargo +nightly fuzz run mul_div_ceil -- -max_total_time=60`

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_ceil, mul_div_floor};

fuzz_target!(|data: (u64, u64, u64)| {
    let (a, b, divisor) = data;

    let ceil = mul_div_ceil(a, b, divisor);
    let floor = mul_div_floor(a, b, divisor);

    // Property 2
    if divisor == 0 {
        assert!(ceil.is_none(), "divisor=0 must return None");
        assert!(floor.is_none(), "divisor=0 must return None (floor sibling)");
        return;
    }

    let product = (a as u128) * (b as u128);
    let d = divisor as u128;
    let floor_128 = product / d;
    let ceil_128 = if product % d == 0 {
        floor_128
    } else {
        floor_128 + 1
    };

    // Property 6
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
        if product % d == 0 {
            assert_eq!(c, f, "exact division: ceil != floor");
        } else {
            assert_eq!(c - f, 1, "non-exact division: ceil-floor != 1");
        }
    }
});
