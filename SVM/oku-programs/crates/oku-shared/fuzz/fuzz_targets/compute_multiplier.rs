//! cargo-fuzz target: `compute_multiplier` — the streaming accrual function.
//!
//! This is the highest-value fuzz target in the crate. `compute_multiplier`
//! is a *view*: it is evaluated on every mint, every redeem, and by every
//! wallet, on every chain. A panic here bricks the PSM; a wrong value breaks
//! cross-chain agreement silently.
//!
//! Properties verified:
//!
//!   1. **Never panics.** The EVM counterpart is fuzzed for exactly this
//!      (`OkuMoney.fuzz.t.sol:351 testFuzz_OkuMMultiplierNeverReverts`).
//!   2. **Monotonic in time.** For a fixed schedule, `m(t2) >= m(t1)` for
//!      `t2 >= t1`. The multiplier can never decrease — the protocol has no
//!      on-chain representation of a loss.
//!   3. **Clamped.** Output never exceeds `MAX_MULTIPLIER`.
//!   4. **No supply term.** Trivially true by signature — there is no supply
//!      argument — which is what makes the value identical across chains.
//!   5. **Halted schedules are flat.** `rate == PRECISION` with no armed
//!      successor returns `base` for every timestamp.
//!   6. **Bounded overhang.** Past `pending_rate_end` the value freezes:
//!      an unattended successor halts rather than compounding forever.
//!
//! Run: cargo +nightly fuzz run compute_multiplier -- -max_total_time=300

#![no_main]

use libfuzzer_sys::fuzz_target;
use oku_shared::{compute_multiplier, Schedule, MAX_MULTIPLIER, MAX_RATE, PRECISION};

/// Coerce arbitrary fuzz bytes into a schedule that satisfies the *writer*
/// invariants the on-chain instructions enforce. Fuzzing wholly unconstrained
/// inputs is also useful (property 1 holds unconditionally), but the
/// interesting properties only apply to schedules a writer could produce.
fn realistic_schedule(raw: (u128, u64, i64, i64, u64, i64)) -> Schedule {
    let (base, rate, anchor, rate_end_delta, pending_rate, pending_delta) = raw;

    let base = (base % MAX_MULTIPLIER).max(PRECISION);
    // Rates live in [PRECISION, MAX_RATE].
    let rate = PRECISION + (rate as u128 % (MAX_RATE - PRECISION + 1));
    let pending_rate = PRECISION + (pending_rate as u128 % (MAX_RATE - PRECISION + 1));

    // Anchor in a sane epoch range; windows strictly ordered and bounded.
    // `rem_euclid` already yields a non-negative result, which also keeps us
    // inside `compute_multiplier`'s non-negative-timestamp domain.
    let anchor = anchor.rem_euclid(4_000_000_000);
    let rate_end = anchor.saturating_add(rate_end_delta.rem_euclid(90 * 86_400) + 1);
    let pending_rate_end = rate_end.saturating_add(pending_delta.rem_euclid(90 * 86_400) + 1);

    Schedule {
        base_multiplier: base,
        rate_per_second: rate,
        last_accrual_time: anchor,
        rate_end,
        pending_rate_per_second: pending_rate,
        pending_rate_end,
    }
}

fuzz_target!(|data: (u128, u64, i64, i64, u64, i64, u32, u32)| {
    let (base, rate, anchor, red, prate, pd, dt1, dt2) = data;

    // ---- Property 1: never panics, even on wholly unconstrained input ----
    let _ = compute_multiplier(base, rate as u128, anchor, red, prate as u128, pd, anchor);

    let s = realistic_schedule((base, rate, anchor, red, prate, pd));

    // Two timestamps at/after the anchor, ordered.
    let a = s.last_accrual_time.saturating_add(dt1.min(dt2) as i64);
    let b = s.last_accrual_time.saturating_add(dt1.max(dt2) as i64);

    let ma = s.multiplier_at(a);
    let mb = s.multiplier_at(b);

    // ---- Property 3: clamped ----
    if let Some(v) = ma {
        assert!(
            v <= MAX_MULTIPLIER,
            "multiplier {v} exceeded MAX_MULTIPLIER at t={a} for {s:?}"
        );
    }

    // ---- Property 2: monotonic in time ----
    if let (Some(va), Some(vb)) = (ma, mb) {
        assert!(
            vb >= va,
            "multiplier DECREASED: m({a})={va} > m({b})={vb} for {s:?}"
        );
    }

    // ---- Property 6: bounded overhang — value freezes past pending_rate_end ----
    if s.pending_rate_end > 0 {
        let past = s.pending_rate_end.saturating_add(1);
        let way_past = s.pending_rate_end.saturating_add(3_650 * 86_400);
        if let (Some(x), Some(y)) = (s.multiplier_at(past), s.multiplier_at(way_past)) {
            assert_eq!(
                x, y,
                "overhang NOT bounded: accrual continued past pending_rate_end for {s:?}"
            );
        }
    }

    // ---- Property 5: halted schedules are flat ----
    let halted = Schedule {
        base_multiplier: s.base_multiplier,
        rate_per_second: PRECISION,
        last_accrual_time: s.last_accrual_time,
        rate_end: 0,
        pending_rate_per_second: PRECISION,
        pending_rate_end: 0,
    };
    assert_eq!(
        halted.multiplier_at(b),
        Some(s.base_multiplier),
        "halted schedule was not flat"
    );
});
