# Open issues tracker

Items that remain open after the WS1–8 pre-audit sweep + the SVM noBridge
deployment ceremony (`noBridge-mvp-deployed` tag) + the audit-prep cycle
that landed the USDC peg circuit-breaker. All WS1–8 findings have been
resolved and the SVM programs are now live on devnet at the noBridge
HEAD bytecode. What remains is explicitly deferred or blocked on external
input.

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

## Audit-readiness snapshot

| Item | State |
|---|---|
| Production programs | 2 (`lite-psm`, `oku-dollar`) + 1 shared crate (`oku-shared`) |
| Bankrun tests | 129 / 129 |
| Cargo unit tests | 20 / 20 |
| Anchor build | clean |
| `cargo clippy -D warnings` (lenient) | clean |
| `cargo clippy -W arithmetic_side_effects -W cast_sign_loss …` (strict) | clean |
| `cargo dylint` | deferred (upstream `crytic/solana-lints` still pinned to `nightly-2025-01-09`, incompatible with Anchor 1.0.2's `extract_if` — re-probed 2026-06-15, no upstream bump since cycle 1) |
| Pyth USDC/USD peg circuit-breaker | embedded in `lite-psm` (audit-prep cycle) |
| Trident `#[init]` invariants | wired (cycle 3); 0 panics across ~100 k random tx per program; `oku_m_price`/`usd_multiplier` invariants firing |
| Kani formal proofs | 9 / 9 SUCCESSFUL (cycle 3 tightened the two SAT-hard harness domains) |
| Rust toolchain pin | 1.90.0 across `programs/` + `trident-tests/` |
| Anchor CLI / lib | 1.0.2 / 1.0.2 (no drift warning) |
| EVM ↔ SVM constant parity | re-verified post-cycle |

Full audit handoff package lives under `oku-programs/audit/`:

- `audit/README.md` — entry point.
- `audit/ACCEPTED_RISKS.md` — known trust-assumptions, deferrals.
- `audit/clippy-checklist.md` — clippy disposition.
- `audit/program-sizes.txt`, `audit/test-output-*.txt` — captured snapshots.

The audit toolkit lives at `audit/SVM/` (separate from the in-program
`oku-programs/audit/` package). Run `make doctor` to verify toolchain
pins match installed binaries before kicking off `make all`.

## 📋 Deployment status (2026-06-05)

All chains running noBridge HEAD bytecode:

| Chain | OkuMoney / lite_psm | OkuDollar | LitePSM (EVM) | RedemptionQueue |
| --- | --- | --- | --- | --- |
| sepolia | impl `0x8bAd19F0` | impl `0xe35D166a` | impl `0xA90845CF` | impl `0x52C117fb` |
| baseSepolia | impl `0x040D347f` | impl `0xbdF02387` | impl `0x704eb5C0` | impl `0x394ceDbd` |
| bscTestnet | impl `0x040D347f` | impl `0xbdF02387` | impl `0x704eb5C0` | impl `0x394ceDbd` |
| base | impl `0xb48B9779` | impl `0x8F9EE327` | impl `0xD18170F0` | impl `0x7d48bbcA` |
| bsc | impl `0xB43A3617` | impl `0x795bD849` | impl `0x0E4d4719` | impl `0x1BC7630A` |
| svm-devnet | program `3CLDWjDT…YC7N` | program `3TeNwAqQ…PJgy` | (lite_psm above) | (PsmConfig PDA `2A8FojJF…zm1f`) |

SVM seed rotations:
- 2026-06-05 (noBridge migration) — all four PDA seeds rotated to `*_v2`
  to force fresh storage layouts after the blacklist-exempt fields were
  removed from `PsmConfig`.
- 2026-06-12 (audit-prep cycle) — `psm_config` rotated `_v2 → _v3` to
  force a fresh PDA after the PoR plumbing was replaced with the USDC
  peg circuit-breaker. The three other PDA seeds (`redemption_queue_v2`,
  `oku_dollar_config_v2`, `usd_oku_mint_v2`) were unaffected and remain
  on `_v2`.

Pre-rotation accounts orphaned — see
`SVM/oku-programs/deployments/DEPRECATED.md` for the orphan-PDA table and
post-launch rent-recovery plan.

Tag location: `noBridge-mvp-deployed` → HEAD on `noBridge` branch.

### Post-deploy smoke test (2026-06-05)

End-to-end smoke against live testnets. All flows verified.

**SVM devnet (`npm run test:onchain`):** 12 / 12 steps passing — `state`,
`mint`, `transfer`, `rebase`, `wrap`, `unwrap`, `redeem`, `queueRedeem`,
`distributeYield`, `pause`, `setAuthority`, `oracleMint`. One fix shipped
in this round: `test-devnet.ts` `setOracle(PublicKey.default, ...)` calls
were missing the explicit `oracleAccount: null` field — added at three
call sites (lines 367, 1395, 1441).

**EVM orchestrator CLIs on baseSepolia (`scripts/operator/*.ts`):**
all 6 verified — `depositBuffer`, `mintOkuM`, `redeemOkuM`, `processQueue`,
`withdrawBuffer`, `configureMinterAllowance`. Display logs show
pre-tx balances instead of post-tx in two places (cosmetic, doesn't affect
operation); on-chain state always reflects the correct final values.

**Cross-chain bridge (baseSepolia → bscTestnet):**
- Source leg: `redeemOkuM(5 OkuM)` on baseSepolia tx `0x2b1e8ef3…`
- Off-chain transit: dev wallet minted 5 USDC on bscTestnet tx `0x5aaee7d8…`
  (models orchestrator's USDC custody transfer across rails)
- Destination leg: `mintOkuM(5 USDC)` on bscTestnet tx `0xa5ddf491…`
- Recipient OkuM balance on bscTestnet: 5 (matches source-leg burn)
- USDC conservation invariant verified — every USDC accounted for on
  both sides of the bridge.

**On timelocks:** okuMoney is a centralized US-regulated financial product, not a
decentralized protocol. Industry peers (USDC, USDT, USDP, PYUSD, FDUSD) do not use
on-chain timelocks; they rely on operational, procedural, and regulatory controls.
Trust in okuMoney is anchored in Oku Money as a legal entity, its MSB registration,
and its internal control framework — not in on-chain delay mechanics. On-chain RBAC
enforces *separation of duties within the company*; the cold multisig quorum
requirement is itself the delay mechanism. Timelocks are **not pursued**.
Trust implications for each signer role are documented in `README.md § Signer trust
implications`, `EVM/README.md § Per-role trust and blast radius`, and
`SVM/README.md § Authority Model`.

---

## 🔴 Pre-external-deploy (needed before any non-internal devnet)

### `security_txt!` contact — upgrade to dedicated email if available

Both programs' `security_txt!` blocks currently point at:
`uri:https://github.com/anomalyco/okuMoney/security/advisories/new`

This is functional. If a dedicated `security@` email is set up before mainnet,
replace the `contacts` field in both `programs/{lite-psm,oku-dollar}/src/lib.rs`,
rebuild, and redeploy.

**Effort:** 15 min + rebuild/redeploy. **Blocked on: team providing real email.**

---

## 🟡 Should-fix before external audit

### ~~Oracle relay (USDC peg circuit-breaker) — SVM mirror~~ ✅ (2026-06-12)

Landed in the SVM audit-prep cycle that paralleled the EVM PoR-removal /
peg-relay refactor. Per the user's direction, the SVM mirror was embedded
directly inside `lite-psm` (no new program) — see
`EVM_VS_SVM.md § Oracle` for the documented divergence.

Surface:

- New helper module `programs/lite-psm/src/helpers/oracle_relay.rs` — Pyth-V2
  USDC/USD parser, normalizes `(price: i64, expo: i32)` to 1e9 precision,
  validates band + status + freshness + positive answer + owner.
- New fields on `PsmConfig` (`_v2 → _v3` seed rotation):
  `oracle_relay_feed`, `oracle_relay_pyth_program_owner`,
  `oracle_relay_staleness`, `oracle_relay_min_price_e9`,
  `oracle_relay_max_price_e9`.
- Four new `oracle_manager`-gated instructions:
  `set_oracle_relay_feed`, `set_oracle_relay_staleness`,
  `set_oracle_relay_band`, `set_oracle_relay_pyth_program_owner`. The first
  doubles as the kill switch (`new_feed = Pubkey::default()`).
- Wired into `mint_oku_m`, `redeem_oku_m`, `process_queue` (lite-psm) and
  cross-program via `psm_config` reads from `wrap` / `unwrap` (oku-dollar).
- Constants in `oku-shared`: `ORACLE_USDC_PRICE_FLOOR = 0.95e9`,
  `ORACLE_USDC_PRICE_CEILING = 1.05e9`, `MAX_FEED_EXPO_MAGNITUDE = 18`.
- Default peg band `[0.97e9, 1.03e9]` (±3%), default staleness `3600s`.
- New operator script: `scripts/admin/set-oracle-relay.ts` (four-subcommand CLI).
- New bankrun test suite: `tests/bankrun/oracle-relay.ts` (12 tests).
- Stub fork test path kept at `tests/fork/pyth-oracle.ts` for live USDC/USD reads.

Mirrors EVM `OracleRelay` semantically but embedded in `lite-psm` rather
than as a separate UUPS proxy program. (The EVM tracker now flags its own
relay UUPS overhead as a candidate for future simplification too.)

### Key custody and change-management documentation

Auditors of centralized stablecoin contracts evaluate operational controls, not
on-chain delay mechanisms. What's expected and currently missing:

- **Key custody procedures.** Where are the cold/warm multisig hardware devices
  stored? What is the off-boarding process when a signer leaves the company? What
  is the recovery process if a device is lost or a signer is unavailable?
- **Change-management runbook per admin action class.** For each action the cold
  multisig can take (`configureRelay`, `configureMinterAllowance`, `setMaxSupply`,
  role grants, upgrade ceremonies): who proposes? Who reviews the proposed tx data?
  Who signs? What is the dry-run / fork-test requirement before mainnet?
- **Segregation of duties statement.** Which humans hold cold vs warm vs orchestrator
  keys? Do any individuals hold keys in more than one tier? (The system allows overlap
  on-chain; operational policy should prohibit it.)
- **Incident response procedures.** Specific runbooks for: compromised orchestrator
  key, compromised warm multisig, unexpected admin event detected by monitoring.

**Effort:** 2–4 days (writing, not implementation). **This is what audit reports flag
for centralized stablecoin projects, not missing timelocks.**

### ~~`cargo clippy -D warnings`~~ ✅ (2026-06-12)

Cleared in the audit-prep cycle. Two real findings (`unneeded return` in
`oku-dollar::wrap`) fixed; two crate-level suppressions added for noise from
Anchor's `#[program]` macro expansion (`diverging_sub_expression`,
`unexpected_cfgs` for the `target_os = "solana"` cfg used by
`solana-program-entrypoint`). Both suppressions documented inline with their
rationale. `cargo clippy --workspace --all-targets -- -D warnings` exits 0.

Once the CI job is wired (separate workstream), `-D warnings` should be the
default flag.

### `cargo dylint` (crytic/solana-lints) — DEFERRED

Trail of Bits' Solana lint suite is declared in `Cargo.toml` but cannot
run against `anchor-lang 1.0.2`. The upstream pin
(`crytic/solana-lints` → `rust-toolchain = nightly-2025-01-09`) predates
the `extract_if` stabilization (Rust 1.87) that Anchor 1.0.2 relies on
via its proc-macro derives. We re-probed upstream on 2026-06-15 and
the pin is unchanged since cycle 1 — the most recent commits are
dependabot bumps for ancillary deps (tempfile, toml, assert_cmd), and
no `clippy_utils`/toolchain bumps have landed in 2025-H2 or 2026-H1.

Per the cycle-3 plan, we **did not vendor** the upstream repo. The
audit Makefile's `solana-lints` target now stubs out with a
deferred-status message and writes a marker file under
`reports/solana-lints/`. The earlier review-pass findings (F-02
`arbitrary_cpi`, F-03 manual byte parsing in oracle helpers, F-04
sysvar usage) remain valid and have already been triaged via
crate-wide `#![allow]` suppressions plus inline comments. The only
new code since that review is `programs/lite-psm/src/helpers/oracle_relay.rs`
and the four oracle-relay admin ix — all using the same CPI / owner-
check / parser patterns already covered.

**Effort to re-enable:** ½ day once upstream bumps the `clippy_utils`
pin to a nightly with `extract_if`. **Tracking signal**: watch
`https://github.com/crytic/solana-lints/blob/master/rust-toolchain`
for a channel newer than `nightly-2025-04-xx`.

### ~~Trident `#[init]` wiring~~ ✅ (2026-06-15)

Wired in cycle 3. Both `fuzz_lite_psm` and `fuzz_oku_dollar` now have
working `#[init]` bodies that bootstrap the canonical state via the
program's own `Initialize` / `Setup*` ix flow. The 1-minute smoke
runs archived under `audit/SVM/reports/trident/lite-psm_20260615_*.txt`
and `…/oku-dollar_20260615_*.txt` show:

- `Initialize`, `SetupRedemptionQueue`, `SetupOkuMoneyEscrow`,
  `LitePsmInitialize`, `OkuDollarInitialize`, `InitUsdcMint`,
  `InitOkuMoneyMint` — all 984/984 invocations succeed.
- Every other ix (Mint, Redeem, ProcessQueue, DepositBuffer,
  WithdrawBuffer, Freeze, Thaw, Wrap, Unwrap, UpdateUsdMultiplier,
  Pause/Unpause) — invoked thousands of times with random calldata,
  all fail (expected: random user/ATA/mint addresses) with `0`
  panics.

The `#[end]` invariants on `oku_m_price` and `usd_multiplier` are now
firing because the config PDAs exist with valid layouts. The
dead-shares anti-inflation seed for `oku-dollar` was left unwired
this cycle — the `wrap` flow reverts with `BelowMinimumLiquidity` on
every call but the multiplier invariants are independent of reserve
balance, so the invariant signal still lands.

Key technical finding: Trident 0.12.0's SVM **doesn't crypto-verify
signatures** (`trident-svm-0.2.0/src/methods/trident_svm_transactions.rs:39`
calls `try_from_legacy_transaction(tx, &HashSet::new())`). This
means signer-gated ix can be called with `payer.pubkey()` filling
every `Signer<'info>` slot — no multi-keypair machinery required.
This unblocks the same on-chain harness pattern used by `bankrun`
without the bankrun TypeScript glue.

**Follow-on (post-audit):** wire dead-shares pre-seed via
`set_account_custom`, convert flows from `.insert()` to `.get()` so
they reuse canonical mint/vault addresses for higher `Ix Success`
rates. **Effort:** 1–2 days. Once wired, add a CI smoke run:
`trident fuzz run fuzz_lite_psm --max-iterations 1000`.

### Health-check / monitoring scripts (both sides)

Standalone scripts that exit non-zero on out-of-band conditions — needed for
day-1 operator dashboards and alerting:
- Oracle staleness (`updatedAt` vs `stalenessThreshold`)
- Queue depth and age of oldest entry
- Buffer solvency (`vault_usdc >= total_queued_oku_m × oku_m_price / 1e9`)
- Pause state
- Supply vs cap headroom
- Minter allowance headroom

Both EVM and SVM need this. Output JSON for Prometheus/alertmanager consumption.
**Effort:** 2–4 days total.

---

## ⚪ Post-launch / low priority

### SVM standalone orchestrator CLI scripts

`scripts/admin/mint-okum.ts` and `scripts/admin/redeem-okum.ts` — standalone CLIs
for the orchestrator's bridge legs. Currently only accessible inside the
`test-devnet.ts` step runner. Mirror the EVM `scripts/operator/mintOkuM.ts`
pattern.

`scripts/admin/set-vault-authority.ts` — OkuDollar (vault) role rotation. The
existing `set-authority.ts` only handles PSM roles; vault roles (`pauser`,
`unpauser`, `reserveManager`, `usdRebaser`) lack a CLI.

**Effort:** 2–3 hours each.

### `cargo fmt --check` / `cargo deny check` in CI

Both exist in the repo but are not wired into `.github/workflows/test.yml`.
`cargo fmt` needs one pass to clean up any drift; `deny.toml` already exists for
`cargo deny`.

**Effort:** 30 min each, after any lint cleanup.

### Coverage reporting

`forge coverage --report lcov` (upload to Codecov) and `cargo llvm-cov` — not
produced or uploaded. Useful for surfacing uncovered branches before audit.

**Effort:** 1 hour to wire.

### Queue capacity: 200 → 500 entries

The SVM redemption queue is capped at 200 entries by the Solana
`MAX_PERMITTED_DATA_INCREASE = 10 240 bytes` single-CPI allocation limit. The
spec target was 500. Two paths to close the gap:

1. **Multi-step init + 2× realloc** — initial `setup_redemption_queue` allocates
   10 KB, two follow-up `realloc` calls grow the PDA. Keeps the zero-copy ring
   intact; only deploy script changes.
2. **Per-user PDAs** — one PDA per queued entry; lifts the cap entirely.

**Defer until:** telemetry shows operators repeatedly hitting `QueueFull`.
The 200-entry ring + `MAX_BATCH_ENTRIES = 50` per-tx drain + auto-batching
`process-queue.ts` script is sufficient for launch.

### Two-chain Foundry invariant harness

Extend the existing `LitePSMHandler` / `OkuDollarHandler` stateful-fuzz harness
to model a second simultaneous `chainB` LitePSM and randomly bridge between them.
Surfaces cross-chain accounting bugs that scripted scenarios miss. Expand warp
range from the current 30-day cap to multi-year.

**Effort:** 1–2 weeks. High property-coverage upside; better as a follow-on audit
preparation than an internal testing requirement.

### Cross-process E2E test

Forked EVM (anvil) + bankrun SVM + actual orchestrator process running between them.
Better suited as nightly CI than per-PR. High setup cost.

**Effort:** 2–3 weeks. Post-launch.

---

---

## Potentially redundant / unused functions

Tracked for future review. None of these are dead code (each is reachable
and covered by tests), but each is either redundant given the centralized
trust model or operational convenience that could be removed if the
operator runbook confirms it is unused. Mirror of `EVM/TRACKER.md`'s
equivalent section.

A pruning pass on these should only happen after audit feedback so the
auditor sees the full surface as currently shipped.

### Operator surface that may be unused

- `oku_dollar::deposit_reserves` (`reserve_manager`).
  Adds OkuMoney to the vault outside the normal `wrap` flow. The
  operator can equivalently mint OkuM/USDC through the PSM and use
  `withdraw_reserves` to rebalance. Convenience-only; flagged on the EVM
  side first.
- `oku_dollar::withdraw_reserves` (`reserve_manager`).
  Symmetric to the above. Audit-prep cycle added yield-lock parity with
  EVM's `withdrawSurplus`, so the function now matches the EVM behavior
  but the same "do we actually need it?" question applies.
- `lite_psm::deposit_buffer` / `withdraw_buffer` (`buffer_depositor` /
  `buffer_withdrawer`).
  Same redundancy argument. Operator can drive USDC through the mint /
  redeem flow instead of using these direct deposit paths. Kept for v1
  until the operational runbook confirms which paths the orchestrator
  actually uses.

### Defensive guards that are unreachable through user paths

These remain because they fail-loud against future-developer mistakes or
math-sanity edge cases. Removing them would save a handful of bytes per
guard and is not worth the risk.

- `helpers::oracle_relay::get_usdc_price` — the `shift >= 0` /
  `shift < 0` normalization branches. Under realistic Pyth feeds
  (`expo == -8`), only the `shift < 0` branch is reachable; the other is
  forward-compat for non-standard feeds.
- `helpers::oracle_relay` — `FeedExpoTooLarge` guard. Rejected at admin
  time (`validate_oracle_relay_feed`), so the runtime branch is
  unreachable; kept as a math-safety net.
- `helpers::math` — `calculate_fee` is `#[allow(dead_code)]`. Kept for
  parity with the EVM `LitePSM.fee` seam and for future use when a PSM
  fee is introduced.

### Setup-time helpers redundant with deploy scripts

- (None at present.) SVM has no `assertUsdcMatch` analogue; the deploy
  script wires both PSM and vault to a single source-of-truth USDC mint.

### Convenience views / helpers (off-chain / parity only)

- `oku_dollar::helpers::usd_to_oku_money` — explicitly `#[allow(dead_code)]`
  in the source with an MVP note. Currently unused by any instruction
  handler; kept for parity with EVM `OkuDollar.dollarsToOkuM()` and for
  off-chain consumers.

### Two-step `RoleAdmin` transfer

`pending_role_admin` / `accept_role_admin` / `cancel_role_admin_transfer`.
Not a removal candidate — this is a useful operator-footgun protection
(matches EVM's `Ownable2Step` pattern) that catches typos before the
meta-role rotates. Noted here only to flag it for the auditor as
"deliberate added surface, mirrors EVM."

### Upgradeability that may not be needed (cross-chain item)

The EVM `OracleRelay` is a UUPS proxy with a `RELAY_UPGRADER` role.
After this cycle the EVM tracker flags it for simplification — the SVM
mirror is already non-upgradeable (embedded in `lite-psm`), so no SVM
action needed. Listed here for symmetry.

---

## Recent decisions

- 2026-06-15 — Cycle 3 (audit-prep round 3). Pure-cleanup tracks first:
  Anchor CLI 1.0.0 → 1.0.2 (closes the build-time CLI/lib drift
  warning), Rust toolchain 1.85.0 → 1.90.0 (collapsed against
  `trident-tests/` which previously floated on `stable`), audit
  Makefile housekeeping (added `vault_share_round_trip` to
  `FUZZ_TARGETS`, stubbed `solana-lints` target, added `make doctor`
  for drift checks).
- 2026-06-15 — Kani harness domain tightening: 9/9 SUCCESSFUL on
  the strict toolkit (cycle 2 had 7/9 with 2 SAT-hard timeouts).
  `proof_mul_div_floor_correctness_bounded` domain tightened to
  `u8::MAX` (3 vars), `proof_oku_m_to_dollars_identity_at_precision`
  to `u16::MAX` (1 var × 30-bit constant). Both are sufficient
  structural witnesses; complementary `cargo-fuzz` covers full u64
  range.
- 2026-06-15 — Trident `#[init]` wiring landed for both
  `fuzz_lite_psm` and `fuzz_oku_dollar`. Both Init paths reach
  984/984 success on the 1-minute smoke; 0 panics across ~100 k
  random transactions per program; `#[end]` invariants on
  `oku_m_price` / `usd_multiplier` are firing for the first time.
  Trident 0.12.0's SVM doesn't crypto-verify signatures
  (`try_from_legacy_transaction(tx, &HashSet::new())`), which lets a
  single payer fill every `Signer<'info>` slot without multi-keypair
  machinery.
- 2026-06-15 — `cargo dylint` (crytic/solana-lints) probed upstream;
  toolchain pin (`nightly-2025-01-09`) is unchanged since cycle 1.
  Per the cycle-3 plan we did **not** vendor a fork. The audit
  Makefile's `solana-lints` target now stubs out with a
  deferred-status message. Re-enable when upstream bumps to a
  nightly with `extract_if`.
- 2026-06-12 — Removed PoR `check_oracle_reserves` plumbing from
  `lite-psm`; replaced with USDC peg circuit-breaker
  (`helpers::oracle_relay::check_usdc_peg`). Storage-incompatible
  `PsmConfig` change accepted because deployed testnet PDAs are
  throwaway; seed rotated `psm_config_v2 → psm_config_v3` to force a
  fresh layout. Mirror of EVM cycle.
- 2026-06-12 — Tightened `lite_psm::set_oku_m_price` and
  `oku_dollar::update_usd_multiplier` to require strict-increase
  (rejects equal value). Aligns with `distribute_yield`'s
  `YieldTooSmall` guard so a no-op call cannot stamp the sandwich-lock
  slot without moving the multiplier.
- 2026-06-12 — Re-doc'd `MAX_OKU_M_PRICE` / `MAX_USD_MULTIPLIER` and
  the corresponding `PriceAboveMax` / `MultiplierAboveMax` errors as
  math-sanity bounds rather than "defense against compromised rebaser
  key." Operator-compromise is out of scope per
  `SVM/README.md § Authority Model`; the cap exists to bound the
  `u64 * u64 -> u128` multiplications away from the overflow region.
- 2026-06-12 — Added yield-lock parity guard to
  `oku_dollar::withdraw_reserves` (mirrors EVM `withdrawSurplus`'s
  `whenYieldNotDistributing` modifier). Reads `oku_m_price` and
  `usd_multiplier` for the post-withdrawal collateral check; the lock
  ensures both multipliers don't shift in the same slot.

## 📚 References

- `docs/orchestrator-runbook.md` — preflight checklist, failure recovery, minterAllowance rotation, monitoring SLAs.
- `README.md § Signer trust implications` — what each key tier can and cannot do on-chain.
- `EVM/README.md § Per-role trust and blast radius` — EVM-specific role table with bounded/unbounded characterization.
- `SVM/README.md § Authority Model` — SVM-specific per-role table with blast radius.
- `SVM/EVM_VS_SVM.md` — full EVM↔SVM divergence catalogue.
- `TESTNET_DEPLOYMENT.md` — initial parameters, mainnet RBAC ceremony, SVM upgrade-authority ceremony.
- `tests/shared/bankrun.ts` — bankrun harness (single source of truth for in-process tests).
- `tests/shared/setup.ts` — runner-agnostic PSM bootstrap.
