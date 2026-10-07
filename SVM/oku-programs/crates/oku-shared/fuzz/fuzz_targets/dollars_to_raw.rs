//! cargo-fuzz target: `dollars_to_raw`
//!
//! Properties:
//! 1. No panic for any `(dollar_value, multiplier)`.
//! 2. `multiplier == 0` returns `None`.
//! 3. Identity at `PRECISION`.
//! 4. Round trip never returns more dollars than the input.
//! 5. Round-trip loss is at most `multiplier / PRECISION + 2` (two chained floors).
//! 6. Agrees with `wad::mul_div_floor_u128_narrow` (valid here since
//!    `u64 * PRECISION` fits `u128`).
//!
//! Run: cargo +nightly fuzz run dollars_to_raw -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::wad::mul_div_floor_u128_narrow;
use oku_shared::{dollars_to_raw, raw_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u128)| {
    let (dollar_value, multiplier) = data;

    let result = dollars_to_raw(dollar_value, multiplier);

    // Property 2
    if multiplier == 0 {
        assert!(
            result.is_none(),
            "dollars_to_raw: multiplier=0 must return None"
        );
        return;
    }

    // Property 6
    let reference = mul_div_floor_u128_narrow(dollar_value as u128, PRECISION, multiplier)
        .and_then(|v| u64::try_from(v).ok());
    assert_eq!(
        result, reference,
        "dollars_to_raw inconsistent with mul_div_floor_u128_narrow"
    );

    // Property 3
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
            // Property 4
            assert!(
                dollars_back <= dollar_value,
                "dollars_to_raw round-trip: got more dollars back than input (dollar_value={dollar_value}, multiplier={multiplier}, raw={raw}, dollars_back={dollars_back})"
            );

            // Property 5 (loose; the saturating cast only loosens the bound).
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
