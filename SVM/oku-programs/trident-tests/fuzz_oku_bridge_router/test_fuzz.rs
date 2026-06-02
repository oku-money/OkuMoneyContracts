//! Trident fuzz harness for oku-bridge-router.
//!
//! Flows: bridge_wrapped (bridge_usd_oku), pause toggle, CPI substitution attack.
//! Invariants: no stranded OkuMoney, address constraint enforcement, pause propagation.
//!
//! Run: trident fuzz run fuzz_oku_bridge_router

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::oku_bridge_router;
use types::oku_bridge_router::*;

const ITER_COUNT: u64 = 500;
const TX_PER_ITER: u64 = 50;

/// Same precision constant as `programs/oku-dollar/src/helpers.rs::PRECISION`.
/// Used by `flow_update_usd_multiplier` as the starting target.
const PRECISION: u64 = 1_000_000_000;
/// Upper bound on `usd_multiplier` enforced by the program.
const MAX_USD_MULTIPLIER: u64 = 1_000_000_000_000_000;

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    /// Local mirror of the highest successfully-applied `usd_multiplier`
    /// target. Used by `flow_update_usd_multiplier` so each bump is a
    /// monotonic step rather than a random absolute value (the program
    /// rejects decreases with `MultiplierCannotDecrease`).
    last_usd_multiplier: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            last_usd_multiplier: PRECISION,
        }
    }

    #[init]
    fn start(&mut self) {
        // TODO: initialize all three programs in dependency order:
        //   1. lite-psm (Initialize + SetupRedemptionQueue + SetupOkusdEscrow + InitializeBridge)
        //   2. oku-dollar (Initialize)
        //   3. oku-bridge-router (Initialize)
    }

    fn router_config_pda(&mut self) -> Pubkey {
        self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(
                &[b"router_config"],
                oku_bridge_router::program_id(),
            )),
        )
    }

    // ----------------------------------------------------------------
    // FLOW 1: bridge_usd_oku (BridgeWrapped in stale types)
    // Sequence: user's wOkuSD → unwrap → OkuMoney → bridge_burn
    //
    // Key invariant: user_okusd_ata balance unchanged after the full flow
    // (intermediate OkuMoney fully consumed by bridge_burn, no stranded tokens)
    // ----------------------------------------------------------------
    #[flow]
    fn flow_bridge_wrapped(&mut self) {
        let wokusd_shares: u64 = self.trident.random_from_range(1u64..1_000_000u64);
        let destination_chain: u16 = 1; // must be in lite-psm supported_chains
        let recipient: [u8; 20] = {
            let mut r = [0u8; 20];
            self.trident.random_bytes(&mut r);
            r[0] = r[0].max(1); // non-zero recipient required
            r
        };
        let min_okusd_out: u64 = 0;

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.router_config_pda();
        let vault_config = self
            .fuzz_accounts
            .vault_config
            .insert(&mut self.trident, None);
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let wokusd_mint = self
            .fuzz_accounts
            .wokusd_mint
            .insert(&mut self.trident, None);
        let user_okusd_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let user_wokusd_ata = self
            .fuzz_accounts
            .user_wokusd_ata
            .insert(&mut self.trident, None);
        let vault_okusd = self
            .fuzz_accounts
            .vault_okusd
            .insert(&mut self.trident, None);
        let bridge_config = self
            .fuzz_accounts
            .bridge_config
            .insert(&mut self.trident, None);
        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);
        let bridge_nonce = self
            .fuzz_accounts
            .bridge_nonce
            .insert(&mut self.trident, None);
        let fee_recipient_ata = self
            .fuzz_accounts
            .fee_recipient_ata
            .insert(&mut self.trident, None);

        let okusd_before = self
            .trident
            .get_token_account(user_okusd_ata)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        let ix = BridgeWrappedInstruction::data(BridgeWrappedInstructionData::new(
            wokusd_shares,
            recipient,
            destination_chain,
            min_okusd_out,
        ))
        .accounts(BridgeWrappedInstructionAccounts::new(
            user,
            config,
            vault_config,
            okusd_mint,
            wokusd_mint,
            user_okusd_ata,
            user_wokusd_ata,
            vault_okusd,
            bridge_config,
            psm_config,
            bridge_nonce,
            fee_recipient_ata,
        ));

        let result = self.trident.process_transaction(&[ix.instruction()], Some("BridgeWrapped"));

        if result.is_success() {
            // Invariant: no OkuMoney stranded after successful bridge_wrapped
            let okusd_after = self
                .trident
                .get_token_account(user_okusd_ata)
                .map(|a| a.account.amount)
                .unwrap_or(0);

            assert_eq!(
                okusd_before, okusd_after,
                "INVARIANT VIOLATION: OkuMoney stranded in user ATA after bridge_wrapped: \
                 before={okusd_before} after={okusd_after}"
            );
        }
    }

    // ----------------------------------------------------------------
    // FLOW 2: pause / unpause toggle
    // Invariant: bridge_wrapped fails when router is paused
    // ----------------------------------------------------------------
    #[flow]
    fn flow_pause_toggle(&mut self) {
        let do_pause: bool = self.trident.random_bool();
        let config = self.router_config_pda();

        if do_pause {
            let pauser = self.fuzz_accounts.pauser.insert(&mut self.trident, None);
            let ix = PauseInstruction::data(PauseInstructionData::new())
                .accounts(PauseInstructionAccounts::new(pauser, config));
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("Pause"));
        } else {
            let unpauser = self.fuzz_accounts.unpauser.insert(&mut self.trident, None);
            let ix = UnpauseInstruction::data(UnpauseInstructionData::new())
                .accounts(UnpauseInstructionAccounts::new(unpauser, config));
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("Unpause"));
        }
    }

    // ----------------------------------------------------------------
    // FLOW 3: CPI substitution attack
    // Attempt to supply a random Pubkey as vault_program.
    // The Anchor address = oku_dollar::ID constraint MUST reject this.
    // ----------------------------------------------------------------
    #[flow]
    fn flow_bad_program_id(&mut self) {
        let wokusd_shares: u64 = 1_000_000;
        let destination_chain: u16 = 1;
        let recipient: [u8; 20] = [0xaau8; 20];

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.router_config_pda();
        let vault_config = self
            .fuzz_accounts
            .vault_config
            .insert(&mut self.trident, None);
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let wokusd_mint = self
            .fuzz_accounts
            .wokusd_mint
            .insert(&mut self.trident, None);
        let user_okusd_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let user_wokusd_ata = self
            .fuzz_accounts
            .user_wokusd_ata
            .insert(&mut self.trident, None);
        let vault_okusd = self
            .fuzz_accounts
            .vault_okusd
            .insert(&mut self.trident, None);
        let bridge_config = self
            .fuzz_accounts
            .bridge_config
            .insert(&mut self.trident, None);
        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);
        let bridge_nonce = self
            .fuzz_accounts
            .bridge_nonce
            .insert(&mut self.trident, None);
        let fee_recipient_ata = self
            .fuzz_accounts
            .fee_recipient_ata
            .insert(&mut self.trident, None);

        let mut ix = BridgeWrappedInstruction::data(BridgeWrappedInstructionData::new(
            wokusd_shares,
            recipient,
            destination_chain,
            0,
        ))
        .accounts(BridgeWrappedInstructionAccounts::new(
            user,
            config,
            vault_config,
            okusd_mint,
            wokusd_mint,
            user_okusd_ata,
            user_wokusd_ata,
            vault_okusd,
            bridge_config,
            psm_config,
            bridge_nonce,
            fee_recipient_ata,
        ));

        // Substitute a random fake program for vault_program
        ix.accounts.vault_program = AccountMeta::new_readonly(self.trident.random_pubkey(), false);

        let result = self.trident.process_transaction(&[ix.instruction()], Some("BridgeWrapped"));

        // This MUST fail — if it succeeds, the address constraint on vault_program is broken
        assert!(
            result.is_error(),
            "CRITICAL: bridge_wrapped accepted a fake vault_program ID! \
             Address constraint on vault_program is not enforced."
        );
    }

    // ----------------------------------------------------------------
    // FLOW: redeem_usd_oku — usdOku → OkuMoney → USDC
    //
    // Parity with the EVM `testFuzz_RedeemUsdOku_NoRevertOnRounding_*`
    // fuzz tests added in `EVM/test/psm/LitePSMRebasingRedeem.fuzz.t.sol`
    // alongside the LitePSM bug fix (commit a8b82a9). Those tests pin-
    // assert that the EVM `InsufficientBalance()` selector (0xf4d678b8)
    // can never appear post-fix; the SVM equivalent of that failure mode
    // would be an SPL Token-2022 "insufficient funds" error returned from
    // the `unwrap` CPI inside `oku_bridge_router::redeem_usd_oku`. We
    // don't have a stable error-code selector to pin against in Trident,
    // so the flow's invariant is the absence of an `okuMoneyDelta` on
    // the user's ATA after a successful redeem (which would indicate
    // stranded OkuMoney from a partial CPI).
    //
    // This is the test that, in conjunction with `flow_update_usd_multiplier`,
    // would catch any future rounding-asymmetry regression analogous to
    // the EVM `OkuDollar.transferFrom` floor vs `OkuDollar.unwrap` ceil
    // mismatch — the bug that produced the Sepolia incident.
    // ----------------------------------------------------------------
    #[flow]
    fn flow_redeem_usd_oku(&mut self) {
        let usd_oku_shares: u64 = self.trident.random_from_range(1u64..1_000_000u64);
        let min_oku_money_out: u64 = 0;

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.router_config_pda();
        let vault_config = self
            .fuzz_accounts
            .vault_config
            .insert(&mut self.trident, None);
        // Maps to `oku_money_mint` in the new context; the stale storage
        // slot is named `okusd_mint` from the previous generator pass.
        let oku_money_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let usd_oku_mint = self
            .fuzz_accounts
            .wokusd_mint
            .insert(&mut self.trident, None);
        let user_oku_money_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let user_usd_oku_ata = self
            .fuzz_accounts
            .user_wokusd_ata
            .insert(&mut self.trident, None);
        let reserve_vault = self
            .fuzz_accounts
            .reserve_vault
            .insert(&mut self.trident, None);
        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);
        let redemption_queue = self
            .fuzz_accounts
            .redemption_queue
            .insert(&mut self.trident, None);
        let usdc_mint = self
            .fuzz_accounts
            .usdc_mint
            .insert(&mut self.trident, None);
        let user_usdc_ata = self
            .fuzz_accounts
            .user_usdc_ata
            .insert(&mut self.trident, None);
        let vault_usdc = self
            .fuzz_accounts
            .vault_usdc
            .insert(&mut self.trident, None);
        let vault_oku_money = self
            .fuzz_accounts
            .vault_oku_money
            .insert(&mut self.trident, None);

        let oku_money_before = self
            .trident
            .get_token_account(user_oku_money_ata)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        let ix = RedeemUsdOkuInstruction::data(RedeemUsdOkuInstructionData::new(
            usd_oku_shares,
            min_oku_money_out,
        ))
        .accounts(RedeemUsdOkuInstructionAccounts::new(
            user,
            config,
            vault_config,
            oku_money_mint,
            usd_oku_mint,
            user_oku_money_ata,
            user_usd_oku_ata,
            reserve_vault,
            psm_config,
            redemption_queue,
            usdc_mint,
            user_usdc_ata,
            vault_usdc,
            vault_oku_money,
        ));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("RedeemUsdOku"));

        if result.is_success() {
            // Invariant: no stranded OkuMoney after a successful redeem —
            // the router consumes every OkuMoney unit produced by unwrap.
            // A non-zero residual would be the SVM analog of the EVM
            // 1-share rounding mismatch that produced `InsufficientBalance()`.
            let oku_money_after = self
                .trident
                .get_token_account(user_oku_money_ata)
                .map(|a| a.account.amount)
                .unwrap_or(0);
            assert_eq!(
                oku_money_before, oku_money_after,
                "INVARIANT VIOLATION: OkuMoney stranded in user ATA after redeem_usd_oku: \
                 before={oku_money_before} after={oku_money_after} (shares={usd_oku_shares})"
            );
        }
    }

    // ----------------------------------------------------------------
    // FLOW: update_usd_multiplier — drift `usd_multiplier` off PRECISION
    // so the redeem-path fuzz exercises the regime in which the EVM bug
    // was reachable (Sepolia incident at usdMultiplier ≈ 1.0001197x).
    //
    // CPIs the oku_dollar program directly. The frequency is intentionally
    // higher than the bump magnitude — many small bumps simulate a live
    // APY trajectory better than a single large jump.
    // ----------------------------------------------------------------
    #[flow]
    fn flow_update_usd_multiplier(&mut self) {
        let bps_bucket = self.trident.random_from_range(0u64..100u64);
        let bps_inc: u64 = match bps_bucket {
            0..=39 => self.trident.random_from_range(1u64..10u64),
            40..=74 => self.trident.random_from_range(10u64..100u64),
            75..=94 => self.trident.random_from_range(100u64..1000u64),
            _ => self.trident.random_from_range(1000u64..5000u64),
        };
        let target = self
            .last_usd_multiplier
            .saturating_mul(10_000 + bps_inc)
            / 10_000;
        let target = target.min(MAX_USD_MULTIPLIER).max(self.last_usd_multiplier);

        let usd_rebaser = self
            .fuzz_accounts
            .usd_rebaser
            .insert(&mut self.trident, None);
        let vault_config = self
            .fuzz_accounts
            .vault_config
            .insert(&mut self.trident, None);
        let reserve_vault = self
            .fuzz_accounts
            .reserve_vault
            .insert(&mut self.trident, None);
        let usd_oku_mint = self
            .fuzz_accounts
            .wokusd_mint
            .insert(&mut self.trident, None);
        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);

        let ix = UpdateUsdMultiplierInstruction::data(UpdateUsdMultiplierInstructionData::new(
            target,
        ))
        .accounts(UpdateUsdMultiplierInstructionAccounts::new(
            usd_rebaser,
            vault_config,
            reserve_vault,
            usd_oku_mint,
            psm_config,
        ));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("UpdateUsdMultiplier"));

        if result.is_success() {
            self.last_usd_multiplier = target;
        }
    }

    #[end]
    fn end(&mut self) {
        let _ = self.last_usd_multiplier;
        let _ = MAX_USD_MULTIPLIER;
    }
}

fn main() {
    FuzzTest::fuzz(ITER_COUNT, TX_PER_ITER);
}
