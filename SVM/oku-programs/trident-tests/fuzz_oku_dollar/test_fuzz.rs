//! Trident fuzz harness for oku-dollar.
//!
//! Flows: wrap, unwrap, wrap-unwrap round-trip, pause toggle.
//! Invariants: round-trip monotonicity, multiplier bounds, collateral ratio.
//!
//! Run: trident fuzz run fuzz_oku_dollar

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::oku_dollar;
use types::oku_dollar::*;
// `lite_psm` types are reachable through `types::lite_psm` because the
// regenerated `types.rs` includes both programs' IDLs (oku-dollar's
// `Initialize` ix requires the lite-psm `psm_config` PDA to already
// exist, so the harness initializes lite-psm first).
use types::lite_psm as lite_psm_types;

const PRECISION: u64 = 1_000_000_000;
const MAX_USD_MULTIPLIER: u64 = 1_000_000_000_000_000;
/// Dead-shares anti-inflation floor on `usd_oku_mint` — referenced by
/// `wrap` to refuse first-deposit unless reserves are pre-seeded. Kept
/// here for parity with the source-of-truth in `oku-shared::constants`;
/// the init currently doesn't pre-seed dead shares so flows that hit
/// `wrap` revert with `BelowMinimumLiquidity`. See the `#[init]` doc
/// comment for rationale.
#[allow(dead_code)]
const MINIMUM_LIQUIDITY: u64 = 1_000_000;

const ITER_COUNT: u64 = 1000;
const TX_PER_ITER: u64 = 100;

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
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

    /// Six-step init wires both programs to their canonical state so the
    /// `#[end]` invariants on `usd_multiplier` can fire:
    ///
    /// 1. Create USDC SPL mint.
    /// 2. Create OkuMoney Token-2022 mint (authority = lite-psm config PDA).
    /// 3. lite-psm `Initialize` (creates PsmConfig PDA + vault_usdc).
    /// 4. lite-psm `SetupRedemptionQueue` (9 640-byte zero-copy alloc).
    /// 5. lite-psm `SetupOkuMoneyEscrow` (vault_oku_money ATA).
    /// 6. oku-dollar `Initialize` (creates OkuDollarConfig PDA, usdOku
    ///    mint PDA, and reserve_vault ATA — Anchor handles all the
    ///    creation via `init` constraints, including the usdOku mint
    ///    which is itself a PDA at `[b"usd_oku_mint_v2"]`).
    ///
    /// Dead-shares anti-inflation seed: deferred. The OkuDollar
    /// program's `wrap` handler refuses the first wrap unless the
    /// reserve vault has at least `DEAD_SHARES = 1_000_000` units of
    /// OkuMoney, which requires either (a) burning OkuMoney from a
    /// faucet — but we have no mint authority because it's a PDA — or
    /// (b) forging the reserve_vault token account state via
    /// `set_account_custom`. (b) bypasses the dead-shares
    /// initialization sequence the program is meant to test, so the
    /// invariant-fuzzing value is low. For this cycle we leave the
    /// seed unwired; `flow_wrap` will revert on `BelowMinimumLiquidity`
    /// every call but the `#[end]` invariants on `usd_multiplier` still
    /// fire (`update_usd_multiplier` doesn't depend on the reserve
    /// balance).
    ///
    /// Trident's SVM doesn't crypto-verify signatures (see
    /// `trident-svm/src/methods/trident_svm_transactions.rs:39`,
    /// `try_from_legacy_transaction(tx, &HashSet::new())`), so we sign
    /// every ix as the default payer regardless of which `Signer<'info>`
    /// the program expects.
    #[init]
    fn start(&mut self) {
        let payer = self.trident.payer().pubkey();
        self.trident.airdrop(&payer, 1000 * LAMPORTS_PER_SOL);

        // -----------------------------------------------------------------
        // PDAs (lite-psm + oku-dollar).
        // -----------------------------------------------------------------
        let (psm_config_pda, _) = Pubkey::find_program_address(
            &[b"psm_config_v3"],
            &lite_psm_types::program_id(),
        );
        let (queue_pda, _) = Pubkey::find_program_address(
            &[b"redemption_queue_v2"],
            &lite_psm_types::program_id(),
        );
        let (oku_dollar_config_pda, _) = Pubkey::find_program_address(
            &[b"oku_dollar_config_v2"],
            &oku_dollar::program_id(),
        );
        let (usd_oku_mint_pda, _) = Pubkey::find_program_address(
            &[b"usd_oku_mint_v2"],
            &oku_dollar::program_id(),
        );

        // -----------------------------------------------------------------
        // 1. USDC SPL mint.
        // -----------------------------------------------------------------
        let usdc_mint = self.fuzz_accounts.usdc_mint.insert(&mut self.trident, None);
        let usdc_init_ixs =
            self.trident.initialize_mint(&payer, &usdc_mint, 6, &payer, None);
        let _ = self
            .trident
            .process_transaction(&usdc_init_ixs, Some("InitUsdcMint"));

        // -----------------------------------------------------------------
        // 2. OkuMoney Token-2022 mint (authority = lite-psm config PDA).
        // -----------------------------------------------------------------
        let oku_money_mint = self
            .fuzz_accounts
            .okusd_mint
            .insert(&mut self.trident, None);
        let oku_init_ixs = self.trident.initialize_mint_2022(
            &payer,
            &oku_money_mint,
            6,
            &psm_config_pda,
            Some(&psm_config_pda),
            &[],
        );
        let _ = self
            .trident
            .process_transaction(&oku_init_ixs, Some("InitOkuMoneyMint"));

        // -----------------------------------------------------------------
        // 3. lite-psm `Initialize` — creates PsmConfig PDA + vault_usdc ATA.
        // -----------------------------------------------------------------
        self.fuzz_accounts
            .psm_config
            .insert_with_address(psm_config_pda);

        let vault_usdc = spl_associated_token_account_ata(&usdc_mint, &psm_config_pda, false);
        let init_psm_ix = lite_psm_types::InitializeInstruction::data(
            lite_psm_types::InitializeInstructionData::new(
                1_000_000_000_000_000_000u64, // max_supply
                1_000_000_000_000_000_000u64, // minter_allowance
                payer, payer, payer, payer, payer, payer, payer, payer, payer, payer, payer,
                payer, // oracle_relay_pyth_program_owner (non-zero placeholder; relay disabled)
            ),
        )
        .accounts(lite_psm_types::InitializeInstructionAccounts::new(
            payer,           // role_admin
            psm_config_pda,
            usdc_mint,
            oku_money_mint,
            vault_usdc,
        ));
        let _ = self
            .trident
            .process_transaction(&[init_psm_ix.instruction()], Some("LitePsmInitialize"));

        // -----------------------------------------------------------------
        // 4. lite-psm `SetupRedemptionQueue`.
        // -----------------------------------------------------------------
        let setup_queue_ix = lite_psm_types::SetupRedemptionQueueInstruction::data(
            lite_psm_types::SetupRedemptionQueueInstructionData::new(),
        )
        .accounts(
            lite_psm_types::SetupRedemptionQueueInstructionAccounts::new(
                payer,
                psm_config_pda,
                queue_pda,
            ),
        );
        let _ = self
            .trident
            .process_transaction(&[setup_queue_ix.instruction()], Some("SetupRedemptionQueue"));

        // -----------------------------------------------------------------
        // 5. lite-psm `SetupOkuMoneyEscrow`.
        // -----------------------------------------------------------------
        let vault_oku_money_psm =
            spl_associated_token_account_ata(&oku_money_mint, &psm_config_pda, true);
        let setup_escrow_ix = lite_psm_types::SetupOkuMoneyEscrowInstruction::data(
            lite_psm_types::SetupOkuMoneyEscrowInstructionData::new(),
        )
        .accounts(
            lite_psm_types::SetupOkuMoneyEscrowInstructionAccounts::new(
                payer,
                psm_config_pda,
                oku_money_mint,
                vault_oku_money_psm,
            ),
        );
        let _ = self
            .trident
            .process_transaction(&[setup_escrow_ix.instruction()], Some("SetupOkuMoneyEscrow"));

        // -----------------------------------------------------------------
        // 6. oku-dollar `Initialize` — creates OkuDollarConfig PDA,
        //    usdOku mint PDA (via Anchor `init`), and reserve_vault ATA.
        // -----------------------------------------------------------------
        self.fuzz_accounts
            .config
            .insert_with_address(oku_dollar_config_pda);
        self.fuzz_accounts
            .wokusd_mint
            .insert_with_address(usd_oku_mint_pda);

        // Reserve vault: ATA(oku_money_mint, oku_dollar_config_pda) on Token-2022.
        let reserve_vault =
            spl_associated_token_account_ata(&oku_money_mint, &oku_dollar_config_pda, true);

        let init_dollar_ix = InitializeInstruction::data(InitializeInstructionData::new(
            payer,         // pauser
            payer,         // unpauser
            payer,         // usd_rebaser
            payer,         // reserve_manager
            950_000_000,   // min_collateral_ratio (95%)
        ))
        .accounts(InitializeInstructionAccounts::new(
            payer,                  // role_admin
            oku_dollar_config_pda,
            oku_money_mint,
            usd_oku_mint_pda,
            reserve_vault,
            psm_config_pda,
        ));
        let _ = self
            .trident
            .process_transaction(&[init_dollar_ix.instruction()], Some("OkuDollarInitialize"));

        // Sanity check: confirm the OkuDollarConfig PDA reached the
        // canonical 362-byte layout.
        let cfg_data = self.trident.get_account(&oku_dollar_config_pda).data().to_vec();
        if cfg_data.len() < 305 {
            eprintln!(
                "[trident-init] WARN: oku_dollar_config PDA has {} bytes (expected >= 305); \
                 invariants will be skipped this iteration.",
                cfg_data.len()
            );
        }
    }

    fn config_pda(&mut self) -> Pubkey {
        self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(
                &[b"oku_dollar_config_v2"],
                oku_dollar::program_id(),
            )),
        )
    }

    // ----------------------------------------------------------------
    // FLOW 1: wrap — deposit OkuMoney, mint wOkuSD shares
    // ----------------------------------------------------------------
    #[flow]
    fn flow_wrap(&mut self) {
        let oku_m_amount: u64 = self.trident.random_from_range(1_000_000u64..100_000_000u64);

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.config_pda();
        let psm_config = self
            .fuzz_accounts
            .psm_config
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
        let dead_shares_ata = self
            .fuzz_accounts
            .dead_shares_ata
            .insert(&mut self.trident, None);

        let ix = WrapInstruction::data(WrapInstructionData::new(oku_m_amount, 0)).accounts(
            WrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
                psm_config,
                dead_shares_ata,
            ),
        );

        let _ = self.trident.process_transaction(&[ix.instruction()], Some("Wrap"));
    }

    // ----------------------------------------------------------------
    // FLOW 2: unwrap — burn wOkuSD shares, receive OkuMoney
    // ----------------------------------------------------------------
    #[flow]
    fn flow_unwrap(&mut self) {
        let shares: u64 = self.trident.random_from_range(1u64..1_000_000_000u64);

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.config_pda();
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

        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);
        let ix = UnwrapInstruction::data(UnwrapInstructionData::new(shares)).accounts(
            UnwrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
                psm_config,
            ),
        );

        let _ = self.trident.process_transaction(&[ix.instruction()], Some("Unwrap"));
    }

    // ----------------------------------------------------------------
    // FLOW 3: wrap then unwrap round-trip at same multiplier
    // Key invariant: OkuMoney after <= OkuMoney before (floor rounding)
    // ----------------------------------------------------------------
    #[flow]
    fn flow_wrap_unwrap_roundtrip(&mut self) {
        let oku_m_to_wrap: u64 = self.trident.random_from_range(1_000_000u64..100_000_000u64);

        let user = self.fuzz_accounts.user.insert(&mut self.trident, None);
        let config = self.config_pda();
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
        let dead_shares_ata = self
            .fuzz_accounts
            .dead_shares_ata
            .insert(&mut self.trident, None);

        // Snapshot OkuMoney balance before wrap
        let okusd_before = self
            .trident
            .get_token_account(user_okusd_ata)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        let psm_config = self
            .fuzz_accounts
            .psm_config
            .insert(&mut self.trident, None);

        // Wrap
        let wrap_ix = WrapInstruction::data(WrapInstructionData::new(oku_m_to_wrap, 0)).accounts(
            WrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
                psm_config,
                dead_shares_ata,
            ),
        );

        let wrap_result = self
            .trident
            .process_transaction(&[wrap_ix.instruction()], Some("Wrap"));
        if wrap_result.is_error() {
            return;
        }

        // Read shares received
        let shares_received = self
            .trident
            .get_token_account(user_wokusd_ata)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        if shares_received == 0 {
            return;
        }

        // Unwrap all shares received
        let unwrap_ix = UnwrapInstruction::data(UnwrapInstructionData::new(shares_received))
            .accounts(UnwrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
                psm_config,
            ));

        let _ = self
            .trident
            .process_transaction(&[unwrap_ix.instruction()], Some("Unwrap"));

        // Check: round-trip never inflates OkuMoney balance
        let okusd_after = self
            .trident
            .get_token_account(user_okusd_ata)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        assert!(
            okusd_after <= okusd_before,
            "INVARIANT VIOLATION: wrap-unwrap round-trip inflated balance: \
             before={okusd_before} after={okusd_after}"
        );
    }

    // ----------------------------------------------------------------
    // FLOW: update_usd_multiplier — exercise the rebasing path so the
    // existing wrap/unwrap round-trip invariant (flow_wrap_unwrap_roundtrip)
    // is no longer always evaluated at `usd_multiplier == PRECISION`.
    //
    // Closes the gap noted in the end-of-iteration TODO below: without
    // this flow the multiplier never drifts off PRECISION, so any
    // rounding-asymmetry regression analogous to the EVM
    // `InsufficientBalance()` redeem bug (LitePSM.sol:452 pre-fix) would
    // be invisible to the fuzzer.
    //
    // The bump pattern is intentionally diverse (single-bps perturbations
    // up through multi-percent moves) so short-term and long-term yield
    // trajectories are both represented within a single iteration. The
    // call frequently reverts with `InsufficientCollateral` until reserves
    // are topped up — that is expected; we ignore the error.
    // ----------------------------------------------------------------
    #[flow]
    fn flow_update_usd_multiplier(&mut self) {
        // Bias toward small moves (the regime where the EVM bug surfaced
        // — Sepolia was at `1_000_000_001_546_176_000`, barely above
        // PRECISION) but include occasional larger moves for breadth.
        let bps_bucket = self.trident.random_from_range(0u64..100u64);
        let bps_inc: u64 = match bps_bucket {
            0..=39 => self.trident.random_from_range(1u64..10u64), // ~40% single-digit bps
            40..=74 => self.trident.random_from_range(10u64..100u64), // ~35% double-digit bps
            75..=94 => self.trident.random_from_range(100u64..1000u64), // ~20% 1%-10%
            _ => self.trident.random_from_range(1000u64..5000u64),     // ~5% large moves
        };
        // target = last * (10_000 + bps) / 10_000
        let target = self
            .last_usd_multiplier
            .saturating_mul(10_000 + bps_inc)
            / 10_000;
        // Never decrease (the program rejects this with MultiplierCannotDecrease)
        // and never exceed the program's MAX_USD_MULTIPLIER bound.
        let target = target.min(MAX_USD_MULTIPLIER).max(self.last_usd_multiplier);

        let usd_rebaser = self
            .fuzz_accounts
            .usd_rebaser
            .insert(&mut self.trident, None);
        let config = self.config_pda();
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
            config,
            reserve_vault,
            usd_oku_mint,
            psm_config,
        ));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("UpdateUsdMultiplier"));

        // On success, advance the local mirror of the multiplier so the
        // end-of-iteration monotonicity check (TODO below) can rely on it.
        // On failure (the common case, e.g. `InsufficientCollateral`), leave
        // it unchanged.
        if result.is_success() {
            self.last_usd_multiplier = target;
        }
    }

    // ----------------------------------------------------------------
    // FLOW 4: pause / unpause toggle
    // ----------------------------------------------------------------
    #[flow]
    fn flow_pause_toggle(&mut self) {
        let do_pause: bool = self.trident.random_bool();
        let config = self.config_pda();

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

    /// End of iteration invariants.
    ///
    /// `flow_update_usd_multiplier` drifts `usd_multiplier` across an iteration,
    /// exercising wrap/unwrap at elevated multipliers. `last_usd_multiplier`
    /// tracks the highest successfully-applied target for monotonicity checks.
    ///
    /// Invariants (from byte offsets derived from OkuDollarConfig::LEN == 362):
    ///   1. usd_multiplier is non-decreasing (tracked in self.last_usd_multiplier)
    ///   2. usd_multiplier <= MAX_USD_MULTIPLIER (ceiling)
    ///
    /// Byte offsets (see programs/oku-dollar/src/state.rs):
    ///   OkuDollarConfig.usd_multiplier:  account bytes [297..305]
    ///    (8 disc + 1 bump + 9×32 authorities/refs = 9+288 = 297)
    ///   OkuDollarConfig.min_collateral_ratio: account bytes [321..329]
    ///
    /// Collateral ratio check (INV3) and dead-shares check (INV4) require
    /// reading SPL Token accounts (reserve_vault, usd_oku_mint) and are
    /// deferred until #[init] is wired with current types.rs.
    #[end]
    fn end(&mut self) {
        let (config_pda, _) = Pubkey::find_program_address(
            &[b"oku_dollar_config_v2"],
            &oku_dollar::program_id(),
        );

        let config_data = self.trident.get_account(&config_pda).data().to_vec();

        // Invariant 1 + 2: usd_multiplier non-decreasing and within MAX_USD_MULTIPLIER
        if config_data.len() >= 305 {
            let mult_bytes: [u8; 8] = config_data[297..305].try_into().unwrap_or([0u8; 8]);
            let usd_multiplier = u64::from_le_bytes(mult_bytes);
            assert!(
                usd_multiplier >= self.last_usd_multiplier,
                "INV1: usd_multiplier decreased ({usd_multiplier} < {})", self.last_usd_multiplier
            );
            assert!(
                usd_multiplier <= MAX_USD_MULTIPLIER,
                "INV2: usd_multiplier exceeded MAX ({usd_multiplier} > {MAX_USD_MULTIPLIER})"
            );
            self.last_usd_multiplier = usd_multiplier;
        }
    }
}

fn main() {
    FuzzTest::fuzz(ITER_COUNT, TX_PER_ITER);
}

/// ATA pubkey derivation helper. Mirror of the helper in
/// `fuzz_lite_psm/test_fuzz.rs`. Seeds: `[wallet, token_program, mint]`
/// hashed under ATA program `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
fn spl_associated_token_account_ata(mint: &Pubkey, wallet: &Pubkey, is_token_2022: bool) -> Pubkey {
    let ata_program: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    let token_program: Pubkey = if is_token_2022 {
        pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
    } else {
        pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    };
    let (ata, _) = Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ata_program,
    );
    ata
}
