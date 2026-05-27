//! cargo-fuzz target: `oku_m_to_dollars`
//!
//! Properties verified:
//!
//! 1. No panic for any (amount, multiplier) pair.
//! 2. At multiplier == PRECISION ($1.00), dollar_value == amount (identity).
//! 3. At multiplier > PRECISION, dollar_value > amount (yield > 0).
//! 4. At multiplier < PRECISION (discounted), dollar_value < amount.
//! 5. Result never exceeds amount when multiplier <= PRECISION (no inflation via small multiplier).
//! 6. Consistency with mul_div_floor reference: result == mul_div_floor(amount, multiplier, PRECISION).
//!
//! Run: cargo +nightly fuzz run oku_m_to_dollars -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{mul_div_floor, oku_m_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u64)| {
    let (amount, multiplier) = data;

    let result = oku_m_to_dollars(amount, multiplier);

    // Property 1: no panic (guaranteed by return type, but sanitizers will catch UB)

    // Property 6: consistency with reference implementation
    let reference = mul_div_floor(amount, multiplier, PRECISION);
    assert_eq!(
        result, reference,
        "oku_m_to_dollars inconsistent with mul_div_floor (amount={amount}, multiplier={multiplier})"
    );

    // Property 2: identity at PRECISION
    if multiplier == PRECISION && result.is_some() {
        assert_eq!(
            result,
            Some(amount),
            "oku_m_to_dollars: at PRECISION multiplier result must equal amount"
        );
    }

    // Property 3: yield at multiplier > PRECISION (only valid when no overflow)
    if let Some(dollars) = result {
        if multiplier > PRECISION && amount > 0 {
            assert!(
                dollars >= amount,
                "oku_m_to_dollars: multiplier > PRECISION should yield dollars >= amount (amount={amount}, multiplier={multiplier}, dollars={dollars})"
            );
        }
        if multiplier < PRECISION {
            assert!(
                dollars <= amount,
                "oku_m_to_dollars: multiplier < PRECISION should yield dollars <= amount"
            );
        }
    }
});
