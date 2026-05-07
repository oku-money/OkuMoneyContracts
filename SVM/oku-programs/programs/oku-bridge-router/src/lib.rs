use anchor_lang::prelude::*;

pub mod contexts;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod roles;
pub mod state;
pub mod validation;

use contexts::*;
use roles::*;

declare_id!("JDa1YZH8VNjXiVxuBQfhU58fGvXRPuiTAt2t4hA5HAFS");

// `auditors` and `acknowledgements` are intentionally omitted until an audit
// is complete; populate them in a follow-up commit.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney OkuBridgeRouter",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "email:security@okumoney.example",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod oku_bridge_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        instructions::core::initialize(ctx, pauser, unpauser)
    }

    /// Bridge usdOku cross-chain in one transaction
    /// 1. Unwraps usdOku -> OkuMoney via oku-dollar vault
    /// 2. Burns OkuMoney via PSM bridge_burn
    pub fn bridge_usd_oku(
        ctx: Context<BridgeUsdOku>,
        usd_oku_shares: u64,
        recipient: [u8; 20],
        destination_chain: u16,
        min_oku_money_out: u64,
    ) -> Result<()> {
        instructions::core::bridge_usd_oku(
            ctx,
            usd_oku_shares,
            recipient,
            destination_chain,
            min_oku_money_out,
        )
    }

    /// Bridge OkuMoney directly cross-chain
    /// Calls PSM bridge_burn directly — no vault unwrap needed
    pub fn bridge_oku_m(
        ctx: Context<BridgeOkuM>,
        oku_m_amount: u64,
        recipient: [u8; 20],
        destination_chain: u16,
    ) -> Result<()> {
        instructions::core::bridge_oku_m(ctx, oku_m_amount, recipient, destination_chain)
    }

    /// Mint usdOku from USDC in one transaction
    /// 1. PSM mint_oku_m: USDC -> OkuMoney
    /// 2. Vault wrap: OkuMoney -> usdOku
    pub fn mint_usd_oku(
        ctx: Context<MintUsdOku>,
        usdc_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::core::mint_usd_oku(ctx, usdc_amount, min_shares_out)
    }

    /// Redeem usdOku to USDC in one transaction
    /// 1. Vault unwrap: usdOku -> OkuMoney
    /// 2. PSM redeem_oku_m: OkuMoney -> USDC (instant or queued)
    pub fn redeem_usd_oku(
        ctx: Context<RedeemUsdOku>,
        usd_oku_shares: u64,
        min_oku_money_out: u64,
    ) -> Result<()> {
        instructions::core::redeem_usd_oku(ctx, usd_oku_shares, min_oku_money_out)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: RouterAuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }
}
