//! cargo-fuzz target: `raw_to_dollars`
//!
//! Properties verified:
//!
//!   1. No panic for any (amount, multiplier) pair.
//!   2. At `multiplier == PRECISION` ($1.00), `dollar_value == amount`
//!      (identity).
//!   3. At `multiplier > PRECISION` with non-zero amount,
//!      `dollar_value >= amount` (floor-rounding can equalize at small
//!      `amount` even when the multiplier indicates yield).
//!   4. At `multiplier < PRECISION` (discounted), `dollar_value <= amount`.
//!   5. Consistency with the underlying WAD primitive.
//!
//! Note the multiplier is now `u128` (WAD-scaled, up to `MAX_MULTIPLIER = 1e24`),
//! so the product `amount × multiplier` exceeds `u128` and the conversion
//! routes through a 256-bit intermediate. That widening is the thing this
//! target most needs to exercise.
//!
//! Run: cargo +nightly fuzz run raw_to_dollars -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_wad_floor, raw_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u128)| {
    let (amount, multiplier) = data;

    let result = raw_to_dollars(amount, multiplier);

    // Property 1: no panic (guaranteed by return type, but sanitizers will catch UB)

    // Property 5: consistency with reference implementation
    let reference =
        mul_div_wad_floor(amount as u128, multiplier).and_then(|v| u64::try_from(v).ok());
    assert_eq!(
        result, reference,
        "raw_to_dollars inconsistent with mul_div_wad_floor (amount={amount}, multiplier={multiplier})"
    );

    // Property 2: identity at PRECISION
    if multiplier == PRECISION {
        assert_eq!(
            result,
            Some(amount),
            "raw_to_dollars: at PRECISION multiplier result must equal amount"
        );
    }

    // Properties 3 & 4: direction of the conversion follows the multiplier.
    if let Some(dollars) = result {
        if multiplier > PRECISION && amount > 0 {
            assert!(
                dollars >= amount,
                "raw_to_dollars: multiplier > PRECISION should yield dollars >= amount (amount={amount}, multiplier={multiplier}, dollars={dollars})"
            );
        }
        if multiplier < PRECISION {
            assert!(
                dollars <= amount,
                "raw_to_dollars: multiplier < PRECISION should yield dollars <= amount"
            );
        }
    }
});
