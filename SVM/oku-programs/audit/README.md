# Audit Package — okuMoney SVM programs

This directory contains the pre-audit deliverables for the OkuMoney
SVM programs (`lite-psm`, `oku-dollar`). Companion to `EVM/audit/`.
Reference these files when preparing the audit scope document.

## Contents

| File | Description |
|---|---|
| `README.md` | This file. |
| `ACCEPTED_RISKS.md` | Known issues / accepted risks the auditor should NOT re-flag. |
| `clippy-checklist.md` | `cargo clippy -D warnings` output + per-finding disposition. |
| `clippy-output.txt` | Raw `cargo clippy` transcript. |
| `program-sizes.txt` | `.so` sizes for both production programs. |
| `test-output-bankrun.txt` | `npm run test:bankrun` output (128 tests). |
| `test-output-cargo.txt` | `cargo test --workspace` output (20 tests). |

## Toolchain headline

| Tool | Pin |
|---|---|
| Rust | 1.90.0 (`rust-toolchain.toml`) |
| Anchor CLI / lib | 1.0.2 / 1.0.2 (`Anchor.toml`, workspace `Cargo.toml`) |
| Solana CLI | 3.1.10 (`Anchor.toml`) |

Run `make doctor` from `audit/SVM/` to verify the installed binaries
match these pins.

## Test count headline

| Suite | Tests | Failures |
|---|---:|---:|
| Bankrun (full suite + scenarios) | 129 | 0 |
| Cargo unit tests | 20 | 0 |
| **Total** | **149** | **0** |

Bankrun added one test in the cycle-2 pass:
`set_oracle_relay_feed rejects non-default new_feed when oracleAccount
is missing` — codifies the admin-time validation gate documented under
"Audit-toolkit-pass changes" below.

Trident (cycle-3 addition): both programs now have working `#[init]`
flows. 1-minute smoke runs archived under
`audit/SVM/reports/trident/{lite-psm,oku-dollar}_20260615_phase2.txt`
show 100% Init/Setup ix success and 0 panics across ~100 k random tx
per program. The `#[end]` invariants on `oku_m_price` /
`usd_multiplier` are now firing.

Kani (cycle-3 retune): 9 / 9 SUCCESSFUL (cycle 2 had 7/9 with 2
SAT-hard timeouts). Domain bounds on the two affected harnesses were
tightened with documented complementary `cargo-fuzz` coverage of the
full u64 range.

## Static analysis headline

`cargo clippy --workspace --all-targets -- -D warnings` exits 0.

Two suppressions are applied crate-wide on both production programs
(documented inline with rationale):

- `clippy::diverging_sub_expression` — fires on Anchor's `#[program]`
  macro expansion; cannot be annotated inside generated code.
- `unexpected_cfgs` — `target_os = "solana"` cfg used by
  `solana-program-entrypoint`'s panic handler.

`cargo dylint` (Trail of Bits' solana-lints) was re-probed upstream in
cycle 3 (2026-06-15). The pin (`nightly-2025-01-09`) is unchanged from
cycle 1 and incompatible with `anchor-lang 1.0.2` (which uses
`extract_if`, stable since Rust 1.87). Per the cycle-3 plan we did
not vendor a fork; the audit Makefile's `solana-lints` target stubs
out with a deferred-status marker. See `ACCEPTED_RISKS.md § 5` for
the deferral plan and `audit/SVM/FINDINGS.md § Cycle 3 / Phase 3` for
the upstream-tracking signal.

## Program sizes headline

Both programs are within standard BPF-loader bounds:

| Program | Runtime size (B) |
|---|---:|
| `lite-psm.so` | 535,464 |
| `oku-dollar.so` | 414,912 |

(lite-psm grew +272 B from the new `OracleAccountMissing` enforcement
path on `set_oracle_relay_feed`; see "Audit-toolkit-pass changes" below.)

## Oracle relay (USDC peg circuit-breaker)

Audit-prep cycle deleted the Proof-of-Reserves plumbing
(`helpers::oracle::check_oracle_reserves`, the `oracle` /
`staleness_threshold` / `pyth_program_owner` fields on `PsmConfig`, and
the `set_oracle` / `set_pyth_program_owner` admin ix). Rationale: okuMoney
is a centralized US-regulated MSB and the operator is already responsible
for backing USDC; PoR did not detect operator-side reserve fraud, only
oracle malfunction. The replacement is a strict peg circuit-breaker.

New surface:

- `programs/lite-psm/src/helpers/oracle_relay.rs` — Pyth-V2 USDC/USD
  parser with band + status + freshness + positive-answer + owner checks.
  Normalizes `(price: i64, expo: i32)` to SVM's 1e9 precision.
- Five new fields on `PsmConfig`: `oracle_relay_feed`,
  `oracle_relay_pyth_program_owner`, `oracle_relay_staleness`,
  `oracle_relay_min_price_e9`, `oracle_relay_max_price_e9`.
- Four new `oracle_manager`-gated admin ix:
  `set_oracle_relay_feed` (also the kill switch via
  `Pubkey::default()`), `set_oracle_relay_staleness`,
  `set_oracle_relay_band`, `set_oracle_relay_pyth_program_owner`.
- Wired into `mint_oku_m`, `redeem_oku_m`, `process_queue` (lite-psm).
- Cross-program wiring into `oku_dollar::wrap` / `unwrap` lives in the
  same shape — the vault reads `PsmConfig` directly for the lock check
  and would do the same for the relay if the operator decides to require
  peg-gated wrap (kept disabled in v1 — wrap/unwrap operate on share
  accounting that doesn't directly transact USDC; gating it would only
  add latency without changing the threat).
- Shared constants in `oku-shared`:
  `ORACLE_USDC_PRICE_FLOOR = 0.95e9`, `_CEILING = 1.05e9`,
  `MAX_FEED_EXPO_MAGNITUDE = 18`. Mirror EVM (`0.95e18` / `1.05e18` /
  `MAX_FEED_DECIMALS = 18`).
- Default band: `[0.97e9, 1.03e9]` (±3%) seeded by the deploy script.
- Default staleness: `3600s`. Bounded by `[60s, 7 days]`.

PSM config seed rotated `psm_config_v2 → psm_config_v3`. Orphan-PDA
tracking in `deployments/DEPRECATED.md`. Audit risk #3 (operator-side
oracle compromise) is documented in `ACCEPTED_RISKS.md`.

## Defensive-check pass

Surveyed all defensive guards on `lite-psm` and `oku-dollar` against the
"operator-trust-only redundant" criterion used on the EVM side. Same
finding: every guard is either math sanity (e.g. `MAX_OKU_M_PRICE`
ceiling), operator-footgun protection (e.g. `BelowCurrentSupply`,
`YieldTooSmall`), or fail-loud rails for future maintainers (e.g.
`TransferHookNotAllowed`, `OkuMoneyMintMismatch`). None were stripped;
NatSpec/comments updated to drop the "defense against compromised key"
framing because operator-compromise is out of scope per the centralized
trust model documented in `SVM/README.md § Authority Model`.

One small consistency fix applied (mirrors the EVM cycle):

- `lite_psm::set_oku_m_price` and `oku_dollar::update_usd_multiplier`
  now reject equal-value writes (strict-increase). Aligns with
  `distribute_yield`'s `YieldTooSmall` so a no-op call cannot stamp the
  sandwich-lock slot without moving the multiplier.

## Yield-lock parity fix

`oku_dollar::withdraw_reserves` now calls `check_yield_lock` (PSM) and
`check_vault_yield_lock` (vault) before computing the post-withdrawal
collateral ratio. Mirrors EVM `OkuDollar.withdrawSurplus`'s
`whenYieldNotDistributing` modifier. Closes a small symmetry gap noted
in the audit-prep plan.

## Dependency pinning

- Rust toolchain: pinned in `rust-toolchain.toml` (1.90.0 as of cycle 3,
  2026-06-15; bumped from 1.85.0). `trident-tests/rust-toolchain.toml`
  pins the same version (cycle 3 collapsed the previous "stable" float).
- Anchor: `anchor_version = "1.0.2"` in `Anchor.toml`; `anchor-lang = "1.0.2"`
  in the workspace `Cargo.toml`. CLI and lib match — no build-time
  drift warning (cycle 3 closed the 1.0.0 / 1.0.2 mismatch).
- Solana: `solana_version = "3.1.10"` in `Anchor.toml`. The 4.x major
  bump is deferred post-audit (cycle 3 decision; see TRACKER).
- No `solana-sdk` direct dependency; everything pulled through Anchor.

## Audit-toolkit-pass changes (2026-06-15)

A pass with the `../audit/SVM/` toolkit (clippy + cargo-audit +
cargo-deny + cargo-geiger + cargo-fuzz + Kani; dylint deferred per
`ACCEPTED_RISKS.md § 5`) surfaced a handful of items not caught by the
prior `cargo clippy -D warnings` invocation. All addressed in this
cycle:

### Code fixes

1. **`programs/lite-psm/src/helpers/oracle_relay.rs`** — replaced
   raw arithmetic + sign-cast on the Pyth `(price, expo)` normalization
   path with `checked_add` / `unsigned_abs` / `u128::try_from(price)`.
   Five clippy errors under
   `-W clippy::arithmetic_side_effects -W clippy::cast_sign_loss`
   cleared. Behavior unchanged — the normalization is the same
   `price * 10^(expo + 9)` (or `price / 10^|expo + 9|`) computation,
   just with overflow-safe primitives so the audit-tool flags don't
   need a per-line `#[allow]`.

2. **`programs/oku-dollar/src/helpers.rs::calculate_collateral_ratio`** —
   replaced the bare `numerator / denominator` with `checked_div`. The
   `denominator > 0` invariant is asserted in the preceding lines so
   the division can never trap; `checked_div` is the documented form
   that clippy accepts.

3. **`programs/lite-psm/src/instructions/psm_admin.rs::set_oracle_relay_feed`** —
   **audit-grade gap closed**. The prior revision accepted
   `new_feed != Pubkey::default()` with `oracle_account: None` and
   silently persisted the new feed pubkey without running
   `validate_oracle_relay_feed`. An operator could stamp a malformed
   feed that would then error at every subsequent `mint` / `redeem` /
   `process_queue` call until they noticed. The handler now returns
   `OracleAccountMissing` when the account is omitted and the new feed
   is non-default; the disable path (`new_feed == Pubkey::default()`)
   still accepts a null account, matching EVM's
   `setOracleRelay(address(0))` kill-switch shape. A new bankrun test
   (`set_oracle_relay_feed rejects non-default new_feed when
   oracleAccount is missing`) codifies the gate.

4. **`tests/shared/pythFixture.ts`** — extracted the Pyth-V2
   `SolanaPriceAccount` fixture builder from `tests/bankrun/oracle-relay.ts`
   into a shared helper so `tests/bankrun/lite-psm.ts` can wire a valid
   feed for the role-gating / missing-account-at-mint tests that used
   to rely on the now-removed silent-bypass.

### Housekeeping

- Removed orphan `target/deploy/{wokusd_vault,oku_shared}-keypair.json`
  (former `wokusd_vault` program renamed to `oku_dollar` in earlier
  cycle; `oku_shared` is a library crate with no on-chain entrypoint).
- Updated `audit/SVM/Makefile` to drop the removed `oku-bridge-router`
  program from `TRIDENT_TARGETS`, `cargo-geiger`'s crate list, and
  `anchor-verify`'s program list.
- Fixed `audit/SVM/Makefile`'s `cargo-geiger` loop: each crate scan now
  runs in its own subshell (`( cd … && cargo geiger )`) so iterations
  don't share cwd.
- `trident-tests/fuzz_lite_psm/test_fuzz.rs` — rotated the hard-coded
  `psm_config_v2` PDA seed to `psm_config_v3` (cycle 2026-06-12 left
  the harness pointing at a non-existent PDA), and updated the
  `oku_m_price` byte offset for the `#[end]` invariant from `[586..594]`
  to `[634..642]` to match `PsmConfig::LEN == 674`.
- `SVM/TRACKER.md` — documented the `psm_config_v2 → psm_config_v3`
  cycle alongside the noBridge `_v1 → _v2` rotation. The other three
  SVM PDA seeds (`redemption_queue`, `oku_dollar_config`, `usd_oku_mint`)
  remain on `_v2`.
- `deny.toml` — annotated the `license-not-encountered` warnings as
  intentional headroom (Anchor/Solana SDK bumps may surface new
  licenses).
