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

---

## ⏳ Post-MVP punch list (WS8.10 — items deferred from pre-audit sweep)

These are tracked here to ensure they're not forgotten post-launch.

### CI / lint / fuzz
- **`cargo fmt --check`** — not yet wired in CI (`.github/workflows/test.yml`).
- **`cargo clippy -D warnings`** — not wired; likely some latent lint debt.
- **`cargo deny check`** — `deny.toml` exists but CI step is missing.
- **`cargo dylint`** (crytic/solana-lints) declared in `Cargo.toml` but no CI/Make target.
- **Trident fuzz smoke run** — `trident fuzz run fuzz_lite_psm --max-iterations 100` should
  run in CI once `#[init]` is wired (see `trident-tests/fuzz_lite_psm/test_fuzz.rs` TODO).
  Blocked on completing the 3-step `#[init]` using Trident's mint helpers.
- **`solhint`** or `forge lint` — no EVM Solidity linter enforced in CI.
- **Coverage reports** (`forge coverage --report lcov`, `cargo llvm-cov`) — not produced or
  uploaded (Codecov / Coveralls would surface uncovered paths).

### Ops scripts
- **SVM `scripts/admin/mint-okum.ts` and `redeem-okum.ts`** — standalone operator CLIs for
  the orchestrator's `mint_oku_m` / `redeem_oku_m` legs. Currently only available inside
  `scripts/test/test-devnet.ts` step runner.
- **SVM `scripts/admin/set-vault-authority.ts`** — OkuDollar role rotation (pauser, unpauser,
  reserveManager, usdRebaser). Current `set-authority.ts` only handles PSM roles.
- **EVM + SVM health-check scripts** — standalone monitors for oracle staleness, queue depth,
  buffer solvency (`vault_usdc >= total_queued_oku_m × oku_m_price`), pause state, and
  supply-vs-cap. Needed for day-1 operator dashboards.
- **Deploy smoke test** — `deploy/index.ts` (EVM) and `deploy-init.ts` (SVM) should optionally
  run a mint→redeem and assert balances when `SMOKE_TEST=true` or on fork networks.

### Test coverage
- **Two-chain Foundry invariant harness** — a single Foundry session deploying both `chainA`
  and `chainB` LitePSMs and randomly bridging between them (extending the existing handler-based
  invariant suite to include a cross-chain dimension).
- **Cross-process E2E** — forked EVM + bankrun SVM with an actual orchestrator process running
  between them. Better suited as a nightly integration test than a unit test.

### Documentation
- Update EVM/README.md test table to reflect the new test counts after WS8 (481 forge → ~500+,
  28 hardhat → 40+).

## 📚 References

- `SVM/EVM_VS_SVM.md` — full divergence catalogue, refreshed in P8.7.
- `SVM/README.md` — Runbook section (P8.8) + refreshed Testing section
  (P9.6).
- `tests/shared/bankrun.ts` — bankrun harness (single source of truth
  for the in-process test runner).
- `tests/shared/setup.ts` — runner-agnostic PSM bootstrap.
- `scripts/lib/account-sizes.ts` — single source of truth for the
  TS-side mirror of Rust `state.rs::T::LEN` constants.
