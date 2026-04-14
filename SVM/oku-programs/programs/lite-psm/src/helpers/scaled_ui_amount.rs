//! Scaled UI Amount helper module
//!
//! This module re-exports PRECISION from constants.rs for backwards compatibility.

// Re-export PRECISION from constants for backwards compatibility
pub use super::constants::PRECISION;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_precision_constant() {
        assert_eq!(PRECISION, 1_000_000_000);
    }

    #[test]
    fn test_multiplier_math() {
        // 1.0 multiplier
        let multiplier = PRECISION;
        assert_eq!(multiplier, 1_000_000_000);

        // 1.045 multiplier (4.5% appreciation)
        let multiplier = 1_045_000_000u64;

        // 100 USDC at 1.045 price = 100 * 1e9 / 1.045e9 = ~95.69 OkuM
        let usdc = 100_000_000u64; // 100 USDC (6 decimals)
        let oku_m = (usdc as u128) * (PRECISION as u128) / (multiplier as u128);
        assert_eq!(oku_m, 95_693_779); // ~95.69 OkuM

        // 95.69 OkuM at 1.045 price = 95.69 * 1.045 = ~100 USDC
        let back_to_usdc = (oku_m * (multiplier as u128)) / (PRECISION as u128);
        assert_eq!(back_to_usdc, 99_999_999); // ~100 USDC (rounding)
    }
}
