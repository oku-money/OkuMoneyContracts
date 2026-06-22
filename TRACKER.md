# okuMoney Contracts Tracker

Open issues + follow-ups for the okuMoney on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file. Resolved items are removed;
full history lives in git + [`../audit/README.md`](../audit/README.md).

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

The goal is to clear every item before audit. This file should be
removable post-launch.

---

## Audit-prep cycle (2026-06-18) — landed

### EVM

- EVM-A1: `OKUM_BURNER` wired into deploy + grant scripts (was missing → fresh deploys would have bricked redeem).
- EVM-D5/E5: `whenNotPaused` on `setOkuMMultiplier` + `distributeYield` (yield state-effects now freeze with the rest of the contract).
- 4 new operator CLIs: `blacklistBoth.ts`, `setMaxSupply.ts`, `setUsdYieldRate.ts`, `setMinCollateralRatio.ts`.
- Polish: `OkuDollar.unwrap` receiver-blacklist check (D2), `InvalidOracleResponse` split into `OracleUpdatedAtZero` + `OracleStartedAtInvalid` (F3), `OracleRelayDisabled` event gated on `oldRelay != 0` (B3), deploy script reordered to fail-fast on USDC mismatch (J3), post-deploy oracle-relay parity assertion (J4).
- Surface pruning (Tier A): removed `LitePSM.redeemOkuMWithPermit` / `redeemUsdOkuWithPermit` (permit + redeem composable client-side); removed `OkuDollar.getStatus` + `OkuDollarStatus` struct (off-chain bundle of fields already individually exposed); removed `RedemptionQueue.assertUsdcMatch` + `UsdcMismatch` error (hoisted into the deploy script as an inline check).
- Coverage: `_compoundFor` saturation @ `MAX_MULTIPLIER`, `LitePSM` USDC-balance invariant, `OkuDollar.unwrap` receiver-blacklist test. `forge test` 592/592.

### SVM

- 4 new admin CLIs: `pause-vault.ts`, `unpause-vault.ts`, `set-vault-authority.ts`, `set-min-collateral-ratio.ts`.
- 2 standalone orchestrator bridge-leg CLIs: `mint-okum.ts`, `redeem-okum.ts` (previously only reachable via `test-devnet.ts` step runner).
- L1/L2 SoD parity: vault `set_authority` now mirrors PSM-02 — rejects collapsing non-RoleAdmin roles into `role_admin` and rejects no-op self-proposals.
- Dead code purge: 4 unused error variants removed (`AccountFrozen`, `RecipientMismatch`, `TransferHookNotAllowed` from PSM; `InvalidDeadSharesMint` from vault) + `_RingQueue` re-export shim deleted.
- Polish: `OracleRelayDisabled` event gated on `oldRelay != 0`, `withdraw_buffer` pause-bypass intent documented in source, `ImmutableOwner` allow-list rationale added.
- Coverage: 4 bankrun tests for `user_self_rescue_queue_entry` (cycle-4 instruction, previously uncovered); 5 bankrun tests for vault `set_authority` + two-step `accept_role_admin` + L1/L2 guards. `npm test` 138/138.

---

## 🟡 Should-fix before external audit

### `cargo dylint` (crytic/solana-lints) — deferred `[SVM]`

Tracking signal: watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx` (the first nightly
to ship `extract_if`-compatible `clippy_utils`). Re-enable is ~½ day
once that lands.

The earlier review-pass findings (F-02 `arbitrary_cpi`, F-03 manual
byte parsing in oracle helpers, F-04 sysvar usage) remain triaged via
crate-wide `#![allow]` suppressions plus inline comments. Cycle-4
contract changes use the same patterns those suppressions already
cover.

### Trident `#[init]` follow-ons (post-audit) `[SVM]`

Wire dead-shares pre-seed via `set_account_custom`, convert
flows from `.insert()` to `.get()` so they reuse canonical
mint / vault addresses for higher `Ix Success` rates. Add a CI
smoke run: `trident fuzz run fuzz_lite_psm --max-iterations 1000`.

**Effort:** 1–2 days.

### `cargo fmt --check` / `cargo deny check` in CI `[SVM]`

Both exist in the repo but are not wired into
`.github/workflows/test.yml`. `cargo fmt` needs one pass to clean up
any drift; `deny.toml` already exists for `cargo deny`.

**Effort:** 30 min each.

### Lint parity for EVM-side TypeScript `[EVM]`

SVM ships `cargo fmt` / `cargo deny` style checks; EVM-side
TypeScript linting is currently ESLint-only. Worth aligning so
`npm run lint` covers both.

### Coverage reporting `[both]`

`forge coverage --report lcov` (upload to Codecov) and
`cargo llvm-cov` — not produced or uploaded. Useful for surfacing
uncovered branches before audit.

**Effort:** 1 hour to wire.

---

## ⚪ Post-launch / low priority

### `OracleRelay` UUPS overhead `[EVM]`

The relay holds 5 storage fields (feed, staleness, min/max band,
cached feed decimals) and a small read-only consumer surface. The
only mutable state is operator-set config, rotated via existing
`RELAY_FEED_MANAGER` / `RELAY_CONFIG_MANAGER` setters — not via a
logic upgrade. Operator-side kill switch lives on the consumer
(`setOracleRelay(address(0))` on `LitePSM` and `RedemptionQueue`),
so even bricking the relay implementation is recoverable without a
UUPS upgrade.

**Recommendation (follow-up cycle):** drop the UUPS scaffolding
(`UUPSUpgradeable` import, `_authorizeUpgrade`, `RELAY_UPGRADER`
role, `__disableInitializers` constructor pattern) and ship
`OracleRelay` as a plain stateful contract that operators redeploy
on rotation. Saves audit surface area and matches the SVM mirror,
which embeds the peg-check directly inside `lite-psm` with no
upgradeability of its own.

### `RedemptionQueue.QueueEntry` storage packing `[EVM]`

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 okuMAmount` (~7.9e28 max — large
enough for any realistic OkuM amount given `MAX_MULTIPLIER` and
`maxSupply`) + `uint48 timestamp` would pack into two slots.

**Caution:** storage-layout change on a UUPS proxy. Only do this
in a v2 upgrade with a careful migration. Defer to v2.

### Queue capacity: 200 → 500 entries `[SVM]`

The SVM redemption queue is capped at 200 entries by the Solana
`MAX_PERMITTED_DATA_INCREASE = 10_240` bytes single-CPI allocation
limit. The spec target was 500. Two paths:

1. **Multi-step init + 2× realloc** — initial `setup_redemption_queue`
   allocates 10 KB, two follow-up `realloc` calls grow the PDA.
   Keeps the zero-copy ring intact; only deploy script changes.
2. **Per-user PDAs** — one PDA per queued entry; lifts the cap
   entirely.

**Defer until:** telemetry shows operators repeatedly hitting
`QueueFull`. The 200-entry ring + `MAX_BATCH_ENTRIES = 50` per-tx
drain + auto-batching `process-queue.ts` script is sufficient for
launch.

### oku-dollar reserved storage padding `[SVM]`

Account size is pinned at 362 bytes by `const _: () = assert!(...)`.
Any new field requires a seed rotation and migration. Standard
pattern in mature Solana programs is to reserve a `_reserved: [u8; N]`
tail. Weigh against the cost of the next rotation.

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Dead orphan PDAs from cycle-2 + cycle-3 seed rotations `[SVM]`

Pre-rotation PDAs are orphaned because their `owner` field still
references the same program ID, but the program no longer derives
those addresses. Total rent locked ~0.085 SOL across ~9 accounts per
rotation. Not material; tracked for completeness. A future one-shot
`admin_close_legacy_pda(seed_str)` ix gated by `role_admin` could
recover the rent. Details in
[`SVM/README.md § PDA seed history`](SVM/README.md).

### Queue spam DoS via 1-OkuM entries `[SVM]`

A user can fill the 200-entry redemption queue with minimum-size entries
(1 OkuM each) faster than the operator's `MAX_BATCH_ENTRIES = 50`
per-tx drain can clear them. Cost to the attacker: 200 × redeem-tx fees
+ escrowed OkuM for the queue duration. The `MINIMUM_QUEUE_ENTRY_OKUM`
mitigation (single constant + `require!`) was considered but deferred
to avoid pre-audit churn on a tuneable parameter the auditor would probe.

**Mitigation options when revisited:**
1. Add a `MINIMUM_QUEUE_ENTRY_OKUM` constant + `require!` in
   `redeem_oku_m` queued branch.
2. Per-user PDA queue (lifts the cap; see "Queue capacity: 200 → 500").
3. Escalating spam fee.

**Defer until:** auditor opinion or operator telemetry shows abuse.

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

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — both
  programs. The two-step transfer's second step happens once per
  rotation by the cold multisig via Squads; a documented IDL call
  in the runbook is sufficient. Build CLIs only if the runbook
  requires them.
- `user-self-rescue-queue-entry.ts` — permissionless self-rescue
  for queued users. Belongs in `scripts/user/`, not `admin/`.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, coverage notes)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence)
- [`EVM/audit/README.md`](EVM/audit/README.md) — accepted risks + slither triage + tool snapshots
- [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md) — accepted risks + clippy triage
- [`../audit/README.md`](../audit/README.md) — cross-chain parity matrix + cycle headline
