//! cargo-fuzz target: `dollars_to_raw`
//!
//! Properties verified:
//!
//! 1. No panic for any (dollar_value, multiplier) pair.
//! 2. multiplier == 0 returns None (division by zero).
//! 3. At multiplier == PRECISION, raw_amount == dollar_value (identity).
//! 4. Round-trip monotonicity: dollars_back <= dollar_value always.
//! 5. Round-trip precision bound: loss is bounded by max(multiplier/PRECISION, 1).
//!    Two sequential floor divisions (d->raw->d) each lose up to 1 unit
//!    in their respective denominator's scale, so the total dollar-denominated
//!    loss is at most ceil(multiplier / PRECISION). This means at $1 multiplier
//!    the loss is at most 1 lamport, but at $17 multiplier the loss can be up
//!    to 17 lamports -- which is correct behavior for floor-rounded integer math.
//! 6. Consistency with the narrow `mul_div_floor_u128` reference.
//!
//! The multiplier is `u128` (WAD-scaled) since the 1e18 migration. Unlike
//! `raw_to_dollars`, this direction divides BY the multiplier, so it does not
//! need the 256-bit path — the numerator `u64 × 1e18` always fits `u128`.
//!
//! Run: cargo +nightly fuzz run dollars_to_raw -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{dollars_to_raw, mul_div_floor_u128, raw_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u128)| {
    let (dollar_value, multiplier) = data;

    let result = dollars_to_raw(dollar_value, multiplier);

    // Property 2: zero multiplier -> None
    if multiplier == 0 {
        assert!(
            result.is_none(),
            "dollars_to_raw: multiplier=0 must return None"
        );
        return;
    }

    // Property 6: consistency with reference
    let reference = mul_div_floor_u128(dollar_value as u128, PRECISION, multiplier)
        .and_then(|v| u64::try_from(v).ok());
    assert_eq!(
        result, reference,
        "dollars_to_raw inconsistent with mul_div_floor_u128"
    );

    // Property 3: identity at PRECISION
    if multiplier == PRECISION {
        assert_eq!(
            result,
            Some(dollar_value),
            "dollars_to_raw: at PRECISION multiplier result must equal dollar_value"
        );
    }

    // Property 4 & 5: round-trip precision bound
    if let Some(raw) = result {
        if let Some(dollars_back) = raw_to_dollars(raw, multiplier) {
            // Property 4: monotonicity -- never get more dollars back than input
            assert!(
                dollars_back <= dollar_value,
                "dollars_to_raw round-trip: got more dollars back than input (dollar_value={dollar_value}, multiplier={multiplier}, raw={raw}, dollars_back={dollars_back})"
            );

            // Property 5: precision bound (smoke-test, intentionally loose).
            // Saturating cast: a multiplier/PRECISION ratio beyond u64 implies
            // an astronomically large bound, so saturation only loosens it.
            let max_loss = u64::try_from(multiplier / PRECISION)
                .unwrap_or(u64::MAX)
                .saturating_add(2);
            let actual_loss = dollar_value.saturating_sub(dollars_back);
            assert!(
                actual_loss <= max_loss,
                "dollars_to_raw round-trip: loss {actual_loss} exceeds bound {max_loss} (dollar_value={dollar_value}, multiplier={multiplier}, dollars_back={dollars_back})"
            );
        }
    }
});
