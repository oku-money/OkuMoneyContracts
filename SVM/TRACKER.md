# SVM follow-up tracker

Items deferred from earlier review passes. Items here are scoped, not lost.

**Status legend:** ✅ landed, 🟡 partially landed / in progress,
⏳ deferred to a future pass.

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

## ⏳ Smaller follow-ups still open

- **Real `security@` email**: the placeholder `security@okumoney.example`
  remains in both programs' `security_txt!` blocks. Must be replaced
  before any external-facing deploy. Tracked in the README runbook checklist.
- **noBridge v1 cross-chain runbook**: the off-chain orchestrator flow
  is documented in `SVM/README.md` and `SVM/EVM_VS_SVM.md` at a high
  level. A unified, repeatable runbook + retry/recovery script for the
  orchestrator side is on the backlog; not blocking devnet.

---

## ⏳ Mainnet hardening (post-MVP)

- **Timelock on high-impact instructions.** The protocol currently has
  no on-chain delay between proposing and executing a destructive admin
  action (e.g. `set_authority`, `set_oracle`, `set_pyth_program_owner`,
  `set_max_supply`, future program upgrades). A `TimelockController`-
  style PDA (queue + minimum delay + execute window) is the standard
  mainnet hardening for stablecoin protocols; consider before mainnet
  launch. Pairs naturally with the `Ownable2Step` two-step `RoleAdmin`
  transfer that already landed (see `accept_role_admin`).
- **NOT pursuing: on-chain "no key overlap" checks.** Industry
  convention is to enforce role separation **operationally** (multisig
  hardware separation, runbook discipline) rather than via on-chain
  constraints, because contracts cannot distinguish "same EOA holds
  multiple keys" from "multiple EOAs are operated by the same human"
  — only addresses are visible. MakerDAO, Aave, Circle USDC, and OZ
  `AccessControl` all permit overlap and rely on procedural controls.
  We adopt the same posture.

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
