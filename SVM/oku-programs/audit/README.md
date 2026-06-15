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

## Test count headline

| Suite | Tests | Failures |
|---|---:|---:|
| Bankrun (full suite + scenarios) | 128 | 0 |
| Cargo unit tests | 20 | 0 |
| **Total** | **148** | **0** |

## Static analysis headline

`cargo clippy --workspace --all-targets -- -D warnings` exits 0.

Two suppressions are applied crate-wide on both production programs
(documented inline with rationale):

- `clippy::diverging_sub_expression` — fires on Anchor's `#[program]`
  macro expansion; cannot be annotated inside generated code.
- `unexpected_cfgs` — `target_os = "solana"` cfg used by
  `solana-program-entrypoint`'s panic handler.

`cargo dylint` (Trail of Bits' solana-lints) was not re-run for this
cycle; see `ACCEPTED_RISKS.md` for the rationale and deferral plan.

## Program sizes headline

Both programs are within standard BPF-loader bounds:

| Program | Runtime size (B) |
|---|---:|
| `lite-psm.so` | 535,192 |
| `oku-dollar.so` | 414,920 |

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

- Rust toolchain: pinned in `rust-toolchain.toml` (1.85.0).
- Anchor: `anchor_version = "1.0.0"` in `Anchor.toml`; `anchor-lang = "1.0.0"`
  in all `Cargo.toml`s (CLI is 1.0.0 / lib is 1.0.2 by transitive — flagged
  by the build warning, not actionable).
- No `solana-sdk` direct dependency; everything pulled through Anchor.
