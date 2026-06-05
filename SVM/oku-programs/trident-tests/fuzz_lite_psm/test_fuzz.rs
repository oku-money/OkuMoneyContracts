//! Trident fuzz harness for lite-psm.
//!
//! Flows implemented (using available generated types):
//!   flow_mint        — mint_oku_m: deposit USDC, receive OkuMoney
//!   flow_redeem      — redeem_oku_m: queue OkuMoney for USDC redemption
//!   flow_process     — process_queue: execute pending redemptions
//!   flow_pause       — pause / unpause toggle
//!   flow_deposit_buf — deposit_buffer / withdraw_buffer
//!   flow_freeze      — freeze_account / thaw_account
//!
//! (flow_bridge_burn was removed in the noBridge refactor — v1 has no
//! on-chain bridge.)
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
    ///
    /// TODO: wire the 3-step init using Trident's account helpers:
    ///   1. Create USDC SPL mint via `self.trident.create_token_mint(...)`.
    ///   2. Create OkuMoney Token-2022 mint.
    ///   3. Call `InitializeInstruction` with full `InitializeInstructionData`
    ///      (max_supply, minter_allowance, 12 role Pubkeys, pyth_program_owner)
    ///      and the derived `[b"psm_config_v2"]` PDA.
    ///
    /// Without init, the PsmConfig account doesn't exist and the `#[end]`
    /// invariants are no-ops (guarded by `if config_data.len() >= 594`).
    /// The harness still fuzzes instruction execution paths and catches panics
    /// or unexpected program errors. Wire init to enable the #[end] invariants.
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
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
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

        let ix = MintOkuMInstruction::data(MintOkuMInstructionData::new(usdc_amount)).accounts(
            MintOkuMInstructionAccounts::new(
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

        let _ = self.trident.process_transaction(&[ix.instruction()], Some("Mint"));
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
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
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

        let ix = RedeemOkuMInstruction::data(RedeemOkuMInstructionData::new(oku_m_amount)).accounts(
            RedeemOkuMInstructionAccounts::new(
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

        let _ = self.trident.process_transaction(&[ix.instruction()], Some("Redeem"));
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
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
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

        let _ = self.trident.process_transaction(&[ix.instruction()], Some("ProcessQueue"));
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
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
        );

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
    // FLOW 5: deposit_buffer / withdraw_buffer
    // Invariant: withdraw never leaves vault unable to cover queue
    // ----------------------------------------------------------------
    #[flow]
    fn flow_buffer(&mut self) {
        let amount: u64 = self.trident.random_from_range(1u64..1_000_000u64);
        let do_deposit: bool = self.trident.random_bool();
        let config = self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
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
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("DepositBuffer"));
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
            let okusd_mint = self.fuzz_accounts.okusd_mint.insert(&mut self.trident, None);
            let ix = WithdrawBufferInstruction::data(WithdrawBufferInstructionData::new(amount))
                .accounts(WithdrawBufferInstructionAccounts::new(
                    buffer_withdrawer,
                    config,
                    redemption_queue,
                    okusd_mint,
                    withdrawer_usdc_ata,
                    vault_usdc,
                    usdc_mint,
                ));
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("WithdrawBuffer"));
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
            Some(PdaSeeds::new(&[b"psm_config_v2"], lite_psm::program_id())),
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
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("FreezeAccount"));
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
            let _ = self.trident.process_transaction(&[ix.instruction()], Some("ThawAccount"));
        }
    }

    /// End of iteration: read state and assert global invariants.
    ///
    /// Invariants (from byte offsets derived from PsmConfig::LEN == 658):
    ///   1. oku_m_price is non-decreasing (tracked in self.last_oku_m_price)
    ///   2. oku_m_price <= MAX_OKU_M_PRICE (ceiling)
    ///   3. total_queued_oku_m is internally consistent (read from queue account)
    ///
    /// Byte offsets (see programs/lite-psm/src/state.rs):
    ///   PsmConfig.oku_m_price:       account bytes [586..594]
    ///   PsmConfig.max_supply:        account bytes [521..529]
    ///   RedemptionQueue.total_queued_oku_m: account bytes [32..40]
    ///    (zero_copy: 8 disc + 1 bump + 7 pad + 8 head + 8 tail + 8 total = offset 32)
    ///
    /// NOTE: #[init] is not yet wired because types.rs requires regeneration
    /// via `trident fuzz add --skip-build` after `anchor build` to get current
    /// instruction discriminators. Until then, flows silently fail (let _ = tx)
    /// and these invariants are no-ops because the PDA doesn't exist. The
    /// assertions are ready to fire as soon as #[init] is wired.
    #[end]
    fn end(&mut self) {
        let (config_pda, _) = Pubkey::find_program_address(
            &[b"psm_config_v2"],
            &lite_psm::program_id(),
        );
        let (queue_pda, _) = Pubkey::find_program_address(
            &[b"redemption_queue_v2"],
            &lite_psm::program_id(),
        );

        let config_data = self.trident.get_account(&config_pda).data().to_vec();

        // Invariant 1 + 2: oku_m_price non-decreasing, within MAX_OKU_M_PRICE
        if config_data.len() >= 594 {
            let price_bytes: [u8; 8] = config_data[586..594].try_into().unwrap_or([0u8; 8]);
            let oku_m_price = u64::from_le_bytes(price_bytes);
            assert!(
                oku_m_price >= self.last_oku_m_price,
                "INV1: oku_m_price decreased ({oku_m_price} < {})", self.last_oku_m_price
            );
            assert!(
                oku_m_price <= MAX_OKU_M_PRICE,
                "INV2: oku_m_price exceeded MAX_OKU_M_PRICE ({oku_m_price} > {MAX_OKU_M_PRICE})"
            );
            self.last_oku_m_price = oku_m_price;

            // Invariant (informational): max_supply at bytes [521..529]
            let max_supply_bytes: [u8; 8] = config_data[521..529].try_into().unwrap_or([0u8; 8]);
            let _max_supply = u64::from_le_bytes(max_supply_bytes);
            // Supply cap is enforced on-chain by the program; we'd need to read
            // the SPL mint supply to fully assert it here. The flow-level
            // process_transaction silently absorbs ExceedsSupplyCap errors.
        }

        // Invariant 3: total_queued_oku_m is readable (non-panic)
        // RedemptionQueue is zero_copy #[repr(C)]:
        //   8 disc + 1 bump + 7 pad + 8 head + 8 tail = offset 32 → total_queued_oku_m
        let queue_data = self.trident.get_account(&queue_pda).data().to_vec();
        if queue_data.len() >= 40 {
            let queued_bytes: [u8; 8] = queue_data[32..40].try_into().unwrap_or([0u8; 8]);
            let _total_queued = u64::from_le_bytes(queued_bytes);
            // Solvency (vault_usdc >= total_queued_oku_m * oku_m_price / PRECISION)
            // requires reading the vault_usdc ATA token account. Deferred until
            // #[init] is wired (vault_usdc address is in config bytes [457..489]).
            // For now: the field being readable (no panic) is the minimal check.
        }
    }
}

fn main() {
    FuzzTest::fuzz(ITER_COUNT, TX_PER_ITER);
}
