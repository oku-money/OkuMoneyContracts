//! Pure yield-distribution sandwich-lock primitive.
//!
//! The lite-psm program enforces a "no user op in the same slot as a
//! yield event" invariant. The slot comparison itself is one line; the
//! Anchor-error mapping is per-program. This crate owns the comparison
//! so a future change (e.g. a wider lock window) lands in one place.
//!
//! No `anchor-lang`, no `solana-program`, no I/O — by design. Callers
//! resolve `Clock::get()?.slot` themselves and pass it in.

/// Return `true` when the current slot collides with the stored
/// yield-distribution slot. A wrapping `check_yield_lock_*` should
/// emit its program-specific `OverrideInProgress` error in
/// that case.
#[inline]
pub const fn yield_lock_engaged(stored_slot: u64, current_slot: u64) -> bool {
    stored_slot == current_slot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engaged_same_slot() {
        assert!(yield_lock_engaged(42, 42));
    }

    #[test]
    fn disengaged_adjacent_slots() {
        assert!(!yield_lock_engaged(42, 43));
        assert!(!yield_lock_engaged(43, 42));
    }

    #[test]
    fn disengaged_initial_state() {
        // Stored slot is 0 (genesis sentinel) and current is somewhere
        // post-genesis — never engaged in practice.
        assert!(!yield_lock_engaged(0, 1_000_000));
    }
}
