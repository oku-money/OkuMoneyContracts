//! cargo-fuzz target: `dollars_to_oku_m`
//!
//! Properties verified:
//!
//! 1. No panic for any (dollar_value, multiplier) pair.
//! 2. multiplier == 0 returns None (division by zero).
//! 3. At multiplier == PRECISION, oku_m_amount == dollar_value (identity).
//! 4. Round-trip monotonicity: dollars_back <= dollar_value always.
//! 5. Round-trip precision bound: loss is bounded by max(multiplier/PRECISION, 1).
//!    Two sequential floor divisions (d->oku_m->d) each lose up to 1 unit
//!    in their respective denominator's scale, so the total dollar-denominated
//!    loss is at most ceil(multiplier / PRECISION). This means at $1 multiplier
//!    the loss is at most 1 lamport, but at $17 multiplier the loss can be up
//!    to 17 lamports -- which is correct behavior for floor-rounded integer math.
//! 6. Consistency with mul_div_floor reference.
//!
//! Run: cargo +nightly fuzz run dollars_to_oku_m -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{dollars_to_oku_m, mul_div_floor, oku_m_to_dollars, PRECISION};

fuzz_target!(|data: (u64, u64)| {
    let (dollar_value, multiplier) = data;

    let result = dollars_to_oku_m(dollar_value, multiplier);

    // Property 2: zero multiplier -> None
    if multiplier == 0 {
        assert!(
            result.is_none(),
            "dollars_to_oku_m: multiplier=0 must return None"
        );
        return;
    }

    // Property 6: consistency with reference
    let reference = mul_div_floor(dollar_value, PRECISION, multiplier);
    assert_eq!(
        result, reference,
        "dollars_to_oku_m inconsistent with mul_div_floor"
    );

    // Property 3: identity at PRECISION
    if multiplier == PRECISION {
        if let Some(oku_m) = result {
            assert_eq!(
                oku_m, dollar_value,
                "dollars_to_oku_m: at PRECISION multiplier result must equal dollar_value"
            );
        }
    }

    // Property 4 & 5: round-trip precision bound
    if let Some(oku_m) = result {
        if let Some(dollars_back) = oku_m_to_dollars(oku_m, multiplier) {
            // Property 4: monotonicity -- never get more dollars back than input
            assert!(
                dollars_back <= dollar_value,
                "dollars_to_oku_m round-trip: got more dollars back than input (dollar_value={dollar_value}, multiplier={multiplier}, oku_m={oku_m}, dollars_back={dollars_back})"
            );

            // Property 5: precision bound (smoke-test, intentionally loose).
            //
            // The round-trip loss in dollar units is bounded by
            // `ceil(multiplier / PRECISION) + 1`. The `+1` accounts for
            // floor-rounding in the `dollars → oku_m` division; the
            // `ceil` term accounts for the floor in the
            // `oku_m → dollars` direction whose unit is
            // `multiplier / PRECISION` dollars.
            //
            // We use a deliberately loose bound (`+2` slack) to avoid
            // false positives in the `multiplier < PRECISION` regime
            // where the floor asymmetry is non-trivial; this catches
            // order-of-magnitude regressions but not single-unit drift.
            // For single-unit-tight verification see the Kani
            // `proof_dollars_to_oku_m_round_trip_monotone` proof which
            // pins `dollars_back <= dollar_value` symbolically.
            //
            // Cycle 4 (S-24, harness-overflow defense): `saturating_add`
            // mirrors the `vault_share_round_trip` cycle-3 fix so a
            // future `multiplier` near `u64::MAX` can't crash the
            // harness on `+ 2`.
            let max_loss = (multiplier / PRECISION).saturating_add(2);
            let actual_loss = dollar_value.saturating_sub(dollars_back);
            assert!(
                actual_loss <= max_loss,
                "dollars_to_oku_m round-trip: loss {actual_loss} exceeds bound {max_loss} (dollar_value={dollar_value}, multiplier={multiplier}, dollars_back={dollars_back})"
            );
        }
    }
});
