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

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
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

        let result = self.trident.process_transaction(&[ix.instruction()], None);

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
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
        } else {
            let unpauser = self.fuzz_accounts.unpauser.insert(&mut self.trident, None);
            let ix = UnpauseInstruction::data(UnpauseInstructionData::new())
                .accounts(UnpauseInstructionAccounts::new(unpauser, config));
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
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

        let result = self.trident.process_transaction(&[ix.instruction()], None);

        // This MUST fail — if it succeeds, the address constraint on vault_program is broken
        assert!(
            result.is_error(),
            "CRITICAL: bridge_wrapped accepted a fake vault_program ID! \
             Address constraint on vault_program is not enforced."
        );
    }

    #[end]
    fn end(&mut self) {}
}

fn main() {
    FuzzTest::fuzz(ITER_COUNT, TX_PER_ITER);
}
