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

## Audit-prep cycle (2026-06-18 → 2026-06-23) — landed

### EVM

- EVM-A1: `OKUM_BURNER` wired into deploy + grant scripts (was missing → fresh deploys would have bricked redeem).
- EVM-D5/E5: `whenNotPaused` on `setOkuMMultiplier` + `distributeYield` (yield state-effects now freeze with the rest of the contract).
- 4 new operator CLIs: `blacklistBoth.ts`, `setMaxSupply.ts`, `setUsdYieldRate.ts`, `setMinCollateralRatio.ts`.
- Polish: `OkuDollar.unwrap` receiver-blacklist check (D2), `InvalidOracleResponse` split into `OracleUpdatedAtZero` + `OracleStartedAtInvalid` (F3), `OracleRelayDisabled` event gated on `oldRelay != 0` (B3), deploy script reordered to fail-fast on USDC mismatch (J3), post-deploy oracle-relay parity assertion (J4).
- Surface pruning (Tier A): removed `LitePSM.redeemOkuMWithPermit` / `redeemUsdOkuWithPermit` (permit + redeem composable client-side); removed `OkuDollar.getStatus` + `OkuDollarStatus` struct (off-chain bundle of fields already individually exposed); removed `RedemptionQueue.assertUsdcMatch` + `UsdcMismatch` error (hoisted into the deploy script as an inline check).
- CI: TypeScript type-check (`npm run typecheck`) wired into CI as the EVM-side analog of `cargo fmt`/`cargo deny`. Pre-existing TS drift cleared.
- Coverage: `_compoundFor` saturation @ `MAX_MULTIPLIER`, `LitePSM` USDC-balance invariant, `OkuDollar.unwrap` receiver-blacklist test. `forge test` 592/592. `forge coverage` gated at 95% line coverage per src/ file.

### SVM

- 4 new admin CLIs: `pause-vault.ts`, `unpause-vault.ts`, `set-vault-authority.ts`, `set-min-collateral-ratio.ts`. *(Subsequently deleted in the single-token refactor — vault program removed.)*
- 2 standalone orchestrator bridge-leg CLIs: `mint-okum.ts`, `redeem-okum.ts` (previously only reachable via `test-devnet.ts` step runner).
- L1/L2 SoD parity: vault `set_authority` now mirrors PSM-02 — rejects collapsing non-RoleAdmin roles into `role_admin` and rejects no-op self-proposals. *(Vault program subsequently removed in the single-token refactor; parity logic lives only in lite-psm now.)*
- Dead code purge: 4 unused error variants removed (`AccountFrozen`, `RecipientMismatch`, `TransferHookNotAllowed` from PSM; `InvalidDeadSharesMint` from vault) + `_RingQueue` re-export shim deleted.
- Polish: `OracleRelayDisabled` event gated on `oldRelay != 0`, `withdraw_buffer` pause-bypass intent documented in source, `ImmutableOwner` allow-list rationale added.
- CI hardening: `cargo fmt --check`, `cargo deny check`, and `cargo llvm-cov` (oku-shared gated at 90% line coverage) wired into `.github/workflows/test.yml`. Repo-wide cargo fmt pass cleared all pre-existing drift.
- Trident harness: `.insert(None)` → `.get()` conversion for canonical addresses (config / mints / vault / queue) stashed in `#[init]`. Harness now compiles cleanly against current IDL and is regression-gated in CI via `cargo check --all-targets`. Full `trident fuzz run` left out of CI (heavy toolchain + multi-minute runtime); the smoke compile catches harness drift.
- Coverage: 4 bankrun tests for `user_self_rescue_queue_entry` (cycle-4 instruction, previously uncovered); 5 bankrun tests for vault `set_authority` + two-step `accept_role_admin` + L1/L2 guards. `npm test` 138/138.

---

## 🟡 Should-fix before external audit

### `cargo dylint` (crytic/solana-lints) — upstream-blocked `[SVM]`

Tracking signal: watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx` (the first nightly
to ship `extract_if`-compatible `clippy_utils`). Upstream is
currently pinned at `nightly-2025-01-09` (regressed from the channel
we were tracking). Re-enable is ~½ day once a newer nightly lands.

The earlier review-pass findings (F-02 `arbitrary_cpi`, F-04 sysvar
usage) remain triaged via crate-wide `#![allow]` suppressions plus
inline comments. Cycle-4 contract changes use the same patterns those
suppressions already cover. F-03 (manual byte parsing in the oracle
helper) is moot — the oracle helper was removed entirely along with
the rest of the SVM oracle infrastructure. **Not actionable until
upstream moves**; tracked here so it re-enters the queue automatically
once the upstream pin advances.

---

## ⚪ Post-launch / low priority

### `RedemptionQueue.QueueEntry` storage packing `[EVM]`

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 okuMAmount` (~7.9e28 max — large
enough for any realistic OkuM amount given `MAX_MULTIPLIER` and
`maxSupply`) + `uint48 timestamp` would pack into two slots.

**Caution:** storage-layout change on a UUPS proxy. Only do this
in a v2 upgrade with a careful migration. Defer to v2.

### ~~oku-dollar reserved storage padding `[SVM]`~~ — CANCELLED

~~Account size is pinned at 362 bytes by `const _: () = assert!(...)`.
Any new field requires a seed rotation and migration. Standard
pattern in mature Solana programs is to reserve a `_reserved: [u8; N]`
tail. Weigh against the cost of the next rotation.~~

*Removed: the `oku-dollar` program was deleted in the single-token
refactor. No longer applicable.*

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Dead orphan PDAs from cycle-2 + cycle-3 + single-token-refactor + queue-removal seed rotations `[SVM]`

Pre-rotation PDAs are orphaned because their `owner` field still
references the same program ID, but the program no longer derives
those addresses. The single-token refactor added further orphans:
`psm_config_v4` seed (superseded by v5), plus all `oku-dollar`
program PDAs (program deleted) and the `redemption_queue_v3` PDA
(the redemption queue account was removed entirely in a follow-up
rotation to `psm_config_v6` — there is no longer any queue seed to
derive). Not material; tracked for completeness. A future one-shot
`admin_close_legacy_pda(seed_str)` ix gated by `role_admin` could
recover the rent. Details in
[`SVM/README.md § PDA seed history`](SVM/README.md).

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

### Operator CLI gaps (post-audit triage) `[both]`

Still missing CLIs — defer until post-audit when the function
kill-list is finalised:

**EVM:**

- `setNextUsdYieldRate` — schedules a future rate; `setUsdYieldRate`
  covers the immediate-effect case. Add only if the schedule-ahead
  flow becomes part of the runbook.

**SVM:**

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — lite-psm
  only (vault program removed in single-token refactor). The two-step
  transfer's second step happens once per rotation by the cold multisig
  via Squads; a documented IDL call in the runbook is sufficient. Build
  CLIs only if the runbook requires them.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, coverage notes)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence)
- [`EVM/audit/README.md`](EVM/audit/README.md) — accepted risks + slither triage + tool snapshots
- [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md) — accepted risks + clippy triage
