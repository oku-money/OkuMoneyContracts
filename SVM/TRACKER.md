# SVM follow-up tracker

Items deferred from earlier review passes. Items here are scoped, not lost.

**Status legend:** ✅ landed, 🟡 partially landed / in progress,
⏳ deferred to a future pass.

---

## ✅ Phase 13c — Pre-devnet polish pass

Post-13b cleanup: surface and fix the remaining drift before the next
devnet redeploy. Same test posture as 13b (159 passing, 1 pending,
0 failing; `anchor build` clean).

Landed:

- **`scripts/admin/process-queue.ts` rewritten.** Previously hard-coded
  `MAX_ENTRIES = 10` and used `% 10` to index `entries[]` — against
  the 200-entry queue this would pay the wrong recipients for any
  entry past slot 9. Now:
  - Constants mirror Rust: `QUEUE_MAX_ENTRIES = 200n` (bigint),
    `MAX_BATCH_ENTRIES = 50`.
  - `head`/`tail` decoded through `BigInt(bn.toString())` end-to-end —
    no `Number()` truncation possible.
  - **Auto-loops until empty.** A single invocation can fully drain a
    full 200-entry queue (4× 50-entry batches). Each batch re-fetches
    the queue so the head is always current; bails if the on-chain
    handler returned early (e.g. all-skipped slots or vault depleted).
  - `--max=N` caps total drain across batches; default is drain-to-empty.
  - `--dry-run` plans + describes batches without submitting.
- **`scripts/utils/addressBook.ts`** gained a program-ID-mismatch guard.
  `loadDeployment()` now diffs the on-disk `deployments/<network>.json`
  against `Anchor.toml [programs.<section>]` and prints a loud
  `[addressBook] WARNING` block on any mismatch (the exact failure
  mode that's currently latent in `deployments/devnet.json`).
  `loadDeploymentStrict()` is available for callers (deploys, mainnet
  admin paths) that should refuse to run on mismatch. Rent-recovery
  instructions are documented inline (see `TESTNET_DEPLOYMENT.md`).
- **`scripts/test/test-devnet.ts` gained a `queueRedeem` step.** Drains
  the USDC buffer to zero, submits a `redeem_oku_m` that's forced into
  the queue path, refills the buffer, then invokes `process_queue`
  (auto-batched at `MAX_BATCH_ENTRIES = 50`) to drain. Asserts head
  advanced, `total_queued_oku_m == 0`, and recipient USDC went up. This
  is the first live-cluster coverage of the Phase 13b queue path —
  previously verified only in bankrun.
- **`readState` step** updated to compute pending via BigInt, surfaces
  `Capacity (MAX_ENTRIES) = 200`.
- **npm script rename:** `test:process-queue` → `admin:process-queue`.
  Consistent with the rest of the orchestrator-action namespace.
- **Doc drift cleanup**:
  - `programs/lite-psm/src/instructions/init.rs` doc-comments: "24 KB"
    → "9.6 KB / 9 640 bytes", "500-entry" → "200-entry".
  - `tests/bankrun/lite-psm.ts` ring-buffer wraparound test comments:
    500 → 200, 499 → 199.
  - `SVM/README.md`: `rescue_queue_entry(queue_index: u32)` → `u64`;
    diff-table queue-size row corrected to `[QueueEntry; 200]`;
    queue-capacity SLA block rewritten (was contradicting itself with
    "10-entry SLA"); cron template updated to `npm run admin:process-queue`;
    admin-table row renamed `test:` → `admin:`.
  - `SVM/TRACKER.md` Phase 4c section rewritten — original goal
    (`MAX_ENTRIES = 10` → bigger cap) was achieved by Phase 13b; what
    remains is the 200 → 500 follow-up via `init + 2× realloc` or
    per-user PDAs, deferred until telemetry justifies.
  - `TESTNET_DEPLOYMENT.md` SVM sections fixed: removed dead refs to
    `scripts/bridge/test-bridge-flow.ts`, `relay-from-evm.ts`,
    `deploy:verify`; replaced with `bridge:mint` + `test:onchain` +
    `bridge:state` (which all exist); added Test 4 (queue drain) and
    documented the stale-deployments-file rent-recovery workflow.

Recovered (Phase 13c followup):

- ✅ **Rent recovery for the stale devnet program IDs.** A new
  `npm run admin:close-programs` wrapper around `solana program close`
  landed in this pass and was used to close the three stale program
  data accounts authored by deployer
  `5WSQGabWxFT8Ge2CohzsD9ks4GtEyn2FbMEn91zDQeej`:
  - `3pi3vBj7dn98C4QbrrKD1LEFacpXBtmCzY17YR6j7wNa` (lite_psm) —
    5.44325592 SOL reclaimed
  - `AWwByFuQfnoiCEZAMdSc4WixepppzXXStXkQijPoKNi5` (oku_dollar) —
    2.70753048 SOL reclaimed
  - `JDa1YZH8VNjXiVxuBQfhU58fGvXRPuiTAt2t4hA5HAFS` (oku_bridge_router) —
    2.54594712 SOL reclaimed
  - **Total recovered: 10.696718520 SOL** (the ~0.000015 SOL delta vs
    the on-chain estimate is the three close-tx fees).
  - `deployments/devnet.json` is intentionally still present — the
    next `NETWORK=devnet npm run deploy:init` will overwrite it with
    the current `Anchor.toml [programs.devnet]` IDs. The addressBook
    warning will keep firing until then.

Also recovered in Phase 13c (orphan oku_dollar cleanup):

- ✅ `BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC` (oku_dollar,
  deployed at slot 443M — older than the now-closed `AWwBy…` round)
  closed via `npm run admin:close-programs --
  --ids=BjjK75Vx… --allow-anchor-toml-ids`. **2.509249 SOL reclaimed.**
  Total Phase 13c rent recovery: **13.205968 SOL** across four
  program data accounts (deployer wallet 22.33 → 35.54 SOL on devnet).
- ✅ Devnet keypair-derived IDs (`3pi3vBj7…`, `AWwByFuQ…`,
  `JDa1YZH8…` — same as `[programs.localnet]` and `declare_id!()`)
  will be the new devnet addresses on the next `deploy:programs`.
  `Anchor.toml [programs.devnet]` will be updated to those IDs
  post-deploy. Policy: **devnet and localnet IDs will remain
  separate** even though they currently coincide — keeps the option
  open to rotate one without touching the other if a future devnet
  keypair compromise scenario forces it. `deploy:programs` now prints
  the exact `[programs.<network>]` block to paste into `Anchor.toml`
  at the end of its run.

Also landed in Phase 13c (pre-devnet readiness pass):

- ✅ **Deployment file now persists `psmVaultUsdc` + `vaultOkuMoney`.**
  Previously `PsmInitResult` discarded `vaultUsdc` and `deploy-init.ts`
  never wrote either field — `admin:setup-router-alt` would throw
  `TypeError: Cannot read property of undefined` on line 64. Both
  fields now flow through `PsmInitResult → deploy-init.ts → pdas.*`
  in the deployment file. Files: `scripts/deploy/lib/initialize.ts`,
  `scripts/deploy/deploy-init.ts`.
- ✅ **`deploy:init` auto-runs the two post-init lockdown steps**
  (new `scripts/deploy/lib/post-init.ts`):
  - `initializeBlacklistExemptIfNeeded()` — reads `PsmConfig` to skip
    if both blacklist-exempt fields are already non-default; otherwise
    submits `initialize_blacklist_exempt` with the bridge config PDA
    + router program ID.
  - `setupRouterAltIfMissing()` — reads
    `deployment.addressLookupTables.router` to skip if the ALT is
    already recorded AND alive on chain; otherwise creates the ALT
    with all 17 entries and persists the pubkey.
  Both wired between `saveDeployment()` and `verifyDeployment()`, both
  wrapped in try/catch that downgrades failures to non-fatal warnings
  (so a temporary RPC blip doesn't kill the whole deploy). The
  standalone `admin:blacklist-exempt` and `admin:setup-router-alt`
  scripts remain for re-runs and share the same idempotency
  guarantees.
- ✅ **Anchor.toml policy guidance baked into the deploy script.**
  `deploy:programs` prints a `[programs.devnet]` block at the end with
  the freshly-deployed IDs. README + TESTNET_DEPLOYMENT.md call out
  the "devnet/localnet stay separate" policy.

Pre-devnet test posture: 159 passing / 1 pending / 0 failing on the
combined `npm test` (Rust + bankrun); `anchor build` clean; `tsc
--noEmit` clean on all modified TS files (the residual 28 errors are
the pre-existing `Program<Idl>` noise in `test-devnet.ts` only — `tsx`
ignores them).
- ⏳ End-to-end SVM-burn → EVM-mint round-trip script. Currently the
  operator chains `bridge:burn` + EVM-side mint manually with
  `bridge-request.json`. Not blocking devnet; on the backlog.
- ⏳ Migrate sites that still type-erase to `Program<Idl>` rather than
  the generated `Program<LitePsm>` / `Program<OkuDollar>` types (~20
  `tsc --noEmit` errors in `scripts/test/test-devnet.ts` only; `tsx`
  ignores them). Pre-existing, not introduced or worsened in 13c.

---

## ✅ Phase 13b — Zero-copy `RedemptionQueue` + 200-entry cap

Migrated `RedemptionQueue` from `#[account]` (Borsh-deserialized into a
BPF stack frame on every handler entry) to `#[account(zero_copy)]`
(byte-indexed directly out of account data). This unblocks the
`MAX_ENTRIES` bump from 10 → 200, a 20× improvement, and closes the
biggest functional gap with the EVM spec target.

The original Phase 13b plan targeted **500 entries** (matching the spec
target verbatim). During implementation a Solana runtime constraint
surfaced that I had not accounted for in the planning round: CPI-driven
account allocations are capped at `MAX_PERMITTED_DATA_INCREASE = 10_240`
bytes, and Anchor's `init` constraint goes through a
`system_program::create_account` CPI. A 500-entry queue would be ~24 KB
and require a multi-step `init + realloc + realloc` deploy flow. 200
entries (9 640 bytes) fits the single-CPI budget with ~600 bytes of
headroom and keeps the deploy script single-step.

Landed:

- **`RedemptionQueue`** → `#[account(zero_copy)] #[repr(C)]`,
  `MAX_ENTRIES = 200`, `head`/`tail`/`total_queued_oku_m` widened from
  `u32` → `u64` to remove the 4.3B-enqueue practical wrap. Pinned at
  `LEN = 9_640` via compile-time `assert!`.
- **`QueueEntry`** → `#[zero_copy] #[repr(C)]`. `bytemuck`'s `Pod` +
  `Zeroable` derived by Anchor's `#[zero_copy]` attribute. Total size
  pinned at 48 bytes via compile-time `assert!`.
- **`bytemuck = "1.17"`** with `derive` + `min_const_generics` features
  added to `programs/lite-psm/Cargo.toml`. Anchor 1.0 does not auto-pull
  bytemuck; the explicit dep is needed for any program with a zero-copy
  account.
- **Contexts retrofit**: `RedeemOkuM`, `ProcessQueue`, `WithdrawBuffer`,
  `RescueQueueEntry`, `SetupRedemptionQueue` all switched from
  `Account<RedemptionQueue>` → `AccountLoader<RedemptionQueue>`. The
  `bump = redemption_queue.bump` constraint pattern is incompatible
  with `AccountLoader` (the macro can't `load()?` to read a field
  there), so those sites now use bare `bump` and Anchor recomputes the
  bump from seeds (small CU bump per ix, negligible in practice).
- **Handler refactor**: every handler that touches the queue now holds
  the `AccountLoader::load()` / `load_mut()` borrow in a tight scope and
  drops it before any CPI. Held-across-CPI borrows would runtime-panic
  on the second `RefCell` borrow inside the CPI's re-entry. This is the
  load-bearing discipline for zero-copy with CPIs.
- **`process_queue` `MAX_BATCH_ENTRIES = 50` hard cap.** Without this an
  orchestrator could request `max_entries = 200` and OOM the CU budget
  mid-batch. 50 stays well under the 1.4 M raised-budget ceiling
  (empirically ~70 entries fit), leaves transfer-hook overhead room,
  and is documented inline at
  `programs/lite-psm/src/instructions/psm.rs::MAX_BATCH_ENTRIES`. To be
  revisited when real-workload telemetry shows we hit it.
- **`rescue_queue_entry` queue_index widened** from `u32` → `u64` to
  match the new head/tail width. TS-side test code passes `BN` instead
  of `number` accordingly.
- **Event fields widened to u64**:
  `RedemptionQueuedEvent.{queue_position,queue_length}`,
  `RedemptionSkippedEvent.queue_index`,
  `RedemptionRescuedEvent.queue_index`,
  `BufferRefilledEvent.{processed_count,skipped_count}`. Indexer
  consumers don't exist yet so the breaking change is free.

Verification (the spike that unblocked the migration):

- A throwaway `ZcSpike` zero-copy account + `init_zc_spike` instruction
  was added temporarily, exercised via a bankrun test that round-tripped
  `program.account.zcSpike.fetch(pda)` against an Anchor-set field
  value. Result: TS-side `.fetch()` decodes zero-copy bytes correctly
  with no manual decoder helpers. The throwaway code was torn out
  before the real migration started.

Tests:

- **All 158 pre-existing bankrun tests still pass.** Bit-for-bit
  identical results.
- **`queue ring buffer wraparound`** test rewritten. The pre-Phase-13b
  version forced 12 enqueue/process cycles to wrap a `MAX_ENTRIES = 10`
  ring. With `MAX_ENTRIES = 200` that approach would be slow; instead
  the new test seeds `head` and `tail` to 199 directly via
  `banksClient.setAccount`, enqueues twice, and asserts the second
  entry lands at ring slot 0 — proving the modulo wraparound with two
  cycles.
- **New `queue capacity (Phase 13b)` test** enqueues 50 entries to
  confirm `QueueFull` does not fire below the new cap (the old cap of
  10 would have tripped at entry 11). Cleanup processes in 5 batches
  of 10 to stay under the per-tx 200K CU budget.
- **Cargo unit tests**: 4 (lite-psm helpers) + 1 (router) + 7
  (oku-dollar helpers) + 6 (oku-shared math) = 18/18 still pass.

Open follow-ups:

- ⏳ Spec target was 500; we shipped 200. The remaining 2.5× gap is
  bounded by the 10 KB single-CPI allocation cap. To close it would
  require either a multi-step `setup_redemption_queue` flow
  (`init` + 2× `realloc`) or rebuilding the queue as per-user PDAs
  (Option A from the original Phase 4c outline). Defer until real
  workload telemetry shows queue pressure.
- ⏳ Tighter CU budget management on `process_queue`. Current `MAX_BATCH_ENTRIES = 50`
  is a static hard cap; a smarter version would inspect the per-tx CU
  remaining and walk only as many entries as fit. Defer until needed.

Deploy considerations:

- One-time rent jump: `RedemptionQueue` account rent grows from
  ~0.004 SOL (505 bytes) to ~0.067 SOL (9 640 bytes). Update the
  deployer SOL float accordingly. The on-disk
  `calculateDeploymentCost.ts` figure auto-updates via
  `scripts/lib/account-sizes.ts::REDEMPTION_QUEUE_LEN = 9_640`.
- No migration path for already-deployed programs — the prototype has
  no live deployment, so the next devnet redeploy starts fresh.

---

## ✅ Phase 13 — `#[derive(InitSpace)]` migration

Replaced the hand-counted `LEN` arithmetic on every `#[account]`
struct with Anchor's `#[derive(InitSpace)]`. The compile-time
`const _: () = assert!(T::LEN == N);` guards we already had now
serve as a **dual-witness check**: the hand-counted byte total on
the left, `InitSpace`'s field-by-field walk on the right, must
agree. Any field-type change that drifts the layout fires a hard
compile error instead of silently corrupting account allocation.

Landed:

- **9 `#[account]` structs** migrated:
  `PsmConfig` (690), `RedemptionQueue` (505), `BridgeConfig` (487),
  `BridgeNonce` (20), `ProcessedRequest` (89), `RefundedRequest`
  (89), `PendingRefund` (121), `OkuDollarConfig` (330),
  `RouterConfig` (170).
- **1 inner serializable type** migrated: `QueueEntry` (48). Used
  via `[QueueEntry; 10]` inside `RedemptionQueue`; `InitSpace`
  computes the fixed-size array as `10 * QueueEntry::INIT_SPACE`,
  no `#[max_len]` annotation needed.
- **Pattern per struct:** `pub const LEN: usize = 8 + Self::INIT_SPACE;`
  (8 = Anchor discriminator). Call sites using `space = T::LEN`
  unchanged; no caller had to be touched.
- **Pinned totals via `const _: () = assert!(T::LEN == N);`** for
  every account struct. If a reviewer changes a field type by
  accident (e.g. `u64 → u128`) the compile fails with a clear
  pointer-back to the assertion.
- **LOC delta:** -29 LOC across `state.rs` files (hand-counted
  byte tallies in doc-comments and arithmetic replaced by a single
  `8 + Self::INIT_SPACE` line + a one-line assertion).

Verification:

- `anchor build` clean (lite-psm + oku-dollar + oku-bridge-router).
- All 9 compile-time assertions hold (any mismatch would be a hard
  compile error, not a warning).
- 158 bankrun tests passing, 1 pending, 0 failing — bit-for-bit
  identical to pre-migration.
- 18/18 Rust unit tests across `oku-shared`, `lite-psm`,
  `oku-dollar`, `oku-bridge-router`.

---

## ✅ Phase 12 — Pre-internal-review polish

Pre-review cleanup pass. Goal: every reviewer-visible "why is this
duplicated / why is this 80 lines of boilerplate" question gets a
satisfying answer. 158 tests still green; `anchor build` clean.

Landed:

- **`oku-shared` workspace crate** (new at `crates/oku-shared`). The
  SVM-side counterpart to `EVM/src/lib/Constants.sol` +
  `EVM/src/lib/MathLib.sol`. Zero deps (no `solana-*`, no
  `anchor-lang`) so the build is cheap and version-conflict-free.
  Houses:
  - `PRECISION`, `BASIS_POINTS`, `MIN_COLLATERAL_RATIO_FLOOR`,
    `MAX_MULTIPLIER` (+ aliases `MAX_OKU_M_PRICE` and
    `MAX_USD_MULTIPLIER`), `ORACLE_MIN_STALENESS_SECS`,
    `ORACLE_MAX_STALENESS_SECS`, `TOKEN_DECIMALS`.
  - `mul_div_floor(a, b, divisor) -> Option<u64>` —
    overflow-safe + division-by-zero-safe `(a * b) / divisor` with
    u128 intermediate. Six other helpers (`oku_m_to_dollars`,
    `dollars_to_oku_m`, `calculate_fee`) trivially delegate to it.
  - 6 unit tests in `crates/oku-shared/src/math.rs`.
  - **Design rule:** returns `Option<u64>` (NOT a `Result` with a
    specific error type) so each program can map `None` to its own
    `Error::Overflow` without coupling the crates.

- **Workspace reshape** (`Cargo.toml`): `members = ["programs/*",
  "crates/*"]`. Keeps `anchor build` honest (it walks `programs/*`
  and requires the `idl-build` feature on every member there; the
  lib-only `oku-shared` lives in `crates/*` outside that scope).

- **lite-psm migration**: `programs/lite-psm/src/constants.rs` now
  `pub use oku_shared::{...}` for the protocol-wide constants and
  retains only the bridge-specific ones (`BRIDGE_DEADLINE_*`,
  `BRIDGE_MESSAGE_LEN`, `ED25519_*`, `MAX_SUPPORTED_CHAINS`,
  `MAX_NONCE_SKIP`). `programs/lite-psm/src/helpers/math.rs` is now
  a thin (3-fn) wrapper that maps `None` → `LitePsmError::Overflow`.

- **oku-dollar migration**: `programs/oku-dollar/src/constants.rs`
  now `pub use oku_shared::{...}` and retains only `MINIMUM_LIQUIDITY`.
  `programs/oku-dollar/src/helpers.rs` retains the multi-multiplier
  vault helpers (`calculate_collateral_ratio`, `calculate_surplus`,
  `shares_to_oku_money`, `oku_money_to_shares`,
  `is_sufficiently_collateralized`, `check_vault_yield_lock`) and
  delegates the single-multiplier ones to `oku_shared::math`.
  ~80 LOC of duplicated arithmetic gone.

- **`macro_rules! rotate_role!` collapse** of the 12-arm match in
  `set_authority` (`programs/lite-psm/src/instructions/psm_admin.rs`)
  and the 10-arm + 2-rejected match in `set_bridge_authority`
  (`programs/lite-psm/src/instructions/bridge_admin.rs`). Each
  shrunk from ~70 lines of `let old = config.X; config.X = new; old`
  boilerplate to a 12-/10-line dispatch table. Behavior is
  byte-for-byte identical; the privilege-escalation guard for
  `OrchestratorSigner | FeeRecipient` remains the explicit
  `require!` at the top of the bridge handler.

- **`process_queue` yield-lock rationale** documented inline on
  `programs/lite-psm/src/instructions/psm.rs` — explains why the
  function deliberately omits `check_yield_lock` (monotonic-non-
  decreasing prices mean queued users can only benefit from a
  same-slot yield op, never be harmed).

Deferred (per Phase 12 plan):

- `#[derive(InitSpace)]` migration — landed in Phase 13 above.
- Real `security@` email — still placeholder
  `security@okumoney.example` in all three programs' `security_txt!`
  blocks. Needs the real address from product.

---

## ✅ Phase 11 — Bankrun refinement / cleanup

**Status:** complete. Audit of the bankrun-era test surface; trimmed
dead code, removed adapter ceremony, centralised one of the trickier
bankrun quirks. 158 tests still green.

Landed:

- **PSM singleton removed** (`tests/shared/setup.ts`). The
  `psmInitialized` + `psmConfigPda` + `vaultUsdcAta` + `vaultOkuMoneyAta`
  memoization (and the `resetPsmSingleton()` ritual every describe had
  to call) was anti-functional given bankrun gives each describe a
  fresh cluster. Renamed `initializePSMIfNeeded` → `initializePsm`;
  takes `(h, program, payer, usdcMint, okuMoneyMint)` and always
  performs the on-chain init.
- **Validator helpers gone from `setup.ts`**: `validatorFunder`,
  `safeAirdrop`, `safeAirdropAll`, `safeMintTo`, `ensureAta` deleted.
  The surfpool fork tests keep a local `safeAirdrop` /
  `safeAirdropAll` in `tests/fork/_shared/legacy-funder.ts`.
- **Surfpool helpers relocated** to `tests/fork/_shared/{surfpool,
  assertions}.ts`. The dead `fixtures.ts` (645 lines, zero callers
  after the validator removal) was deleted. `tests/shared/` now
  contains only bankrun-relevant code (`bankrun.ts`, `setup.ts`,
  `bridge-helpers.ts`).
- **Bridge-helpers extracted** to `tests/shared/bridge-helpers.ts`:
  `signMessage`, `calculateRequestId`, `randomEvmAddress`,
  `serializeBridgeMintMessage` (pure helpers); `createBridgeMintTx`,
  `bridgeBurnAndGetLogs`, `expectBridgeMintProgramError` (bind a
  `BridgeTestContext`); `expectError` (works with both Anchor and
  bankrun error shapes). Removed ~250 LOC of duplication from
  `bridge_security.ts`.
- **`startBankrun({ autoBumpSlot: true })`** (default on). Wraps
  `provider.sendAndConfirm` so every tx advances the bankrun slot by
  1. Closes both `check_yield_lock` cross-test poisoning AND the
  "this transaction has already been processed" same-blockhash
  dedupe. Removed 2 `beforeEach` slot-bump hooks and 4 inline
  `warpSlots(h, 1n)` calls.
- **`npm run test:validator` removed.** `Anchor.toml`'s `[scripts]
  test` still runs the bankrun command, so `anchor test` and `npm
  test` remain synonymous.

Phase 11 did NOT do:

- Move off `anchor-bankrun@0.5.0` / `solana-bankrun@0.4.0`.
  `litesvm@1.0.0` (the modern standalone package built on `@solana/kit`
  / web3.js v2) is available but would require rewriting every
  `program.methods.X().rpc()` call as a raw `Instruction` with
  hand-built borsh args (~2.5x line count). The current adapter
  reduces to a single `as unknown as anchor.Provider` cast at
  provider-registration time. Re-evaluate when Anchor 2.x ships a
  bankrun-compatible Provider directly.

---

## ✅ Phase 4b — Test runner migration (`solana-bankrun`)

**Status:** complete (Phase 9 landed the migration; Phase 11
removed the residual validator-path code). The entire unit suite now
runs on `solana-bankrun` via the `anchor-bankrun` adapter. `npm test`
(and `anchor test`) execute `tests/bankrun/**/*.ts` in ~5 seconds; no
`solana-test-validator` path remains.

What landed in Phase 9:

- `tests/shared/bankrun.ts` — full harness: `startBankrun`, `fundKeypairs`,
  `createMintViaBankrun`, `createOkuMoneyMintViaBankrun`, `mintToViaBankrun`,
  `ensureAtaViaBankrun`, `warpBy`, `warpTo`, `warpSlots`, `setLamports`,
  `getProgram`, `loadProgramFromIdl`, `expectBankrunError`, `tryProcess`.
  Loads programs directly from `target/idl/*.json` so the `anchor.workspace`
  proxy cache cannot leak provider bindings across sequential files.
- `tests/shared/setup.ts` — bankrun-only after Phase 11. Shared
  authority keypairs + an `initializePsm(h, ...)` helper. The
  `Funder` callback abstraction and the `resetPsmSingleton()`
  bookkeeping were removed.
- `tests/bankrun/bridge_security.ts` — cut-over migrated from
  `tests/unit/bridge_security.ts`. Dropped: `RUN_HEAVY_BRIDGE_TESTS` env
  gate, the 60-line `sendAndConfirm` monkey-patch (old lines 407–468),
  the `setTimeout(50)` blockhash busy-loop, the `setTimeout(500)`
  event-listener wait. Replaced `addEventListener` with synchronous log
  decoding via `findBridgeBurnEventInLogs`. Added: full happy-path
  refund test (burn → `warpBy(3601)` → initiate → confirm → assert
  re-minted balance).
- `tests/bankrun/lite-psm.ts` — full port of `tests/unit/lite-psm.ts`.
  Slot-bump in `beforeEach` resolves `YieldDistributionInProgress`
  cross-talk between describes.
- `tests/bankrun/oku-bridge-router.ts` — includes router CPI
  happy paths (`mint_usd_oku`, `redeem_usd_oku`, `bridge_oku_m`,
  `bridge_usd_oku`).
- `tests/bankrun/oku-dollar.ts` — full vault coverage.
- `tests/bankrun/pyth-oracle.ts` — 4 tests, hand-built Pyth V2 fixture
  injected via `setAccount`. Mirrors `tests/fork/pyth-oracle.ts`; runs
  on every CI invocation.
- `tests/bankrun/init-invariants.ts` — Phase 10 addition. Verifies the
  new TransferHook-reject invariant.
- `scripts/lib/bridge/event.ts` — added `findBridgeBurnEventInLogs`
  (sync, log-only — no `Connection.getTransaction` round-trip) for
  bankrun's `tryProcessTransaction` flow.
- `package.json`:
  - `npm test` → bankrun
  - `npm run test:validator` → the validator escape hatch
  - `npm run test:fork` → surfpool, unchanged
  - removed devDeps: `ts-mocha`, `ts-node`, `patch-package`
- `Anchor.toml`: `[scripts] test` points at the bankrun command so
  `anchor test` and `npm test` are synonymous.

Results: **158 passing / 1 pending / 0 failing** across the whole
bankrun suite (Phase 10 final tally). The single pending test is the
Ed25519-invalid-sig case — see the dedicated section below for the
full story; it's a `with_precompiles`-toggle issue in litesvm, not a
fundamental limitation. Coverage for the path lives in
`scripts/test/test-devnet.ts` (the `bridgeMintInvalidSig` step) which
runs against a real validator.

---

## ⏳ Phase 4c — Closing the 200 → 500 gap (deferred follow-up to 13b)

**Status:** scoped, not implemented. Phase 13b superseded the original
Phase 4c goal: the `MAX_ENTRIES = 10` cap and the `% 10` magic are gone.
The remaining 2.5× gap to the spec target of 500 entries is bounded by
Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240` byte cap on
single-CPI allocations (a 500-entry queue is ~24 KB).

**Options to close the gap when telemetry justifies it:**

1. **Multi-step init + 2× realloc** on `setup_redemption_queue`. Initial
   `init` allocates 10 KB, two follow-up reallocs grow the queue PDA in
   place. Lowest disruption: keeps the existing zero-copy ring layout
   intact, only the deploy script changes.
2. **Per-user PDAs** (the original Phase 4c sketch). Replace the fixed
   ring with one PDA per queued entry, seeds
   `[b"queue_entry", &index.to_le_bytes()]`, plus a small state PDA
   holding `head: u64, tail: u64, bump: u8`. Lifts the cap entirely;
   each entry pays ~rent for its PDA so the orchestrator must still
   drain promptly.

**Defer until:** real workload telemetry shows operators repeatedly
hitting the 200-entry `QueueFull` cliff. The README runbook documents
the current 200-entry SLA + `MAX_BATCH_ENTRIES = 50` per-tx drain
limit; the `admin:process-queue` script auto-batches across multiple
txs so the orchestrator UX is "kick the cron, it does the rest".

---

## ✅ Test coverage gaps — Phase 10 closure

**Phase 8.3 + Phase 9 + Phase 10 landed**:

- ✅ `set_pyth_program_owner` happy/sad/role-gate tests
- ✅ `set_oracle` staleness-bound tests (Phase 3 bounds)
- ✅ `set_bridge_authority` privilege-escalation defense tests
  (`UseDedicatedRotation` for OrchestratorSigner / FeeRecipient arms)
- ✅ `update_bridge_deadline` / `update_bridge_limits` /
  `update_fee_recipient` negative-path tests
- ✅ `initiate_refund` deadline-not-elapsed reject (Phase 8.3)
- ✅ `initiate_refund` non-role-holder reject (Phase 8.3)
- ✅ Full happy-path refund (Phase 9 — uses `warpBy`)
- ✅ Router CPI happy paths: `mint_usd_oku`, `redeem_usd_oku`,
  `bridge_oku_m`, `bridge_usd_oku` (Phase 9 / Phase 10)
- ✅ Oracle-on `mint_oku_m` happy + sad paths with hand-built Pyth
  fixture (Phase 9)
- ✅ Oracle-on staleness / status-not-Trading /
  InsufficientReserves rejects (Phase 9)
- ✅ `bridge_burn` fee==0 and fee>0 edge cases (Phase 10)
- ✅ Wrong-direction bridge format reject (Phase 10 — SVM-burn-shape
  message submitted to `bridge_mint` is caught by
  `WrongDestinationChain`).
- ✅ Orchestrator-rotation invalidation: a message signed by the OLD
  orchestrator is rejected with `InvalidSignature` after rotation
  (Phase 10).
- ✅ `process_queue` rejects with `InsufficientAccounts` when the
  recipient ATA is missing from `remaining_accounts` (Phase 10).
- ✅ `rescue_queue_entry` to a non-original recipient succeeds
  (Phase 10 — confirms the program does NOT enforce
  `recipient == original_user`, matching EVM).
- ✅ Init-time TransferHook rejection (Phase 10).

**Still deferred** (low priority):

- (None — see the Bankrun coverage gaps section below for the
  one outstanding limitation.)

---

## 🟡 Bankrun coverage gaps

### Ed25519 precompile not enforced in-process

**The mechanism.** `litesvm@1.0.0` (the BPF executor that
`solana-bankrun@0.4.0` and Surfpool 1.1.2 wrap) ships a
`LiteSVM::with_precompiles` toggle introduced in 0.4.0. The toggle is
**off by default**, and neither bankrun nor surfpool's JS/RPC surface
exposes it. With the toggle off, the Ed25519 precompile is a no-op:
any transaction containing an Ed25519Program instruction succeeds at
the precompile level regardless of whether the signature math
actually verifies.

**Why it matters.** Our `bridge_mint` follows the canonical Solana
pattern: it embeds an Ed25519Program instruction at tx index 0 and
trusts the precompile to validate the curve25519 math. The
program-side `verify_ed25519_signature` then byte-compares the
precompile ix data against the bytes it expects (using
`bridge_config.orchestrator_signer` as the expected pubkey). If the
precompile passes a tx with a math-invalid sig, our byte-compare
still matches (we built the bytes from the same wrong signature), so
the program proceeds and mints.

Re-implementing curve25519 in BPF would burn ~200K CU per call —
that's why no production Solana program does this; Wormhole, Pyth
Receiver, and Mayan all use the same precompile-trust pattern.

**What's covered in bankrun:**
- Wrong pubkey declared in precompile ix → `InvalidSignature`
  (byte-compare against `orchestrator_signer` fails).
- Tampered message → `InvalidRequestId` (keccak mismatch).
- Expired deadline.
- Post-`update_orchestrator_signer` invalidation of in-flight
  messages.

**What's NOT covered in bankrun (and therefore moved to a real-validator step):**
- The pure curve25519-math-invalid case (sig was generated by the wrong
  keypair but otherwise byte-consistent).

**Real-validator coverage.** `scripts/test/test-devnet.ts` step
`bridgeMintInvalidSig`. Builds a `bridge_mint` tx with a deliberately-
wrong-keypair-signed message and asserts the cluster rejects it
before our program runs. Run via:

```bash
npm run test:onchain -- --step=bridgeMintInvalidSig          # devnet
NETWORK=localnet npm run test:onchain -- --step=bridgeMintInvalidSig
```

`bridgeMintInvalidSig` is also included in the default `test:onchain`
step ordering, so a full `npm run test:onchain` run exercises it
unconditionally.

**Upstream-fix path.** If/when `solana-bankrun` (or its successor)
exposes the `with_precompiles` toggle, we can flip the `it.skip` in
`tests/bankrun/bridge_security.ts` to a real `it`. Tracked, not
blocked on anything we control.

---

## ✅ Operational tooling — Phase 10 closure

**Phase 8.4 + 8.6 + Phase 10 landed**:

- ✅ `admin:set-authority` / `admin:set-bridge-authority`
- ✅ `admin:pause-psm` / `unpause-psm` / `pause-bridge` / `unpause-bridge`
- ✅ `admin:distribute-yield`
- ✅ `bridge:refund-initiate` / `refund-confirm` / `refund-cancel`
- ✅ `admin:setup-router-alt`
- ✅ `admin:set-max-supply` (Phase 10, cap_manager-gated)
- ✅ `admin:set-minter-allowance` (Phase 10, allowance_manager-gated)
- ✅ `admin:set-oku-m-price` (Phase 10, rebaser-gated; stamps
  `last_yield_distribution_slot`)
- ✅ `admin:update-bridge-fee` (Phase 10)
- ✅ `admin:update-bridge-limits` (Phase 10)
- ✅ `admin:update-bridge-deadline` (Phase 10)
- ✅ `admin:update-fee-recipient` (Phase 10)
- ✅ `admin:freeze-account` / `admin:thaw-account` (Phase 10)
- ✅ `admin:add-supported-chain` / `admin:remove-supported-chain`
  (Phase 10)
- ✅ `admin:skip-nonce` (Phase 10, bounded by `MAX_NONCE_SKIP`)
- ✅ `admin:process-queue` (Phase 10 orchestrator drain script; renamed from `test:process-queue` and upgraded to auto-batching drain-to-empty in Phase 13b polish)
- ✅ `scripts/test/test-devnet.ts` smoke-step gaps closed (Phase 10):
  `bridgeMint`, `refund`, `distributeYield`, `pause`, `setAuthority`,
  `oracleMint` steps added.

Every admin script honours `--dry-run` and `--yes-i-mean-it-on-mainnet`
via `scripts/admin/_lib/confirm.ts`.

---

## ✅ Phase 10 — Init-time invariants

- ✅ TransferHook reject: `initialize` now refuses any OkuMoney mint
  that has the Token-2022 `TransferHook` extension. The mint's
  extension list is parsed via `spl_token_2022::extension::
  StateWithExtensions::<MintRaw>::unpack` and checked against
  `ExtensionType::TransferHook`. Closes the "deployment forgot to omit
  the hook" failure mode that was previously held only by operational
  discipline. Test coverage in
  `tests/bankrun/init-invariants.ts`.

---

## ✅ Phase 10 — has_one refactor

- ✅ All 23 `constraint = X.key() == config.X @ Unauthorized` sites
  converted to `has_one = X @ Unauthorized` on the config account.
  Files touched:
  - `programs/lite-psm/src/contexts/psm_admin.rs` (4 sites)
  - `programs/lite-psm/src/contexts/psm.rs` (4 sites)
  - `programs/lite-psm/src/contexts/yield_ops.rs` (2 sites)
  - `programs/lite-psm/src/contexts/bridge_admin.rs` (8 sites)
  - `programs/lite-psm/src/contexts/bridge.rs` (2 sites — refund flow)
  - `programs/oku-bridge-router/src/contexts.rs` (3 sites)

Result: ~40 LOC reduction; the on-chain semantics are identical
(both forms compile to the same constraint check). All 158 tests
remain green.

---

## ⏳ Smaller follow-ups still open

- **Real `security@` email**: per Phase 8 instructions the placeholder
  `security@okumoney.example` remains in all three programs'
  `security_txt!` blocks. Must be replaced before any external-facing
  deploy. Tracked in the README runbook checklist.
- **Chain-ID renumbering**: per Phase 8 instructions the look-alike
  values (420 / 421 / 845) remain. The improved doc comments in
  `scripts/config/constants.ts` and `EVM_VS_SVM.md` clarify the
  protocol-internal-vs-EIP-155 distinction.
- **`Program<LitePsm>` vs `Program<Idl>` typecheck noise** in
  `tests/shared/setup.ts` helpers (e.g. `initializePsm(program:
  Program, ...)`). Pre-existing; `tsx` ignores it but `tsc --noEmit`
  flags ~20 sites.
- **`#[derive(InitSpace)]` migration** — replace hand-computed `LEN`
  constants with `8 + T::INIT_SPACE`. Compile-time asserts are working
  fine; not blocking anything. Defer post-mainnet.

---

## 📚 References

- `SVM/EVM_VS_SVM.md` — full divergence catalogue, refreshed in P8.7.
- `SVM/README.md` — Runbook section (P8.8) + refreshed Testing section
  (P9.6).
- `tests/shared/bankrun.ts` — bankrun harness (single source of truth
  for the in-process test runner).
- `tests/shared/setup.ts` — runner-agnostic PSM bootstrap.
- `scripts/lib/account-sizes.ts` — single source of truth for the
  TS-side mirror of Rust `state.rs::T::LEN` constants.
