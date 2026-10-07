//! Re-exports of the shared constants plus the OkuM on-chain metadata identity.
//! Decimals: OkuM 6 on SVM (18 on EVM); USDC is asserted to match `USDC_DECIMALS`
//! at init (EVM reads decimals at init); multipliers use 1e18 (`PRECISION`) on both.

pub use oku_shared::{MAX_MULTIPLIER, PRECISION, TOKEN_DECIMALS, USDC_DECIMALS};

/// OkuM mint `TokenMetadata` name/symbol: the identity wallets show. Must match
/// EVM `OkuMoney`. The "usdOku" dollar view is the `ScaledUiAmount` display, not
/// an on-chain symbol. Shared by `initialize` and `update_token_metadata`.
pub const OKU_M_METADATA_NAME: &str = "OkuMoney";
pub const OKU_M_METADATA_SYMBOL: &str = "OkuM";
