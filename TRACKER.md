# okuMoney Contracts Tracker

Open issues + follow-ups for the okuMoney on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file. Resolved items are removed;
full history lives in git + in the per-chain audit READMEs below.

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

The goal is to clear every item before audit. This file should be
removable post-launch.

---

## 🟡 Should-fix before external audit

### SVM program upgrade not yet deployed for the M-1/M-2/L-3 fixes `[SVM]`

2026-08-05: the source fixes for three previously-tracked findings
(M-1, M-2, L-3 from the pre-audit review pass) were implemented,
tested, and merged, but **the SVM program has not been redeployed**
to any cluster (devnet or mainnet-beta) — this pass was scoped to
code + tests only:

- **`initialize` zero-pubkey / role_admin-collapse validation**
  (`instructions/init.rs`) — the 9 granular authorities are now
  validated against `Pubkey::default()` and against collapsing into
  `role_admin`, mirroring `set_authority`'s existing guards. Tests:
  `tests/bankrun/init-invariants.ts` § "authority validation" (4 new
  cases).
- **`deposit_buffer` yield-lock + pause guard**
  (`instructions/psm.rs`) — now calls `check_yield_lock` and rejects
  while paused, for symmetry with every other value-moving
  instruction. Tests: `tests/bankrun/lite-psm.ts` § "orchestrator role
  separation" (2 new cases, incl. an isolated-harness same-slot
  check).
- **f64 multiplier round-trip made explicit**
  (`helpers/scaled_ui.rs`) — the `u64 -> f64 -> u64` cast is now a
  pure `multiplier_f64_to_u64` helper backed by a compile-time
  `MAX_MULTIPLIER < 2^52` assertion and 4 Rust unit tests proving the
  round-trip identity across the full supported range.

Verified: `cargo build`/`cargo test --workspace` (20 tests, incl. the
new ones) and `anchor build` + the full bankrun suite (91 tests, incl.
the 6 new cases) all green with no regressions; `cargo fmt`/`clippy`
clean on the changed lines.

**Follow-up required before this can be closed:** deploy the rebuilt
program to devnet, re-verify with the bankrun/devnet suites, then to
mainnet-beta following the same testnet-then-mainnet posture used for
the EVM redeploy. The SVM audit-snapshot regen (next item) must run
**after** that upgrade, not before, or the snapshot captures stale
bytecode.

### Regenerate audit tool-output snapshots before handoff `[both]`

`EVM/audit/` and `SVM/oku-programs/audit/` intentionally do NOT
commit raw tool transcripts (coverage, slither/clippy, test output,
contract/program sizes) — a stale snapshot is worse than none, and
they go stale on every commit. Each audit README documents the exact
commands to regenerate them. Run all of them fresh immediately before
handing either package to an external auditor; do not commit the
output back into git (keep them local/attached-to-the-audit-request
only). **SVM:** wait for the program-upgrade follow-up above to land
first.

### `cargo dylint` (crytic/solana-lints) — upstream-blocked `[SVM]`

Tracking signal: watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx` (the first nightly
to ship `extract_if`-compatible `clippy_utils`). Upstream is
currently pinned at `nightly-2025-01-09` (regressed from the channel
we were tracking). Re-enable is ~½ day once a newer nightly lands.

The earlier review-pass findings (F-02 `arbitrary_cpi`, F-04 sysvar
usage) remain triaged via crate-wide `#![allow]` suppressions plus
inline comments. F-03 (manual byte parsing in the oracle helper) is
moot — the oracle helper was removed entirely along with the rest of
the SVM oracle infrastructure. **Not actionable until upstream
moves**; tracked here so it re-enters the queue automatically once
the upstream pin advances.

---

## ⚪ Post-launch / low priority

### `RedemptionQueue.QueueEntry` storage packing `[EVM]`

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 okuMAmount` (~7.9e28 max — large
enough for any realistic OkuM amount given `MAX_MULTIPLIER` and
`maxSupply`) + `uint48 timestamp` would pack into two slots.

**Caution:** storage-layout change on a UUPS proxy. Only do this
in a v2 upgrade with a careful migration. Defer to v2.

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Dead orphan PDAs from prior seed rotations `[SVM]`

Pre-rotation PDAs (and the deleted `oku-dollar` program's PDAs) are
orphaned because their `owner` field still references an old program
ID, but nothing derives those addresses anymore. Not material;
tracked for completeness. A future one-shot
`admin_close_legacy_pda(seed_str)` ix gated by `role_admin` could
recover the rent. Full rotation history is in `git log` for
`SVM/oku-programs/programs/lite-psm/src/state.rs`.

### Two-chain Foundry invariant harness `[EVM]`

Extend the existing `LitePSMHandler` / `OkuDollarHandler` stateful-fuzz
harness to model a second simultaneous `chainB` LitePSM and randomly
bridge between them. Surfaces cross-chain accounting bugs that
scripted scenarios miss.

**Effort:** 1–2 weeks.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

**Effort:** 2–3 weeks.

### Audit-attention surfaces flagged in final pre-review pass `[both]`

Informational only — no functional issue, just where reviewer time
will concentrate and where small refactors would reduce copy-paste
risk:

- **SVM manual Token-2022 mint construction in `initialize`**
  (`init.rs:103-198`) is the highest-complexity code in the crate:
  extension-length math, a two-step `CreateAccount`, and four raw
  `invoke`/`invoke_signed` calls. Correct and well-commented as
  written; flagged for focused audit attention rather than as a
  defect. Related nit: the "OkuDollar"/"usdOku" brand strings are
  duplicated as literals in both the `TokenMetadata` struct
  (`init.rs:78-79`) and the metadata-init CPI (`init.rs:189-190`) —
  a single source-of-truth constant would remove the risk of the two
  drifting apart on a rename.
- **SVM repeated inline PDA-signer construction.** The
  `let seeds = &[PsmConfig::SEED, &[bump]]; let signer = &[&seeds[..]];`
  pattern is copy-pasted across ~6 handlers (`psm.rs:84,201,279`;
  `psm_admin.rs:137,164`; `direct_mint.rs:67`; `init.rs:179`;
  `yield_ops.rs:45`). A `config.signer_seeds()` helper would cut the
  duplication and the chance of a bump mismatch on a future edit.
- **SVM overloaded error variants.** `OutputBelowMinimum` covers both
  the zero-output guard (`psm.rs:163`) and the slippage check
  (`psm.rs:166`) — two semantically distinct failures collapsed into
  one error. `MultiplierReadFailed` (`errors.rs:110-112`) similarly
  covers unpack failure, missing extension, and out-of-range value.
  Splitting would aid debugging; low priority given the
  centralized-trust model.
- **EVM `LitePSM._redeemOkuMShared`** (`LitePSM.sol:257-316`) is the
  densest control flow in the EVM suite — a single function serving
  4 call shapes via a `bool okuMAtPsm` flag that toggles both the
  token-pull and the event emission. Logic is correct and commented;
  flagged as where auditor review time will concentrate, not as a
  defect.

### Operator CLI gaps `[both]`

Still missing CLIs — defer until post-audit when the function
kill-list is finalised:

**EVM:**

- `setNextUsdYieldRate` — schedules a future rate; `setUsdYieldRate`
  covers the immediate-effect case. Add only if the schedule-ahead
  flow becomes part of the runbook.

**SVM:**

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the
  two-step `role_admin` transfer's second step happens once per
  rotation by the cold multisig via Squads; a documented IDL call in
  the runbook is sufficient. Build CLIs only if the runbook requires
  them.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, coverage notes)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence)
- [`EVM/audit/README.md`](EVM/audit/README.md) — accepted risks + slither triage
- [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md) — accepted risks + clippy triage
