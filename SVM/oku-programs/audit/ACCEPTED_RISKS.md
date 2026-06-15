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

## 5. `cargo dylint` (solana-lints) not re-run for this cycle

The Trail of Bits Solana lint suite is declared in `Cargo.toml` and
was run during an earlier review pass — the F-02 (`arbitrary_cpi`)
finding was triaged crate-wide via `#![allow]` annotations.

The tool is not installed on the audit-prep workstation, so it was
not re-run after the oracle-relay refactor. The only new helper
(`helpers/oracle_relay.rs`) uses the same CPI patterns as the rest
of the codebase, so the triage shouldn't change. Running the suite
is on the to-do list (`SVM/TRACKER.md § 🟡`) but is not blocking the
audit cycle.

`cargo clippy --workspace --all-targets -- -D warnings` runs clean
(see `clippy-checklist.md`).

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
