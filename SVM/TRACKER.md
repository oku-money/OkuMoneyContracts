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
| Bankrun tests | 128 / 128 |
| Cargo unit tests | 20 / 20 |
| Anchor build | clean |
| `cargo clippy -D warnings` | clean |
| `cargo dylint` | deferred (tool not installed locally; see audit/ACCEPTED_RISKS.md) |
| Pyth USDC/USD peg circuit-breaker | embedded in `lite-psm` (audit-prep cycle) |
| EVM ↔ SVM constant parity | re-verified post-cycle |

Full audit handoff package lives under `oku-programs/audit/`:

- `audit/README.md` — entry point.
- `audit/ACCEPTED_RISKS.md` — known trust-assumptions, deferrals.
- `audit/clippy-checklist.md` — clippy disposition.
- `audit/program-sizes.txt`, `audit/test-output-*.txt` — captured snapshots.

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

SVM seed rotation (2026-06-05): all four PDA seeds rotated to `*_v2` to force
fresh storage layouts. Pre-rotation accounts orphaned — see
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

### `cargo dylint` (crytic/solana-lints)

Trail of Bits' Solana lint suite is declared in `Cargo.toml` but never invoked
locally — `cargo-dylint` is not installed on the audit-prep workstation. The
suite has been run historically as part of an earlier review pass and the F-02
(`arbitrary_cpi`) finding was already triaged crate-wide via `#![allow]`. The
remaining auditor-facing risk is "did anything land since that review that
the suite would flag?" — answer: only the small `helpers/oracle_relay.rs`
addition, which uses the same CPI pattern as the rest of the codebase and
follows the same review reasoning.

**Effort:** 1 day (install `cargo-dylint` + `dylint-link`, point at the
crytic suite, triage). **Worth running before audit; not blocking this
cycle.** Documented in `audit/ACCEPTED_RISKS.md`.

### Trident `#[init]` wiring

`trident-tests/fuzz_{lite_psm,oku_dollar}/test_fuzz.rs` have real `#[end]`
invariants (oku_m_price monotonicity, usd_multiplier ceiling) but empty `#[init]`
stubs. Until init populates state, the invariants are no-ops because the PDA never
exists.

Wire the 3-step init (`Initialize + setupRedemptionQueue + setupOkuMoneyEscrow`)
using Trident's SPL mint helpers. Blocked on Trident 0.12.0's async mint-creation
API — check `trident-fuzz::fuzzing::Trident` for `create_token_mint` / `set_account`
patterns in the 0.12.0 release notes.

**Effort:** 2–4 days. Once wired, add a CI smoke run:
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
