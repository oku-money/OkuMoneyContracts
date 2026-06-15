# Accepted Risks — SVM Programs

This document lists trust assumptions and design decisions that the SVM
side of okuMoney makes deliberately. Auditors should NOT re-flag these
items; they are the considered output of design discussion documented
in `SVM/README.md` and `SVM/TRACKER.md`.

## 1. Operator-compromise is out of scope

okuMoney is a centralized US-regulated MSB. The on-chain authority
model encodes separation-of-duties within the company (see
`SVM/README.md § Authority Model`), but the threat model does NOT
include "what if the cold multisig is malicious." That scenario is
managed via off-chain controls (key custody, change-management
procedures, regulatory framework).

This affects how the auditor should interpret defensive checks. Guards
like `MAX_OKU_M_PRICE`, `MIN_COLLATERAL_RATIO_FLOOR`, and the peg-band
hard floor/ceiling are present as math-sanity bounds (keeping the
`u64 * u64 -> u128` paths in the overflow-safe region, and stopping
operator typos), not as defense against a compromised rebaser key. The
prior generation of NatSpec used "defense in depth against compromised
key" language; that language has been stripped during the audit-prep
cycle because it over-promised a guarantee the model doesn't provide.

## 2. Proof-of-Reserves was removed in favor of a USDC peg circuit-breaker

The `check_oracle_reserves` helper (Pyth-V2 custom-feed parser
publishing total reserves in OkuMoney base units) was deleted in the
audit-prep cycle. Rationale: PoR did not actually detect operator-side
reserve fraud — the operator controls the reserve attestation feed.
The replacement is a strict USDC peg circuit-breaker
(`helpers::oracle_relay::check_usdc_peg`) wrapping the live Pyth USDC/USD
feed, which defends against the one threat the trust model doesn't
cover (USDC depeg events).

This change is storage-incompatible with the `_v2` PDA layout; the
PSM config seed rotated `psm_config_v2 → psm_config_v3`. Orphan-PDA
tracking lives in `deployments/DEPRECATED.md`. The deployed testnet
PDAs are throwaway, so no migration ceremony is required.

## 3. Pyth Solana Receiver (`PriceUpdateV2`) not supported in v1

The relay parser at `helpers::oracle_relay` accepts only the legacy
Pyth V2 `SolanaPriceAccount` layout (`magic == 0xa1b2c3d4`,
`version == 2`, `atype == Price`). The modern Pyth Solana Receiver
program (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) uses a different
account layout (`PriceUpdateV2`) and is NOT parsed.

Migration hook: `set_oracle_relay_pyth_program_owner` rotates the
accepted owner pubkey. A second parser path can be added in a follow-up
upgrade when receiver-only USDC/USD feeds become the only option; for
v1, every Pyth deployment we target still publishes V2 feeds.

## 4. Queue capacity capped at 200 entries

The `RedemptionQueue` zero-copy ring buffer is sized at
`MAX_ENTRIES = 200`. Solana's `MAX_PERMITTED_DATA_INCREASE = 10,240`
bytes per single-CPI allocation caps the largest single-step
`init` to ~9.6 KB of array data. The spec target was 500; reaching it
would require a multi-step `init + 2× realloc` deploy flow OR per-user
PDAs.

The 200-entry cap with `MAX_BATCH_ENTRIES = 50` per `process_queue` tx
is sufficient for launch SLA. Defer the 500 upgrade until telemetry
shows operators repeatedly hitting `QueueFull`.

## 5. `cargo dylint` (solana-lints) deferred — upstream incompatibility

The Trail of Bits Solana lint suite is declared in `Cargo.toml` and
was run during an earlier review pass. F-02 (`arbitrary_cpi`),
F-03 (`type_cosplay`), and F-04 (`sysvar_get`) were triaged crate-wide
via `#![allow]` annotations with documented rationale.

Cycle 3 (2026-06-15) re-probed upstream
(`https://github.com/crytic/solana-lints`). The repository's
`rust-toolchain` is still pinned to `nightly-2025-01-09`, the same
pin from cycle 1. Recent commits (most recent 2025-05-15) are all
dependabot bumps for ancillary deps (tempfile / toml / assert_cmd) —
no `clippy_utils` or nightly-toolchain bumps in 2025-H2 or 2026-H1.
Anchor 1.0.2's proc-macros use `extract_if` (stabilized in Rust
1.87), which is unavailable on that nightly. Running `cargo dylint`
against the current workspace fails at the proc-macro derive stage.

Per the cycle-3 plan we deliberately did **not** vendor a fork of
`crytic/solana-lints`. The audit Makefile's `solana-lints` target
now stubs out with a deferred-status marker and writes a marker
file under `reports/solana-lints/`. The original invocation is
preserved in a commented-out block adjacent to the target for
one-line re-enable when upstream bumps.

The only post-cycle-1 surface change (`helpers/oracle_relay.rs` +
the four `set_oracle_relay_*` admin ix from cycle 2) uses the same
CPI / owner-check / Pyth-V2 parser patterns that the cycle-1 dylint
pass already triaged. The triage doesn't change.

**Tracking signal**: watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx` (the first nightly
to ship `extract_if`-compatible `clippy_utils`). Re-enable is ~½
day once that lands.

`cargo clippy --workspace --all-targets -- -D warnings` and the
strict variant (with `-W arithmetic_side_effects -W cast_sign_loss`)
both exit 0 on Rust 1.90.0 (see `clippy-checklist.md`).

## 6. `cargo fmt --check` and `cargo deny check` not wired into CI

Both tools are configured (`deny.toml` exists; rustfmt config exists)
but not yet invoked by `.github/workflows/test.yml`. Documented as a
post-launch follow-up in `SVM/TRACKER.md § ⚪`. Manual runs are
expected to be clean.

## 7. SVM ↔ EVM constant parity carries the 1e9 vs 1e18 scaling delta

SVM uses `PRECISION = 1e9` because OkuMoney/USDC/OkuDollar are
6-decimal on Solana vs 18-decimal on EVM. Every numeric constant has
its SVM-scaled counterpart (`ORACLE_USDC_PRICE_FLOOR = 0.95e9` vs
`0.95e18` on EVM, etc.). The off-chain orchestrator handles the scale
conversion when reflecting value across the EVM ↔ SVM boundary. See
`EVM_VS_SVM.md § Token model and precision`.

## 8. `peg-check on wrap/unwrap` deferred

The vault's `wrap`/`unwrap` instructions DO read PSM state
(`oku_m_price`, `check_yield_lock`) but currently do NOT call
`check_usdc_peg`. Rationale: `wrap`/`unwrap` move OkuMoney shares
in and out of usdOku — neither side touches USDC directly. The peg
circuit-breaker exists to prevent USDC value bleed; gating
wrap/unwrap on it would only add latency without changing the
threat. PSM-side mint/redeem are the relevant entry points and ARE
gated.

If a future product change makes vault operations USDC-flow-sensitive
(e.g. a direct USDC↔usdOku route), the peg check should be added on
the new path. Tracked under "Potentially redundant / unused functions"
in `SVM/TRACKER.md`.
