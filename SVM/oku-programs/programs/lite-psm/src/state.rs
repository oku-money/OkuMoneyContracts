//! Account state definitions for the Lite-PSM program.
//!
//! Single-token design: the PSM deals exclusively in **OkuM** (a
//! Token-2022 mint with the `ScaledUiAmount` extension). The multiplier
//! that converts raw token amounts to dollar-display values lives on the
//! mint itself, not in PsmConfig.
//!
//! Storage patterns adapted from a few upstream sources:
//! - The minter-allowance + blacklist-exempt fields on `PsmConfig` mirror
//!   Circle's FiatToken minter / blacklist controller pattern.
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol

use anchor_lang::prelude::*;

/// PSM configuration PDA.
///
/// Seeds: `["psm_config"]`. This is the single, program-wide config
/// account; it holds the granular authorities, token references, limits,
/// and the yield-distribution slot.
#[account]
#[derive(InitSpace)]
pub struct PsmConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Granular Authorities - One Per Action =====
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,
    /// Warm Multisig - freeze accounts
    pub freezer: Pubkey,
    /// Cold Multisig - thaw accounts (requires deliberate review)
    pub unfreezer: Pubkey,
    /// Orchestrator - deposit USDC buffer
    pub buffer_depositor: Pubkey,
    /// Cold Multisig - withdraw buffer
    pub buffer_withdrawer: Pubkey,
    /// Cold Multisig - set max supply
    pub cap_manager: Pubkey,
    /// Cold Multisig - reset minter / direct-minter / direct-burner allowances
    pub allowance_manager: Pubkey,
    /// Orchestrator - update multiplier on the OkuM mint
    pub rebaser: Pubkey,

    // ===== Token References =====
    /// USDC mint address
    pub usdc_mint: Pubkey,
    /// OkuM mint address (Token-2022 with ScaledUiAmount extension).
    /// The multiplier for USDC ↔ OkuM conversion is read from the
    /// mint's ScaledUiAmountConfig extension, not stored on PsmConfig.
    pub oku_m_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,

    // ===== Limits =====
    /// Maximum OkuM supply cap (in raw token units)
    pub max_supply: u64,
    /// Mint allowance remaining (configurable cap on freshly minted OkuM
    /// between admin resets, mirroring the EVM `minterAllowance` pattern).
    pub minter_allowance: u64,
    /// Whether the PSM is paused
    pub is_paused: bool,

    /// Solana slot of last yield distribution (sandwich prevention).
    /// Operations like mint/redeem are blocked in the same slot as yield distribution.
    pub last_yield_distribution_slot: u64,

    /// Pending `role_admin` rotation target — the two-step admin-transfer
    /// model (OpenZeppelin `Ownable2Step` pattern). `set_authority(RoleAdmin,
    /// new_admin)` writes to this slot only; the rotation does NOT take
    /// effect until `new_admin` signs `accept_role_admin`, which moves the
    /// value into `role_admin` and clears the slot. This protects the
    /// protocol from a typo or stale key on the proposing side silently
    /// locking out the meta-role.
    ///
    /// `Pubkey::default()` means "no pending rotation".
    pub pending_role_admin: Pubkey,

    // ===== Direct Mint (fiat on-ramp) =====
    //
    // Permissioned direct OkuM mint path — no USDC collateral required
    // on-chain. Matches EVM `OkuM.mint(to, amount)` called by an
    // authorised minter role holder. The fiat collateral is held off-chain.
    /// Operator / fiat gateway — can mint OkuM directly without USDC.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_minter: Pubkey,

    /// Per-direct-minter allowance (separate from the USDC-backed
    /// `minter_allowance`). Decremented on each direct mint; reset by
    /// `allowance_manager` via `set_direct_minter_allowance`.
    pub direct_minter_allowance: u64,

    // ===== Direct Burn (bridge / off-ramp) =====
    //
    // Permissioned direct OkuM burn path — burns OkuM from the
    // caller's ATA without USDC payout. Enables SVM→EVM bridging
    // where the KMS-backed orchestrator burns on the source chain.
    /// Operator / bridge backend — can burn OkuM directly without
    /// triggering a USDC redemption.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_burner: Pubkey,

    /// Per-direct-burner allowance. Decremented on each direct burn;
    /// reset by `allowance_manager` via `set_direct_burner_allowance`.
    pub direct_burner_allowance: u64,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned to 562 bytes by the
    /// compile-time assertion below; if a reviewer changes a field's
    /// width the assertion fires.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// PDA signer seeds for CPIs signed by the config PDA.
    ///
    /// Single source of truth for the `[SEED, [bump]]` seed shape that
    /// every PDA-signed CPI in this program needs. Previously this was
    /// hand-rolled at ~8 call sites as
    /// `let seeds = &[PsmConfig::SEED, &[bump]]; let signer = &[&seeds[..]];`
    /// which repeated the `SEED` reference and the double-wrap shape each
    /// time (a bump/seed mismatch on any one edit would silently break
    /// signing). The caller owns the 1-byte bump array and passes a
    /// reference so no allocation or lifetime juggling is needed:
    ///
    /// ```ignore
    /// let bump = [ctx.accounts.config.bump];
    /// let seeds = PsmConfig::signer_seeds(&bump);
    /// let signer = &[&seeds[..]];
    /// // ... CpiContext::new_with_signer(..., signer)
    /// ```
    #[inline]
    pub fn signer_seeds(bump: &[u8; 1]) -> [&[u8]; 2] {
        [Self::SEED, bump]
    }
}

// Compile-time assertion: if PsmConfig layout changes, this will fail to compile.
//
// Note on pubkey grouping: the `AuthorityRole` enum has 12 variants, but the
// three "special" role pubkeys (role_admin, direct_minter, direct_burner) are
// counted in their own lines below rather than in the "authorities" block, so
// the arithmetic does not line up 1:1 with the enum count. Total stored
// pubkeys = 13 role slots + pending_role_admin + 3 token refs = 17 * 32 = 544.
//
// (562 = 8 disc + 1 bump
//      + 32*10 core-role authorities (role_admin, pauser, unpauser, freezer,
//               unfreezer, buffer_depositor, buffer_withdrawer, cap_manager,
//               allowance_manager, rebaser = 320)
//      + 32*2 token mints (usdc_mint + oku_m_mint = 64)
//      + 32*1 vault (vault_usdc = 32)
//      + 8 max_supply + 8 minter_allowance + 1 is_paused
//      + 8 last_yield_distribution_slot
//      + 32 pending_role_admin
//      + 32 direct_minter + 8 direct_minter_allowance
//      + 32 direct_burner + 8 direct_burner_allowance.)
const _: () = assert!(PsmConfig::LEN == 562);
