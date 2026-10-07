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

3. **`multiplier_to_f64_floor`'s `display <= canonical` holds by exact
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

### Before the next deploy `[both]`

The next EVM deploy is clean-slate, not an in-place upgrade: `DEPLOYMENT_VERSION =
v0.4`, the EVM address book and `testnet-addresses.json` EVM contracts are empty
(`MockUSDC` included), and `roleGrants.json` is `[]`. Outstanding: run the deploy,
regenerate `artifacts/` (`export-abis`, `export-idls`), and have the backend pick up:

- **EVM ABI:** `LitePSM.initialize(okuMoney, okuDollar, usdc, admin)`;
  `depositBuffer(amount)`; `redeemOkuM` / `redeemUsdOku` revert
  `InsufficientBuffer(available, required)` and dust redeems revert `AmountTooSmall`.
  Removed: `QueueProcessed`, the `RedemptionQueue` events, `PSM_QUEUE_PROCESSOR`
  and `QUEUE_*` roles, `BelowMinimumRedemption`.
- **SVM IDL:** `ZeroOutput` removed (redeem output can never be zero);
  `MultiplierAboveMax` is `MultiplierTooHigh`. Error codes shift; match on names
  or regenerate the IDL.
- **EVM storage layout:** OkuMoney's rate schedule and `lastYieldDistributionBlock`
  moved to their own ERC-7201 namespace (`okumoney.storage.OkuMoneyRateSchedule`,
  in `OkuMoneyRateSchedule.sol`). This is incompatible with any existing proxy;
  it is acceptable only because this deploy is clean-slate. ABIs are unchanged.
- **Operator-facing behaviour:** buffer deposit and withdraw are now pause-gated and
  blocked during the override lock on both stacks (`depositBuffer` / `withdrawUsdc`,
  `deposit_buffer` / `withdraw_buffer`). Automation must unpause before topping up.
- **Clear on deploy:** the tracked `EVM/.openzeppelin/*.json` manifests and
  `EVM/scripts/config/addresses.pre-streaming.json` describe the retired queue-era
  deployments, and `artifacts/evm/MockUSDC.json` is not written by `export-abis`.
  Kept until the next deploy; delete them (and regenerate `artifacts/`) as part of it.
- The deploy writes `EVM/scripts/config/upgradeBaselines.json` (layout baseline per proxy)
  and fresh `.openzeppelin/<chain>.json` manifests. **Commit both**: the upgrade script
  refuses to run without them (it never `forceImport`s).

### Open: tooling and CI `[EVM]`

- CI needs an `ANKR_FREEMIUM_API_KEY` repo secret for the pinned, cached mainnet fork.
  Without it fork suites run at latest and warn. The key is rejected for Optimism
  (403), so Optimism stays on Alchemy/public.
- CI pins Foundry to `v1.8.5`. Its `forge lint` flags `reentrancy-events`,
  `block-timestamp`, `unsafe-typecast` and `require-revert-in-loop` in `src/`; each site
  carries a `forge-lint: disable-next-item(...)` with a reason. Foundry < 1.8 rejects those
  ids as unknown, so run the lint locally with the pinned version (`foundryup -i v1.8.5`).

### OPEN: deferred audit items `[both]`

Reviewed, understood, deliberately not fixed:

- `update_token_metadata` has no rent payer (SVM) — a `name`/`symbol` rewrite
  that grows the TLV has no account to fund the realloc.
- Token-2022 CPI errors surface opaquely (SVM) — only `display_sync.rs`'s
  `update_multiplier` wraps its error; every other CPI call site propagates the
  raw SPL/Token-2022 error code via bare `?`.

---

## Standing traps — deploy and operations

- **`verifyDeployment()` must throw, never warn.** It asserts the complete
  role-grant matrix (`expectedRoleGrants()`: 26 entries — 24 granted to the admin by
  `initialize`, 2 sent by the script), the LitePSM minter allowance, and address-book
  completeness.
  Roles and allowances are checked separately on purpose: `OkuMoney.mint` gates
  on **both** `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, which
  `initialize` populates for nobody — so a grant without an allowance still
  reverts `ExceedsAllowance`. The drill asserts against the same exported list;
  never hand-copy it. Only script-sent grants go in `roleGrants.json`.
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

`accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the second step of the
two-step `role_admin` transfer happens once per rotation, signed by the cold
multisig via Squads; the IDL call documented in `README.md` § Mainnet ceremony is
sufficient. Build CLIs only if the runbook requires them.

### Audit-attention surfaces `[both]`

Informational only — where reviewer time will concentrate:

- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`): extension-length math, a two-step `CreateAccount`,
  and raw `invoke`/`invoke_signed` calls.
- **SVM `f64` multiplier round-trip** (`helpers/display_sync.rs`,
  `instructions/yield_ops.rs`): the most numerically-sensitive path. See
  standing invariant 3.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md) — canonical role/authority reference
- [`EVM/README.md`](EVM/README.md) — EVM contracts, deployment, accepted risks
- [`EVM/docs/epoch-accounting.md`](EVM/docs/epoch-accounting.md) — rear-facing epoch model + simulation record
- [`SVM/README.md`](SVM/README.md) — SVM programs, design, runbook, EVM divergence
