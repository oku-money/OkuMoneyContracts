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

Four properties that are load-bearing, non-obvious, and easy to break with a
change that looks locally reasonable. Each is pinned by a test; each is listed
here because the *reason* it matters is not visible from the code alone.

1. **The multiplier is monotonically non-decreasing, and that is the only
   reason the PSM needs no slippage parameter.** Rate writes are floored at
   `PRECISION`; the emergency override requires a strict increase. Redeem
   output is linear and increasing in the multiplier, so delay, reordering and
   front-running can only pay the caller *more*. **This depends on the PSM
   charging no fee — a fee was considered and ruled out as protocol policy for
   exactly this reason.** If that policy is ever reversed, min-out parameters
   must land in the same change as the fee, not after. Pinned by
   `test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier`.

2. **Rate windows are bounded at 90 days on both stacks, and the two constants
   must agree.** Not a style rule: `rpow` overflows internally at ~15 years
   (measured 472,763,099 s), and once `okuMMultiplier()` reverts, *every*
   recovery path reverts with it — including the emergency override, which
   re-anchors through the same read. The only exit is an upgrade. A divergence
   between stacks means one chain accepts a schedule the other rejects.
   Long-horizon fixtures must chain 90-day re-anchors, not open one long window.

3. **`address(0)` is the "slot cleared" sentinel in `RedemptionQueue`.**
   `enqueue` rejects it for that reason. A zero-user entry would be
   unprocessable, unrescuable, and would permanently block `withdrawUsdc` via
   `WouldStrandQueue`. Related: `advanceHead` must keep `nonReentrant`, and
   `processQueue` must keep deleting before the external transfer.

4. **`multiplier_to_f64_floor`'s `display <= canonical` holds by exact
   cancellation, not by margin.** Two `next_down` steps cancel two f64
   roundings with `2^-104` left over. Adding any third rounding operation
   breaks it. Relative ULP is `2^-52` at the *bottom* of a binade and `2^-53`
   at the top, so `m≈1e18` (bottom of its binade) is the BEST case, not the
   worst. The true minimum margin is per-binade, found by search (no closed
   form) and measured at `1.04e-16`, i.e. 0.47x of the `2.22e-16` two-rounding
   budget — any sampling that misses those witnesses over-measures the margin
   several-fold. The invariant is checked in exact integer arithmetic
   (`f64_conversion_never_exceeds_canonical_exactly`); do not simplify it back
   to a float threshold, and do not measure the *relative bias of `f` against
   the float* `fl(m)/fl(PRECISION)` — that is a different, looser metric that
   misses a dropped `next_down` entirely (see `display_sync.rs`'s doc comments
   for the two prior wrong attempts at this list).

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
being a production design.

Two things worth keeping from the prior entries because a contributor could
not learn them from the code alone:

- **V̄ is the denominator of the rate derivation**, so a chain silently
  dropping out of the sample set makes every derived rate come out *too
  high*. `SVM_EXPECTED=true` (`EVM/.env`) exists to turn that specific silent
  failure into a hard error instead of a warning — do not remove it or make
  it default-off.
- **Env-var names at the `broadcastSchedule.ts` → subprocess boundary are
  generated**, by `cli.ts`'s camelCase→SCREAMING_SNAKE transform, and appear
  literally nowhere at either end. An `EPOCH_PHASE` vs `PHASE` mismatch was
  unreadable and only discoverable by execution. `broadcastSchedule` takes an
  injectable `SubprocessRunner` purely so that boundary is assertable;
  `broadcastSchedule.test.ts` pins the exact env every chain receives. Keep
  it if the orchestration scripts are ever touched again.

### OPEN: deferred audit items `[both]`

Reviewed, understood, deliberately not fixed:

- `approveAmount` validation on the EVM side.
- No paid-vs-queued return signal on the PSM redeem path, so a caller cannot
  tell from the return value whether they were paid or enqueued.
- `update_token_metadata` has no rent payer.
- Token-2022 CPI errors surface opaquely.
- Token-2022 CPI error mapping: exactly one call site (`display_sync.rs`'s
  `update_multiplier`) wraps its CPI error; ~12 others — every hot-path
  `transfer_checked`/`mint_to`/`burn`, both freeze/thaw, both metadata writes —
  propagate raw SPL codes.

---

## Deploy-day runbook — internal-testing MVP

**Steps 0-4 are DONE, step 5 has been exercised once end-to-end (2026-10-05),
steps 6-7's loop-closing verification has also run once.** This is a record of
having done it, not a standing guarantee — re-verify state before relying on
it for anything beyond continued internal testing. Each step's verification
gates the next.

### Already executed

- **EVM v0.3 is live on all four testnets** (`sepolia`, `baseSepolia`,
  `arbSepolia`, `bscTestnet`), five contracts each at CREATE2-deterministic
  addresses, recorded in `scripts/config/addresses.json`. Deployed in commits
  `79c2d27` and `d5fef79`. The v0.2 set — including the `base`/`bsc` *mainnet*
  deployments — is archived in `addresses.pre-streaming.json` and is stale by
  design.
- **SVM clean-slate is live on devnet**, `2026-09-19`, program ID
  `4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN`, consistent across
  `deployments/devnet.json`, `declare_id!` and `Anchor.toml`. The old program
  ID was rotated out and closed for rent recovery.

> **Note on CREATE2 addresses after the `bytecodeHash = "none"` change.**
> Implementation addresses moved when the metadata hash left the initCode, and
> since the proxy initCode embeds the impl address as a constructor arg, the
> *predicted* proxy addresses moved with them.
>
> **This does not affect the live fleet.** Upgrade-in-place resolves the proxy
> from the address book (`scripts/upgrade/index.ts`), the `.openzeppelin/`
> manifests are tracked for all six networks, and there is a `forceImport`
> recovery path if an entry is missing. The deployed proxies keep their
> addresses permanently; only the implementation behind them changes, which is
> the point of a proxy.
>
> What *does* change: a from-scratch deploy, or a deploy to a new chain, now
> lands at different addresses than the current book records, and
> block-explorer verification of the existing contracts is stale against
> current source until they are next upgraded. Both are testnet-only — mainnet
> `base`/`bsc` are v0.2 on a different salt and untouched. Accepted; no
> migration needed.

### Remaining / last verified state

**3. Wire the bridge env.** Confirmed set and working as of 2026-10-05:
`npm run operator:sampleGlobalValue` lists `solana` at a non-zero value
alongside the four EVM testnets.

**4. Bootstrap V̄.** Not on a schedule (cron setup is operational infra, out of
scope here — see "Out of scope" above). Three manual samples exist in
`globalValueSamples.json` as of 2026-10-05, which is enough to satisfy
`samplesInWindow`'s ≥2-in-window rule for a `stage-settlement` call against a
window that includes that day. Re-sample before relying on a `stage-settlement`
derivation at any later date.

**5. Set the first schedule — done, 2026-10-05.** All four testnets + SVM
devnet confirmed on an identical `(rate=3% APY, rateEnd=2026-10-06T00:00Z)` via
direct `setOkuMYieldRate` / `admin:set-yield-rate --mode=active`.
`checkMultiplierDrift` confirmed 0 bps spread across all 5 chains.

**6. First full epoch cycle — the `roll-epoch` half exercised, 2026-10-05.**
`operator:deriveEpochSchedule PHASE=roll-epoch` + `operator:broadcastSchedule`
armed a successor (`rate≈0.055% APY`, `rateEnd=2026-10-06T22:24Z`) atomically
on all 5 chains, activating with no further transaction at the base-window
boundary. This is the **first time `broadcastSchedule.ts`'s SVM leg has run
against a live deployment** — see the trap below for what that surfaced.
`stage-settlement` was not exercised this pass (no settlement-window correction
staged for this epoch); the mechanism is unchanged and was validated earlier by
`operatorDrill.test.ts` against a real deployed contract.

**Trap found by actually running the SVM leg live:**
`scripts/admin/set-yield-rate.ts`'s POST-submission display (the "schedule
after" block, after `tx: <sig>` has already printed and the write has already
landed) calls `computeMultiplier` with `Date.now()` as `nowTs` against the
just-fetched on-chain `anchor` — and on devnet, local-clock-vs-cluster-slot-time
skew of a couple of seconds is enough for `nowTs < anchor`, which throws and
exits 1. **The transaction itself had already succeeded** both times this was
hit; only the cosmetic post-write summary crashed. `broadcastSchedule.ts` reads
the subprocess exit code, not just the regex-scraped `tx:` line, so it treats
this as `[solana] FAILED` even though the schedule landed correctly — the
artifact needs its `solana` receipt added by hand (signature recoverable via
`getSignaturesForAddress` on the config PDA) before re-running the broadcaster
so it does the carry-ledger write rather than resubmitting a redundant
transaction. Not fixed — these scripts are an internal-testing proof of
concept (see "Out of scope" above), and the fix (clamp `nowTs` to `>= anchor`,
or drop the display read entirely) is a few lines whenever someone is back in
this file; recorded here mainly so the next person who hits `[solana] FAILED`
checks on-chain state with `read-schedule.ts` before assuming the write didn't
land.

**7. Close the loop — confirmed, 2026-10-05.** `carryLedger.json` carries two
rows: the prior epoch's `reconciledCarryUsd` was backfilled ($0.114, since the
intervening halt meant $0.00 was actually paid against an $0.114 target), and
exactly one new row was written for the rolled epoch. `checkMultiplierDrift`
reports agreement (0 bps) across all four testnets and SVM.

### Deploy-time traps that are not visible from the scripts

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
- **`scripts/config/addresses.json` is tracked and must never receive `fork:`
  keys.** `saveAddressBook()` re-derives the tracked / `addresses.local.json`
  partition on every write, including the reserved `upgrades` index, so no
  caller has to remember. Never add a writer that bypasses the helper.
- **Operator scripts are env-var driven, never flag-driven.** `npx hardhat run`
  parses argv itself and rejects unrecognised `--flag` (HH305/HH310) before the
  script runs. `parseArg()` maps camelCase→SCREAMING_SNAKE
  (`minAmountOut`→`MIN_AMOUNT_OUT`); `isYesMainnet()` accepts `YES_MAINNET=1|true`.
  Do not reintroduce `--flag=value` into any script header, README, or error
  message.
- **The drill clears and backs up `carryLedger.json` and
  `globalValueSamples.json` in `before()`.** Both are gitignored, so stale
  local state silently corrupts a rerun's carry/target math with no error and
  no visible diff — and they can hold real operator state.
- **Never hardcode `NETWORK` in a drill.** The fork's chainId comes from
  `FORK_NETWORK` at hardhat startup; let `resolveNetworkContext()` auto-detect.
- **`PsmConfig` carries `reserved: [u8; 128]`, `LEN` = 754 pinned by a
  compile-time `assert!`.** New fields are consumed **from the front of
  `reserved` with `LEN` held constant** — no offset moves, no resize, no
  redeploy.
- **V̄'s denominator set and the broadcast's recipient set must be the same
  set.** `scripts/config/epochChains.ts` is the single source of truth
  (`participatingChains()`); all call sites route through it, including
  explicit `CHAINS=` lists.
- **SVM `initialize` is gated on the program's own BPF upgrade authority via
  `ProgramData`**, pinned with Anchor's `address =` so a foreign program's
  account cannot be substituted. Bankrun loads programs under BPFLoader2 and
  creates no ProgramData account, so the harness seeds a real one
  (`seedProgramData`) rather than feature-flagging the check off under
  `cfg(test)`. Any new init-path test must do the same.

---

## ⚪ Post-launch / low priority

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/` package) was
removed. If a static-analysis gate is wanted for the audit, re-introduce a lint
runner (dylint or an alternative) in CI.

### Kani: four harnesses remain undischarged `[SVM]`

CI now runs the two cheap harnesses (`proof_mul_div_floor_correctness_bounded`,
`proof_mul_div_floor_no_u128_overflow`) via `cargo kani --package oku-shared
--harness ...` in the `svm-cargo` job — they discharge in well under a minute
once Kani itself is installed (cached; cold install ~5-10 min).

Four others still do not terminate in 15 minutes:
`rate.rs::proof_compound_for_output_clamped`,
`wad.rs::proof_div_wad_quotient_bound`, and both `raw_to_dollars` harnesses.
Not a regression — their predecessors didn't terminate either, verified by
checking out their prior versions and running them. The cost is symbolic
256-bit arithmetic inside `rpow`/`div_wad`, not loop bounds. Discharging them
needs a different formulation — proving properties of the primitives
separately and composing, rather than symbolically executing the whole path.
Kept in-file as documentation (each already says so), deliberately NOT added
to CI's `--harness` allowlist. Low priority for this scope.

### Differential corpus: revert-case coverage is thin `[both]`

CI already enforces freshness: `.github/workflows/test.yml`'s `differential`
job regenerates `EVM/test/differential/vectors.jsonl` from the Solidity
reference on every push and hard-fails on any byte difference
(`GenerateVectors.t.sol`'s generation is fully deterministic — no
`vm.warp`/`block.timestamp` dependence, fixed-seed keccak chain, not
randomness). A corpus that did not come from that generator fails on the next
CI run, which is narrower than a hash pin (proves the current tree is
self-consistent, not that history was honest) but closes the practical
tautology risk.

What remains: only 4 of 3,867 vectors are revert cases, all the same shape
(`nowTs < anchor`) — no coverage of `rpow` overflow or window/rate rejection
reverts. Widening requires regenerating the committed oracle corpus, a
deliberate act. This is a testing/parity tool and the existing shape is proven
and working; low priority.

### Cold-ATA mint compute target moved to 150k `[SVM]`

A first-time minter in the two-`rpow` overhang branch measured
101,847-131,847 CU against a self-imposed 100,000 CU composability target.
A CU-reduction pass on `mint_oku_m`/`redeem_oku_m` (dropped three unused
`Account<T>` deserializations on the mint path that were only ever forwarded
as `AccountInfo` to a CPI; relaxed `user_usdc_ata`'s `associated_token::`
constraint to `token::mint=`/`token::authority=` since it's never created and
so needs no PDA derivation; threaded one `Clock::get()` through both the
yield-lock check and the multiplier read instead of two; replaced a
post-mint/burn `reload()` with arithmetic from the already-read pre-CPI
supply) brought the cold path down to 98,597-112,097 CU across repeated
runs — sometimes under 100k, sometimes over, which is why
`tests/bankrun/compute-budget.ts` now asserts it against a dedicated
`COLD_PATH_CU_CEILING = 150_000` rather than the 100k target, with no lower
bound (a future optimisation landing it durably under 100k is not something to
pin against). See that constant's doc comment for the full before/after.
Solana's 200,000 hard limit was never approached either side of the pass.

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

Informational only — no functional issue, just where reviewer time will
concentrate:

- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`): extension-length math, a two-step `CreateAccount`,
  and four raw `invoke`/`invoke_signed` calls. Correct and well-commented;
  flagged for focused attention rather than as a defect.
- **SVM `f64` multiplier round-trip** (`helpers/display_sync.rs`,
  `instructions/yield_ops.rs`): the most numerically-sensitive path. See
  standing invariant 4 above.
- **EVM `LitePSM._redeemOkuMShared`**: the densest control flow in the EVM
  suite — one function serving 4 call shapes via a `bool okuMAtPsm` flag that
  toggles both the token-pull and the event emission.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md) — canonical role/authority reference
- [`EVM/README.md`](EVM/README.md) — EVM contracts, deployment, accepted risks
- [`EVM/docs/epoch-accounting.md`](EVM/docs/epoch-accounting.md) — rear-facing epoch model + simulation record
- [`SVM/README.md`](SVM/README.md) — SVM programs, design, runbook, EVM divergence
