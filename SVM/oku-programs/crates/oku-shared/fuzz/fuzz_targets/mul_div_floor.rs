//! cargo-fuzz target: `mul_div_floor`
//!
//! Properties for every `(a, b, divisor)`:
//! 1. No panic.
//! 2. `divisor == 0` returns `None`.
//! 3. Product overflow or an out-of-`u64` result returns `None`.
//! 4. When `Some`, equals `floor(a * b / divisor)` via a `u128` reference.
//! 5. Result `<= a` when `b <= divisor`, and `<= b` when `a <= divisor`.
//! 6. Monotonic in `a` whenever both calls succeed.
//!
//! Run: cargo +nightly fuzz run mul_div_floor -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::mul_div_floor;

fuzz_target!(|data: (u64, u64, u64)| {
    let (a, b, divisor) = data;

    let result = mul_div_floor(a, b, divisor);

    // Properties 1 & 2
    if divisor == 0 {
        assert!(
            result.is_none(),
            "mul_div_floor: divisor=0 must return None"
        );
        return;
    }

    // Properties 3 & 4
    let product_128 = (a as u128).checked_mul(b as u128);
    match product_128 {
        None => {
            assert!(
                result.is_none(),
                "mul_div_floor: u128 product overflow must return None (a={a}, b={b}, d={divisor})"
            );
        }
        Some(prod) => {
            let expected_128 = prod / (divisor as u128);
            if expected_128 > u64::MAX as u128 {
                assert!(
                    result.is_none(),
                    "mul_div_floor: result > u64::MAX must return None (a={a}, b={b}, d={divisor})"
                );
            } else {
                let expected = expected_128 as u64;
                assert_eq!(
                    result,
                    Some(expected),
                    "mul_div_floor: incorrect result (a={a}, b={b}, d={divisor})"
                );
            }
        }
    }

    // Property 5
    if let Some(r) = result {
        if b <= divisor {
            assert!(r <= a, "Property 5: r <= a when b <= divisor (got {r} > {a})");
        }
        if a <= divisor {
            assert!(r <= b, "Property 5: r <= b when a <= divisor (got {r} > {b})");
        }
    }

    // Property 6 (skip `a == u64::MAX` to avoid wrapping `a + 1`).
    if a < u64::MAX {
        let next = mul_div_floor(a + 1, b, divisor);
        if let (Some(curr), Some(nxt)) = (result, next) {
            assert!(
                nxt >= curr,
                "Property 6: non-monotone (a={a}, b={b}, d={divisor}): curr={curr}, next={nxt}"
            );
        }
    }
});
