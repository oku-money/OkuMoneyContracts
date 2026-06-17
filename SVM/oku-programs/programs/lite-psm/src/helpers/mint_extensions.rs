//! Token-2022 mint-extension allow-list.
//!
//! The PSM and vault both assume the OkuMoney mint behaves as a stock
//! `Mint` for accounting purposes — `transfer_checked` moves exactly the
//! requested amount, no hooks fire, no per-account state machine sits
//! between `from.amount -= n; to.amount += n;`. Several Token-2022
//! extensions break that assumption, silently corrupting collateral /
//! supply / share accounting downstream. The cheapest defensible answer
//! is to reject the dangerous extensions at init time.
//!
//! ## Allow-list rationale
//!
//! | Extension | Decision | Why |
//! |---|---|---|
//! | `MintCloseAuthority` | allow | Cosmetic; doesn't affect transfer semantics. |
//! | `MetadataPointer` | allow | Read-only pointer; off-chain only. |
//! | `TokenMetadata` | allow | Read-only on-chain metadata; no behaviour change. |
//! | `InterestBearingConfig` | allow | Read-only UI-only accrual; OkuMoney's economic price is set via `oku_m_price`, not the mint's interest field. (Already in use; see `state.rs` doc-comment.) |
//! | `TransferFeeConfig` | **reject** | Would deduct fees on every escrow / vault transfer, breaking `actualReceived == amount`. |
//! | `TransferHook` | **reject** | Re-enters the PSM mid-transfer (the original Phase 10 reject reason). |
//! | `ConfidentialTransferMint` | **reject** | Encrypted balances; on-chain `amount` field becomes meaningless. |
//! | `PermanentDelegate` | **reject** | Any holder of the delegate role can move arbitrary amounts; defeats the role model. |
//! | `NonTransferable` | **reject** | Would brick every escrow transfer. |
//! | `DefaultAccountState` | **reject** | Could make all freshly-created OkuMoney ATAs frozen by default. |
//! | `Pausable` | **reject** | Mint-level pause overrides program-level pause; surface area duplication. |
//! | `ConfidentialMintBurn` / `ConfidentialTransferFee*` | **reject** | Encrypted-supply variants of above. |
//! | `ScaledUiAmount` | **reject** | UI-only multiplier conflicts with the protocol's `oku_m_price`. |
//! | Account-only extensions (`TransferFeeAmount`, `*Account`, etc.) | reject as mint extensions | Not valid on a mint TLV in any case. |
//!
//! See `audit/README.md` § "Behaviour deltas" for the EVM side —
//! Solidity has no analogous per-mint extension surface, so this
//! hardening is SVM-only.
//!
//! Mirrors EVM `contracts/EVM/audit/README.md` § Accepted Risks
//! (the "operator-deployed OkuMoney mint must not be misconfigured"
//! constraint).

use crate::errors::LitePsmError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintRaw;

/// Returns `true` if `e` is an extension the protocol will tolerate on
/// the OkuMoney mint. Anything not on this list is rejected at init.
#[inline]
fn is_allowed_mint_extension(e: ExtensionType) -> bool {
    matches!(
        e,
        ExtensionType::Uninitialized
            | ExtensionType::MintCloseAuthority
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::InterestBearingConfig
            | ExtensionType::ImmutableOwner
            | ExtensionType::GroupPointer
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroup
            | ExtensionType::TokenGroupMember
    )
}

/// Parse the supplied mint account and reject any extension not on the
/// allow-list above. Returns `LitePsmError::IncompatibleMintExtension`
/// if the mint carries a forbidden extension (or is corrupt / fails to
/// unpack — both are treated as the same hard reject because the only
/// way `unpack` fails on a Token-2022 mint is malformed bytes).
///
/// This is the single source of truth for extension policy across the
/// workspace; `oku-dollar`'s `initialize` calls this same function so the
/// two programs are guaranteed to agree on what an "acceptable" OkuMoney
/// mint looks like.
pub fn assert_oku_money_mint_extensions_whitelisted(mint_account: &AccountInfo) -> Result<()> {
    let mint_data = mint_account.try_borrow_data()?;
    let unpacked = StateWithExtensions::<MintRaw>::unpack(&mint_data)
        .map_err(|_| error!(LitePsmError::IncompatibleMintExtension))?;
    let extensions = unpacked
        .get_extension_types()
        .map_err(|_| error!(LitePsmError::IncompatibleMintExtension))?;
    for e in extensions {
        require!(
            is_allowed_mint_extension(e),
            LitePsmError::IncompatibleMintExtension
        );
    }
    Ok(())
}
