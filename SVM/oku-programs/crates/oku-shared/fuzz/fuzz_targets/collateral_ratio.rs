//! cargo-fuzz target: `collateral_ratio`
//!
//! Coverage for `oku_shared::vault_math::collateral_ratio`, the
//! three-way widening multiplication that gates every yield event in
//! `oku-dollar::update_usd_multiplier` (and the deposit/withdraw
//! reserve flows). Cross-checked against an in-test u128 reference
//! implementation (we can't reach for `primitive_types::U256` here
//! without complicating the fuzz crate; instead the property is
//! re-derived from `mul_div_floor` step-wise, which is the same
//! primitive `collateral_ratio` composes — but the reconstruction
//! catches any future refactor that introduces a different ordering
//! of `checked_mul`s).
//!
//! Properties verified:
//!
//!   1. No panic for any `(reserve, supply, usd_mult, oku_m_price)`
//!      input tuple.
//!   2. `supply == 0` → result == Some(u64::MAX) (the documented
//!      "infinite collateralisation" sentinel).
//!   3. `oku_m_price == 0` AND `supply != 0` → result is Some(0) when
//!      the numerator survives (since the numerator multiplies in
//!      `oku_m_price`, an `oku_m_price == 0` zeroes it out).
//!   4. Result matches the u128 reference oracle when both fit.
//!   5. Monotone in `reserve_balance`: more reserves never decreases
//!      the ratio.
//!
//! Run: `cargo +nightly fuzz run collateral_ratio -- -max_total_time=60`

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::vault_math::collateral_ratio;
use oku_shared::PRECISION;

fuzz_target!(|data: (u64, u64, u64, u64)| {
    let (reserve, supply, usd_mult, price) = data;

    let result = collateral_ratio(reserve, supply, usd_mult, price);

    // Property 1 (implicit): no panic above this point. If we got here,
    // the function returned `Some`/`None` cleanly.

    // Property 2: zero supply → infinite-collat sentinel.
    if supply == 0 {
        assert_eq!(
            result,
            Some(u64::MAX),
            "supply==0 must return Some(u64::MAX), got {result:?}"
        );
        return;
    }

    // Property 3: denominator collapse — when `supply * usd_mult == 0`
    // (only possible here if `usd_mult == 0`, since `supply > 0` was
    // just established), the function returns the sentinel
    // `Some(u64::MAX)`. The documented contract treats this as
    // "undefined-but-infinite", matching the zero-supply branch.
    if usd_mult == 0 {
        assert_eq!(
            result,
            Some(u64::MAX),
            "usd_mult==0 (denominator collapse) must return Some(u64::MAX), got {result:?}"
        );
        return;
    }

    // Property 4: zero price + non-zero supply + non-zero multiplier
    // → the numerator collapses to 0, so the ratio is 0. (Or the
    // intermediate multiplication overflows u128 and we get None.)
    if price == 0 {
        match result {
            Some(0) => {}
            None => {}
            other => panic!(
                "price==0,supply>0,usd_mult>0 should be Some(0)|None, got {other:?}"
            ),
        }
    }

    // Property 4: u128 reference oracle.
    if let Some(r) = result {
        // Reproduce the math step-wise. The denominator multiplication
        // cannot overflow u128 (u64 × u64). The numerator is three-way;
        // if it overflows u128 the function would have returned None
        // already, so reach here means it fit.
        let denom = (supply as u128) * (usd_mult as u128);
        if denom == 0 {
            // Function would have returned Some(u64::MAX) — verify.
            assert_eq!(r, u64::MAX);
        } else {
            // Numerator may not fit in u128 if we got here without
            // overflowing — but `vault_math::collateral_ratio` did
            // `checked_mul`s, so reaching `Some(r)` implies it did fit.
            // Reconstruct the expected value.
            if let Some(num) =
                (reserve as u128).checked_mul(price as u128).and_then(|x| x.checked_mul(PRECISION as u128))
            {
                let expected_128 = num / denom;
                let expected = u64::try_from(expected_128).unwrap_or(u64::MAX);
                assert_eq!(
                    r, expected,
                    "ratio mismatch: reserve={reserve}, supply={supply}, mult={usd_mult}, price={price}"
                );
            }
        }
    }

    // Property 5: monotonicity in reserve. Only check when both sides
    // succeed (overflow on either is acceptable).
    if reserve < u64::MAX {
        let next = collateral_ratio(reserve + 1, supply, usd_mult, price);
        if let (Some(a), Some(b)) = (result, next) {
            assert!(
                b >= a,
                "non-monotone in reserve: ratio({reserve})={a}, ratio({})={b}",
                reserve + 1
            );
        }
    }
});
