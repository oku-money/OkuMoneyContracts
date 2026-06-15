//! cargo-fuzz target: `vault_share_round_trip`
//!
//! F-05 remediation: fuzz coverage for the two-multiplier vault share
//! conversion round-trip (`oku_money_to_shares` → `shares_to_oku_money`).
//!
//! The vault math in `oku-dollar` is:
//!   wrap:   `shares = floor(oku_m * oku_m_price / usd_multiplier)`
//!   unwrap: `oku_m  = floor(shares * usd_multiplier / oku_m_price)`
//!
//! Both are `mul_div_floor` calls, so we test the composed primitive here.
//!
//! Properties verified:
//!
//! 1. No panic for any (oku_m, oku_m_price, usd_multiplier) triple.
//! 2. `usd_multiplier == 0` → shares computation returns None (guarded by
//!    `require!` in the handler, but the math primitive itself returns None).
//! 3. `oku_m_price == 0` → unwrap computation returns None.
//! 4. Round-trip monotonicity: `oku_m_out <= oku_m_in` always.
//! 5. Round-trip precision bound: loss bounded by
//!    `ceil(usd_multiplier / oku_m_price) + 1`.
//!    (Two sequential floor divisions, same analysis as `dollars_to_oku_m`.)
//!
//! Run: cargo +nightly fuzz run vault_share_round_trip -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::mul_div_floor;

fuzz_target!(|data: (u64, u64, u64)| {
    let (oku_m_in, oku_m_price, usd_multiplier) = data;

    // Property 2: zero usd_multiplier → shares is None
    let shares_result = mul_div_floor(oku_m_in, oku_m_price, usd_multiplier);
    if usd_multiplier == 0 {
        assert!(
            shares_result.is_none(),
            "vault wrap: usd_multiplier=0 must return None"
        );
        return;
    }

    // Property 3: zero oku_m_price → unwrap is None (checked after we have shares)
    let Some(shares) = shares_result else {
        // Overflow on the wrap step — fine, handler rejects with Overflow error.
        return;
    };

    let oku_m_out_result = mul_div_floor(shares, usd_multiplier, oku_m_price);
    if oku_m_price == 0 {
        assert!(
            oku_m_out_result.is_none(),
            "vault unwrap: oku_m_price=0 must return None"
        );
        return;
    }

    let Some(oku_m_out) = oku_m_out_result else {
        // Overflow on the unwrap step — fine, handler rejects with Overflow error.
        return;
    };

    // Property 4: round-trip monotonicity — never return more than deposited
    assert!(
        oku_m_out <= oku_m_in,
        "vault share round-trip overpaid: oku_m_in={oku_m_in}, oku_m_price={oku_m_price}, \
         usd_multiplier={usd_multiplier}, shares={shares}, oku_m_out={oku_m_out}"
    );

    // Property 5: precision bound.
    //
    // The round-trip loss is bounded by `ceil(usd_multiplier / oku_m_price) + 1`.
    // The `+1` accounts for the floor in the oku_m->shares direction; the
    // ceil term accounts for the floor in the shares->oku_m direction
    // whose unit is `(usd_multiplier / oku_m_price)` in oku_m units.
    //
    // Cycle 3 (2026-06-15): cargo-fuzz turned up a libFuzzer crash on
    // input `(oku_m=3_138_912_443, oku_m_price=1, usd_multiplier=u64::MAX)`
    // because the harness's `(usd_multiplier / oku_m_price) + 2`
    // computed `u64::MAX + 2` and overflowed under
    // `overflow-checks = true`. The production math is correct on the
    // same input (`mul_div_floor` returns Some(0) → round-trip oku_m_out
    // is 0 → loss == oku_m_in is finite and well-defined). The harness
    // bound is what was unsound, not the function under test. Fix:
    // `saturating_add` so the bound itself can't overflow when
    // `usd_multiplier >> oku_m_price` produces a near-`u64::MAX`
    // tolerance. The property is still meaningfully checked: any
    // round-trip loss that fits in u64 is compared against the
    // (saturated) bound.
    let max_loss = (usd_multiplier / oku_m_price).saturating_add(2);
    let actual_loss = oku_m_in.saturating_sub(oku_m_out);
    assert!(
        actual_loss <= max_loss,
        "vault share round-trip: loss {actual_loss} exceeds bound {max_loss} \
         (oku_m_in={oku_m_in}, oku_m_price={oku_m_price}, usd_multiplier={usd_multiplier}, \
         shares={shares}, oku_m_out={oku_m_out})"
    );
});
