//! cargo-fuzz target: `raw_to_dollars`
//!
//! Properties:
//!   1. No panic for any `(amount, multiplier)`.
//!   2. Identity at `PRECISION`.
//!   3. `multiplier > PRECISION` and `amount > 0` gives `dollars >= amount`.
//!   4. `multiplier < PRECISION` gives `dollars <= amount`.
//!   5. Agrees with `mul_div_wad_floor` (the product exceeds `u128`, so the
//!      256-bit path is what this exercises).
//!
//! Run: cargo +nightly fuzz run raw_to_dollars -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_wad_floor, raw_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u128)| {
    let (amount, multiplier) = data;

    let result = raw_to_dollars(amount, multiplier);

    // Property 5
    let reference =
        mul_div_wad_floor(amount as u128, multiplier).and_then(|v| u64::try_from(v).ok());
    assert_eq!(
        result, reference,
        "raw_to_dollars inconsistent with mul_div_wad_floor (amount={amount}, multiplier={multiplier})"
    );

    // Property 2
    if multiplier == PRECISION {
        assert_eq!(
            result,
            Some(amount),
            "raw_to_dollars: at PRECISION multiplier result must equal amount"
        );
    }

    // Properties 3 & 4
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
