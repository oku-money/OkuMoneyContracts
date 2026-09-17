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

### RESOLVED: every operator script's documented CLI invocation was impossible `[EVM]`

`npx hardhat run <script>` parses argv **itself** and rejects any parameter it
doesn't recognise, before the script executes. Every operator script documented
a `--flag=value` invocation, and none of them could ever have worked:

```
npx hardhat run scripts/operator/psmOps.ts --action=mintOkuM
  -> Error HH310: Invalid param --action=mintOkuM. Command line params must be lowercase.
npx hardhat run scripts/operator/psmOps.ts --action=foo
  -> Error HH305: Unrecognized param --action=foo
npx hardhat run scripts/operator/psmOps.ts --yes-mainnet
  -> Error HH305: Unrecognized param --yes-mainnet
```

Position is irrelevant (before or after the script path). Verified against all
three error paths.

**Why nothing caught it:** the operator drill calls `runPsmOp()`,
`runRescueQueueEntry()`, etc. **in-process**, which is the right call for
testing script *logic* — but it bypasses the CLI entirely. The CLI surface had
never been executed by anything.

**Two real consequences, not just bad docs:**

1. `parseArg` falls back to `process.env[NAME]`, so an env-var form always
   worked — but it was undocumented, and the documented form was the broken one.
2. `isYesMainnet()` was `process.argv.includes("--yes-mainnet")` with **no env
   fallback**, so `mainnetGuard` could never be satisfied under `hardhat run`.
   Mainnet broadcast was *impossible*, not merely guarded. (Fail-safe rather
   than dangerous, but the mainnet runbook was non-functional.)

Notably `grantRoles.ts` / `grantRolesMainnet.ts` had **already discovered this**
and rolled their own `YES_MAINNET` env check with an accurate comment — that fix
just never propagated to the shared `cli.ts` helper or the other 14 scripts.

**Fixed:**
- `isYesMainnet()` now accepts `YES_MAINNET=1` / `=true`, matching the
  convention `grantRoles.ts` already established, so there is one convention.
- `parseArg()` now resolves camelCase options to readable SNAKE_CASE env names
  (`minAmountOut` -> `MIN_AMOUNT_OUT`, `pendingEndTimestamp` ->
  `PENDING_END_TIMESTAMP`), falling back to the legacy literal-uppercase form
  for back-compat. Needed because env vars are now the *primary* interface and
  a bare `toUpperCase()` produced names like `MINAMOUNTOUT`.
- All 14 operator script headers + README rewritten to the env-var form.
- `mainnetGuard` and `scripts/upgrade/index.ts` error messages no longer tell
  operators to pass a flag that cannot work.
- `operator:mint` / `operator:redeem` npm aliases now bake in
  `ACTION=mintOkuM` / `ACTION=redeemOkuM` — previously both were byte-identical
  to `operator:psmOps` with no action, so both failed with
  `Required: --action=...`. Added missing `operator:vaultOps`,
  `operator:runEpoch`, `operator:setOkuMMultiplier` aliases.

**Verified end-to-end against a live Sepolia fork node**, not just unit-level:
deployed via `hardhat run scripts/deploy/index.ts --network localhost`, then
executed a real (non-DRY_RUN) `ACTION=mintOkuM AMOUNT=1000000000 npx hardhat run
scripts/operator/psmOps.ts --network localhost` -> broadcast succeeded, and
`npm run operator:mint` likewise. Mainnet guard confirmed to block by default
and accept both `YES_MAINNET=1` and `=true`.

**Remaining gap (not fixed):** operator CLI entry points are still only covered
in-process by the drill. A thin CLI-level smoke test (spawn one script with env
vars against a fork, assert exit code) would have caught this on day one and
would prevent regression. Worth adding before the operator runbook is relied on.

### RESOLVED: `forge fmt` drift in `test/invariants/VaultInvariants.t.sol` `[EVM]`

Pre-existing formatting drift that kept CI's **first** gate (`forge fmt
--check`) red independently of any work in this tracker — confirmed via `git
stash` against a clean checkout. Fixed by running `forge fmt` on the file; the
resulting diff is a pure whitespace reflow of a single `assertGe(...)` call,
no logic change. `forge fmt --check` now exits 0.

**Still worth reconsidering while here:** `forge fmt --check` and the 95%
per-file `forge coverage` gate in `.github/workflows/test.yml` are both fairly
strict, and this session found both false-red at least once for reasons
unrelated to the actual code changes under review (formatting nits after
adding assertions; coverage dipping below threshold from adding a small amount
of untested ERC-4626 surface). Worth deciding whether these gates are
providing proportional value or mostly generating friction — could simplify
CI (e.g. loosen the coverage threshold, or drop `forge fmt --check` in favor
of a pre-commit hook / editor integration) if the team decides the strictness
isn't earning its keep. Not changed unilaterally here — flagging for a
decision.

### RESOLVED: test failures across 5 hardhat fixtures, 12 tests total (stale `OkuDollar` deploy args, predated single-multiplier refactor) `[EVM]`

Found while verifying the full `npx hardhat test` suite (the CI command,
which sets `FORK_NETWORK=mainnet`) during an unrelated audit pass. Confirmed
pre-existing via `git stash` against a clean checkout — not introduced by any
work in this tracker. **Full scope, verified directly (an earlier version of
this entry under-scoped this to 2 files — corrected here):**

| File | Failing | Stale arg |
|---|---|---|
| `test/hardhat/scenarios/RealWorldUsage.ts` | 8 (7 edge cases + the 365-day sim) | `MIN_COLLATERAL_RATIO` constant, `deployChain()` |
| `test/hardhat/fork/OkuMoney.ts` | 1 (whole file, fails at `before all`) | inline `parseEther("0.95")` |
| `test/hardhat/fork/OkuDollar.ts` | 1 (whole file) | inline `parseEther("0.95")` |
| `test/hardhat/fork/LitePSM.ts` | 1 (whole file) | inline `parseEther("0.95")` |
| `test/hardhat/happyPath/HappyPath.ts` | 1 (whole file) | inline `parseEther("0.95")` |

All five fail identically: `Error: too many arguments: types/values length
mismatch (count=5, expectedCount=4)` at `deployProxy`/`getInitializerData`,
because each still passes a 5th constructor arg to `OkuDollar.initialize`,
which now takes only 4 (`_okuMoney, name_, symbol_, _admin`).
`minCollateralRatio` (and the whole
`depositReserves`/`withdrawSurplus`/`collateralizationRatio` surface it
gated) was deleted along with the second rate — collateralization is exactly
1.0 by construction under the single-multiplier design. None of these 5
fixtures were updated for that refactor. Every test in each file fails at
setup, before its own logic runs — so all ~28 `it()` blocks across these 5
files are currently **zero-coverage presenting as pre-existing failures**,
not a runtime regression. No other removed-API references (`okuMPrice`,
`distributeYield`, etc.) were found anywhere else in `test/hardhat/` — the
stale 5th arg is the only blocker in each file.

**Status: RESOLVED — all 28 tests now pass.** Deleted the stale 5th arg in all
5 files (5 call sites, including one at `fork/OkuMoney.ts:309` a first pass
missed — a second nested `deployProxy` call later in the same file). No other
removed-API references exist anywhere in `test/hardhat/`, confirmed by
grepping for `depositReserves`, `withdrawSurplus`, `collateralizationRatio`,
`minCollateralRatio`, `okuMPrice`, `distributeYield` — zero hits outside the
5 sites fixed.

That mechanical fix alone unblocked **24 of 28**, confirming most of these
fixtures' logic held up fine across the refactor. The remaining 4 were
genuine stale *content*, each diagnosed to a root cause before being changed.
**In all four cases the contract was correct and the test was wrong** — no
contract bug was found:

1. **`fork/OkuMoney.ts` — `TransferValue` event.** Deliberately removed
   (`OkuMoney.sol:758`: under streaming accrual the dollar field would cost an
   rpow on every transfer, ~5-10k gas forever, and without it the event
   duplicated ERC-20 `Transfer` exactly). Rewritten to assert the `Transfer`
   event that replaced it, plus `balanceOfUI()` for the dollar-value half of
   the original intent — rather than deleting the assertion outright.
2. **`fork/OkuMoney.ts` — pause/unpause.** Test-isolation bleed: contracts are
   deployed once in a top-level `before`, so Bob still held 5,000 OkuM from an
   earlier `it()`; `5000 + 1000 = 6000` exactly matched the observed value.
   Now asserts a delta against a pre-captured balance, removing the ordering
   dependency.
3. & 4. **`fork/OkuDollar.ts` — unwrap formula (2 tests).** Both used
   `amount × usdMultiplier / notePrice`, a **dual-multiplier-era** formula.
   Under the single-multiplier design `usdMultiplier()` literally returns
   `okuMoney.okuMMultiplier()` (`OkuDollar.sol:191-193`), so both terms are
   now the same value and the expression degenerated to `amount` — asserting
   that unwrapping returns dollar-for-dollar in *raw* notes, which would
   inflate value by the multiplier. The contract computes
   `mulDiv(usdAmount, PRECISION, mult, Floor)` (`OkuDollar.sol:490`) —
   dollar-conserving and correct, and directly covered by forge at a 3x
   multiplier (`test_Unwrap_SharesBurnedRoundUp_FavorsVault`, 130/130
   `OkuDollarTest` green). Expectations corrected to match.

   Fixing the formula then exposed a **second** stale assertion in the same
   test: it checked for a fully-drained vault after unwrapping a balance
   captured *before* the multiplier bump. A share balance is denominated in
   raw OkuM, so a UsdOku balance grows with the multiplier — unwrapping the
   pre-bump figure is a partial exit leaving ~9% behind. The old assertion
   only ever passed because the two errors cancelled. The test now exits the
   remaining balance so "full exit" means what its name says.

### RESOLVED: deploy script had zero automated coverage and reported success on a broken role matrix `[EVM]`

`scripts/deploy/index.ts` (~900 lines: proxy deploys, retry, address-book
persistence, 21 role grants, Etherscan verification) was **exercised by no
test at all**. Every fixture in the suite — including the operator drill —
built its own contracts with `upgrades.deployProxy`, so the one artifact
actually run against a testnet was the one thing nothing verified.

Worse, the script's own `verifyDeployment()` step was **warn-only**: it spot-
checked 4 of 21 grants and, on a missing `OKUM_BURNER`, logged
`"redeem paths will revert!"` and then **exited 0**. A deploy with a broken
redeem path reported success. Role misconfiguration is the failure mode most
likely to brick a fresh deploy or silently leave a privilege hole, and it was
the least-protected part of the pipeline.

**Fixed, in three parts:**

- **`runDeploy()` extracted** (`scripts/deploy/index.ts`). The script had no
  exports — `main()` ran unconditionally at import and called `process.exit`,
  so it could not be imported by a test without killing the host process.
  Now follows the same `export async function run*()` +
  `if (require.main === module)` pattern the operator scripts already use.
  Structural only; no deploy logic changed. Takes an optional `deployer`
  override, needed because the CLI path impersonates `DEV_WALLET` on a fork,
  which would otherwise leave a test's own signer holding none of the roles.
- **`verifyDeployment()` now fails loudly**, asserting the *complete* 21-grant
  matrix plus both minter allowances and address-book completeness, and
  throwing with a precise list of what's missing. Minter allowances are
  checked separately from roles on purpose: `OkuMoney.mint` gates on BOTH
  `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, so a role grant
  without an allowance still reverts with `ExceedsAllowance`. The expected
  matrix is exported as `expectedRoleGrants()` so the drill asserts against
  the deploy's own source of truth rather than a hand-copied list that would
  drift the moment a role is added.
- **`test/hardhat/drill/deployDrill.test.ts` added** (7 tests): runs the real
  `runDeploy()` against the local fork and asserts all five proxies have code,
  the address book matches what was deployed, the full role matrix is present,
  minter allowances are non-zero, privileged roles are **not** held by an
  unrelated address or `address(0)` (a positive-only check can't catch an
  over-broad grant), cross-contract wiring is consistent, and — as the
  end-to-end proof — that a real PSM mint succeeds on the resulting chain.

**Verified the hardening isn't vacuous:** temporarily removing the
`OKUM_BURNER -> LitePSM` grant made the deploy abort with
`Deployment verification FAILED — missing role grants`, where it previously
printed a warning and exited 0. Grant restored immediately after.

**Also confirmed against the real target chain:**
`./scripts/deploy/dryRunForks.sh sepolia` completes post-refactor with
`All 21 role grants verified` in the transcript.

### RESOLVED: operator drill validated a role topology no deployed chain has `[EVM]`

The operator drill stood up its own contracts and wired **5** role grants;
`scripts/deploy/index.ts` grants **21**. Every operator lever was therefore
being exercised against a permission set that exists on no real deployment —
exactly the fidelity gap the drill was built to close for the CLI scripts
themselves. Repointed the drill's fixture at `runDeploy()`, so a role the
deploy forgets to grant now breaks the operator drill too, instead of passing
locally and failing on a testnet. All 22 operator-lever tests still pass, now
against the production topology, plus the 7 new deploy-drill tests.

### RESOLVED: new operator drill (`test/hardhat/drill/operatorDrill.test.ts`) exercises every operator-script lever end-to-end `[EVM]`

Added a hardhat test that imports and calls the same functions the operator
CLI scripts call (not spawning processes) against a fresh local chain,
covering mint/burn/redeem/unwrap, PSM ops, rescue paths, epoch settlement +
roll, multiplier overrides, and the DRY_RUN guard for every lever type. The
fidelity choice (calling the real script functions rather than the contracts
directly) is deliberate: a bug in a script's argument handling, address-book
lookup, or guard logic shows up here exactly as it would for an operator
running the CLI. 22 tests, all passing; folded into `npm run test:unit`.

**Two real bugs found and fixed while hardening it, both in the drill itself
(not in production code):**

- **Gitignored reference-implementation stores silently corrupt reruns.**
  `scripts/config/carryLedger.json` and `scripts/config/globalValueSamples.json`
  are gitignored, so a stale entry from a previous local run isn't cleared by
  git and isn't visible as a diff — it just silently corrupts the current
  run's carry/target math with no error and no stack trace, producing a
  result that looks like a slightly-wrong number. Fixed by deleting both
  files at the start of `before()`, before anything reads or writes them.
- **Hardcoded `NETWORK=sepolia` broke under any other fork target.** The
  drill originally forced `process.env.NETWORK = "sepolia"`, assuming the
  local fork's pinned chainId always matches Sepolia. But the chainId is
  actually determined by `FORK_NETWORK` at hardhat startup (e.g.
  `FORK_NETWORK=mainnet` pins chainId 1), so the hardcode threw `Chain ID
  mismatch: local node reports chainId 1, but NETWORK=sepolia expects chainId
  11155111` whenever the process wasn't started against a Sepolia fork —
  found by running the drill together with the fork suite under
  `FORK_NETWORK=mainnet`. Fixed by leaving `NETWORK` unset and letting
  `resolveNetworkContext()` auto-detect `networkName`/`bookKey` from the
  chain's actual live chainId instead; verified passing both with the default
  fork and with `FORK_NETWORK=mainnet`.

Also replaced two hardcoded settlement/roll-epoch yield targets (magic
numbers like `1050`) with values derived from the fixture's actual
`totalSupply()` at runtime, so the test's math stays self-consistent instead
of depending on a number that happened to work against one specific supply
snapshot.

**Self-review pass found 5 more issues in the drill itself, all fixed:**

- `npm run typecheck` (a real CI step, run separately from `hardhat test`)
  failed on 2 unused declarations (`sampleGlobalValueUsd` import, `user2`
  binding) that the initial pass never caught because it only ran `hardhat
  test` directly.
- The network-name assertion added to fix the `NETWORK=sepolia` hardcode
  (above) was tautological: it re-derived `fork:${ctx.networkName}` from
  `ctx` itself and compared it to `ctx.bookKey`, which can never fail — the
  same "checks nothing" class of bug the stage-settlement test's own comment
  calls out. Fixed by independently resolving the expected name from the live
  chainId via `getNetworkNameByChainId()`, the same lookup
  `resolveNetworkContext()` uses internally, so the assertion can actually
  fail if they disagree.
- The gitignored-store fix (above) deleted `carryLedger.json` /
  `globalValueSamples.json` with no backup, on the reasoning that "they're
  gitignored, so there's nothing to restore." That reasoning was wrong — they
  can hold real local operator state that's meaningful independent of git
  tracking. Now backed up and restored exactly like the tracked address book.
- Removing a conditional guard (`if (bal >= amount)` / `.catch(() => {})`)
  around the `burn` test's `mint()` call surfaced a real gap in the drill's
  own setup: `admin` holds `OKUM_MINTER` from `initialize()`, but `mint()` is
  *also* gated on a separate per-minter `minterAllowance` mapping that
  `initialize()` never populates for anyone, so the unconditional mint
  reverted with `ExceedsAllowance()`. Fixed by granting admin a small minter
  allowance in `before()` — this is a drill-fixture gap, not a contract bug
  (the contract's split of role vs. allowance is intentional, per its own doc
  comments).
- Several other conditional guards (`rescueQueueEntry`, `vaultOps` unwrap)
  were removed in favor of deterministically establishing the precondition
  and asserting the operation's actual on-chain effect (e.g. queue slot
  zeroed, recipient balance moved by exactly the entry amount) rather than
  skipping the assertion when the precondition wasn't met.

### RESOLVED: `effectiveAt()`/`newUIMultiplier()` signaled a scheduled change when none was armed; MathLib/ERC-8056 test gaps closed `[EVM]`

Three previously-deferred coverage/correctness items, closed in the same pass
as the simulation-suite audit below:

- **Real bug, fixed:** `effectiveAt()` returned `okuMRateEnd` whenever a
  bounded active window existed, even with **no successor rate armed** — a
  bounded window with nothing staged is just the current rate continuing, not
  a scheduled change. `newUIMultiplier()`'s own doc comment already claimed
  "when no pending rate is armed, returns the current multiplier" but the code
  never actually checked that condition — the doc described intent, not
  behavior. Both functions now check `okuMPendingRatePerSecond <=
  Constants.PRECISION` explicitly and return `0` / the current
  `okuMMultiplier()` respectively when nothing is armed. Zero test coverage
  existed for either function before this fix; 6 new tests added
  (`test_EffectiveAt_*`, `test_NewUIMultiplier_*`) covering halted, armed,
  post-activation, and the regression case directly.
- `MathLib.computeMultiplier` / `compoundFor` had **zero direct test
  coverage** — only exercised transitively through `OkuMoney`'s own tests,
  which never drove the two defensive branches (branch 1's overhang path
  requiring `rate <= PRECISION && rateEnd != 0`; branch 2's `anchor > rateEnd`
  underflow guard) since `OkuMoney`'s writers never produce those states.
  Exposed both functions on `MathLibHarness` and added 12 direct tests in
  `test/lib/MathLib.t.sol` covering every branch, including both defensive
  paths, so they're verified rather than "presumed unreachable and therefore
  fine."
- ERC-8056's remaining value surface (`toUIAmount`, `fromUIAmount`,
  `balanceOfUI`, `totalSupplyUI`) had zero test references — only
  `supportsInterface` was covered. Added round-trip, zero-amount, and
  balance/supply-consistency tests for all four.

### RESOLVED: simulation-suite integrity audit found a real ~3.5% mechanism bug masked by a cancelling buffer `[EVM]`

**What happened:** a verification pass on the base+settlement simulation suite
(prompted explicitly to check whether "passing" numbers made real-world
sense, not just whether assertions were green) found that `deriveSettlementRate`
never subtracted the base window's own projected distribution over its
remaining tail (staging → `baseEndSec`), and `distributedUsdOverWindow` silently
dropped the gap between the last sample and the window end. Together these
produced a **~3.5% systematic OVER-distribution** at recommended settings —
which happened to nearly cancel the deliberate 3% `conservativeFactor` buffer,
producing a reported ~0.5% error that looked like the mechanism working
correctly. It was not: with `conservativeFactor = 1.0` (no buffer), the
pre-fix mechanism over-distributed by ~3.5% on FLAT supply with ZERO
volatility — the case that should be exact.

**Also found in the same pass**, all fixed:
- The "epoch length is flat across 5 orders of magnitude" finding was a
  tautology — all 5 scenarios used identical FRACTIONAL staging lead and
  sample count, forcing identical discretization error by construction. Fixed
  to use absolute (non-fractional) staging lead + sample cadence — see the
  residual limitation noted in `epochAccounting.simulation.ts`'s "Epoch
  length" describe block (the mid-epoch shock's position is still fractional,
  so the fix is partial; not fully chased down per the "don't
  over-troubleshoot" directive).
- The "no-split" control used `baseWindowFraction: 1.0`, which still runs a
  same-rate settlement window — not a genuine feed-forward baseline. Added a
  `noSettlement` mode that runs one rate for the whole epoch with no
  correction at all, which is the honest comparison.
- Several assertions were vacuous (`.to.not.be.NaN`, `.to.be.greaterThan(0)`
  on obviously-positive quantities) or compared against the wrong baseline
  (asserting near-zero error against raw `Y*` for scenarios that DELIBERATELY
  apply a buffer, where a permanent ~-3% gap vs. raw `Y*` is correct behavior,
  not error). All replaced with concrete bounds against the correct baseline.
- The on-chain/model parity assertion had 5+ orders of magnitude of slack
  (`< 0.01%` threshold vs. `~1e-7%` measured) — tightened to `< 1e-5%`. This
  tightening then caught a SECOND real bug: the simulation's ground-truth
  model used the un-clamped theoretical rate while the actual contract call
  used `floatRateToBigint`'s clamped rate, producing a spurious ~25.6%
  "divergence" on the one scenario extreme enough to trigger clamping. Fixed
  by re-deriving the model's rate from the clamped bigint everywhere.
- Zero test coverage existed for: the carry mechanism across multiple epochs
  end-to-end against a real contract, a genuine `MAX_RATE`-clamping scenario,
  and a negative-carry (deceleration) scenario. All three added.

**Status: fixed and re-verified.** `test/hardhat/unit/epochDistribution.test.ts`'s
"CORE VALIDATION" test proves flat supply + no buffer now lands within 0.1% of
`Y*` (was ~3.5%). All 25 simulation scenarios re-run and pass with numbers that
now compose correctly (e.g. the recommended and excessive buffer scenarios land
almost exactly on `-(1-conservativeFactor)`, as they should). Every accuracy
number in `EVM/README.md` § Rear-Facing Epoch Accounting has been regenerated
from the fixed mechanism. See `EVM/scripts/utils/epochDistribution.ts` for the
fix itself and its doc comments for the precise mechanism.

### RESOLVED: fork runs dirtied the tracked address book `[EVM]`

`scripts/config/addresses.json` is **tracked**, and every fork run wrote
`fork:<chain>` entries into it — `dryRunForks.sh`, a hand-run
`npm run deploy --network localhost`, and the hardhat drills alike. Those
addresses are ephemeral by construction (the fork is torn down seconds later),
so the diff was pure noise, but it showed as an uncommitted change and was easy
to commit by accident.

**Fixed structurally rather than per-caller.** `scripts/utils/addressBook.ts`
now splits the book across two files by key prefix:

| File | Tracked? | Keys |
|---|---|---|
| `scripts/config/addresses.json` | tracked | live chains (`base`, `sepolia`, …) |
| `scripts/config/addresses.local.json` | **gitignored** | local forks (`fork:base`, …) |

`loadAddressBook()` returns a merged view of both, and `saveAddressBook()`
re-derives the partition on every write — so a fork entry cannot reach tracked
state regardless of how a caller assembled the object. The reserved `upgrades`
audit-trail index is partitioned the same way, so fork upgrade records don't
leak either. The local file is created only when fork state exists and removed
when the last fork entry goes, so pure-live workflows never see a stray file.

**Chosen over the alternatives** (an `ADDRESS_BOOK_PATH` env override set by
`dryRunForks.sh`, or snapshot/restore inside the shell script) because those
fix only that one script — a hand-run local-fork deploy would still dirty the
file. This approach requires nobody to remember anything.

**Contained to one file:** every caller already routed through
`loadAddressBook` / `saveAddressBook` (the latter has exactly one call site
outside the helper, in `deploy/index.ts`), so `deploy/index.ts`,
`upgrade/index.ts`, `verify.ts` and all 14 operator scripts needed no changes.
One test did: `deployDrill.test.ts` read the raw tracked file to assert the
written entry, and now reads the merged view.

**No migration needed** — the committed `addresses.json` was verified to hold
only live keys (`sepolia`, `baseSepolia`, `bscTestnet`, `base`, `bsc`,
`arbSepolia`); there were no `fork:` entries to move.

**Coverage added:** `addressBook.ts` previously had **no** direct unit tests —
only indirect exercise through the drills, which is how this went unnoticed.
`test/hardhat/unit/addressBook.test.ts` (12 tests) now covers the split,
the merged read, `upgrades` partitioning, local-file lifecycle, and — as the
direct regression guard — that the tracked file is **byte-identical** across a
pure fork run. `deployDrill.test.ts` additionally asserts the tracked book
contains no `fork:` keys after a real deploy.

**Verified** by running `./scripts/deploy/dryRunForks.sh sepolia` and
confirming `git status` reports `addresses.json` clean.

### Carry-ledger + V̄-sample-store persistence `[EVM]`

**Decision made:** yield is fully **rear-facing** with fixed epochs — the rate
published for an epoch is derived from the prior epoch's confirmed, realized
off-chain proceeds, divided by that epoch's TIME-WEIGHTED AVERAGE global value
(not a spot value — see "Two V's" below). No forecasting, no deliberate
withholding by default. See `EVM/README.md` § Rear-Facing Epoch Accounting for
the full mechanism (the impossibility of hitting a nominal USD amount exactly,
why a rate-based design is a reframe rather than a downgrade, and the
cumulative-conservation identity), and
`EVM/scripts/utils/yieldRate.ts::realisedYieldToRatePerSecond` /
`reconcileActualPayout` for the implementation (unit-tested in
`EVM/test/hardhat/unit/yieldRate.test.ts`).

The carry/measurement math itself required no contract changes — every input
is off-chain, feeding the existing `setOkuMYieldRate` / `setNextOkuMYieldRate`
rate integers. Adopting the base+settlement design on top of it DID add one
contract function, `setOkuMYieldRateWithSuccessor` — a pure atomic composition
of the two existing setters (no new state, no new validation logic beyond
what each already had) closing a real two-transaction race the base+settlement
model otherwise hits every epoch — see the "Epoch-grid convention" item below.

The remaining gap either way: **both the carry balance and the V̄ sample
history are cross-chain-critical state with no on-chain representation.** The
published rate is independently verifiable via `okuMRatePerSecond()`; neither
the carry balance nor the time-weighted average backing that rate is
verifiable by anyone except whoever holds the off-chain stores.

**Resolves the previously-filed "AUM-drift: realized payout ≠ realized yield"
item.** That item's root cause was `realisedYieldToRatePerSecond` dividing by a
SPOT global value at epoch start rather than a time-weighted average, which
made the accounting error scale with AUM growth (5–25% for realistic mid-epoch
mint volume — see the "spot vs time-weighted" test in
`EVM/test/hardhat/unit/yieldRate.test.ts`). Fixed by requiring the denominator
to be `measuredAvgValueUsd`, a time-weighted average (see "Two V's" in
`EVM/README.md` § Rear-Facing Epoch Accounting). The residual that remains
after this fix is driven by RATE drift between the measurement and paying
epochs, not AUM — an order of magnitude smaller (see the buffer-sizing table
in that same README section: single-digit percent of the distribution for
normal epoch-to-epoch rate changes, vs. 5–25% from the AUM term this replaces).

Reference implementations now exist for both, explicitly marked as
reference-only in their own module docs:
- `EVM/scripts/utils/carryLedger.ts` — append-only local JSON ledger of every
  epoch's rate derivation; `summarizeLedger()` computes the cumulative
  conservation identity. Read (diagnostic-only) by `checkMultiplierDrift.ts`.
- `EVM/scripts/utils/globalValue.ts` + `EVM/scripts/operator/sampleGlobalValue.ts`
  — cross-chain `totalSupply() * okuMMultiplier()` sampler + local JSON store;
  `samplesInWindow()` feeds `timeWeightedAverage()` for a given epoch.

**Follow-up required before this can be closed:**
- **DECIDED** (`SVM/DECISIONS.md` D-26): a **signed off-chain ledger**, not
  on-chain anchoring. Still a **mainnet prerequisite** — the stores must become
  durable, versioned, append-only and signed before they back real rate
  decisions. Under a backend-controlled architecture these files ARE the
  protocol's system of record; losing them means the cumulative-conservation
  identity cannot be reconstructed.
  The trade-off (rate-derivation inputs are trusted, not provable from public
  data) is documented for users in the root `README.md` § "What is and isn't
  independently verifiable". Anchoring a per-epoch hash on-chain remains
  available and additive if third-party verifiability ever becomes a
  requirement; it needs no change to any deployed contract.
- Decide the V̄ sampling cadence (recommended: hourly) against actual AUM
  volatility, and confirm it's fine-grained enough that `samplesInWindow`'s
  ">= 2 samples" floor is never the binding constraint on measurement accuracy.
- **`globalValue.ts` now includes SVM** and requires `SVM_RPC_URL`,
  `SVM_LITE_PSM_PROGRAM_ID` and `SVM_OKU_M_MINT`. If unset, SVM is excluded
  from V(t) and — since V is the DENOMINATOR — every derived rate comes out
  too high. It warns, but consider failing hard once SVM is live.
  See `SVM/DECISIONS.md` D-27.
- Decide whether `checkMultiplierDrift.ts` should assert the published rate is
  consistent with a declared `(epochId, realisedYieldUsd, measuredAvgValueUsd,
  carryInUsd)` tuple per epoch (it currently only reports the ledger's
  cumulative summary, it does not cross-check a given epoch's derivation
  against on-chain state). Note this is the *internal* equivalent of the
  third-party verifiability declined in D-26 — same cross-check, run by us
  against our own ledger rather than by anyone against a published hash.
- If `conservativeFactor < 1` is ever adopted (not the current default),
  confirm the steady-state carry buffer it implies
  (`realizedYieldPerEpoch × (1 − conservativeFactor)`) is an acceptable
  permanent float, not a number picked without doing this arithmetic.

### Epoch-grid convention: length, anchor sizing `[EVM]`

**Decision made:** base + settlement window ("design B3") is adopted — see
`EVM/README.md` § Rear-Facing Epoch Accounting for the mechanism,
`scripts/utils/{epochDistribution,epochSchedule}.ts` for the implementation,
and `test/hardhat/simulation/epochAccounting.simulation.ts` (26 scenarios
against a real deployed contract) for the accuracy characterization —
on-chain/off-chain model parity held to ~1e-7% across every normal-range
scenario (looser, ~1e-5%, at the deliberate `MAX_RATE`-clamping scenario).
Settlement-window sizing is solved generically: `DEFAULT_SETTLEMENT_FRACTION =
1/15` scales proportionally with epoch length (2 days of 30, 4 minutes of 1
hour), rather than needing a fixed absolute value.

`baseWindowFraction = 0.9` is now backed by a targeted experiment, not just
the general axis table: a +50% shock landing specifically INSIDE the
settlement window (after its rate is already staged against a forecast that
couldn't see it) shows `0.9` at −0.57% error vs. `0.3` at +13.99% — confirming
the claimed risk (0.3 concentrates target weight into the settlement window)
is real. An earlier version of this recommendation cited only a mid-BASE-window
shock scenario, which does not actually test that claim (a smaller base
commitment means LESS exposure to a shock landing IN the base window) — see
the "EXPERIMENT" test in the simulation suite.

Still undecided: the concrete epoch LENGTH and ANCHOR timestamp.
`checkMultiplierDrift.ts` supports an OPTIONAL epoch-grid alignment check
(`EPOCH_ANCHOR_UNIX` / `EPOCH_LENGTH_SECONDS` / `EPOCH_GRID_TOLERANCE_SECONDS`
env vars) that is skipped entirely until these are set, specifically so this
decision isn't forced by the tooling.

**Follow-up required before this can be closed:**
- ~~Pick epoch length~~ — **DECIDED: 30 days, anchored 2026-01-01T00:00:00Z**,
  committed in `EVM/scripts/config/epoch.ts` (`SVM/DECISIONS.md` D-23).
  Retained below for the reasoning. The simulation's epoch-length axis is a MECHANISM smoke
  test (confirms the contract/schedule work correctly from 1 hour to 90 days),
  **not an isolated accuracy comparison** — measured error came out flat
  (2.27–2.29%) across all five lengths, but this is very likely because the
  shock scenario's position is still specified as a fraction of the epoch, so
  it scales alongside the (now-absolute) staging lead — see the "Known
  test-design limitation" note in `EVM/README.md` § Rear-Facing Epoch
  Accounting. This axis has not demonstrated a genuine accuracy-vs-length
  relationship either way; do not cite it as one. The DECISIVE constraint
  remains operational: a 1-hour epoch leaves only a 4-minute settlement-staging
  window, unrealistically tight for a reliable transaction. Sub-day epochs are
  characterized but not recommended; 7–30 days is the practical range.
  **Follow-up:** if a genuine accuracy-vs-length comparison is wanted, fix the
  shock's position to an ABSOLUTE time (not `atFraction`) so it doesn't scale
  with the epoch under test. **Not worth doing first** — with on-chain grid
  validation declined (D-22), epoch length is a backend constant and changing
  it later is a config edit, not an upgrade. Recommendation is 30 days on the
  operational argument alone. See `SVM/DECISIONS.md` D-23.
- ~~Pick `conservativeFactor`~~ — **DECIDED: 1.0**, already the shipped
  default. An earlier 0.97 recommendation was withdrawn: it was justified as
  protection against the early-shock overshoot, and a 3% margin against a ~28%
  overshoot is not meaningful mitigation (`SVM/DECISIONS.md` D-24). Original
  analysis retained: (recommended: ~0.97 — simulation shows the
  recommended and excessive settings now land almost exactly on
  `-(1-conservativeFactor)` post-fix: 0.97 → −3.00%, 0.5 → −50.00%, confirming
  the buffer costs exactly what it's designed to and no more).
- ~~Once decided, set the `EPOCH_ANCHOR_UNIX`/`EPOCH_LENGTH_SECONDS` env vars~~ —
  **DONE.** `checkMultiplierDrift.ts` now defaults to the committed grid, so
  the alignment check runs rather than being silently skipped; env vars remain
  as overrides.
- ~~Consider whether the epoch grid should be validated ON-CHAIN~~ —
  **DECIDED: no.** Pure business policy, and it would hard-code a still-open
  parameter (epoch length) into six live contracts, turning a config choice
  into an upgrade. Detection stays in `checkMultiplierDrift.ts`'s optional
  grid check. See `SVM/DECISIONS.md` D-22 and the governing principle there.

### Early-shock detection: no automated monitoring for the "irreversible base-window overshoot" failure mode `[EVM]`

The simulation surfaced a real, non-obvious finding (see `EVM/README.md`
§ Rear-Facing Epoch Accounting, "monotonicity means an early shock is worse
than an equal-size late one"): because the multiplier is monotonic, an early,
long-duration supply shock can push actual distribution past the epoch target
BEFORE the scheduled settlement-staging instant — at which point settlement
can only halt (`PRECISION`) going forward, never claw back the overshoot. In
the simulation this produced the WORST error of any scenario tested (28.61%
for a shock at 5% through the epoch, vs. −0.82% for the identical shock at 97%
through).

The mitigation is straightforward in principle — monitor `distributedSoFarUsd`
continuously (computable live via `globalValue.ts` samples +
`epochDistribution.ts::distributedUsdOverWindow`) and trigger an emergency
re-anchor to `PRECISION` via `setOkuMYieldRateWithSuccessor` the moment it
exceeds target, rather than waiting for the scheduled staging time — but it is
**not implemented**. Today, detecting and responding to this failure mode is
entirely manual.

**DECIDED: the exposure is accepted** (`SVM/DECISIONS.md` D-25). Supply
shocks are treated as part of the deal; the mitigation is conservative
off-chain and on-chain liquidity plus conservative rate-setting, not
additional guards. What is being accepted, numerically: at $100M AUM / 5% APY
/ 30-day epochs, the worst TESTED overshoot of 28.61% is ~$118k
over-distributed and irreversible — and 28.61% is the worst case tested, not a
proven bound. The monitor remains available (it needs no contract change) if
that proves uncomfortable.

### EVM/SVM yield-model divergence — RESOLVED `[SVM]`

SVM's `lite-psm` has been ported to EVM's streaming rate-schedule
model. The multiplier is no longer stored or bumped: it is computed on
read from six schedule fields on `PsmConfig` plus
`Clock::unix_timestamp`, via a line-for-line port of `MathLib.sol` in
`crates/oku-shared/src/rate.rs`.

What this closed:

- **The MEV window.** There is no longer a discrete tick to straddle,
  which is what the EVM refactor set out to remove and what widening
  the sandwich lock could never fix.
- **The "no messaging" carve-out.** Both stacks now run the same
  `rpow` at the same `PRECISION = 1e18` with the same half-up
  rounding, so a schedule broadcast everywhere produces the same
  multiplier at the same wall-clock second. The sandwich lock is
  re-scoped to the emergency override only, which also retires the
  "wait one slot after a price tick before bridging" rule.
- **The 365.24-day friction.** Moot: Token-2022's
  `InterestBearingConfig` is not used, so no token-program rate math
  happens on our behalf. Both stacks consume the same derived
  per-second integer under the same 365-day convention.

`PRECISION` moved 1e9 → 1e18, which was forced rather than cosmetic —
at 1e9 one ulp of a per-second rate is 3.2% APY, so the schedule was
literally inexpressible.

**Since closed (see `SVM/DECISIONS.md`):**

- **D-05 DONE** — cross-language differential harness. 3,290 vectors
  generated from the Solidity reference and replayed against Rust and
  TypeScript, reverts included, all three agreeing exactly. Validated by
  mutation: a one-ulp rounding slip fails 1,218 vectors.
- **D-03 / D-04 handled** — `globalValue.ts` and `checkMultiplierDrift.ts`
  now read SVM. The former mattered economically: SVM supply is a term in
  the denominator of every derived rate, so omitting it systematically
  over-paid yield.
- **D-15 FIXED** — compute budget. The first implementation cost >200k CU
  in the two-`rpow` overhang branch, i.e. mints and redeems would have
  failed outright after every epoch handover. Now ~81k worst case, pinned
  in CI.

**Still open:**

- **D-01** no `MAX_ACCRUAL_WINDOW` on either stack. Deferred because it is
  the only item touching `OkuMoney.sol`, which is live on six networks, so
  it needs a scheduled upgrade rather than a code change. Nothing depends
  on it.
- **D-16** wallet display freshness now depends entirely on the
  permissionless crank. Bounded and safe (the mirror reads low, never
  high), but an operational responsibility.
- Wallet display remains a lagging staircase — unavoidable, since
  `ScaledUiAmount` cannot stream and `InterestBearingConfig` is
  mutually exclusive with it.

### Deploy readiness — internal testing MVP `[both]`

Audited both stacks' deploy pipelines end to end ahead of an internal-testing
deploy (testnets: sepolia/baseSepolia/arbSepolia + SVM devnet). Findings below;
the code-level fixes are recorded in `SVM/DECISIONS.md` D-28 (cross-stack
epoch orchestration) and D-14 (extended `tsc` coverage). This entry is the
deploy-specific summary.

**EVM contracts currently live on all six networks predate the
streaming-accrual refactor entirely** — at the last live redeploy commit,
`OkuMoney.sol` had zero references to `setOkuMYieldRate`/`okuMRatePerSecond`.
A fresh deploy is required on the EVM side too, not just SVM. Decided:
bump `DEPLOYMENT_VERSION` to `v0.3` for a clean CREATE2 generational break;
archive `scripts/config/addresses.json` before deploying so the old v0.2
addresses are preserved for reference rather than overwritten. **Not yet
done** — this pass fixed the tooling and correctness bugs the deploy would
have exercised; the deploy itself is a separate step.

**SVM: clean-slate redeploy, not an in-place upgrade.** Decided (not just
because the config layout grew 562→626 bytes, which alone would have been a
clean init at an already-empty PDA): close the existing program
(`close-programs --allow-anchor-toml-ids`, recovering ~4.35 SOL of stranded
ProgramData rent), rotate `target/deploy/lite_psm-keypair.json`, run
`anchor keys sync` (NOT on the standard build path today — `build.ts` only
does this on the fork path — must be done explicitly), update `Anchor.toml`
and `declare_id!`, then `deploy:programs` → `deploy:init` → `grant-roles`.

**SVM deployment state files were stale and actively misleading — archived,
not fixed in place.** `deployments/devnet.json`'s recorded `psm_config` PDA
pointed at a 562-byte orphan the current (626-byte) program cannot
deserialize, alongside dead two-token-model keys (`tokens.okuMoney`,
`tokens.usdOku`, `redemptionQueue`, `vaultConfig`) and three `OkuDollar`
upgrade records for a program that no longer exists in this workspace.
`devnet-fork.json` additionally carried a live `okuDollarProgram` reference
and pointed at the wrong program ID entirely. Both renamed to
`*.v1-pre-streaming.json` (see `SVM/oku-programs/deployments/README.md`)
rather than left in place — `saveDeployment`'s merge behavior
(`{...existing.tokens, ...addresses.tokens}`) would have carried every dead
key forward into a "fresh" file otherwise.

**The SVM upgrade path (`scripts/upgrade/`) is broken for this class of
change, in three ways — moot given clean-slate redeploy, but worth recording
so `npm run upgrade` isn't reached for reflexively on a future layout
change:** the IDL-diff guard is inert whenever the prior deployment record
has no `idlSnapshot` (true today); the pre/post state-invariant check
excludes fetch errors from its diff, so if BOTH the pre- and post-upgrade
account reads fail (as they would here, since the real config PDA doesn't
exist) it prints a false "all state invariants preserved"; and
`didUpgradeLand`'s post-timeout recheck hashes the on-chain ELF without an
`expectedSize`, so it can never match once the account has grown from a
prior generation's smaller allocation. None of the three were fixed this
pass — not worth it given the redeploy makes them unreachable for this
specific transition, but a genuine in-place upgrade later should not trust
any of these three checks without revisiting them first.

**`verify.ts` was existence-only** and would have reported the stale
562-byte orphan config as a passing check. Fixed: now also checks owner,
account size against `PSM_CONFIG_LEN`, and the `PsmConfig` discriminator.

**`initialize.ts` wired `direct_minter` post-init but never `direct_burner`**
— the SVM→EVM bridge burn path was silently dead until a separate
`grant-roles` run, with nothing surfacing the gap. Fixed: mirrors the
`direct_minter` wiring exactly.

**`runEpoch.ts`'s `roll-epoch` phase derived its rate from the LOCAL
reference chain's supply, not the global value across all chains** —
exactly the mistake `distributeYield` was removed for, reintroduced at the
operator-tooling layer instead of the contract layer. Running the (correctly
documented, single-chain) script once per EVM chain, as its own usage
examples instruct, would have derived a **different rate per chain**. Fixed,
and replaced with a proper derive-once/broadcast-to-all architecture — see
`SVM/DECISIONS.md` D-28 for the full writeup, including what is explicitly
NOT yet done (the V̄ sampler has never been run on a schedule, so the new
path is correct but not yet exercised end-to-end against a live deployment).

**Both stacks now typecheck clean, including scripts (not just tests).**
SVM's `tsconfig.json` only ever covered `tests/**`, so `npm run typecheck`
passed while hiding a real compile error in `withdraw-buffer.ts` (dead
account keys an instruction doesn't take) — see `SVM/DECISIONS.md` D-14.

**Follow-up required before this can be closed:** actually run the EVM v0.3
and SVM clean-slate deploys; bootstrap the V̄ sampler on a schedule; run one
full derive→broadcast→drift-check cycle against the live testnet + devnet
deployment as the closing verification.

### RESOLVED: SVM `tsc --noEmit` now passes, tests AND scripts `[SVM]`

Was 21 errors across the bankrun test files (`Program<LitePsm>` vs
`Program<Idl>` generic-variance around `addEventListener`), fixed by typing
the shared test helpers concretely. This entry's title said RESOLVED before
that fix actually shipped — left contradicting its own body for a full pass;
corrected here.

Extended further during the deploy-readiness pass: `tsconfig.json`'s
`include` was `tests/**/*` only, so `npm run typecheck` — gated in CI —
covered zero scripts and was hiding a real compile error in
`withdraw-buffer.ts` (dead account keys an instruction doesn't take).
`include` now covers `scripts/**/*` too; see `SVM/DECISIONS.md` D-14.

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

### Branch coverage is the weak spot in an otherwise strong forge suite `[EVM]`

CI gates on **line** coverage (95% per `src/` file) and the suite clears it
comfortably — 98.90% lines, 99.32% functions, 576/576 passing. **Branch**
coverage is materially weaker and ungated:

| File | Branches |
|---|---|
| `src/psm/LitePSM.sol` | 74.07% (20/27) |
| `src/lib/MathLib.sol` | 75.00% (9/12) |
| `src/token/OkuDollar.sol` | 81.25% (26/32) |
| **Total** | **85.48% (106/124)** |

`LitePSM` being lowest is notable given `_redeemOkuMShared` is already flagged
under "Audit-attention surfaces" below as the densest control flow in the EVM
suite — the branchiest function is also among the least branch-covered. Not
urgent (the uncovered branches are mostly defensive/unreachable-by-construction
paths), but it's where an auditor will look first, and worth closing before
external review rather than during it.

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
