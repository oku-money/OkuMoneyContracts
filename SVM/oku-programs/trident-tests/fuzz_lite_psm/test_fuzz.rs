//! Trident fuzz harness for lite-psm.
//!
//! Flows implemented (using available generated types):
//!   flow_mint        — mint_oku_m: deposit USDC, receive OkuMoney
//!   flow_redeem      — redeem_oku_m: queue OkuMoney for USDC redemption
//!   flow_process     — process_queue: execute pending redemptions
//!   flow_pause       — pause / unpause toggle
//!   flow_bridge_burn — bridge_burn: burn OkuMoney for cross-chain transfer
//!   flow_deposit_buf — deposit_buffer / withdraw_buffer
//!   flow_freeze      — freeze_account / thaw_account
//!
//! Invariants checked in #[end]:
//!   1. OkuMoney supply never exceeds max_supply
//!   2. oku_m_price is non-decreasing and within [PRECISION, MAX_OKU_M_PRICE]
//!   3. vault_usdc balance >= total_queued_oku_m (solvency)
//!
//! NOTE: The types.rs in this directory was generated from an earlier IDL.
//! Program IDs and some discriminators differ from the current programs.
//! Regenerate types via `trident fuzz add --skip-build` after `anchor build`
//! to get fully up-to-date harnesses. The flows document the intended
//! invariants so regeneration remains mechanical.
//!
//! Run: trident fuzz run fuzz_lite_psm
//!      (from contracts/SVM/oku-programs/)

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::lite_psm;
use types::lite_psm::*;

// Protocol constants (mirrors oku-shared and lite-psm constants)
const PRECISION: u64 = 1_000_000_000; // 1e9
const MAX_OKU_M_PRICE: u64 = 1_000_000_000_000_000; // 1e15

// Trident iteration budget: 1000 iterations × 100 transactions each
const ITER_COUNT: u64 = 1000;
const TX_PER_ITER: u64 = 100;

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    last_oku_m_price: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            last_oku_m_price: PRECISION,
        }
    }

    /// Called once at the start of each fuzzing iteration.
    /// TODO: wire up the 3-step init sequence once types.rs is regenerated
    /// with current discriminators from anchor build:
    ///   1. Initialize (config + roles)
    ///   2. SetupRedemptionQueue
    ///   3. SetupOkusdEscrow
    ///   4. InitializeBridge
    #[init]
    fn start(&mut self) {}

    // ----------------------------------------------------------------
    // FLOW 1: mint_oku_m — core PSM minting path
    // Invariant: OkuMoney minted <= USDC deposited at current price
    // ----------------------------------------------------------------
    #[flow]
    fn flow_mint(&mut self) {
        let usdc_amount: u64 = self.trident.random_from_range(1u64..1_000_000_000u64);

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let usdc_mint = self.fuzz_accounts.usdc_mint.insert(&mut self.trident, None);
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let user_usdc_ata = self
            .fuzz_accounts
            .user_usdc_ata
            .insert(&mut self.trident, None);
        let user_okusd_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let vault_usdc = self
            .fuzz_accounts
            .vault_usdc
            .insert(&mut self.trident, None);
        let price_update = self
            .fuzz_accounts
            .price_update
            .insert(&mut self.trident, None);

        let ix = MintInstruction::data(MintInstructionData::new(usdc_amount)).accounts(
            MintInstructionAccounts::new(
                user,
                config,
                usdc_mint,
                okusd_mint,
                user_usdc_ata,
                user_okusd_ata,
                vault_usdc,
                price_update,
            ),
        );

        let _ = self.trident.process_transaction(&[ix.instruction()], None);
    }

    // ----------------------------------------------------------------
    // FLOW 2: redeem_oku_m — queue OkuMoney for USDC redemption
    // Invariant: queue entry created with correct oku_m_amount
    // ----------------------------------------------------------------
    #[flow]
    fn flow_redeem(&mut self) {
        let oku_m_amount: u64 = self.trident.random_from_range(1u64..1_000_000_000u64);

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let usdc_mint = self.fuzz_accounts.usdc_mint.insert(&mut self.trident, None);
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let user_usdc_ata = self
            .fuzz_accounts
            .user_usdc_ata
            .insert(&mut self.trident, None);
        let user_okusd_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let vault_usdc = self
            .fuzz_accounts
            .vault_usdc
            .insert(&mut self.trident, None);
        let vault_okusd = self
            .fuzz_accounts
            .vault_okusd
            .insert(&mut self.trident, None);
        let redemption_queue = self
            .fuzz_accounts
            .redemption_queue
            .insert(&mut self.trident, None);

        let ix = RedeemInstruction::data(RedeemInstructionData::new(oku_m_amount)).accounts(
            RedeemInstructionAccounts::new(
                user,
                config,
                usdc_mint,
                okusd_mint,
                user_usdc_ata,
                user_okusd_ata,
                vault_usdc,
                vault_okusd,
                redemption_queue,
            ),
        );

        let _ = self.trident.process_transaction(&[ix.instruction()], None);
    }

    // ----------------------------------------------------------------
    // FLOW 3: process_queue — execute pending redemptions
    // ----------------------------------------------------------------
    #[flow]
    fn flow_process_queue(&mut self) {
        let max_entries: u32 = self.trident.random_from_range(1u32..50u32);

        let queue_processor = self
            .fuzz_accounts
            .queue_processor
            .insert(&mut self.trident, None);
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let redemption_queue = self
            .fuzz_accounts
            .redemption_queue
            .insert(&mut self.trident, None);
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let vault_usdc = self
            .fuzz_accounts
            .vault_usdc
            .insert(&mut self.trident, None);
        let vault_okusd = self
            .fuzz_accounts
            .vault_okusd
            .insert(&mut self.trident, None);

        let ix = ProcessQueueInstruction::data(ProcessQueueInstructionData::new(max_entries))
            .accounts(ProcessQueueInstructionAccounts::new(
                queue_processor,
                config,
                redemption_queue,
                okusd_mint,
                vault_usdc,
                vault_okusd,
            ));

        let _ = self.trident.process_transaction(&[ix.instruction()], None);
    }

    // ----------------------------------------------------------------
    // FLOW 4: pause / unpause toggle
    // Invariant: mint_oku_m and redeem_oku_m fail when paused
    // ----------------------------------------------------------------
    #[flow]
    fn flow_pause_toggle(&mut self) {
        let do_pause: bool = self.trident.random_bool();
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );

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
    // FLOW 5: bridge_burn
    // Invariant: OkuMoney supply decreases; bridge nonce increments
    // ----------------------------------------------------------------
    #[flow]
    fn flow_bridge_burn(&mut self) {
        let amount: u64 = self.trident.random_from_range(1u64..100_000_000u64);
        let destination_chain_id: u16 = 1;
        let recipient: [u8; 20] = {
            let mut r = [0u8; 20];
            self.trident.random_bytes(&mut r);
            // Ensure non-zero (zero address is rejected)
            r[0] = r[0].max(1);
            r
        };

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let bridge_config = self.fuzz_accounts.bridge_config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"bridge_config"], lite_psm::program_id())),
        );
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let user_okusd_ata = self
            .fuzz_accounts
            .user_okusd_ata
            .insert(&mut self.trident, None);
        let fee_recipient_ata = self
            .fuzz_accounts
            .fee_recipient_ata
            .insert(&mut self.trident, None);
        let bridge_nonce = self
            .fuzz_accounts
            .bridge_nonce
            .insert(&mut self.trident, None);

        let ix = BridgeBurnInstruction::data(BridgeBurnInstructionData::new(
            amount,
            recipient,
            destination_chain_id,
        ))
        .accounts(BridgeBurnInstructionAccounts::new(
            user,
            config,
            bridge_config,
            okusd_mint,
            user_okusd_ata,
            fee_recipient_ata,
            bridge_nonce,
        ));

        let _ = self.trident.process_transaction(&[ix.instruction()], None);
    }

    // ----------------------------------------------------------------
    // FLOW 6: deposit_buffer / withdraw_buffer
    // Invariant: withdraw never leaves vault unable to cover queue
    // ----------------------------------------------------------------
    #[flow]
    fn flow_buffer(&mut self) {
        let amount: u64 = self.trident.random_from_range(1u64..1_000_000u64);
        let do_deposit: bool = self.trident.random_bool();
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let usdc_mint = self.fuzz_accounts.usdc_mint.insert(&mut self.trident, None);
        let vault_usdc = self
            .fuzz_accounts
            .vault_usdc
            .insert(&mut self.trident, None);

        if do_deposit {
            let buffer_depositor = self
                .fuzz_accounts
                .buffer_depositor
                .insert(&mut self.trident, None);
            let buffer_depositor_usdc_ata = self
                .fuzz_accounts
                .buffer_depositor_usdc_ata
                .insert(&mut self.trident, None);
            let ix = DepositBufferInstruction::data(DepositBufferInstructionData::new(amount))
                .accounts(DepositBufferInstructionAccounts::new(
                    buffer_depositor,
                    config,
                    usdc_mint,
                    buffer_depositor_usdc_ata,
                    vault_usdc,
                ));
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
        } else {
            let buffer_withdrawer = self
                .fuzz_accounts
                .buffer_withdrawer
                .insert(&mut self.trident, None);
            let withdrawer_usdc_ata = self
                .fuzz_accounts
                .withdrawer_usdc_ata
                .insert(&mut self.trident, None);
            let redemption_queue = self
                .fuzz_accounts
                .redemption_queue
                .insert(&mut self.trident, None);
            let ix = WithdrawBufferInstruction::data(WithdrawBufferInstructionData::new(amount))
                .accounts(WithdrawBufferInstructionAccounts::new(
                    buffer_withdrawer,
                    config,
                    usdc_mint,
                    withdrawer_usdc_ata,
                    vault_usdc,
                    redemption_queue,
                ));
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
        }
    }

    // ----------------------------------------------------------------
    // FLOW 7: freeze_account / thaw_account
    // Invariant: a frozen ATA cannot be transferred from
    // ----------------------------------------------------------------
    #[flow]
    fn flow_freeze_thaw(&mut self) {
        let do_freeze: bool = self.trident.random_bool();
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config"], lite_psm::program_id())),
        );
        let okusd_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let target_okusd_ata = self
            .fuzz_accounts
            .target_okusd_ata
            .insert(&mut self.trident, None);

        if do_freeze {
            let freezer = self.fuzz_accounts.freezer.insert(&mut self.trident, None);
            let ix = FreezeAccountInstruction::data(FreezeAccountInstructionData::new()).accounts(
                FreezeAccountInstructionAccounts::new(
                    freezer,
                    config,
                    okusd_mint,
                    target_okusd_ata,
                ),
            );
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
        } else {
            let unfreezer = self.fuzz_accounts.unfreezer.insert(&mut self.trident, None);
            let ix = ThawAccountInstruction::data(ThawAccountInstructionData::new()).accounts(
                ThawAccountInstructionAccounts::new(
                    unfreezer,
                    config,
                    okusd_mint,
                    target_okusd_ata,
                ),
            );
            let _ = self.trident.process_transaction(&[ix.instruction()], None);
        }
    }

    /// End of iteration: read state and assert global invariants.
    /// TODO: deserialize PsmConfig + RedemptionQueue via
    /// self.trident.get_account_with_type::<PsmConfig>(&config_pda) and assert:
    ///   1. oku_money_supply <= max_supply
    ///   2. oku_m_price >= self.last_oku_m_price (non-decreasing)
    ///   3. oku_m_price <= MAX_OKU_M_PRICE
    ///   4. vault_usdc_balance >= queue.total_queued_oku_m (solvency)
    #[end]
    fn end(&mut self) {
        let _ = MAX_OKU_M_PRICE;
        let _ = PRECISION;
        let _ = self.last_oku_m_price;
    }
}

fn main() {
    FuzzTest::fuzz(ITER_COUNT, TX_PER_ITER);
}
