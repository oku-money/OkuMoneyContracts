# OkuMoney Solana Implementation

> See [`../README.md`](../README.md) for shared architecture, cross-chain flows, RBAC tiers, the
> orchestrator runbook, signer trust, and the end-to-end deployment guide. This file owns what is
> specific to the Solana programs: design, program structure, and SVM operations.

Solana implementation of OkuMoney (yield infrastructure backed by US Treasury Bills): a single
`OkuM` token with `ScaledUiAmount`-based yield display.

## Stack

- **Language:** Rust 1.90.0 (pinned in `oku-programs/rust-toolchain.toml`)
- **Framework:** Anchor 1.0.2 (`Anchor.toml` + workspace `Cargo.toml`); Solana crates 3.x (`solana_version = "3.1.10"`)
- **Token standard:** Token-2022 (`ScaledUiAmount` + `MetadataPointer` + `TokenMetadata`); **multisig:**
  Squads; **JS bindings:** `@anchor-lang/core 1.0.x`

## Programs

**lite-psm** (`4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN`) is the single program: buffer-only Peg
Stability Module, yield schedule, compliance (freeze / thaw) and direct mint/burn for bridging. The
`PsmConfig` PDA holds mint, freeze and `ScaledUiAmountConfig` authority over `OkuM`, so no EOA
controls minting. `initialize` creates the mint with its three extensions via Token-2022 CPIs.

**oku-shared** (`crates/`) has **zero dependencies** (no `solana-*`, no `anchor-lang`): constants, the
streaming-accrual port of EVM `MathLib.sol` (`rate.rs` over the 256-bit `wad.rs`), the u64 PSM
conversions (`math.rs`) and the yield-lock predicate (`yield_lock.rs`). It lives outside `programs/`
because `anchor build` requires every `programs/*` member to declare an `idl-build` feature.

**Cross-chain.** No on-chain bridge program: the SVM leg is `burn_oku_m_direct` / `mint_oku_m_direct`
(raw OkuM conserved 1:1). Model and procedure:
[`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated).

---

## Why a single token on SVM

SPL balances are a literal `u64` with no `balanceOf()` hook, so true on-chain rebasing (the EVM
stETH/USDM/rUSDY pattern) is impossible. Token-2022's `ScaledUiAmountConfig` stores an updatable
`f64` multiplier on the mint; supporting wallets and RPCs display `raw_amount * multiplier` while
`token_account.amount` never changes, so AMMs, lending and orderbooks see static balances by
construction (Raydium CPMM/CLMM allow the extension; Jupiter routes through it; see the [integration
guide](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide)). That removes
the wrap/unwrap vault, dead shares and two-program CPI chain of the EVM two-token model.

### The mint extension is NOT the source of truth

It is a **write-only display mirror**: the program pushes values into it and never reads them back.
The canonical multiplier is computed on read from the rate schedule on `PsmConfig`
(`helpers/multiplier.rs` → `oku_shared::rate`), exactly as EVM computes `okuMMultiplier()`. There is
no multiplier field on `PsmConfig` and no read path from the extension — do not add one.

Why: `ScaledUiAmountConfig::current_multiplier()` is a step function with one pre-armable future
step, so it cannot represent continuous accrual; `InterestBearingConfig` can, but is mutually
exclusive with it on-chain and would cost the bounded window, pre-staged successor and re-anchoring.

**Continuous accrual, discrete display.** The canonical multiplier compounds every second with no
transactions. The mirror is a staircase refreshed by the **permissionless** `sync_display_multiplier`
crank (60 s recommended; not a protocol constant), always at or below canonical, so a redeem pays at
least what the wallet showed (about $0.35 under-read per $1,000,000 at 20% APY). Display freshness
is entirely the crank's job (see § Compute budget).

### Naming: OkuM on-chain, usdOku in the wallet

On-chain identity is **OkuM** everywhere; the mint's `TokenMetadata` is `name: "OkuMoney",
symbol: "OkuM"` (matching EVM `OkuMoney`), single-sourced as `OKU_M_METADATA_NAME` /
`OKU_M_METADATA_SYMBOL` and fixed at `initialize`. "usdOku" is **not**
an on-chain symbol: it is the wallet's `raw * multiplier` rendering (EVM's `OkuDollar` wrapper
collapses into this display layer), and labelling a raw number `usdOku` would falsely assert a $1 peg.
Testers see **raw** (below-dollar when multiplier > 1) amounts in non-ScaledUiAmount explorers, raw
RPC (`amount`), `spl-token accounts`, transfer arguments and `supply`.

### Other SVM-specific choices

- **Single-slot sandwich lock.** Only `set_okum_multiplier` (emergency override) stamps
  `last_override_slot`; PSM operations require `current_slot != last_override_slot`.
  Mirrors EVM `lastOverrideBlock`. Unlike EVM, the override is blocked by the program's
  single pause flag, so EVM's pause-around-the-override ceremony (EVM Accepted Risk #11) cannot be
  used here: a mint landing in an earlier slot ahead of an honest override is an accepted residual.
  The pause flag still stops a compromised `rate_manager` from forcing the multiplier.
- **Decimals.** `OkuM` has 6 decimals and USDC is hard-coded to 6 (`InvalidUsdcDecimals` at init);
  EVM `OkuMoney` has 18 and the PSM reads collateral decimals at init (≤ 18). The orchestrator
  rescales across chains.

## Program structure

```
crates/oku-shared/
  src/ lib.rs, constants.rs, math.rs, rate.rs, wad.rs, yield_lock.rs   (+ Kani harnesses in math.rs, rate.rs, wad.rs)
  tests/differential.rs    # replays the Solidity vector corpus
  fuzz/fuzz_targets/       # compute_multiplier, dollars_to_raw, raw_to_dollars, wad_mul_div
programs/lite-psm/src/
  lib.rs                   # 24 instruction entry points
  state.rs                 # PsmConfig only (seed psm_config, LEN = 754)
  errors.rs  events.rs  roles.rs (AuthorityRole, 12 roles)  constants.rs
  helpers/                 # multiplier (canonical), display_sync (mirror), yield_lock,
                           # math (Anchor-error wrappers), limits (check_supply_cap, consume_allowance)
  instructions/            # init, psm (mint/redeem/buffer), psm_admin (pause, freeze, set_authority,
                           # role-admin accept/cancel, caps, allowances), yield_ops
                           # (rate writers, override, display crank), direct_mint, direct_burn
  contexts/                # per-instruction account contexts
tests/                     # bankrun/ (+ scenarios/), shared/, fixtures/
```

## State accounts

### PsmConfig PDA (`b"psm_config"`)

The only state account (`PsmConfig::SEED`, mirrored in `scripts/utils/pdaHelpers.ts`). `LEN` is
**754** bytes (8-byte discriminator + `InitSpace`), pinned by a compile-time `assert!`.

```rust
pub struct PsmConfig {
    pub bump: u8,
    // 12 authorities: role_admin, pauser, unpauser, freezer, unfreezer, buffer_depositor,
    //   buffer_withdrawer, cap_manager, allowance_manager, rate_manager, direct_minter, direct_burner
    // Token references: usdc_mint, oku_m_mint, vault_usdc
    // Limits: max_supply, minter_allowance, direct_minter_allowance, direct_burner_allowance, is_paused
    // Yield schedule (6 fields, as EVM): okum_base_multiplier, okum_rate_per_second,
    //   okum_last_accrual_time, okum_rate_end, okum_pending_rate_per_second, okum_pending_rate_end
    // Sandwich lock: last_override_slot
    // Display crank (observability only): last_display_sync_ts
    // Two-step RoleAdmin: pending_role_admin
    pub reserved: [u8; 128],   // tail padding
}
```

**`reserved`.** The config is a singleton, so a new field would otherwise force close-and-reinit,
losing every role and the accrual anchor. **Consume from the FRONT and shrink the array to keep
`LEN` constant:** no offset moves and deployed accounts stay the right size. There is deliberately no
resize/migration instruction; if `reserved` is exhausted, write one against the struct of that day.

## Core operations

### Yield (streaming rate schedule)

| Instruction | Role | EVM counterpart |
|---|---|---|
| `set_okum_yield_rate(new_rate, end_timestamp)` | rate_manager | `setOkuMYieldRate` |
| `set_next_okum_yield_rate(new_rate, pending_end)` | rate_manager | `setNextOkuMYieldRate` (pre-stages the successor; takes over at `okum_rate_end` with no transaction) |
| `set_okum_yield_rate_with_successor(rate, end, next_rate, next_end)` | rate_manager | `setOkuMYieldRateWithSuccessor` (atomic; used by the epoch orchestrator) |
| `set_okum_multiplier(new_multiplier)` | rate_manager | `setOkuMMultiplier` — EMERGENCY: force the multiplier and halt the schedule; the only discrete jump, so the only one that stamps the sandwich lock |
| `sync_display_multiplier()` | **permissionless** | none — value fully determined by on-chain state |

Rates are WAD-scaled (1e18), as on EVM; neither stack has an on-chain "distribute N dollars"
primitive (the operator publishes a *rate*). Every write re-anchors `okum_base_multiplier` first, so
accrual is continuous across it. Rails: rate in `[PRECISION, MAX_RATE]`; a yielding rate needs a future
end within `MAX_RATE_WINDOW_SECONDS`; a halted rate (`== PRECISION`) carries no end; a successor needs
a live active window and must end strictly after it. The display sync deliberately does not stamp the
lock (it would make the PSM unavailable for a slot per sync for no security benefit). The multiplier is
computed only by `helpers::multiplier::{current, at}`, which projects the six schedule fields into
`oku_shared::rate::Schedule` and compounds against `Clock::unix_timestamp`.

### PSM

```rust
// raw_oku_m = usdc_amount × PRECISION / multiplier (usdc treated as a dollar value). Permissionless.
pub fn mint_oku_m(usdc_amount: u64)
// usdc_amount = raw_oku_m × multiplier / PRECISION; pays from the USDC buffer or reverts
// InsufficientBuffer. min_usdc_out = 0 disables the floor.
pub fn redeem_oku_m(raw_oku_m_amount: u64, min_usdc_out: u64)
pub fn deposit_buffer(amount: u64)    // buffer_depositor
pub fn withdraw_buffer(amount: u64)   // buffer_withdrawer
```

All four are yield-locked and pause-gated; neither buffer instruction has a solvency check. A mint whose
output rounds to zero reverts `AmountTooSmall` (as on EVM). Redeem has no such check: with
multiplier ≥ 1 and OkuM / USDC both 6 decimals, its output is never below its input. `mint_oku_m` is fully
permissionless: the orchestrator holds no privileged PSM mint authority, so its key compromise grants
no mint beyond its `direct_minter` allowance (asserted by `tests/bankrun/crossChainBridging.ts`).

**`min_usdc_out`.** Slippage is not structurally reachable (monotonic multiplier, no PSM fee), so the
floor is defence-in-depth; `scripts/test/test-devnet.ts` also derives it from an independent TypeScript
mirror of the multiplier, making each devnet redeem a live Rust-vs-TS check (other callers pass `0`).
EVM's `LitePSM` has no such parameter: [`../EVM/README.md`](../EVM/README.md) Accepted Risk "The PSM has
no slippage protection".

### Direct mint / burn (bridging + fiat on-ramp)

`mint_oku_m_direct(amount)` (DIRECT_MINTER: bridge destination / fiat on-ramp) and
`burn_oku_m_direct(amount)` (DIRECT_BURNER: bridge source / off-ramp) move raw amounts with no
multiplier conversion (the rate schedule, not bridging, synchronises the multiplier across chains).
Mint is bounded by `direct_minter_allowance` and `max_supply`, burn by `direct_burner_allowance`;
both are pause- and yield-lock-gated.

## Precision model

`PRECISION = 1e18` (WAD), identical to EVM, as are `MAX_RATE`, `MAX_MULTIPLIER` and `rpow`'s half-up
rounding, so a schedule broadcast to every chain yields a **bit-identical** multiplier at the same
second with no messaging. Token amounts are `u64`; multipliers are `u128` and rates `u64` at WAD
scale; everything else rounds down (protocol-favouring).

**Why 1e18.** One ulp of a per-second rate is 3.2% APY at 1e9 but ~3e-9% at 1e18, so a narrower scale
cannot express the schedule (pinned by `one_ulp_of_rate_is_economically_meaningful`,
`oku-shared/src/constants.rs`). **Cost:** `raw × multiplier` (up to ~1.8e43) overflows `u128`, so
multiplier math uses [`wad.rs`](oku-programs/crates/oku-shared/src/wad.rs): a 256-bit intermediate
with small-divisor long division (`1e18 < 2^60`, so not general bignum division).

**f64 display mirror.** `display_sync.rs::multiplier_to_f64_floor` biases the conversion two ULPs
(~2e-16 relative) downward to keep `display <= canonical`; it costs under a cent even at the largest
`u64` position and is far below the by-design crank lag. Each sync writes exactly **one** point,
`m(now)`, effective immediately, so the display is a pure lag behind a monotonic curve and
`display <= canonical` holds unconditionally. There is deliberately no pre-armed second step: it
would fire under whatever schedule is live later and, after a rate *decrease*, land **above** the new
canonical.

---

## Compute budget

Ceilings are pinned in `tests/bankrun/compute-budget.ts` (a regression fails CI); measured values are
from the current build.

| Path | Measured CU | Ceiling |
|---|---|---|
| `mint_oku_m`, warm ATA, 7 / 90-day window | ~49,000 / ~56,300 | 100,000 (user) |
| `mint_oku_m` / `redeem_oku_m`, two-`rpow` overhang branch | ~74,900 / ~84,500 | 100,000 |
| **`mint_oku_m`, cold ATA, overhang (user worst case)** | **~98,600** (98–107k across runs) | 150,000 |
| `set_okum_yield_rate_with_successor` | ~7,100 | 30,000 (operator) |
| `sync_display_multiplier` (1 CPI) | ~54,700 | 80,000 (crank) |

The overhang branch (active window closed, successor running) is the normal state between a handover
and the next schedule write, so it is the number that matters. A first-time minter also pays the
`init_if_needed` ATA CPI, hence the separate cold ceiling (still under Solana's 200k default).

Kept cheap by `u64` limbs in `wad.rs` widened at the multiply (native 64×64→128, no `__multi3`), one
mirror point per sync, and **no opportunistic display sync** in `mint_oku_m` / `redeem_oku_m` (~31k CU
for a cosmetic update). Consequence: an idle PSM with nobody running `scripts/admin/sync-display.ts`
shows a stale-**low** balance — safe (never high) but an operational duty (the crank needs no key).

`rpow` runs on-chain (not a backend-signed quote) because a Solana instruction cannot call out
mid-execution and a quote valid for *N* seconds is a free option; see
[`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).

## Hardcoded constants

None can change without a program upgrade. Shared constants live in
[`crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs); the
`evm_parity_constants` test parses `EVM/src/lib/Constants.sol` and fails on divergence.

| Constant | Value | Notes |
|---|---|---|
| `PRECISION` | `1e18` (WAD) | Multiplier/rate fixed-point base. Byte-identical to EVM. |
| `MAX_RATE` | `PRECISION + 1e11` (~2242% APY) | Sanity bound on `rpow` inputs. Mirrors EVM. |
| `MAX_RATE_WINDOW_SECONDS` | `90 * 86400` | Longest single rate window (active, and a successor's own span); ~60× below `rpow`'s failure point so every schedule writer, including the override, stays callable. Mirrors EVM `MAX_RATE_WINDOW`. |
| `MAX_MULTIPLIER` | `1e24` (= $1M/token) | Math-sanity bound: `compound_for` clamps, the override rejects above it. Mirrors EVM. |
| `TOKEN_DECIMALS` / `USDC_DECIMALS` | `6` / `6` (`= TOKEN_DECIMALS`) | OkuM and USDC decimals; separate names so they cannot silently diverge. `USDC_DECIMALS` is used by every USDC `transfer_checked` and asserted at `initialize`. Unrelated to `PRECISION`. |

`lite-psm/src/constants.rs` re-exports only `PRECISION`, `MAX_MULTIPLIER`, `TOKEN_DECIMALS`,
`USDC_DECIMALS` and defines the OkuM metadata name/symbol.

---

## Authority model

**Canonical: [`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)** — every role-gated instruction with
its guard, blast radius and reversibility, plus the EVM↔SVM authority asymmetries. RBAC tiers are in
[`../README.md` § RBAC](../README.md#rbac-role-based-access-control).

SVM mechanism the matrix assumes: roles are **pubkey fields on `PsmConfig`** enforced by Anchor
`has_one`, not an `AccessControl` mapping — no role enumeration, no grant/revoke events. Rotation is
`set_authority` by `role_admin`; `role_admin`'s own transfer is two-step
(`set_authority(RoleAdmin, new)` proposes → `accept_role_admin` signed by the new key;
`cancel_role_admin_transfer` aborts), so a typo cannot strand the meta-role.

## Initialization

`initialize(InitializeParams)` creates `PsmConfig`, the USDC vault (ATA of the config) and the `OkuM`
mint (`ScaledUiAmount` authority, mint and freeze authority = the config PDA). No other PSM-owned
account exists: redeems burn straight from the user's OkuM account.

### Two binding authority constraints at init

Together these force the deployer and the operational roles onto **different keys**:

1. **`role_admin` must be the BPF upgrade authority.** `contexts/init.rs` requires
   `program_data.upgrade_authority_address == Some(role_admin.key())`, so the signer of `initialize`
   is always the deploying wallet. This stops a third party racing to claim the singleton config PDA
   (and pick `usdc_mint`) between deploy and init.
2. **No granular authority may equal `role_admin`** (nor the zero pubkey). `instructions/init.rs`
   checks all 9 (`pauser`, `unpauser`, `freezer`, `unfreezer`, `buffer_depositor`,
   `buffer_withdrawer`, `cap_manager`, `allowance_manager`, `rate_manager`) with `InvalidAuthority`
   (6024), mirroring `set_authority`'s separation-of-duties guard.

`initialize` takes no `role_admin` parameter: it is always the signing deployer. On devnet/localnet
a separate local operator key (`keys/devnet-authority.json`, see
[`oku-programs/keys/README.md`](oku-programs/keys/README.md)) holds all 9 granular roles, so one key
signs every smoke-test call while the deployer keeps claw-back via `set_authority`. `direct_minter` /
`direct_burner` start disabled and are wired afterwards by `deploy-init` / `grant-roles.ts`.
**Trap:** pointing any granular role at the deployer makes `initialize` revert
(`scripts/config/authorities.ts` keeps them on the operator key).

## Error codes

30 variants in `programs/lite-psm/src/errors.rs`, codes 6000–6029 in declaration order (see
`artifacts/svm/lite_psm.json`). Notable:

- `Unauthorized` (6000), `Paused` (6001), `OverrideInProgress` (6011: same slot as an emergency override).
- `InsufficientBuffer` (6007): vault can't cover a redeem or `withdraw_buffer` (EVM carries
  `(available, required)`); `InsufficientUserBalance` (6008): user's OkuM short on redeem.
- Override: `MultiplierCannotDecrease` (6012, must strictly increase); `MultiplierTooHigh` (6021, above
  `MAX_MULTIPLIER`).
- Schedule rails: `InvalidRate` (6013), `RateTooHigh` (6014), `EndTimestampNotAllowed` (6015),
  `EndTimestampInPast` (6016), `RateWindowTooLong` (6017), `NoRateEndSet` (6018),
  `RateAlreadyExpired` (6019), `PendingEndNotAfterRateEnd` (6020).
- `InvalidAuthority` (6024): zero pubkey, or a granular role / proposal equal to `role_admin`;
  `NoPendingRoleAdmin` (6025) / `NotPendingRoleAdmin` (6026): accept/cancel preconditions.
- `AmountTooSmall` (6028): mint output rounds to zero (EVM name); `SlippageExceeded`
  (6029): redeem output below `min_usdc_out` (no EVM equivalent).

---

## Accepted Risks

Trust assumptions the SVM side makes deliberately; reviewers should not re-flag them.

1. **Operator-compromise is out of scope.** The threat model excludes a malicious cold multisig — see
   [`../README.md` § Signer trust implications](../README.md#signer-trust-implications). SVM
   consequence: `MAX_MULTIPLIER` and the per-role allowance caps are **math-sanity bounds**
   (overflow-safe region, operator typos), not defence against a compromised rate manager key.
2. **No on-chain Proof-of-Reserves or oracle.** Same posture as EVM (`EVM/README.md` Accepted Risk
   "USDC peg monitoring — off-chain"): no PoR feed, no USDC-peg circuit breaker, no oracle relay.
3. **SVM ↔ EVM parity residue.** Constants and `rpow` rounding are byte-identical; what remains:
   `rpow`'s far-tail overflow differs (EVM reverts on an intermediate *product* above `uint256`; SVM
   returns `None` on a *quotient* above `u128`), both ~17 orders of magnitude outside the reachable
   domain (`reachability` tests, `oku-shared/src/rate.rs`); `Clock::unix_timestamp` can lag wall clock
   (self-correcting, but drift monitoring must compare at equal *chain* timestamps); and wallet display
   steps because `ScaledUiAmount` cannot stream.
4. **A PSM pause gates SVM rate writes (single `is_paused` flag).** EVM's rate setters honour
   only OkuMoney's pause; here the one flag also gates them, with the same rule: while paused a
   write may only lower the projected curve (`yield_ops.rs` `check_active_pause_gate` /
   `check_successor_pause_gate`). Once the armed window lapses, the effective rate is
   `PRECISION` and every yielding write reverts `Paused` until the cold `unpauser` acts, so a
   pause longer than the armed window (one to two days at 24-hour epochs) halts SVM accrual.
   The atomic setter clears the armed successor before the successor gate runs, so while paused
   it accepts only a no-yield successor (bankrun: "while paused, the atomic setter accepts only
   a no-yield successor"). Intended posture: a depeg pause covers PSM, OkuMoney and vault on
   **every** chain, so all chains halt together at the same `rateEnd` (`EVM/README.md` Accepted
   Risks #1, #3). Recovery after unpause, and catch-up if chains diverged anyway
   (`set-yield-rate.ts --target-multiplier`): [`../README.md` § Depeg longer than the armed
   window](../README.md#depeg-longer-than-the-armed-window).

## Testing

From `SVM/oku-programs`; `npm test` runs both suites.

| Suite | Command | Count |
|---|---|---|
| Rust (`cargo test --workspace`) | `npm run test:rust` | 62 (lite-psm 10, oku-shared 51, differential 1) |
| Bankrun (in-process BPF on litesvm via `anchor-bankrun`) | `npm run test:bankrun` | 130 |
| Cross-language `compute_multiplier` (Solidity corpus replayed in Rust and TS; `EVM/test/differential/GenerateVectors.t.sol`) | `npm run test:differential` (repo root) | 3,867 vectors |
| Stateful sequence fuzz of `lite_psm` (random instruction sequences vs. a model; `tests/fuzz/psm-sequence.ts`) | `npm run test:fuzz` (`FUZZ_SEEDS`, `FUZZ_STEPS`, `FUZZ_SEED` to replay) | 8 seeds x 250 steps |
| Upgrade-tooling helpers (identity binding, IDL layout diff, state snapshots) | `npm run test:scripts` | 15 |
| Upgrade drill (real validator: deploy-init, direct, propose → execute → verify, refusals) | `npm run drill:upgrade` | — |
| Live devnet / fork smoke | `npm run test:onchain[:fork]` | — |

Bankrun suites are in `tests/bankrun/` (+ `scenarios/`), harness in `tests/shared/`. Of note:
`config-layout.ts` pins the `PsmConfig` size and accrual-block offsets that
`EVM/scripts/utils/svmValue.ts` decodes; `init-invariants.ts` covers the two init constraints;
`compute-budget.ts` pins the CU ceilings.

- **Token-2022 override.** The default bankrun image may predate `UpdateMultiplier`;
  `make fetch-token-2022` installs a mainnet binary (else streaming/display tests fail with
  "invalid instruction").
- **Helpers.** `readDisplayMultiplier()` (`tests/shared/bankrun.ts`) reads the *display mirror*; for
  the CANONICAL value use `computeCanonicalMultiplier()`, which recomputes from the schedule via
  `@okumoney/yield-tooling` (held bit-identical to Solidity and Rust by the differential corpus).
- **`autoBumpSlot` (default on).** `startBankrun()` advances the slot before every transaction (avoids
  `OverrideInProgress` after a yield op, and replayed identical-byte transactions); pass
  `{ autoBumpSlot: false }` + `warpSlots(h, n)` for strict slot semantics.

## Deployment

> The runbook — prerequisites, Surfpool fork pre-flight, the two-phase `deploy:programs` →
> `deploy:init` sequence, stale-deployment recovery, verification smoke and the mainnet ceremony — is
> documented once for both stacks in [`../README.md` § Deployment runbook](../README.md#deployment-runbook).

SVM-specific gotchas: the [two binding authority constraints](#two-binding-authority-constraints-at-init),
and keeping `Anchor.toml [programs.<network>]` equal to the program ID in `deployments/<network>.json`
([state-file notes](oku-programs/deployments/README.md)). Stale deployments are closed with
`admin:close-programs` (recovers rent; a closed program ID can never be redeployed).

## Runbook (SVM-specific)

### Pre-mainnet checklist

- [ ] `MAINNET_ORCHESTRATOR` points at a KMS-backed signer, not the deployer wallet.
- [ ] `role_admin` handed from the deployer to the cold multisig and verified on-chain (below).
- [ ] BPF upgrade authority transferred to the cold multisig (`admin:set-upgrade-authority`).
- [ ] `Anchor.toml [programs.<network>]` matches the freshly-deployed program ID.
- [ ] `make fetch-token-2022` applied if bankrun runs in CI.

### Mainnet `role_admin` handover

`initialize` always binds `config.role_admin` to the deploying wallet, whatever `MAINNET_COLD_MULTISIG`
says, and the upgrade-authority transfer does not move it. Handing it to the cold multisig is a
separate two-step rotation (ceremony order: [`../README.md` § Mainnet ceremony](../README.md#mainnet-ceremony)).

1. **Propose (deployer):** `NETWORK=mainnet-beta npm run admin:set-authority -- --role=roleAdmin
   --new=<SQUADS_COLD_VAULT> --yes-i-mean-it-on-mainnet` (`set_authority(RoleAdmin, new)` writes
   `pending_role_admin`; rejects zero or the current admin). Use the Squads **vault** address (the PDA
   that signs), not the multisig account address.
2. **Accept (cold multisig, via Squads):** `NETWORK=mainnet-beta npm run admin:accept-role-admin --
   --emit` prints the `accept_role_admin` instruction (program, accounts with signer/writable flags,
   data) to enter as a Squads vault transaction; `new_role_admin` = the vault. Run without `--emit`
   when the pending admin is the local wallet (devnet).
3. **Verify:** re-run `admin:accept-role-admin` (it reports "No transfer pending; role_admin is …")
   or fetch the config: `roleAdmin == <vault>`, `pendingRoleAdmin` = the default pubkey.
   `deploy:init` records `authorities.*` from the chain, so right after deploy `coldMultisig` is
   the deployer, as `initialize` sets it.
4. **Abort:** before step 2 the current admin runs `npm run admin:cancel-role-admin-transfer`
   (`--emit` for Squads); a wrong vault address otherwise just leaves the proposal pending.

Afterwards the deployer holds nothing on the PSM; further `set-authority` calls go through Squads.

### Program upgrades

`npm run upgrade[:devnet|:mainnet|:localnet|:devnet-fork|:mainnet-fork]` with `TARGETS=LitePsm`
(`scripts/upgrade/index.ts`; its header is the full reference).

| `MODE` | Upgrade authority | What happens |
|---|---|---|
| `direct` (default) | the wallet (`WALLET_PATH`) | buffer upload → buffer verified → `program extend` if the ELF outgrew ProgramData → `program upgrade` → checks → record |
| `propose` | `SQUADS_VAULT` | buffer upload → verified → buffer authority handed to the vault → `deployments/proposals/<network>-<stamp>.json`; the vault executes in Squads (Developers → Programs → upgrade with that buffer; spill = the wallet) |
| `verify` | — | `PROPOSAL=<file>` after the vault executed: on-chain ELF, liveness, state → record |

Before anything is uploaded the script refuses unless:

1. the deployment file, `declare_id!`, the ELF's embedded id, the IDL address, `Anchor.toml` and
   `target/deploy/lite_psm-keypair.json` all name the same program (the CLI then gets the id in
   base58 plus explicit `--keypair` / `--upgrade-authority`, never its config.yml defaults);
2. the RPC's genesis hash matches the cluster;
3. the IDL recorded for the **deployed** ELF (the deploy baseline written by `deploy:programs`, or the
   last upgrade record — bound by ELF hash; `IDL_BASELINE=<file>` otherwise) shows no account-layout
   break against the new IDL (byte offsets, discriminator, size; consuming `reserved` is fine), and
   any client-visible change (instructions, errors) is accepted with `ACCEPT_IDL_CHANGES=1` or a `yes`;
4. the live `PsmConfig` is 754 bytes, program-owned, and decodes identically under both IDLs.

Afterwards it requires the on-chain ELF to equal the build, **simulates `sync_display_multiplier`**
(an ELF compiled for another `declare_id!` uploads and hashes fine but executes nothing), diffs state
(mint/vault wiring and the config PDA's authorities must not move) and records
`deployments/<network>.json → upgrades[]` plus `deployments/idl/<network>-lite_psm-<sha>.json`.
`--dry-run` runs every check and uploads nothing. Fork networks rehearse the parent's program and
record nothing.

- **Buffers.** Keys live in `.upgrade-buffers/` (gitignored, 0600, outside `target/` so `anchor clean`
  cannot strand a funded buffer). A re-run resumes the upload; on failure the script prints the
  `solana program close <buffer>` command that recovers the rent.
- **Size growth.** A fresh deploy allocates exactly the ELF size. A larger ELF needs
  `ProgramData` extended (rent not refundable); the script prints the cost, extends in `direct`
  mode, and in `propose` mode says the vault must extend first.
- **Verifiable builds.** `npm run build:verifiable` (`anchor build --verifiable`, needs Docker),
  then `SO_PATH=target/verifiable/lite_psm.so`.

### Delegated operation vs. retained ownership (devnet/testnet)

Mainnet roles follow the Squads tiers in
[`../README.md` § RBAC](../README.md#rbac-role-based-access-control). On devnet/testnet, day-to-day
operation is often delegated to a coworker- or CI-owned key while governance retains ownership:
`grant-roles.ts --delegate=<pubkey>` moves only the 4 operational roles.

- **Operational** (delegable; allowance/cap-bounded): `direct_minter`, `direct_burner`, `rate_manager`,
  `buffer_depositor`.
- **Governance/safety** (keep): `pauser`, `unpauser`, `freezer`, `unfreezer`, `cap_manager`,
  `allowance_manager` (it caps the delegate's own roles), `buffer_withdrawer`.
- **`role_admin`** stays with the owner: unconditional claw-back of every role in one tx each. The
  **BPF upgrade authority** is a separate axis (`admin:set-upgrade-authority`) and also stays.

`grant-roles.ts` never touches the governance set or `role_admin`. **Ordering:** once `rate_manager` and
`buffer_depositor` sit with a delegate you do not hold, `npm run test:onchain` cannot run its
`streamingAccrual` and `redeem` steps — run the smoke test first, or claw the roles back.

### Orchestrator key and buffer

The v1 orchestrator holds one KMS-backed Solana keypair with `buffer_depositor`, `rate_manager`,
`direct_minter` and `direct_burner`, plus the matching EVM EOA roles
([`../README.md` § Orchestrator runbook](../README.md#orchestrator-runbook)). There is no on-chain
bridge state, nonce or refund flow.

Redemption availability is an operational property: keep `vault_usdc` topped up via `deposit_buffer`
and alert well before depletion ([`../README.md` § Monitoring SLAs](../README.md#monitoring-slas)).
An `InsufficientBuffer` revert is fixed by `deposit_buffer`; nothing is stuck.

### Admin scripts

All under `scripts/admin/`. Each prints a summary before any state change, honours `--dry-run`, and on
`mainnet-beta` / `mainnet-fork` requires `--yes-i-mean-it-on-mainnet` or an interactive `yes`.

| Script (`npm run …`) | Wraps | Role gate |
|---|---|---|
| `admin:set-authority` | `set_authority` (any role; `--role=roleAdmin` only *proposes*) | `role_admin` |
| `admin:grant-roles` (`--delegate=<pubkey>`) | `set_authority` for the 4 operational roles + resets their allowances | `role_admin` (+ `allowance_manager`, best-effort) |
| `admin:pause-psm` / `admin:unpause-psm` | `pause` / `unpause` | `pauser` / `unpauser` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` / `admin:set-direct-minter-allowance` / `admin:set-direct-burner-allowance` | `set_*_allowance` | `allowance_manager` |
| `admin:mint-oku-m` / `admin:redeem-oku-m` | `mint_oku_m` / `redeem_oku_m` (bridge-leg CLIs) | permissionless / caller |
| `admin:mint-oku-m-direct` | `mint_oku_m_direct` | `direct_minter` |
| `admin:set-yield-rate` / `admin:set-multiplier` | rate writers / `set_okum_multiplier` (emergency) | `rate_manager` |
| `admin:read-schedule` / `admin:sync-display` | read-only (exits non-zero if accrual has HALTED) / `sync_display_multiplier` | none (permissionless) |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:deposit-buffer` / `admin:withdraw-buffer` | `deposit_buffer` / `withdraw_buffer` | `buffer_depositor` / `buffer_withdrawer` |
| `admin:set-upgrade-authority` / `admin:close-programs` | `solana program set-upgrade-authority` (`--new-authority=<vault> --confirm=<vault>` / `--disable`; verifies the result on-chain) / `solana program close` (recover rent) | BPF upgrade authority |
| `admin:accept-role-admin` / `admin:cancel-role-admin-transfer` | `accept_role_admin` / `cancel_role_admin_transfer` (`--emit` prints the instruction for a Squads vault transaction) | pending `role_admin` / `role_admin` |

Mutating scripts load `deployments/<network>.json` strictly (refusing on a mismatch with
`Anchor.toml` or `target/idl`) and check the RPC's genesis hash before sending. No CLI exists for
`burn_oku_m_direct`; call it from the IDL.

---

## EVM vs SVM — divergence catalogue

SVM-specific deliberate departures from EVM; the symmetric view is in
[`../EVM/README.md`](../EVM/README.md).

### Workspace layout

| EVM file (`EVM/src/lib/`) | SVM equivalent |
|---|---|
| `Constants.sol` / `MathLib.sol` | `oku-shared/src/constants.rs` / `rate.rs` + `wad.rs` (+ `math.rs` for u64 PSM conversions) |
| `OverrideBlockGuard.sol` | `oku-shared/src/yield_lock.rs` + `lite-psm/src/helpers/yield_lock.rs` |
| `Roles.sol` / `errors/*.sol` / `events/*.sol` | `programs/lite-psm/src/{roles,errors,events}.rs` |
| `ReentrancyGuardUpgradeable.sol` | not ported: Solana forbids a program re-entering itself |

### Token model and multiplier location

EVM has two tokens (`OkuMoney` raw, `OkuDollar` rebasing wrapper); SVM has one (`OkuM`) — see § Why a
single token on SVM. On **both** stacks the canonical multiplier is *computed*, never stored (same
`rpow` over the same six fields at 1e18; `rate.rs` ports `MathLib.sol` line for line). The only
divergence is display: EVM streams through `OkuDollar.balanceOf()`; SVM keeps a lagging write-only
mirror nothing prices against.

### Pause behaviour

| Aspect | EVM | SVM |
|---|---|---|
| Pause flags | separate `OkuMoney` / `LitePSM` / `OkuDollar` pauses | one `is_paused` |
| `freeze_account` / `thaw_account` | bypass pause (freeze authority independent of `Pausable`) | bypass pause (config-PDA CPI; check intentionally omitted) |
| PSM mint / redeem, buffer deposit / withdraw | `whenNotPaused` + `whenNoOverrideThisBlock` | `Paused` + `OverrideInProgress` — **matches**; neither buffer path has a solvency check |
| OkuM peer-to-peer transfers while paused | blocked (`OkuMoney` pause) | not blocked (Token-2022 transfers bypass the program) |
| Direct burn while paused | `burn()` works | `burn_oku_m_direct` is blocked |
| Rate writes while paused | may only lower the projected curve: a yielding rate `<=` the *effective* rate and ending no later than the segment accruing now; a successor no higher / no later than the armed one; halts always pass | same, against the single flag |

### Bridging, rounding, events

EVM bridges via PSM-mediated USDC; SVM via raw `burn_oku_m_direct` / `mint_oku_m_direct` with no USDC
intermediary and no multiplier conversion; the orchestrator absorbs the asymmetry. PSM mint/redeem
round down on both stacks (a round trip loses at most 1 wei / 1 micro-USDC). PSM events have matching
shapes with minor naming differences (`BufferDeposited` ↔ `BufferDepositEvent`); schemas in
[`../EVM/src/lib/events/`](../EVM/src/lib/events) and
[`events.rs`](oku-programs/programs/lite-psm/src/events.rs).

---

## Pointers

[`../README.md`](../README.md) (orchestrator runbook, RBAC tiers, mainnet ceremony, deployment) ·
[`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md) · [`../TRACKER.md`](../TRACKER.md) (invariants, open
items) · [`../EVM/README.md`](../EVM/README.md)
