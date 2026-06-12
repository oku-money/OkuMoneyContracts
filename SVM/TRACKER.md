# Open issues tracker

Items that remain open after the WS1–8 pre-audit sweep + the SVM noBridge
deployment ceremony (`noBridge-mvp-deployed` tag). All WS1–8 findings have
been resolved and the SVM programs are now live on devnet at the noBridge
HEAD bytecode. What remains is explicitly deferred or blocked on external input.

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

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

### Oracle relay (USDC peg circuit-breaker) — SVM mirror

The EVM side shipped an `OracleRelay` proxy contract (see
`EVM/src/oracle/OracleRelay.sol` + `IOracleRelay.sol`) that wraps a Chainlink
USDC/USD aggregator, validates round completeness / freshness / in-band price,
and normalizes the answer to 1e18 precision. `LitePSM` and `RedemptionQueue` on
EVM call `oracleRelay.checkUsdcPeg()` at the top of every mint, redeem, and
`processQueue` path to circuit-break when USDC depegs.

**SVM mirror required:** build a parallel `oracle-relay` Solana program (or a
single PDA writer that ingests Pyth / Switchboard / Chainlink Solana data) that
exposes a normalized `(price_e18, last_updated, in_band)` shape. `lite-psm`
should consume the check inside `mint_oku_m`, `redeem_oku_m`, and
`process_queue` instructions, with an operator-controlled enable/disable
toggle paralleling EVM's `setOracleRelay(address(0))` kill switch.

**Constants that must match EVM:**

| Constant | EVM value | Notes |
| --- | --- | --- |
| `ORACLE_USDC_PRICE_FLOOR` | `0.95e18` | Hard floor for the peg band setter. |
| `ORACLE_USDC_PRICE_CEILING` | `1.05e18` | Hard ceiling for the peg band setter. |
| Default band | `[0.97e18, 1.03e18]` | ±3% — revisit per ops feedback. |
| Default staleness | `3600s` (1 hour) | Bounded by `[60s, 7 days]`. |
| `MAX_FEED_DECIMALS` | `18` | Reject feeds reporting more decimals than this. |

**Status when starting:** EVM side is feature-complete with tests and is in
the audit-ready pre-flight set. SVM side intentionally deferred to a separate
work stream so this audit cycle focuses on EVM only.

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

### `cargo clippy -D warnings`

Not yet run systematically; likely latent lint debt across `programs/` and `crates/`.
Once clean, add `cargo clippy -D warnings` to the `svm-cargo` CI job.

**Effort:** 1–3 days (first run + triage + fixes). Low risk — mostly style.

### `cargo dylint` (crytic/solana-lints)

Trail of Bits' Solana lint suite is declared in `Cargo.toml` but never invoked.
May surface real security-relevant patterns (unchecked arithmetic, incorrect CPI
authority handling, etc.).

**Effort:** 1–2 days. **Worth running before audit.**

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

## 📚 References

- `docs/orchestrator-runbook.md` — preflight checklist, failure recovery, minterAllowance rotation, monitoring SLAs.
- `README.md § Signer trust implications` — what each key tier can and cannot do on-chain.
- `EVM/README.md § Per-role trust and blast radius` — EVM-specific role table with bounded/unbounded characterization.
- `SVM/README.md § Authority Model` — SVM-specific per-role table with blast radius.
- `SVM/EVM_VS_SVM.md` — full EVM↔SVM divergence catalogue.
- `TESTNET_DEPLOYMENT.md` — initial parameters, mainnet RBAC ceremony, SVM upgrade-authority ceremony.
- `tests/shared/bankrun.ts` — bankrun harness (single source of truth for in-process tests).
- `tests/shared/setup.ts` — runner-agnostic PSM bootstrap.
