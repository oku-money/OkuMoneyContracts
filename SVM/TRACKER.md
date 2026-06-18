# SVM Tracker

Currently-open issues + blockers for the okuMoney SVM stack.
Resolved items are removed; full history lives in git +
[`../../audit/SVM/README.md`](../../audit/SVM/README.md) (cycle-4
findings section).

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Audit-prep cycle (2026-06-18) — landed:**
- 4 new admin CLIs: `pause-vault.ts`, `unpause-vault.ts`, `set-vault-authority.ts`, `set-min-collateral-ratio.ts`.
- 2 standalone orchestrator bridge-leg CLIs: `mint-okum.ts`, `redeem-okum.ts` (previously only reachable via `test-devnet.ts` step runner).
- L1/L2 SoD parity: vault `set_authority` now mirrors PSM-02 — rejects collapsing non-RoleAdmin roles into `role_admin` and rejects no-op self-proposals.
- Dead code purge: 4 unused error variants removed (`AccountFrozen`, `RecipientMismatch`, `TransferHookNotAllowed` from PSM; `InvalidDeadSharesMint` from vault) + `_RingQueue` re-export shim deleted.
- Polish: `OracleRelayDisabled` event gated on `oldRelay != 0`, `withdraw_buffer` pause-bypass intent documented in source, `ImmutableOwner` allow-list rationale added.
- Coverage: 4 bankrun tests for `user_self_rescue_queue_entry` (cycle-4 instruction, previously uncovered); 5 bankrun tests for vault `set_authority` + two-step `accept_role_admin` + L1/L2 guards. `npm test` 138/138.

---

## 🔴 Pre-external-deploy (needed before any non-internal devnet)

### `security_txt!` contact — upgrade to dedicated email if available

Both programs' `security_txt!` blocks currently point at:
`uri:https://github.com/anomalyco/okuMoney/security/advisories/new`

Functional. If a dedicated `security@` email is set up before
mainnet, replace the `contacts` field in both
`programs/{lite-psm,oku-dollar}/src/lib.rs`, rebuild, and redeploy.

**Effort:** 15 min + rebuild/redeploy. **Blocked on: team providing real email.**

---

## 🟡 Should-fix before external audit

### Key custody + change-management documentation

Auditors of centralized stablecoin contracts evaluate operational
controls, not on-chain delay mechanisms. What's expected and
currently missing from the repo:

- **Key custody procedures.** Where are the cold / warm multisig
  hardware devices stored? What's the off-boarding process when a
  signer leaves? What's the recovery process if a device is lost?
- **Change-management runbook per admin action class.** For each
  cold-multisig action: who proposes? Who reviews the proposed tx
  data? Who signs? What's the dry-run / fork-test requirement
  before mainnet?
- **Segregation-of-duties statement.** Which humans hold cold vs
  warm vs orchestrator keys? Do any individuals hold keys in more
  than one tier? (The system allows overlap on-chain; operational
  policy should prohibit it.)
- **Incident response procedures.** Specific runbooks for:
  compromised orchestrator key, compromised warm multisig,
  unexpected admin event detected by monitoring.

This applies equally to EVM and SVM. **Effort:** 2–4 days (writing,
not implementation).

### Health-check / monitoring scripts (both sides)

Standalone scripts that exit non-zero on out-of-band conditions —
needed for day-1 operator dashboards and alerting:

- Oracle staleness (`updatedAt` / `agg.publish_time` vs `stalenessThreshold`).
- Queue depth and age of oldest entry.
- Buffer solvency (`vault_usdc >= total_queued_oku_m × oku_m_price / 1e9`).
- Pause state.
- Supply vs cap headroom.
- Minter allowance headroom.

Output JSON for Prometheus / alertmanager consumption.
**Effort:** 2–4 days total.

### `cargo dylint` (crytic/solana-lints) — deferred

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

### Trident `#[init]` follow-ons (post-audit)

Wire dead-shares pre-seed via `set_account_custom`, convert
flows from `.insert()` to `.get()` so they reuse canonical
mint / vault addresses for higher `Ix Success` rates. Add a CI
smoke run: `trident fuzz run fuzz_lite_psm --max-iterations 1000`.

**Effort:** 1–2 days.

---

## ⚪ Post-launch / low priority

### Potentially redundant / unused functions

Tracked for future review. None are dead code (each is reachable
and covered by tests) but each is either redundant given the
centralized trust model or operational convenience that could be
removed if the operator runbook confirms it is unused. A pruning
pass should only happen after audit feedback so the auditor sees
the full surface as currently shipped.

**Operator surface:**

- `oku_dollar::deposit_reserves` (`reserve_manager`). Adds OkuMoney
  to the vault outside the normal `wrap` flow. The operator can
  equivalently mint OkuM / USDC through the PSM and use
  `withdraw_reserves` to rebalance. Convenience-only.
- `oku_dollar::withdraw_reserves` (`reserve_manager`). Symmetric to
  the above.
- `lite_psm::deposit_buffer` / `withdraw_buffer`. Same redundancy
  argument. Operator can drive USDC through the mint / redeem flow
  instead. Kept for v1 until the operational runbook confirms which
  paths the orchestrator actually uses.

**Defensive guards (unreachable through user paths):**

- `helpers::oracle_relay::get_usdc_price` — the `shift >= 0` /
  `shift < 0` normalization branches. Under realistic Pyth feeds
  (`expo == -8`), only the `shift < 0` branch is reachable; the
  other is forward-compat for non-standard feeds.
- `helpers::oracle_relay` — `FeedExpoTooLarge` guard. Rejected at
  admin time (`validate_oracle_relay_feed`), so the runtime branch
  is unreachable; kept as math-safety net.

### Remaining admin CLI gaps (post-audit triage)

Audit-prep cycle added the four hottest gaps
(`pause-vault`, `unpause-vault`, `set-vault-authority`,
`set-min-collateral-ratio`) plus the two standalone orchestrator
bridge-leg CLIs (`mint-okum`, `redeem-okum`). Still missing CLIs —
defer until post-audit when the function kill-list is finalised:

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — both
  programs. The two-step transfer's second step happens once per
  rotation by the cold multisig via Squads; a documented IDL call
  in the runbook is sufficient. Build CLIs only if the runbook
  requires them.
- `deposit-reserves.ts`, `withdraw-reserves.ts` — already on the
  "potentially redundant" review list; triage before shipping CLIs.
- `user-self-rescue-queue-entry.ts` — permissionless self-rescue
  for queued users. Belongs in `scripts/user/`, not `admin/`.

### `cargo fmt --check` / `cargo deny check` in CI

Both exist in the repo but are not wired into
`.github/workflows/test.yml`. `cargo fmt` needs one pass to clean up
any drift; `deny.toml` already exists for `cargo deny`.

**Effort:** 30 min each.

### Coverage reporting

`forge coverage --report lcov` (upload to Codecov) and
`cargo llvm-cov` — not produced or uploaded. Useful for surfacing
uncovered branches before audit.

**Effort:** 1 hour to wire.

### Queue capacity: 200 → 500 entries

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

### oku-dollar reserved storage padding

Account size is pinned at 362 bytes by `const _: () = assert!(...)`.
Any new field requires a seed rotation and migration. Standard
pattern in mature Solana programs is to reserve a `_reserved: [u8; N]`
tail. Weigh against the cost of the next rotation.

### Solana 3 → 4 SDK bump

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Dead orphan PDAs from cycle-2 + cycle-3 seed rotations

Pre-rotation PDAs are orphaned because their `owner` field still
references the same program ID, but the program no longer derives
those addresses. Total rent locked ~0.085 SOL across ~9 accounts per
rotation. Not material; tracked for completeness. A future one-shot
`admin_close_legacy_pda(seed_str)` ix gated by `role_admin` could
recover the rent. Details in
[`../README.md § PDA seed history`](../README.md).

### Queue spam DoS via 1-OkuM entries

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

### Two-chain Foundry invariant harness

Extend the existing `LitePSMHandler` / `OkuDollarHandler` stateful-fuzz
harness to model a second simultaneous `chainB` LitePSM and randomly
bridge between them. Surfaces cross-chain accounting bugs that
scripted scenarios miss.

**Effort:** 1–2 weeks.

### Cross-process E2E test

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

**Effort:** 2–3 weeks.

---

## Pointers

- [`README.md`](README.md) — SVM-specific docs (programs, design, runbook, EVM divergence)
- [`oku-programs/audit/README.md`](oku-programs/audit/README.md) — accepted risks + clippy triage
- [`../README.md`](../README.md) — workspace overview + orchestrator runbook
- [`../../audit/README.md`](../../audit/README.md) — cross-chain parity matrix + cycle headline
- [`../EVM/TRACKER.md`](../EVM/TRACKER.md) — EVM-side tracker
