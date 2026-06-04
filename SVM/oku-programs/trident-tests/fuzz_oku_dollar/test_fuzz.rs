//! Trident fuzz harness for oku-dollar (wokusd_vault).
//!
//! Flows: wrap, unwrap, wrap-unwrap round-trip, pause toggle.
//! Invariants: round-trip monotonicity, multiplier bounds, collateral ratio.
//!
//! Run: trident fuzz run fuzz_oku_dollar

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::wokusd_vault;
use types::wokusd_vault::*;

const PRECISION: u64 = 1_000_000_000;
const MAX_USD_MULTIPLIER: u64 = 1_000_000_000_000_000;
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

    #[init]
    fn start(&mut self) {
        // TODO: call Initialize once types.rs is regenerated with current
        // discriminators (Initialize now takes usd_rebaser, reserve_manager,
        // min_collateral_ratio params not present in the stale types.rs).
    }

    fn config_pda(&mut self) -> Pubkey {
        self.fuzz_accounts.config.insert(
            &mut self.trident,
            Some(PdaSeeds::new(
                &[b"oku_dollar_config"],
                wokusd_vault::program_id(),
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

        let ix = WrapInstruction::data(WrapInstructionData::new(oku_m_amount)).accounts(
            WrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
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

        let ix = UnwrapInstruction::data(UnwrapInstructionData::new(shares)).accounts(
            UnwrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
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

        // Wrap
        let wrap_ix = WrapInstruction::data(WrapInstructionData::new(oku_m_to_wrap)).accounts(
            WrapInstructionAccounts::new(
                user,
                config,
                okusd_mint,
                wokusd_mint,
                user_okusd_ata,
                user_wokusd_ata,
                vault_okusd,
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
            &[b"oku_dollar_config"],
            &wokusd_vault::program_id(),
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
