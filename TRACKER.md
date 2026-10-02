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
   front-running can only pay the caller *more*. **This collapses the moment a
   PSM fee exists** — see the fee entry below. Pinned by
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
   breaks it. The weak region is just *below* a power of two (measured minimum
   bias 1.05e-16 at m≈1.306e23), not at m≈1e18 — any sampling that skips it
   over-measures the margin several-fold. The invariant is checked in exact
   integer arithmetic (`f64_conversion_never_exceeds_canonical_exactly`); do
   not simplify it back to a float threshold.

---

## 🟡 Should-fix before external audit

### OPEN: queue dust floor collapses to 1 wei on 18-decimal collateral `[EVM]`

`_redeemOkuMShared` gates minimum redemption at `okuMAmount <
decimalMultiplier`. `decimalMultiplier` is `10**(18-d)`, so the floor is
`1e12` OkuM wei (~$0.000001) at 6 decimals and **`1`, i.e. nothing,** at 18.
Combined with there being no fee (round-tripping the PSM is free, so the
buffer can be drained to force redemptions into the queue), queue-stuffing is
cheap on an 18-decimal chain.

**Deliberately not fixed.** The fix is an absolute minimum-redemption
parameter independent of `decimalMultiplier` — new storage, new admin lever,
SVM parity obligation — and it *overlaps directly with the open fee decision*
below, which prices queue entry in dollar terms rather than in units that
scale with collateral decimals. Resolve the fee question first.

**Operational trigger:** only materialises on a chain deployed against
genuinely 18-decimal collateral. Treat `SKIP_MOCK_USDC=true` on BSC as
requiring the fee decision to be resolved first. See `EVM/README.md`
§ Accepted Risks, "queue dust floor".

### OPEN: no PSM swap fee — the largest open economic question, gates three findings `[EVM][SVM]`

**There is no fee anywhere in the protocol.** Not on `mintOkuM`, `redeemOkuM`,
`mintUsdOku`, `redeemUsdOku`, nor their SVM counterparts.
`Constants.BASIS_POINTS` exists and is read by nothing — its own doc comment
says so — which suggests a fee was intended once and never landed.

The two Accepted Risks below should be read as **consequences of this one open
decision**, not as independently accepted residuals.

**What a fee would close**

| Item | Today | With a fee |
|---|---|---|
| **Emergency-override sandwich** (AR "discrete-tick MEV") | `YieldSandwichGuard` is forward-only: it blocks the same-block backrun but not a mint one block before the override paired with a redeem one block after. That captures the whole discrete step on **one block** of capital exposure, for gas. | A round-trip must clear `tin + tout`. Even 1–5 bps makes the one-block hold unprofitable for any realistic step, without touching the guard. |
| **Free buffer drain** | `mintOkuM -> redeemOkuM` costs only gas and at most one collateral unit of dust, so transient capital can drain the buffer to par and force all redemptions into the queue. | Round-tripping becomes strictly loss-making. |
| **Queue stuffing** (AR "queue dust floor") | Once the buffer is empty, entries can be created at the dust floor, which collapses to 1 wei on 18-decimal collateral. The processor pays full loop-body gas plus an external `burn` per entry. | Prices entry creation in **dollar** terms rather than in units that scale with collateral decimals. |

That last row is why a fee and an absolute minimum-redemption floor are
**alternative** fixes — so the dust-floor item must not be closed
independently of this one.

**What it would cost**

- **Peg band widens to `[1 - tout, 1 + tin]`** rather than exactly 1. This is
  the real trade, and it is a product decision, not an engineering one.
- **ERC-4626 conformance.** `mintUsdOku`/`redeemUsdOku` route through
  `OkuDollar`, so the fee must appear in `previewDeposit`/`previewMint`/
  `previewWithdraw`/`previewRedeem` — but **must not** appear in `convertTo*`,
  which the spec requires to be fee-free. The two families diverge; a classic
  integrator-bug source.
- **Rounding placement** must be identical on both stacks or it becomes a new
  differential-parity obligation. Applying the fee after `dollarsToOkuM`
  compounds two truncations; before it changes the dollar basis.
- **Test surface.** Every PSM test asserts exact conversion outputs.

**Where it would live:** `LitePSM` storage + an admin lever
(`PSM_FEE_MANAGER`?), mirrored by a `PsmConfig` field and a `set_fee`
instruction on SVM. Both need a hard upper bound in constants — an unbounded
fee setter is a rug vector — and the role sits alongside `PSM_BUFFER_*` in
`AUTHORITY-MATRIX.md`.

**Open sub-questions**

1. Symmetric (`tin == tout`) or asymmetric? Asymmetric lets the protocol lean
   against whichever direction is draining the buffer.
2. Does the fee accrue to the buffer (strengthening backing) or to a treasury?
   Buffer accrual is simpler and avoids a new withdrawal path.
3. Is a fee of zero a valid configured state? If yes, ship fee-capable and
   launch at zero. **This is probably the answer** — it decouples the mechanism
   from the economics call instead of blocking a deploy on it.

**Status: not decided, not implemented, no code written against it.**
`LitePSM.redeemOkuM`'s NatSpec names the no-fee property as the load-bearing
precondition for having no min-out parameter: if a fee lands, min-out
parameters must land *with* it, not after.

### OPEN: carry ledger + V̄ sample store are not durable `[EVM]`

Both are JSON files under `EVM/scripts/config/`, and both are **gitignored**.
Under a backend-controlled architecture these files *are* the protocol's
system of record: losing them means the cumulative-conservation identity
cannot be reconstructed.

**Decided:** a signed off-chain ledger, not on-chain anchoring. Anchoring a
hash on-chain proves the file was not edited after the fact but proves nothing
about whether its inputs were honest, which is the property that actually
matters — so it buys attestation theatre at the cost of a new write path.

**Still a mainnet prerequisite:** the stores must become durable, versioned,
append-only and signed before they back real rate decisions. The user-facing
trade-off (rate-derivation inputs are trusted, not provable from public data)
is documented in the root `README.md` § "What is and isn't independently
verifiable".

**Also open:**
- Should `checkMultiplierDrift.ts` cross-check a declared
  `(epochId, realisedYieldUsd, measuredAvgValueUsd, carryInUsd)` tuple against
  on-chain state? Undecided.
- `conservativeFactor < 1` keeps permanent float arithmetic in the derivation
  path. Currently 1.0, so moot — but a future change to it reopens this.

**Hazard worth stating once:** V̄ is the **denominator** of the rate
derivation, so a chain silently dropping out of the sample set makes every
derived rate come out *too high*. `SVM_EXPECTED=true` exists to turn that
specific silent failure into a hard error.

### OPEN: orchestration glue is untested and unexercised end-to-end `[both]`

The epoch math (`epochSchedule`/`epochDistribution`/`yieldRate`) is unit-tested
where it lives in `packages/yield-tooling`. The orchestration layer on top of
it is not:

- **`deriveRollEpoch`'s ex-post reconciliation is an approximation.** It infers
  the global actual-paid delta from the prior ledger entry's
  `measuredAvgValueUsd` times the reference chain's multiplier ratio, rather
  than a fresh global sample at the settlement window's close. Exact if
  `measuredAvgValueUsd` was correctly time-weighted (it is, structurally) and
  the multiplier ratio is identical across chains (which drift monitoring is
  supposed to guarantee) — but never exercised against a live multi-chain
  deployment.
- **The V̄ sample store has never been bootstrapped.** `sampleGlobalValueUsd`
  and its persistence half exist and are unit-tested, but nothing runs the
  sampler on a schedule. `deriveRollEpoch` hard-errors on an empty store, which
  is correct, but means the path cannot be exercised end-to-end until the
  sampler is wired into a cron.
- **`broadcastSchedule.ts`'s SVM leg has never run against a live SVM
  deployment** — verified by code review and by the shape of SVM's
  `set-yield-rate.ts --mode=atomic` CLI, not by an integration test.

**Trap that cost real time and will recur:** env-var names at a process
boundary are *generated* by `cli.ts`'s camelCase→SCREAMING_SNAKE transform and
appear literally nowhere at either end. An `EPOCH_PHASE` vs `PHASE` mismatch
was unreadable and only discoverable by execution. `broadcastSchedule` takes an
injectable `SubprocessRunner` purely so that boundary is assertable;
`broadcastSchedule.test.ts` pins the exact env every chain receives. Keep it.

### OPEN: `npm run upgrade` has three structurally broken checks `[SVM]`

Do **not** reach for it on an SVM layout change until these are fixed:

1. The IDL-diff guard is inert when the prior record has no `idlSnapshot`.
2. The pre/post state-invariant check excludes fetch errors from its diff, so
   if *both* reads fail it prints "all state invariants preserved".
3. `didUpgradeLand`'s post-timeout recheck hashes the ELF with no
   `expectedSize`, so it can never match once the account has grown.

Not fixed because the clean-slate deploy path avoids all three. Revisit before
any genuine in-place upgrade.

### OPEN: deferred audit items `[both]`

Reviewed, understood, deliberately not fixed:

- `approveAmount` validation on the EVM side.
- No paid-vs-queued return signal on the PSM redeem path, so a caller cannot
  tell from the return value whether they were paid or enqueued.
- `update_token_metadata` has no rent payer.
- Token-2022 CPI errors surface opaquely.
- **Cold-ATA compute is unmeasured.** The pinned 80,883 CU excludes first-time
  ATA creation (~+20–25k), which breaches the self-imposed 100k ceiling while
  staying inside Solana's 200k limit.

---

## Deploy-day runbook — internal-testing MVP

**Steps 0-2 are DONE.** Steps 3-7 remain. Each step's verification gates the
next.

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

### Remaining

**Status of steps 3-7 cannot be determined from the repo** — they depend on
operator `.env` state and on-chain calls. Confirm each before relying on it.

**3. Wire the bridge env. THE EASIEST STEP TO SKIP AND THE MOST COSTLY.**
Set `SVM_RPC_URL`, `SVM_LITE_PSM_PROGRAM_ID`, `SVM_OKU_M_MINT`, and
`SVM_EXPECTED=true` in `EVM/.env`. Until `SVM_EXPECTED=true` is set, a
missing/unreadable SVM config is a **warning**, SVM drops out of V̄, and every
derived rate comes out too high. Verify: `npm run operator:sampleGlobalValue`
lists `solana` in its per-chain breakdown with a non-zero value.

**4. Bootstrap V̄.** `operator:sampleGlobalValue` on a schedule (hourly
recommended). **At least two samples must exist spanning the measurement
window before any derivation** — `samplesInWindow` hard-errors below two, by
design. This is the one step with an unavoidable wall-clock wait.

**5. Set the first schedule.** No epoch exists yet, so there is nothing to
roll: use `operator:setOkuMYieldRate` directly per chain plus SVM's
`admin:set-yield-rate`, to put every chain on one identical
`(rate, rateEnd)`. Verify with `operator:checkMultiplierDrift` — it scans
every chain in `CHAIN_METADATA`, deliberately wider than the participating
set, so it will also flag the stale pre-streaming `base`/`bsc` mainnet
deployments; that is expected and is not a failure of this deploy.

**6. First full epoch cycle.** `operator:deriveEpochSchedule` with
`PHASE=stage-settlement`, then `operator:broadcastSchedule` for that
artifact; later `PHASE=roll-epoch` and broadcast again. Run both with
`DRY_RUN=true` first — the broadcaster propagates it to every subprocess and
skips the ledger write. For internal testing pass a short `EPOCH_LENGTH_SEC`
(the contracts impose no epoch-length constraint; see
`scripts/config/epoch.ts`), accepting that the settlement window scales down
with it.

**7. Close the loop.** After the first `roll-epoch` broadcast, confirm the
carry ledger has exactly one row per epoch, that the prior row's
`reconciledCarryUsd` was backfilled, and that `checkMultiplierDrift` reports
agreement across all four testnets and SVM.

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
