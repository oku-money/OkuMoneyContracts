//! Yield-distribution sandwich-lock primitive: no user op in the same slot as
//! a yield event. Callers pass in `Clock::get()?.slot`.

/// `true` when `current_slot` equals the stored yield-distribution slot.
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
        assert!(!yield_lock_engaged(0, 1_000_000));
    }
}
