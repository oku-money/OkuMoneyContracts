# okuMoney Contracts Tracker

Open issues + follow-ups for the okuMoney on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file. Resolved items are removed;
full history lives in git and in each side's README (see "Accepted
Risks" in `EVM/README.md` / `SVM/README.md`).

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

The goal is to clear every item before audit. This file should be
removable post-launch.

---

## 🟡 Should-fix before external audit

### v0.3 single-token refactor — follow-ups `[EVM]`

The EVM side was refactored from the dual-token split economy to a single
ERC-8056 token (`OkuDollar` / `rUSDOku`). Contracts, tests, scripts and docs are
done; these items are outstanding.

- **`MAX_IMPLIED_APR` is a placeholder.** Currently 1000 bps nominal. This is the
  bound doing most of the work in the compromised-setter story, and it needs a
  real number from treasury rather than a round one. Paired with
  `MAX_RATE_DURATION = 30 days` it caps worst-case over-accrual at ~0.82% per
  segment.
- **ERC-7730 deployment addresses are zero-filled.** `EVM/metadata/erc7730/*.json`
  carry the full field-label metadata but placeholder addresses. Fill them in
  after the first `v0.3` deploy and submit to the Ledger registry.
  **This is a launch blocker** — Ledger and Trezor render raw calldata, so without
  it the app says "$1,050" while the device says "1,000".
- **Client SDK not built.** `EVM/metadata/DISPLAY_CONVENTION.md` specifies the
  required API shape (`getDisplayBalance`, `getMaxSendRaw` with no inverse,
  `allowanceUI`). The contract-side surface it needs is complete and shipped.
- **Reference AMM + lending integrations not built.** Rate-aware pools only —
  a naive constant-product pair against USDC leaks the entire accrual rate to
  arbitrageurs.
- **Listings communications.** Neither number is a $1 unit price. What goes to
  CoinGecko / CMC / exchange listing teams, and whether the ticker changes, must
  land before launch.
- **`MathLib.rpow` has one uncovered assembly branch.** The `zx` overflow revert
  inside the squaring loop. Assembly branch coverage is unreliable and the branch
  requires a very specific overflow shape; left uncovered deliberately rather
  than chased with a contrived harness. `src/lib/MathLib.sol` is at 96.67% lines,
  above the 95% CI gate.

### SVM devnet needs a fresh re-deploy (not an in-place upgrade) `[SVM]`

The program builds and passes all tests, but **the devnet program has
not been rebuilt/redeployed** against the current source. On-chain state
is out of scope for review/audit; the internal devnet instance should
eventually be refreshed for testing. An in-place BPF upgrade is **not**
sufficient — the config PDA seed is `psm_config`, so if any prior devnet
deploy used a different seed a fresh deploy (new PDA + mint) is required.

Notable deployed-surface facts vs. any older devnet build:

- Config PDA seed is `psm_config`.
- USDC transfers use `transfer_checked` (mint + decimals validated).
- Error enum includes `ZeroOutput`, `SlippageExceeded`,
  `MultiplierUnpackFailed`, `ScaledUiExtensionMissing`,
  `MultiplierOutOfRange`.
- `update_token_metadata` instruction is present.

**Follow-up required before this can be closed:** rebuild, deploy fresh
to devnet (new PDA + mint), re-verify with the bankrun/devnet suites,
then mainnet-beta following the testnet-then-mainnet posture.

### SVM test harness does not pass `tsc --noEmit` `[SVM]`

`npx tsc --noEmit` reports ~35 type errors across the bankrun test files
(`Program<LitePsm>` vs `Program<Idl>` generic-variance around
`addEventListener`). Harmless — the suite runs via `tsx` (no type-check)
and all 94 bankrun tests pass — but a fully polished project would type-
check clean. Fix with a targeted cast/typing shim in the harness.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/`
package) was removed. If a static-analysis gate is wanted for the audit,
re-introduce a lint runner (dylint or an alternative) in CI.

---

## ⚪ Post-launch / low priority

### `RedemptionQueue.QueueEntry` storage packing `[EVM]`

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 rawAmount` (~7.9e28 max — large
enough for any realistic amount given `MAX_MULTIPLIER` and
`MAX_TOTAL_SUPPLY`) + `uint48 timestamp` would pack into two slots.

**Caution:** storage-layout change on a UUPS proxy. Only do this
in a v2 upgrade with a careful migration. Defer to v2.

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Two-chain Foundry invariant harness `[EVM]`

Extend the v0.3 `SystemHandler` stateful-fuzz harness to model a second
simultaneous `chainB` LitePSM and randomly bridge between them. Surfaces
cross-chain accounting bugs that scripted scenarios miss — including the
EVM-continuous vs SVM-stepwise multiplier skew, which is currently only
reasoned about rather than fuzzed.

**Effort:** 1–2 weeks.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

**Effort:** 2–3 weeks.

### Audit-attention surfaces `[both]`

Informational only — no functional issue, just where reviewer time
will concentrate:

- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`) is the highest-complexity code in the crate:
  extension-length math, a two-step `CreateAccount`, and four raw
  `invoke`/`invoke_signed` calls. Correct and well-commented as
  written; flagged for focused audit attention rather than as a
  defect.
- **SVM `f64` multiplier round-trip** (`helpers/scaled_ui.rs`,
  `instructions/yield_ops.rs`) is the most numerically-sensitive path:
  the `u64 → f64 → u64` conversion is exact only under the compile-time
  `MAX_MULTIPLIER < 2^52` assertion, and `read_multiplier` re-implements
  effective-multiplier selection to work around the Token-2022 zero-init
  edge case. Carries an in-code `AUDITOR ATTENTION` block.
- **EVM `LitePSM._redeem`** (`LitePSM.sol`) is the
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
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, accepted risks)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence, accepted risks)
