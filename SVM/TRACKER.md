# SVM follow-up tracker

Items deferred from earlier review passes. Items here are scoped, not lost.

**Status legend:** ✅ landed, 🟡 partially landed / in progress,
⏳ deferred to a future pass.

---

## ✅ Phase 4b — Test runner migration (`solana-bankrun`)

**Status (Phase 9):** complete. The entire unit suite now runs on
`solana-bankrun` via the `anchor-bankrun` adapter. `npm test` (and
`anchor test`) execute `tests/bankrun/**/*.ts` in ~5 seconds; the
legacy `solana-test-validator` path survives only as `npm run
test:validator` for ad-hoc debugging.

What landed in Phase 9:

- `tests/shared/bankrun.ts` — full harness: `startBankrun`, `fundKeypairs`,
  `createMintViaBankrun`, `createOkuMoneyMintViaBankrun`, `mintToViaBankrun`,
  `ensureAtaViaBankrun`, `warpBy`, `warpTo`, `warpSlots`, `setLamports`,
  `getProgram`, `loadProgramFromIdl`, `expectBankrunError`, `tryProcess`.
  Loads programs directly from `target/idl/*.json` so the `anchor.workspace`
  proxy cache cannot leak provider bindings across sequential files.
- `tests/shared/setup.ts` — runner-agnostic `Funder` callback shape;
  `validatorFunder(connection)` for the legacy path, `fundKeypairs(h, ...)`
  for bankrun. `resetPsmSingleton()` clears the cached PDA bookkeeping
  between files.
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
Ed25519-invalid-sig case which litesvm cannot enforce (precompile is a
no-op); the fork test continues to cover that path.

---

## ⏳ Phase 4c — Per-user PDA queue redesign

**Status:** scoped, not implemented. Highest-disruption item from the
original review; defer until the prototype graduates.

**Goal:** lift the `RedemptionQueue::MAX_ENTRIES = 10` cap and remove
the hardcoded `% 10` magic in tests.

**Sketch:**
- Replace `RedemptionQueue { entries: [QueueEntry; 10], head, tail, ... }`
  with one PDA per queued entry: seeds `[b"queue_entry",
  &index.to_le_bytes()]` plus a small `RedemptionQueueState` PDA holding
  `head: u64, tail: u64, bump: u8`.
- `redeem_oku_m` queue path: `init` `queue_entry_<tail>` and increment
  `tail`. `process_queue` reads `head..head+max_entries`, processes
  (token CPIs + `close` PDA), advances `head`. `rescue_queue_entry`
  closes a specific entry PDA.
- Updates to `scripts/utils/pdaHelpers.ts` and the deploy/test scripts.
- Document the new operational expectation: `process_queue` no longer
  has a hard cap, but each entry costs ~rent for its PDA so the
  orchestrator should still drain promptly.

The README runbook documents the 10-entry SLA in the meantime.

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

- The single skipped Ed25519-invalid-sig test stays skipped on bankrun;
  fork-test coverage on Surfpool catches it.

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
- ✅ `test:process-queue` (Phase 10, orchestrator drain script)
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
  `tests/shared/setup.ts` helpers (e.g. `initializePSMIfNeeded(program:
  Program, ...)`). Pre-existing; `tsx` ignores it but `tsc --noEmit`
  flags ~20 sites.
- **`set_authority` / `set_bridge_authority` 12-arm match macros** —
  cosmetic; would collapse the per-arm 3-line pattern with a
  `macro_rules!`. Low priority.
- **`#[derive(InitSpace)]` migration** — replace hand-computed `LEN`
  constants with `8 + T::INIT_SPACE`. Compile-time asserts are working
  fine; not blocking anything.

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
