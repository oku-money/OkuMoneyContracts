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

### SVM devnet needs a fresh re-deploy (not an in-place upgrade) `[SVM]`

The current review-prep cleanup pass changed the program's deployed
surface. These are code + test changes only; **the devnet program has
not been rebuilt/redeployed.** On-chain state is out of scope for
review/audit, but the internal devnet instance should eventually be
refreshed for testing. An in-place BPF upgrade is **not** sufficient —
one change rotates the config PDA seed, so a fresh deploy (new PDA +
mint) is required.

Deployed-surface changes in this pass:

- **PDA seed renamed** `psm_config_v6` → `psm_config`
  (`state.rs`, `pdaHelpers.ts`, tests). New seed ⇒ new `PsmConfig` PDA
  address ⇒ a full re-deploy + re-init, not an upgrade.
- **USDC transfers now use `transfer_checked`** (`instructions/psm.rs`,
  all 4 legs) — validates mint + decimals on-chain.
- **Error enum changed** (`errors.rs`): `OutputBelowMinimum` split into
  `ZeroOutput` + `SlippageExceeded`; `MultiplierReadFailed` split into
  `MultiplierUnpackFailed` + `ScaledUiExtensionMissing` +
  `MultiplierOutOfRange`. New error codes/IDL.
- **`update_token_metadata` instruction** (`role_admin`-gated in-place
  rename of the OkuM mint's Token-2022 name/symbol).

Also carried in from the prior pass and still un-deployed: `initialize`
zero-pubkey / role_admin-collapse validation; `deposit_buffer`
yield-lock + pause guard; explicit `multiplier_f64_to_u64` round-trip
helper (`MAX_MULTIPLIER < 2^52` compile-time assertion + unit tests).

**Follow-up required before this can be closed:** rebuild, deploy fresh
to devnet (new PDA + mint), re-verify with the bankrun/devnet suites,
then mainnet-beta following the testnet-then-mainnet posture.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/`
package) was removed. If a static-analysis gate is wanted for the audit,
re-introduce a lint runner (dylint or an alternative) in CI.

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
  defect.
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
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, accepted risks)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence, accepted risks)
