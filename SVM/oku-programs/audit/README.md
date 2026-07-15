# Audit Package — okuMoney SVM Programs

Pre-audit deliverables for the OkuMoney SVM program (`lite-psm`).
Companion to `../../../EVM/audit/`. Post-Tier-A baseline
(2026-06-23).

## Contents

| File | Description |
|---|---|
| `README.md` | This file — accepted risks, clippy triage, tool snapshots. |
| `clippy-output.txt` | Raw `cargo clippy` transcript. |
| `coverage-summary.txt` | `cargo llvm-cov` summary for the `oku-shared` workspace crate. |
| `program-sizes.txt` | `.so` size for the production program. |
| `test-output-bankrun.txt` | `npm run test:bankrun` output. |
| `test-output-cargo.txt` | `cargo test --workspace --lib` output. |

## Toolchain headline

| Tool | Pin |
|---|---|
| Rust | 1.90.0 (`rust-toolchain.toml`) |
| Anchor CLI / lib | 1.0.2 / 1.0.2 (`Anchor.toml`, workspace `Cargo.toml`) |
| Solana CLI | 3.1.10 (`Anchor.toml`) |

Run `make doctor` from `../../../../audit/SVM/` to verify the
installed binaries match these pins.

## Test count headline (post-single-token refactor)

| Suite | Tests | Failures |
|---|---:|---:|
| Bankrun | 105 | 0 |
| Cargo unit | 15 | 0 |
| **Total** | **120** | **0** |

Test deltas vs. cycle-4 baseline (174 → 120, −54): the single-token
refactor deleted `oku-dollar` and its vault/wrap/unwrap test suites,
removed vault-math unit tests, and added ScaledUiAmount extension
tests for the new single-token usdOku design.

Kani (cycle 4): **13 / 13 SUCCESSFUL** (4 vault-math proofs removed
with the oku-dollar program deletion).

cargo-fuzz (cycle 4): **5 targets** (`mul_div_floor`, `mul_div_ceil`,
`oku_m_to_dollars`, `dollars_to_oku_m`, `calculate_fee`);
`vault_share_round_trip` and `collateral_ratio` removed with vault
deletion. 0 crashes.

## Coverage headline

`cargo llvm-cov` on the `oku-shared` workspace crate (pure-Rust
math + yield-lock):

| Metric | Value | Target |
|---|---:|---:|
| Lines | 97.47 % | ≥ 90 % ✓ |
| Functions | 97.37 % | ≥ 90 % ✓ |
| Regions | 94.93 % | ≥ 90 % ✓ |

CI gates `cargo llvm-cov --package oku-shared --lib` at ≥ 90 %
line coverage (see `.github/workflows/test.yml`). The Anchor
program crate (`lite-psm`) is exercised through the bankrun
integration suite rather than `--lib`-style unit tests; its
coverage is captured by the bankrun suite itself.

## Static analysis headline

`cargo clippy --workspace --all-targets -- -D warnings` exits 0.
Strict invocation in `audit/SVM/Makefile` (with `-W
clippy::arithmetic_side_effects -W clippy::cast_*` family) also
exits 0 on Rust 1.90.0.

Three suppressions applied crate-wide on the production program,
documented inline with rationale:

- `clippy::diverging_sub_expression` — fires on Anchor's `#[program]`
  macro expansion; cannot be annotated inside generated code.
- `unexpected_cfgs` — `target_os = "solana"` cfg used by
  `solana-program-entrypoint`'s panic handler.
- `clippy::arbitrary_cpi` — every CPI target is constrained by
  Anchor's typed `Program<'info, T>` accounts; the lint fires because
  the program ID is obtained at runtime from a typed account field
  rather than a hardcoded literal.

`cargo dylint` (Trail of Bits `solana-lints`) re-probed
2026-06-23. The upstream pin (`nightly-2025-01-09`) is unchanged
since cycle 1 and incompatible with `anchor-lang 1.0.2`. Currently
deferred — see Accepted Risk § 4.

`cargo fmt --check` and `cargo deny check` are wired into CI
(`.github/workflows/test.yml`). Both exit clean on the current
workspace. `cargo deny` ignores two transitive advisories from
Anchor/Solana SDK deps (bincode 1.3.3 unmaintained, rand 0.8.5
unsoundness conditions unreachable on-chain) — documented in
`../deny.toml`.

## Program sizes headline

Program within standard BPF-loader bounds (post-single-token refactor):

| Program | Runtime size (B) |
|---|---:|
| `lite-psm.so` | 608,024 |

## Dependency pinning

- **Rust toolchain:** 1.90.0 (collapsed across `programs/` + `trident-tests/` in cycle 3).
- **Anchor:** `anchor_version = "1.0.2"` in `Anchor.toml`; `anchor-lang = "1.0.2"` in workspace `Cargo.toml`. No build-time drift warning.
- **Solana:** `solana_version = "3.1.10"`. 4.x major bump deferred post-audit.
- No `solana-sdk` direct dependency; everything pulled through Anchor.

---

# Accepted Risks — SVM Programs

This document lists trust assumptions and design decisions that the
SVM side of okuMoney makes deliberately. Auditors should NOT re-flag
these; they are the considered output of design discussion.

## 1. Operator-compromise is out of scope

okuMoney is a centralized US-regulated MSB. The on-chain authority
model encodes separation-of-duties within the company (see
[`../README.md § Authority model`](../README.md)), but the threat
model does NOT include "what if the cold multisig is malicious."
That scenario is managed via off-chain controls (key custody,
change-management procedures, regulatory framework).

This affects how the auditor should interpret defensive checks.
Guards like `MAX_MULTIPLIER` and the peg-band hard floor/ceiling
are present as math-sanity bounds (keeping the `u64 * u64 -> u128`
paths in the overflow-safe region, and stopping operator typos),
not as defense against a compromised rebaser key. Comments have
been stripped of the "defense in depth against compromised key"
language because it over-promised a guarantee the model doesn't
provide.

## 2. Proof-of-Reserves and oracle relay removed

The `check_oracle_reserves` helper and the `oracle_relay` module
were deleted in the single-token refactor. The PoR feed did not
detect operator-side reserve fraud (the operator controls the feed),
and the USDC peg circuit-breaker (`check_usdc_peg`) was removed
along with the oracle infrastructure. v1 relies on off-chain
monitoring for USDC depeg events; on-chain oracle integration is
deferred to a future upgrade.

## 3. Queue capacity capped at 200 entries (was §4)

The `RedemptionQueue` zero-copy ring is sized at `MAX_ENTRIES = 200`.
Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240` bytes per single-CPI
allocation caps the largest single-step `init` to ~9.6 KB of array
data. The spec target was 500; reaching it would require a
multi-step `init + 2× realloc` deploy flow OR per-user PDAs.

The 200-entry cap with `MAX_BATCH_ENTRIES = 50` per `process_queue`
tx is sufficient for launch SLA. Cycle 4 added permissionless
`user_self_rescue_queue_entry` (PSM-06) so a frozen / wrong-owner
ATA at the queue head no longer DoSes downstream entries — the
affected user can self-unblock from a thawed ATA. Defer the 500
upgrade until telemetry shows operators repeatedly hitting
`QueueFull`.

## 4. `cargo dylint` (solana-lints) deferred — upstream incompatibility

The Trail of Bits Solana lint suite is declared in `Cargo.toml` and
was run during an earlier review pass. F-02 (`arbitrary_cpi`), F-03
(`type_cosplay`), and F-04 (`sysvar_get`) were triaged crate-wide
via `#![allow]` annotations with documented rationale.

The upstream `https://github.com/crytic/solana-lints` repository's
`rust-toolchain` remains pinned to `nightly-2025-01-09`
(re-checked 2026-06-23). Anchor 1.0.2's proc-macros use
`extract_if` (stabilized in Rust 1.87), which is unavailable on
that nightly. Running `cargo dylint` against the current workspace
fails at the proc-macro derive stage.

We deliberately did **not** vendor a fork. The audit Makefile's
`solana-lints` target stubs out with a deferred-status marker. The
original invocation is preserved in a commented-out block adjacent
to the target for one-line re-enable when upstream bumps.

**Tracking signal:** watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx` (first nightly to ship
`extract_if`-compatible `clippy_utils`). Re-enable is ~½ day once
that lands. **Not actionable until upstream moves.**

## 5. SVM ↔ EVM constant parity carries the 1e9 vs 1e18 scaling delta

SVM uses `PRECISION = 1e9` for the structural reason that `u64`
token amounts × `1e9` precision peak around `1.8e28`, comfortably
within `u128::MAX`. A `1e18` precision would require either `u128`
token amounts (no SPL Token-2022 support) or aggressive precision
loss on every operation. Every numeric constant has its SVM-scaled
counterpart (`ORACLE_USDC_PRICE_FLOOR = 0.95e9` vs `0.95e18` on
EVM, etc.). The off-chain orchestrator handles the scale conversion
when reflecting value across the EVM ↔ SVM boundary. See
[`../crates/oku-shared/src/constants.rs`](../crates/oku-shared/src/constants.rs)
for the SVM-side constants and the EVM mirror in
[`../../../EVM/src/lib/Constants.sol`](../../../EVM/src/lib/Constants.sol).

## 6. Cycle-4 IDL break — `InitializeParams` struct

Cycle 4 (PSM-17) collapsed the lite-psm `initialize` instruction's
15 positional pubkey args into a single `InitializeParams` borsh
struct. This is a wire-format break for any TS client compiled
against the cycle-3 IDL. Accepted pre-audit because the IDL break
significantly improves audit readability (every field is named, not
positional). All test fixtures + the deploy script were updated in
the same cycle.

---

# Clippy findings — pre-audit triage

Tool: `cargo clippy --workspace --all-targets -- -D warnings`.
Toolchain: Rust **1.90.0** (cycle-3 bump).
Result: **0 errors, 0 warnings**.

The audit toolkit also runs the stricter:

```bash
cargo clippy --workspace --all-features -- -D warnings -D clippy::all \
  -W clippy::arithmetic_side_effects \
  -W clippy::cast_possible_truncation \
  -W clippy::cast_sign_loss \
  -W clippy::cast_possible_wrap \
  -W clippy::checked_conversions
```

invocation defined in `../../../../audit/SVM/Makefile`. Result: **0
errors, 0 warnings** as of cycle 4 (no new lints surfaced from the
cycle-3 toolchain bump nor the cycle-4 contract changes).

## Resolved findings (historical, kept for reference)

| Lint | Location | Disposition |
|---|---|---|
| `clippy::arithmetic_side_effects` | `lite_psm::helpers::oracle_relay::get_usdc_price` (`expo + precision_exp`, `(-shift) as u32`) | Fixed — `expo.checked_add(PRECISION_EXP)` + `shift.unsigned_abs()`. (Oracle relay since removed.) |
| `clippy::cast_sign_loss` | `lite_psm::helpers::oracle_relay::get_usdc_price` (`price as u128`, `shift as u32`, `(-shift) as u32`) | Fixed — `u128::try_from(price)` (sign-safe after `price > 0` assertion) + `shift.unsigned_abs()`. (Oracle relay since removed.) |

## Crate-wide suppressions (documented inline)

| Lint | Suppression scope | Rationale |
|---|---|---|
| `clippy::diverging_sub_expression` | `lite-psm` | Fires on Anchor's `#[program]` macro expansion. Cannot be annotated inside generated code. |
| `unexpected_cfgs` | `lite-psm` | `target_os = "solana"` cfg emitted by `solana-program-entrypoint`'s panic-handler macro. The check-cfg machinery doesn't know about the BPF target. |
| `clippy::arbitrary_cpi` | `lite-psm` | F-02 disposition. Every CPI target is constrained by Anchor's typed `Program<'info, T>` account system; the lint fires because the program ID is obtained at runtime from a typed account field rather than a hardcoded literal. |

Cycle 4 dropped the `clippy::too_many_arguments` crate-wide
suppression — the only fn that triggered it (`initialize`) collapsed
its signature into `InitializeParams`.

---

## Pointers

- **SVM-specific docs:** [`../README.md`](../README.md) (programs, design choices, deployment, runbook, EVM divergence)
- **Workspace overview:** [`../../../README.md`](../../../README.md)
- **Open issues:** [`../../../TRACKER.md`](../../../TRACKER.md)
- **EVM in-repo audit:** [`../../../EVM/audit/README.md`](../../../EVM/audit/README.md)
