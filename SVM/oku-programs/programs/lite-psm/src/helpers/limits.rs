//! Supply-cap and allowance checks shared by the mint and burn paths.

use crate::errors::LitePsmError;
use anchor_lang::prelude::*;

/// Returns `current + amount`, rejecting overflow and totals above `max_supply`.
pub fn check_supply_cap(current: u64, amount: u64, max_supply: u64) -> Result<u64> {
    let new_total = current.checked_add(amount).ok_or(LitePsmError::Overflow)?;
    require!(new_total <= max_supply, LitePsmError::MaxSupplyExceeded);
    Ok(new_total)
}

/// Check `amount` against `allowance` and decrement it. Done before the CPI as
/// plain effects-then-interactions hygiene, not a reentrancy defence: Solana
/// forbids a program re-entering itself within one transaction.
pub fn consume_allowance(allowance: &mut u64, amount: u64) -> Result<()> {
    *allowance = allowance
        .checked_sub(amount)
        .ok_or(LitePsmError::AllowanceExceeded)?;
    Ok(())
}

/// Restore up to `amount` to `allowance` after a burn, never above `limit`.
/// An allowance already at or above `limit` is left untouched (never lowered),
/// e.g. while `limit` still reads 0 after an upgrade.
pub fn restore_allowance(allowance: &mut u64, limit: u64, amount: u64) {
    if *allowance < limit {
        *allowance = allowance.saturating_add(amount).min(limit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supply_cap_allows_exactly_max_and_rejects_above() {
        assert_eq!(check_supply_cap(90, 10, 100).unwrap(), 100);
        assert!(check_supply_cap(90, 11, 100).is_err());
        assert!(check_supply_cap(u64::MAX, 1, u64::MAX).is_err());
    }

    #[test]
    fn allowance_is_decremented_and_cannot_underflow() {
        let mut allowance = 10;
        consume_allowance(&mut allowance, 4).unwrap();
        assert_eq!(allowance, 6);
        assert!(consume_allowance(&mut allowance, 7).is_err());
        assert_eq!(allowance, 6);
    }

    #[test]
    fn restore_is_capped_at_limit() {
        let mut allowance = 4;
        restore_allowance(&mut allowance, 10, 3);
        assert_eq!(allowance, 7);
        restore_allowance(&mut allowance, 10, 100);
        assert_eq!(allowance, 10);
        let mut a = u64::MAX - 1;
        restore_allowance(&mut a, u64::MAX, u64::MAX);
        assert_eq!(a, u64::MAX);
    }

    #[test]
    fn restore_never_lowers_an_allowance_above_limit() {
        // Post-upgrade: limit reads 0 from `reserved`, allowance is live.
        let mut allowance = 1_000;
        restore_allowance(&mut allowance, 0, 500);
        assert_eq!(allowance, 1_000);
        let mut at = 10;
        restore_allowance(&mut at, 10, 5);
        assert_eq!(at, 10);
    }

    #[test]
    fn mint_redeem_cycle_returns_consumed_allowance() {
        let limit = 100;
        let mut allowance = limit;
        for _ in 0..1_000 {
            consume_allowance(&mut allowance, 60).unwrap();
            restore_allowance(&mut allowance, limit, 60);
        }
        assert_eq!(allowance, limit);
    }
}
