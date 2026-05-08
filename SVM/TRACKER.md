# SVM follow-up tracker

Items deferred from earlier review passes. Items here are scoped, not lost.

**Status legend:** ✅ landed in Phase 8, 🟡 in progress / partially landed,
⏳ deferred to a future pass.

## ✅ Phase 4b — Test runner migration (litesvm/bankrun)

**Status:** Phase 8.2 landed an `anchor-bankrun` harness
(`tests/shared/bankrun.ts`) and a smoke suite (`tests/bankrun/smoke.ts`)
running via `npm run test:bankrun`. The peer-dep concern from the
original tracker turned out not to be a real blocker —
`anchor-bankrun`'s `BankrunProvider` is structurally compatible with
`@anchor-lang/core`'s `Provider` (both packages share the same shape;
only the package name differs). A single `as unknown as Provider` cast
at provider-registration time is the entire integration cost.

**Deferred:** migrating `tests/unit/bridge_security.ts` (the file gated
by `RUN_HEAVY_BRIDGE_TESTS=1`) onto bankrun. The harness is ready and
the migration is mechanical; folded into the next test-coverage pass.
Once migrated, the `RUN_HEAVY_BRIDGE_TESTS=1` gate can be lifted, the
`provider.sendAndConfirm` monkey-patch (`bridge_security.ts:407-468`)
removed, and the `setTimeout(500)` clock waits at `lite-psm.ts:923`,
`bridge_security.ts:1136-1139`, and `bridge_security.ts:2631` replaced
with `warpBy()` / `warpSlots()` from `tests/shared/bankrun.ts`.

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

The Phase 8 README runbook documents the 10-entry SLA in the meantime.

## 🟡 Test coverage gaps

**Phase 8.3 added** (across `tests/unit/lite-psm.ts` and
`tests/unit/bridge_security.ts`):

- ✅ `set_pyth_program_owner` happy/sad/role-gate tests
- ✅ `set_oracle` staleness-bound tests (Phase 3 bounds)
- ✅ `set_bridge_authority` privilege-escalation defense tests
  (`UseDedicatedRotation` for OrchestratorSigner / FeeRecipient arms)
- ✅ `update_bridge_deadline` / `update_bridge_limits` /
  `update_fee_recipient` negative-path tests
- ✅ `initiate_refund` deadline-not-elapsed reject (gated heavy)
- ✅ `initiate_refund` non-role-holder reject

**Still deferred:**
- Full happy-path refund flow (`initiate -> confirm -> assert mint`).
  Needs cluster-clock advancement past `bridge_deadline_secs`. Trivial
  on bankrun via `warpBy()`; folded into the bankrun migration above.
- Router CPI happy-path tests (`bridge_usd_oku`, `bridge_oku_m`,
  `mint_usd_oku`, `redeem_usd_oku`). Currently zero coverage.
- Oracle-on `mint_oku_m` happy path. Needs a stub Pyth PriceUpdateV2
  account (use Surfpool `surfnet_setAccount` or hand-construct the
  240-byte buffer per the layout in `oracle.rs`).
- `process_queue` with a frozen recipient ATA.
- `rescue_queue_entry` with a non-original-user recipient.
- `bridge_burn` fee==0 vs fee>0 edge cases.
- Negative tests for the wrong-direction bridge format (SVM-burn 80 bytes
  submitted to `bridge_mint`, vice versa).
- `bridge_mint` with a valid signed message followed by orchestrator
  rotation: the original signed message now fails (proves
  `bridge_config.orchestrator_signer` is read at execution time).
- `mint_usd_oku` / `redeem_usd_oku` happy paths AND the new router
  cross-program PDA-mismatch reject (`PsmVaultMismatch`).

## 🟡 Operational tooling

**Phase 8.4 added**:

- ✅ `admin:set-authority` (PSM RBAC role rotation, 12 roles)
- ✅ `admin:set-bridge-authority` (10 bridge roles; refuses
  OrchestratorSigner / FeeRecipient per Phase 8.1)
- ✅ `admin:pause-psm` / `admin:unpause-psm`
- ✅ `admin:pause-bridge` / `admin:unpause-bridge`
- ✅ `admin:distribute-yield`
- ✅ `bridge:refund-initiate` / `bridge:refund-confirm` / `bridge:refund-cancel`

**Phase 8.6 added**:

- ✅ `admin:setup-router-alt` (Address Lookup Table for v0 router txs)

**Still deferred** (mechanical to add following the existing pattern):

- `admin:set-max-supply` — wraps `set_max_supply`; cap_manager-gated.
- `admin:set-minter-allowance` — wraps `set_minter_allowance`;
  allowance_manager-gated.
- `admin:set-oku-m-price` — wraps `set_oku_m_price`; rebaser-gated.
- `admin:update-bridge-fee` / `admin:update-bridge-limits` /
  `admin:update-bridge-deadline` / `admin:update-fee-recipient`.
- `admin:freeze-account` / `admin:thaw-account`.
- `admin:add-supported-chain` / `admin:remove-supported-chain`.
- `admin:skip-nonce` (now bounded by `MAX_NONCE_SKIP` per Phase 8.1).
- `test:process-queue` orchestrator drain script (mentioned in the
  README runbook; pattern is in `scripts/admin/distribute-yield.ts`).
- `scripts/test/test-devnet.ts` smoke-step gaps: `bridgeMint`, `refund`,
  `distributeYield`, `pause`, `setAuthority`, `oracleMint`. The
  remaining hardcoded amounts and the `vc.totalShares` typo were fixed
  in earlier phases.

## ⏳ Smaller follow-ups still open

- **Real `security@` email**: per Phase 8 instructions the placeholder
  `security@okumoney.example` remains in all three programs'
  `security_txt!` blocks. Must be replaced before any external-facing
  deploy. Tracked in the README runbook checklist.
- **Chain-ID renumbering**: per Phase 8 instructions the look-alike
  values (420 / 421 / 845) remain. The improved doc comments in
  `scripts/config/constants.ts` and `EVM_VS_SVM.md` clarify the
  protocol-internal-vs-EIP-155 distinction. Renumbering would require
  a coordinated EVM-side change.
- **`process_queue` indirect yield-lock**: `process_queue` itself has
  no yield-lock check (deliberate per a // NOTE comment that has since
  been removed; behavior matches EVM `processQueue`'s lack of
  `whenYieldNotDistributing`). Re-add an explicit comment or document
  in `EVM_VS_SVM.md`.
- **TransferHook invariant assertion**: the SVM port assumes the
  OkuMoney mint has no Token-2022 `TransferHook` extension (otherwise
  the ECI ordering doesn't fully defend against re-entrancy). Currently
  operational discipline; consider adding an on-chain assertion at
  init that the mint extension list does not include `TransferHook`.

## 🟡 Refactor / simplify

**Phase 8.6 landed**:

- ✅ `oku_bridge_router::validation` CU optimisation: dropped
  per-call `find_program_address` (~30 K CU saved per
  `bridge_usd_oku`). Switched to `try_deserialize_unchecked` for
  forward-compat with future state-struct realloc migrations.

**Still open** (cosmetic; low priority):

- `has_one` migration — replace ~20 sites of
  `constraint = X.key() == config.X @ Unauthorized` with
  `has_one = X @ Unauthorized` for ~40 LOC reduction.
- `set_authority` / `set_bridge_authority` 12-arm match macros — would
  collapse the per-arm 3-line pattern.
- `#[derive(InitSpace)]` migration — replace hand-computed `LEN`
  constants with `8 + T::INIT_SPACE`. Lower priority; the compile-time
  asserts are working fine.

## 📚 References

- `SVM/EVM_VS_SVM.md` — full divergence catalogue, refreshed in P8.7.
- `SVM/README.md` — Runbook section added in P8.8 with the
  pre-mainnet checklist, dual-key orchestrator requirement, queue
  capacity SLA, Pyth feed requirements, and refund flow steps.
- `tests/shared/bankrun.ts` — bankrun harness for the next test pass.
- `scripts/lib/account-sizes.ts` — single source of truth for the
  TS-side mirror of Rust `state.rs::T::LEN` constants.
