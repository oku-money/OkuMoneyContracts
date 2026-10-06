# okuMoney Contracts Tracker

Open issues + follow-ups for the okuMoney on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file.

**Resolved items are deleted, not archived.** Git holds the history. An
entry survives resolution only if it records something a contributor could
*not* learn by reading the current code and tests — a load-bearing invariant,
a trap that will be re-entered, or a decision whose alternative still looks
attractive. "Fixed a bug, added a test" is not one of those.

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

---

## Standing invariants — do not regress these

Load-bearing, non-obvious, and easy to break with a change that looks locally
reasonable. Each is listed because the *reason* is not visible from the code alone.

1. **The multiplier is monotonically non-decreasing, and that is the only
   reason the PSM needs no slippage parameter.** Redeem output is increasing in
   the multiplier, so delay and front-running can only pay the caller more.
   **This depends on the PSM charging no fee.** If that policy is ever reversed,
   min-out parameters must land in the same change as the fee. Full reasoning:
   NatSpec on `LitePSM.redeemOkuM`.

2. **Rate windows are bounded at 90 days on both stacks, and the two constants
   must agree.** At `MAX_RATE`, `rpow` overflows internally at roughly 15 years,
   and once `okuMMultiplier()` reverts, *every* recovery path reverts with it —
   including the emergency override, which re-anchors through the same read. The
   only exit is an upgrade. A divergence between stacks means one chain accepts
   a schedule the other rejects. Long-horizon fixtures must chain 90-day
   re-anchors, not open one long window.

3. **`address(0)` is the "slot cleared" sentinel in `RedemptionQueue`.** A
   zero-user entry would be unprocessable, unrescuable, and would block
   `withdrawUsdc` via `WouldStrandQueue`, hence the `enqueue` check. Also:
   `advanceHead` must keep `nonReentrant`, and `processQueue` must keep deleting
   before the external transfer. Reasoning: comments in `enqueue` and
   `processQueue`, NatSpec on `advanceHead`.

4. **`multiplier_to_f64_floor`'s `display <= canonical` holds by exact
   cancellation, not by margin.** Two `next_down` steps cancel two f64
   roundings with almost nothing left over, so adding any third rounding
   operation breaks it. The margin is per-binade and found by search, so
   sampled checks over-estimate it. The invariant is checked in exact integer
   arithmetic; do not simplify it to a float threshold. Derivation and the wrong
   approaches to avoid: doc comments in `display_sync.rs`.

---

## 🟡 Should-fix before external audit

### Out of scope: epoch management, yield-rate orchestration, and the carry ledger `[both]`

Epoch management (deriving/staging/rolling schedules, sampling V̄, the
backend's carry ledger and reconciliation) is handled by the off-chain
backend and is **out of scope for this repo**. This repo's job is to make sure
every lever and control the backend needs is present and reachable on-chain —
not to make the orchestration scripts under `EVM/scripts/operator/` and
`EVM/scripts/config/` production-ready. Those scripts, `carryLedger.json`, and
`globalValueSamples.json` are an internal-testing proof of concept, not a
production-representative implementation; do not harden them against this
being a production design. Design: [`EVM/docs/epoch-accounting.md`](EVM/docs/epoch-accounting.md).

Things a contributor could not learn from the code alone:

- **V̄ is the denominator of the rate derivation**, so a chain silently
  dropping out of the sample set makes every derived rate come out *too
  high*. `SVM_EXPECTED=true` turns that silent failure into a hard error
  (`checkMultiplierDrift.ts`, `globalValue.ts`) — do not remove it or make it
  default-off.
- **V̄'s denominator set and the broadcast's recipient set must be the same
  set.** `EVM/scripts/config/epochChains.ts` (`participatingChains()`) is the
  single source of truth; all call sites route through it, including explicit
  `CHAINS=` lists.
- **Env-var names at the `broadcastSchedule.ts` → subprocess boundary are
  generated** by `cli.ts`'s camelCase→SCREAMING_SNAKE transform and appear
  literally nowhere at either end, so a mismatch is only discoverable by
  execution. `broadcastSchedule` takes an injectable `SubprocessRunner` so that
  boundary is assertable; `broadcastSchedule.test.ts` pins the env every chain
  receives. Keep it if the orchestration scripts are touched.
- **SVM `set-yield-rate.ts` can crash after the write has landed.** Its
  post-submission summary evaluates the multiplier at the local clock, which on
  devnet can sit behind the on-chain anchor and throw. `broadcastSchedule.ts`
  then reports `[solana] FAILED` although the schedule is live. Check on-chain
  state with `admin:read-schedule` before assuming the write failed or re-sending.
  Not fixed; PoC scripts.

### Early-shock detection — out of scope, unimplemented `[both]`

An alert that watches distributed-so-far against the epoch target and halts early
(re-anchor to `PRECISION`) is part of the backend, not this repo, and does not
exist here. Why it matters: `EVM/docs/epoch-accounting.md` § Finding.

### Before the next EVM redeploy `[EVM]`

The queue changes are not upgrade-compatible with the deployed testnet contracts, so
the next deploy must be fresh, not an in-place upgrade:

- `RedemptionQueue.QueueEntry` is repacked into two slots and `getQueueEntry`'s tuple
  order changed. Bump `DEPLOYMENT_VERSION` **and** clear the four contract keys per
  `EVM/scripts/config/addresses.README.md` (the `tryAttach` hazard) in the same change.
- ABI changes backend consumers must pick up (`artifacts/evm/` is current):
  `depositBuffer` takes five arguments; `BufferRefilled` is now `QueueProcessed`;
  new queue functions and events (cancel, freeze/release, `rescueExcessOkuM`).
- Once an audited deployment exists, add an OpenZeppelin `validateUpgrade` check against
  that deployed implementation. The new layout is pinned only by a storage-slot test.

### Open: tooling and CI `[EVM]`

- CI needs an `ANKR_FREEMIUM_API_KEY` repo secret for the pinned, cached mainnet fork.
  Without it fork suites run at latest and warn. The key is rejected for Optimism
  (403), so Optimism stays on Alchemy/public.
- `forge lint src/ --deny warnings` fails on a clean compile with nightly Foundry
  because of OpenZeppelin's "Unreachable code" warning, which comes from OkuDollar's
  deliberate pure-revert `_update`. CI uses the stable toolchain; confirm it is green there.
- Operator scripts were out of scope for the queue work. Known gaps:
  `processQueue.ts` stops when the head can't clear (stranding entries behind a stuck
  head) and prefers a `MockUSDC` book entry over `USDC`; `depositBuffer.ts` always passes
  `processQueue_ = false`; `rescueQueueEntry.ts` still names USDC-blacklisting as its
  trigger.
- `SVM/.../instructions/psm.rs` has a doc comment saying EVM `withdrawUsdc` isn't
  pause-gated; it now is.

### OPEN: deferred audit items `[both]`

Reviewed, understood, deliberately not fixed:

- `LitePSM.processQueue`'s `approveAmount` is unvalidated (EVM) — liveness-only
  residual, no fund-loss path. See `AUTHORITY-MATRIX.md` §3-G.
- `update_token_metadata` has no rent payer (SVM) — a `name`/`symbol` rewrite
  that grows the TLV has no account to fund the realloc.
- Token-2022 CPI errors surface opaquely (SVM) — only `display_sync.rs`'s
  `update_multiplier` wraps its error; every other CPI call site propagates the
  raw SPL/Token-2022 error code via bare `?`.

---

## Standing traps — deploy and operations

- **`verifyDeployment()` must throw, never warn.** It asserts the complete
  role-grant matrix, both minter allowances, and address-book completeness.
  Roles and allowances are checked separately on purpose: `OkuMoney.mint` gates
  on **both** `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, which
  `initialize` populates for nobody — so a grant without an allowance still
  reverts `ExceedsAllowance`. `expectedRoleGrants()` is exported so the drill
  asserts against the deploy's own source of truth; never hand-copy the list.
- **`RedemptionQueue` must not hold `OKUM_MINTER`.** Asserted as an explicit
  negative in both `verifyDeployment` and the drill, so a re-grant or a stale
  address-book reuse fails loudly rather than silently widening mint authority.
- **`LitePSM.initialize`'s `QueueUsdcMismatch`/`QueueOkuMoneyMismatch` checks
  and `verifyDeployment`'s re-assertion of the same two edges are not
  redundant.** The init-time check structurally cannot cover a PSM or queue
  reused from the address book via `tryAttach` without re-running `initialize`.
  Do not remove either. A mismatched queue fails *closed* — the unguarded
  `burn` reverts the whole batch, including the already-executed USDC
  transfer — not silently.
- **`EVM/scripts/config/addresses.json` is tracked and must never receive `fork:`
  keys.** `saveAddressBook()` re-derives the tracked / `addresses.local.json`
  partition on every write, including the reserved `upgrades` index, so no
  caller has to remember. Never add a writer that bypasses the helper.
- **Operator scripts are env-var driven, never flag-driven.** `npx hardhat run`
  parses argv itself and rejects unrecognised `--flag` (HH305/HH310) before the
  script runs. `parseArg()` maps camelCase→SCREAMING_SNAKE
  (`minAmountOut`→`MIN_AMOUNT_OUT`); `isYesMainnet()` accepts `YES_MAINNET=1|true`.
  Do not reintroduce `--flag=value` into any EVM script header, README, or error
  message. (SVM `tsx` scripts are the opposite: they take `--flags`.)
- **The drill clears and backs up `carryLedger.json` and
  `globalValueSamples.json` in `before()`.** Both are gitignored, so stale
  local state silently corrupts a rerun's carry/target math with no error and
  no visible diff — and they can hold real operator state.
- **Never hardcode `NETWORK` in a drill.** The fork's chainId comes from
  `FORK_NETWORK` at hardhat startup; let `resolveNetworkContext()` auto-detect.
- **`PsmConfig` carries a `reserved` byte array and its `LEN` is pinned by a
  compile-time `assert!`.** New fields are consumed **from the front of
  `reserved` with `LEN` held constant** — no offset moves, no resize, no
  redeploy.
- **SVM `initialize` is gated on the program's own BPF upgrade authority via
  `ProgramData`**, pinned with Anchor's `address =` so a foreign program's
  account cannot be substituted. Bankrun loads programs under BPFLoader2 and
  creates no ProgramData account, so the harness seeds a real one
  (`seedProgramData`) rather than feature-flagging the check off under
  `cfg(test)`. Any new init-path test must do the same.

---

## ⚪ Post-launch / low priority

### Kani: some harnesses remain undischarged `[SVM]`

CI runs only an explicit `--harness` allowlist of the cheap harnesses
(`.github/workflows/test.yml`, `svm-cargo` job). The remaining harnesses in
`oku-shared` (`rate.rs`, `wad.rs`, `math.rs`) do not terminate in a practical
time: the cost is symbolic 256-bit arithmetic inside `rpow`/`div_wad`, not loop
bounds. Discharging them needs a different formulation — proving the primitives
separately and composing — not more time. Kept in-file as documentation (each
says so) and deliberately NOT added to the allowlist.

### Differential corpus: revert-case coverage is thin `[both]`

CI regenerates `EVM/test/differential/vectors.jsonl` from the Solidity reference
(`differential` job) and fails on any byte difference, so the corpus cannot drift
from its generator. What remains thin is coverage: the few revert vectors all share
one shape (`nowTs < anchor`) — nothing exercises `rpow` overflow or window/rate
rejection reverts. Widening means regenerating the committed corpus, a deliberate
act. Low priority.

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Two-chain Foundry invariant harness `[EVM]`

Extend the existing `LitePSMHandler` / `OkuDollarHandler` stateful-fuzz
harness to model a second simultaneous `chainB` LitePSM and randomly
bridge between them. Surfaces cross-chain accounting bugs that
scripted scenarios miss.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

### Spawn-based operator CLI smoke test `[EVM]`

Operator CLI entry points are covered only in-process by the drill. A
spawn-based test asserting exit codes against a fork would have caught the
flag-vs-env-var breakage on day one. Deferred post-audit.

### Operator CLI gaps `[SVM]`

`accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the two-step
`role_admin` transfer's second step happens once per rotation by the cold
multisig via Squads; a documented IDL call in the runbook is sufficient. Build
CLIs only if the runbook requires them.

### Audit-attention surfaces `[both]`

Informational only — where reviewer time will concentrate:

- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`): extension-length math, a two-step `CreateAccount`,
  and raw `invoke`/`invoke_signed` calls.
- **SVM `f64` multiplier round-trip** (`helpers/display_sync.rs`,
  `instructions/yield_ops.rs`): the most numerically-sensitive path. See
  standing invariant 4.
- **EVM `LitePSM._redeemOkuMShared`**: the densest control flow in the EVM
  suite — one function serving several call shapes via a `bool okuMAtPsm` flag
  that toggles both the token-pull and the event emission.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md) — canonical role/authority reference
- [`EVM/README.md`](EVM/README.md) — EVM contracts, deployment, accepted risks
- [`EVM/docs/epoch-accounting.md`](EVM/docs/epoch-accounting.md) — rear-facing epoch model + simulation record
- [`SVM/README.md`](SVM/README.md) — SVM programs, design, runbook, EVM divergence
