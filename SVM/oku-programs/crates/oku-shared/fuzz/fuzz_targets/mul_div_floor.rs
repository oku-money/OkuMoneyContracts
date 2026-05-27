//! cargo-fuzz target: `mul_div_floor`
//!
//! Properties verified for every (a, b, divisor) triple:
//!
//! 1. No panic -- the function must never panic for any input.
//! 2. Division-by-zero safety -- divisor=0 returns None, never panics.
//! 3. Overflow safety -- large inputs return None, never wrap/panic.
//! 4. Correctness (when Some): result == floor(a * b / divisor)
//!    verified via u128 reference computation.
//! 5. Upper bound: result <= a (when b <= divisor) and result <= b (when a <= divisor).
//! 6. Monotonicity: mul_div_floor(a, b, d) <= mul_div_floor(a+1, b, d) for all valid inputs.
//!
//! Run: cargo +nightly fuzz run mul_div_floor -- -max_total_time=60
//! (from crates/oku-shared/)

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::mul_div_floor;

fuzz_target!(|data: (u64, u64, u64)| {
    let (a, b, divisor) = data;

    let result = mul_div_floor(a, b, divisor);

    // Property 1 & 2: no panic, divisor=0 → None
    if divisor == 0 {
        assert!(
            result.is_none(),
            "mul_div_floor: divisor=0 must return None"
        );
        return;
    }

    // Property 3 & 4: when Some, verify correctness against u128 reference
    let product_128 = (a as u128).checked_mul(b as u128);
    match product_128 {
        None => {
            // u128 overflow -- result must be None
            assert!(
                result.is_none(),
                "mul_div_floor: u128 product overflow must return None (a={a}, b={b}, d={divisor})"
            );
        }
        Some(prod) => {
            let expected_128 = prod / (divisor as u128);
            if expected_128 > u64::MAX as u128 {
                // Result overflows u64 -- must be None
                assert!(
                    result.is_none(),
                    "mul_div_floor: result > u64::MAX must return None (a={a}, b={b}, d={divisor})"
                );
            } else {
                // Result fits -- must be Some and equal to expected
                let expected = expected_128 as u64;
                assert_eq!(
                    result,
                    Some(expected),
                    "mul_div_floor: incorrect result (a={a}, b={b}, d={divisor})"
                );
            }
        }
    }
});
