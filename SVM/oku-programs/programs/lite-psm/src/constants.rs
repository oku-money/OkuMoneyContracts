//! # Lite-PSM constants
//!
//! `PRECISION`, `MAX_MULTIPLIER`, `TOKEN_DECIMALS` and `USDC_DECIMALS` are
//! authored in the workspace crate `oku-shared` and re-exported here so call
//! sites can write `use crate::constants::*`.
//!
//! The PSM operates on a single token: **OkuM**, a Token-2022 mint with the
//! `ScaledUiAmount` extension. The USDC ↔ OkuM multiplier is COMPUTED from the
//! rate schedule on `PsmConfig` (see `helpers::multiplier`); the extension is a
//! write-only display mirror and is never read back. Conversion math lives in
//! `helpers::math`.
//!
//! Decimals: USDC 6 on both stacks; OkuM 18 on EVM, 6 on SVM; multipliers 1e18
//! on both (`oku_shared::PRECISION`). `TOKEN_DECIMALS` names OkuM's count,
//! `USDC_DECIMALS` names USDC's — see `oku_shared::constants::USDC_DECIMALS`.

// ---------------------------------------------------------------------------
// Re-exports from the shared workspace crate
// ---------------------------------------------------------------------------

pub use oku_shared::{MAX_MULTIPLIER, PRECISION, TOKEN_DECIMALS, USDC_DECIMALS};

// ---------------------------------------------------------------------------
// On-chain Token-2022 metadata identity (OkuM)
// ---------------------------------------------------------------------------
//
// Single source of truth for the OkuM mint's Token-2022 `TokenMetadata`
// name/symbol — the TRUE on-chain identity wallets and explorers display for
// the mint and for transfers. MUST match the EVM `OkuMoney` (OkuM) token
// (`EVM/test/shared/Constants.sol`: OKUMONEY_NAME / OKUMONEY_SYMBOL) so the
// two chains present a consistent identity.
//
// OkuM vs usdOku: the metadata below is the base, value-appreciating,
// T-Bill-backed token, and is what generic wallets show. "$1-pegged usdOku" is
// a display-layer value produced by the `ScaledUiAmount` extension
// (raw_amount * multiplier), not an on-chain symbol. (On EVM,
// usdOku/"OkuDollar" is a *separate* wrapper token; SVM collapses that into
// the ScaledUiAmount display of the single OkuM mint.)
//
// Consumed by `initialize` (mint metadata init) and `update_token_metadata`
// (in-place rename); one definition keeps the two call sites from drifting.
pub const OKU_M_METADATA_NAME: &str = "OkuMoney";
pub const OKU_M_METADATA_SYMBOL: &str = "OkuM";
