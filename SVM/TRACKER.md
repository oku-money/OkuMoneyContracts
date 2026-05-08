# SVM follow-up tracker

Items deferred from the May 2026 internal-prototype review pass. Items here
are scoped, not lost.

## Phase 4b — Test runner migration (litesvm)

**Status:** scoped, not implemented in this pass.

**Goal:** eliminate the `RUN_HEAVY_BRIDGE_TESTS=1` gate, the
`provider.sendAndConfirm` monkey-patch in
`tests/unit/bridge_security.ts:407-468`, and the various `setTimeout(...)`
clock waits scattered across the unit suite. All driven by
`solana-test-validator`'s 30s confirmation polling window.

**Wrinkle:** the natural choice (`anchor-bankrun`) peer-deps
`@coral-xyz/anchor`, while this repo uses `@anchor-lang/core@1.0.0` (the
renamed Anchor 1.0 package). `litesvm@1.x` directly uses `@solana/kit`,
not `@solana/web3.js@1.x`, so migrating any of the four test files to
`litesvm` requires rewriting all transaction construction (the existing
tests use `Program<T>.methods.foo().rpc()` which is web3.js-specific).

**Two viable paths:**

1. **Patch / fork `anchor-bankrun`** to accept `@anchor-lang/core@1.0.x`.
   The shape of `Provider`/`Program` is essentially unchanged in the rename;
   the peer-dep declaration is the only blocker. This is the lower-effort
   path. Drop a patches/anchor-bankrun.patch file and use `patch-package` in
   postinstall.
2. **Rewrite tests against raw `litesvm` + `@solana/kit`.** ~1-2 days of
   test rewriting; eliminates the dependency on Anchor-flavoured tooling
   entirely. Higher long-term payoff but blocking on (a) `@anchor-lang/core`
   IDL ↔ `@solana/kit` codec interop and (b) accepting the rewrite cost.

**Recommended:** path 1 first as a near-term unblock; path 2 as a longer
follow-up once a litesvm-flavoured Anchor helper stabilises.

**Acceptance criteria:**
- `tests/unit/bridge_security.ts` runs all 9 currently-skipped end-to-end
  bridge_mint tests with no `RUN_HEAVY_BRIDGE_TESTS` gate.
- `tests/unit/lite-psm.ts:923` `setTimeout(500)` replaced with a slot-warp
  helper.
- `tests/unit/bridge_security.ts:1136-1139` blockhash busy-loop replaced.
- `bridge_security.ts:2631` `setTimeout(500)` for event-listener flush
  replaced with a deterministic await on the listener's promise.

## Phase 4c — Per-user PDA queue redesign

**Status:** scoped, not implemented in this pass.

**Goal:** lift the `RedemptionQueue::MAX_ENTRIES = 10` cap and remove the
hardcoded `% 10` magic in tests.

**Sketch:**
- Replace `RedemptionQueue { entries: [QueueEntry; 10], head, tail, ... }`
  with one PDA per queued entry: seeds `[b"queue_entry",
  &index.to_le_bytes()]` plus a small `RedemptionQueueState` PDA holding
  `head: u64, tail: u64, bump: u8`.
- `redeem_oku_m` queue path: `init` `queue_entry_<tail>` and increment
  `tail`. `process_queue` reads `head..head+max_entries`, processes (token
  CPIs + `close` PDA), advances `head`. `rescue_queue_entry` closes a
  specific entry PDA.
- Updates to `scripts/utils/pdaHelpers.ts` and the deploy/test scripts.

**Note:** the prototype is comfortable with 10 entries; production must
revisit.

## Test coverage gaps still uncovered (Phase 6 follow-up)

Items the user deferred from the current Phase 6 round:

- `initiate_refund` / `confirm_refund` / `cancel_refund` end-to-end tests,
  including the new `InitiatorCannotConfirm` runtime check (`bridge.rs`
  Phase 3 work) and the tightened `cancel_refund` access pattern (initiator
  OR bridge_admin).
- Router CPI happy-path tests (`bridge_usd_oku`, `bridge_oku_m`) plus the
  new `validation::*` cross-program PDA assertions.

The `RUN_HEAVY_BRIDGE_TESTS=1` gate on the existing security tests should
not be lifted until Phase 4b lands.

## Misc smaller follow-ups

- Replace `securit_txt!` placeholder email `security@okumoney.example`
  with a real address before any external-facing deploy. Three programs.
- Reconsider the chain-ID numbering scheme in
  `scripts/config/constants.ts` (current values 420 / 421 / 845 are
  look-alike to real EIP-155 IDs and confuse future maintainers).
- `oku-bridge-router` `MintUsdOku` / `RedeemUsdOku` contexts hold 16-17
  accounts each — at the practical Solana transaction-size ceiling.
  Verify a real instruction fits under the 1232-byte tx limit including
  signatures, lookup-tables, and compute-budget headers.
- `scripts/utils/calculateDeploymentCost.ts` size estimates are stale
  vs the compile-time `LEN` constants in state.rs.
- Drop `chalk@5` (ESM-only) → `chalk@4` for CJS compatibility, OR commit
  to ESM throughout (and remove `ts-node`).
- `scripts/utils/testnetRegistry.ts` hardcodes `SVM_CLUSTER_CHAIN_IDS`
  in parallel with `scripts/config/constants.ts:SOLANA_CHAIN_ID`.
  Centralise.
