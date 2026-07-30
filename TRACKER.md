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

### Regenerate audit tool-output snapshots before handoff `[both]`

`EVM/audit/` and `SVM/oku-programs/audit/` intentionally do NOT
commit raw tool transcripts (coverage, slither/clippy, test output,
contract/program sizes) — a stale snapshot is worse than none, and
they go stale on every commit. Each audit README documents the exact
commands to regenerate them. Run all of them fresh immediately before
handing either package to an external auditor; do not commit the
output back into git (keep them local/attached-to-the-audit-request
only).

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
