//! cargo-fuzz target: `calculate_fee`
//!
//! Properties verified:
//!
//! 1. No panic for any (amount, fee_bps) pair.
//! 2. fee_bps == 0 always returns Some(0) (zero fee).
//! 3. fee_bps == 10_000 (100%) returns Some(amount) (full fee).
//! 4. Fee never exceeds amount: result <= amount for any fee_bps in [0, 10_000].
//! 5. Fee is monotonically non-decreasing in fee_bps (higher bps → higher fee).
//! 6. Consistency with mul_div_floor reference: fee == mul_div_floor(amount, fee_bps, 10_000).
//! 7. u16 input domain: fee_bps is capped at u16::MAX (65_535), but the protocol
//!    should only accept values up to 10_000. Fuzz the full u16 range to ensure
//!    no overflow for out-of-range values.
//!
//! Run: cargo +nightly fuzz run calculate_fee -- -max_total_time=60

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{calculate_fee, mul_div_floor, BASIS_POINTS};

fuzz_target!(|data: (u64, u16)| {
    let (amount, fee_bps) = data;

    let result = calculate_fee(amount, fee_bps);

    // Property 6: consistency with reference
    let reference = mul_div_floor(amount, fee_bps as u64, BASIS_POINTS);
    assert_eq!(
        result, reference,
        "calculate_fee inconsistent with mul_div_floor (amount={amount}, fee_bps={fee_bps})"
    );

    // Property 2: zero fee_bps → zero fee
    if fee_bps == 0 {
        assert_eq!(
            result,
            Some(0),
            "calculate_fee: fee_bps=0 must return Some(0)"
        );
    }

    // Properties 3 & 4: fee in valid range
    if fee_bps <= BASIS_POINTS as u16 {
        if let Some(fee) = result {
            assert!(
                fee <= amount,
                "calculate_fee: fee ({fee}) exceeds amount ({amount}) for fee_bps={fee_bps}"
            );

            if fee_bps == BASIS_POINTS as u16 {
                assert_eq!(fee, amount, "calculate_fee: 100% fee must equal amount");
            }
        }
    }

    // Property 5: monotonicity in fee_bps. Cycle 4 (S-20): header
    // claimed this property but the body didn't actually check it.
    // `calculate_fee(amount, k) <= calculate_fee(amount, k+1)`
    // whenever both succeed. Overflow on the higher side is
    // acceptable (the bigger product can narrow-fail where the
    // smaller didn't).
    if fee_bps < u16::MAX {
        let next = calculate_fee(amount, fee_bps + 1);
        match (result, next) {
            (Some(a), Some(b)) => {
                assert!(
                    a <= b,
                    "fee non-monotone: f({fee_bps})={a} > f({})={b}",
                    fee_bps + 1
                );
            }
            (Some(_), None) => {
                // Higher fee_bps overflowed — acceptable (fee math
                // narrowing fails earlier as bps climbs).
            }
            (None, Some(_)) => {
                panic!(
                    "non-monotone overflow: f({fee_bps})=None but f({})=Some",
                    fee_bps + 1
                );
            }
            (None, None) => {}
        }
    }
});
