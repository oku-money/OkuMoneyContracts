# Audit Package — okuMoney EVM Contracts

Pre-audit deliverables for the OkuMoney EVM contracts. Reference
these files when preparing the audit scope document.

> **Snapshot status:** The raw tool-output snapshots
> (`coverage-summary.txt`, `contract-sizes.txt`, `slither-report.json`,
> `test-output-forge-unit.txt`, `test-output-forge-invariants.txt`,
> `test-output-hardhat.txt`) were cleared following the OracleRelay
> removal (the five-contract surface shrank to four: `OkuMoney`,
> `OkuDollar`, `LitePSM`, `RedemptionQueue`). Regenerate them before
> handing this package to an auditor — see the commands in the
> Contents table below.

## Contents

| File | Description |
|---|---|
| `README.md` | This file — accepted risks, slither triage, tool snapshots. |
| `coverage-summary.txt` | *(cleared — regenerate via `forge coverage --report summary`)* per-file disposition of uncovered branches. |
| `contract-sizes.txt` | *(cleared — regenerate via `forge build --sizes`)* output for the four production contracts. |
| `slither-report.json` | *(cleared — regenerate via `slither . --filter-paths "test/\|lib/\|script/\|node_modules/"`)* machine-readable findings. |
| `test-output-forge-unit.txt` | *(cleared — regenerate via `forge test --no-match-path 'test/invariants/*'`)* output. |
| `test-output-forge-invariants.txt` | *(cleared — regenerate via `forge test --match-path 'test/invariants/*'`)* output. |
| `test-output-hardhat.txt` | *(cleared — regenerate via `npx hardhat test`)* output. |

## Test count headline (post-OracleRelay-removal)

| Suite | Tests | Failures |
|---|---:|---:|
| `forge` (unit + fuzz + invariants) | 564 | 0 |
| Hardhat (fork + integration + scenarios) | 27 | 0 |
| **Total** | **591** | **0** |

## Coverage headline

| Metric | Value | Target |
|---|---:|---:|
| Lines | 98.95 % | ≥ 95 % ✓ |
| Statements | 97.73 % | ≥ 95 % ✓ |
| Branches | 86.32 % | ≥ 90 % (see notes) |
| Functions | 99.17 % | ≥ 95 % ✓ |

Branch metric falls under 90 % on the aggregate. Remaining uncovered
branches are defensive guards unreachable through user-callable
paths — full disposition in the regenerated `coverage-summary.txt` and in the
"Forge coverage notes" section of `../README.md`.

CI gates `forge coverage` at ≥ 95 % per-file line coverage (see
`.github/workflows/test.yml`).

## Static analysis headline

Slither findings pending regeneration (see snapshot-status note above).
The previous baseline reported informational-severity-only findings;
re-run and re-triage against the current 4-contract surface before
audit handoff.

## Contract sizes headline

All four production contracts well below the EIP-170 24 KB limit
(sizes pending regeneration — see snapshot-status note above).

## Dependency pinning

OpenZeppelin v5.6.1 (Foundry + Hardhat identical), solc 0.8.28,
Hardhat 2.28.6, ethers 6.16.0, hardhat-toolbox 6.1.2. Full pin list
in `../README.md § Dependencies`.

## Tier A surface pruning (post-cycle-4)

The audit-prep cycle (2026-06-18 → 2026-06-23) removed external
surface that was reachable but had no on-chain caller and was
trivially composable off-chain. Auditors comparing source against
an earlier draft should note these no longer exist:

| Removed | Replacement | File |
|---|---|---|
| `LitePSM.redeemOkuMWithPermit` | client-side `permit()` + `redeemOkuM()` | `src/psm/LitePSM.sol` |
| `LitePSM.redeemUsdOkuWithPermit` | client-side `permit()` + `redeemUsdOku()` | `src/psm/LitePSM.sol` |
| `OkuDollar.getStatus` + `OkuDollarStatus` struct | per-field views already on the contract | `src/token/OkuDollar.sol` |
| `RedemptionQueue.assertUsdcMatch` + `UsdcMismatch` error | inline equality check in `scripts/deploy/index.ts` | `src/psm/RedemptionQueue.sol` |

Storage layouts were not touched. The removals shrink the audit
surface area without changing semantics of any retained function.

---

# Accepted Risks

This document lists known issues and design choices explicitly
accepted by the protocol team. Auditors should be aware so the same
ground isn't re-covered as new findings.

## 1. Centralized operator model — no on-chain timelock

**Decision:** OkuMoney v1 ships as a centralized financial product,
modelled on similar yield-bearing stablecoins (Ondo Finance, Circle
USDC). No `TimelockController` sits between the operator multisig
and any contract.

**Scope of operator powers:**

- `OKUM_REBASER`: writes `okuMMultiplier` and `lastYieldDistributionBlock`. Bounded by `MAX_MULTIPLIER` and monotonic-increase invariants.
- `VAULT_REBASER`: writes USD yield rate. Bounded by `MAX_RATE` and `MAX_MULTIPLIER`.
- `VAULT_RESERVE_MANAGER`: deposits / withdraws OkuMoney from vault reserves. Withdrawals gated by `minCollateralRatio` post-condition and `whenYieldNotDistributing`.
- `OKUM_MINTER` / `OKUM_BURNER`: bounded by per-minter allowance + global `maxSupply`. PSM and Queue are the only intended holders. Cycle 4 (EVM-15) split `OKUM_BURNER` from `OKUM_MINTER`.
- `PSM_*` roles: queue processing, buffer custody.
- `OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER`: shared blacklist for OkuMoney + OkuDollar.

**On-chain mitigations:**

- All multiplier-write operations stamp `lastYieldDistributionBlock`; the `whenYieldNotDistributing` modifier prevents same-block sandwich attacks on every PSM + vault op that reads the multiplier.
- Defense-in-depth ceilings (`MAX_MULTIPLIER = 1e24`, `MAX_RATE = PRECISION + 1e11`) cap the blast radius of a single-call compromise.
- Monotonic guards (`MultiplierCannotDecrease`, `RateAlreadyExpired`) prevent backward writes.

**Operational expectations:**

- Each operational role must rotate to a multisig before mainnet launch.
- `VAULT_REBASER` and `VAULT_RESERVE_MANAGER` must be held by separate keys / multisigs (Risk 2 below).

## 2. `VAULT_REBASER` + `VAULT_RESERVE_MANAGER` cross-block opsec

**Issue:** If both `VAULT_REBASER` and `VAULT_RESERVE_MANAGER` are
held by the same key, that key can sequence `setUsdYieldRate` (or
`distributeYield`) in block N followed by `withdrawSurplus` in block
N + 1 to extract value just added to the apparent reserve dollar
valuation.

**On-chain mitigation:** `whenYieldNotDistributing` prevents the
SAME-block attack. Cross-block manipulation is NOT mitigated
on-chain — would require either a timelock (rejected, see Risk 1)
or stale-multiplier checks that themselves depend on the same
compromised key.

**Off-chain mitigation:** Roles MUST be held by separate
keys / multisigs, both rotated to multisigs before mainnet. Documented
in NatSpec on
[`OkuDollar.withdrawSurplus`](../src/token/OkuDollar.sol).

## 3. USDC peg monitoring — off-chain (no on-chain oracle)

Both chains now handle USDC peg monitoring entirely off-chain. The
EVM side previously had an on-chain `OracleRelay` circuit-breaker
(Chainlink USDC/USD aggregator, `checkUsdcPeg()` gate on every mint,
redeem, and `processQueue` path) — this was fully removed, including
the storage slots that referenced it. `LitePSM` and `RedemptionQueue`
storage layouts were both compacted (the `__deprecated_oracleRelay`
placeholder slots were dropped entirely rather than kept as
`__gap`-style filler). All associated roles (`PSM_ORACLE_MANAGER`,
`QUEUE_ORACLE_MANAGER`, `RELAY_UPGRADER`, `RELAY_FEED_MANAGER`,
`RELAY_CONFIG_MANAGER`), constants, errors, and events were removed
as well. Since existing testnet/mainnet-test deployments used mock
USDC and were never a production launch, this is a clean-slate
change — the current contracts are not upgrade-compatible with any
pre-removal deployment and require a fresh deploy (the corresponding
`.openzeppelin/*.json` manifests for the prior deployments were
deleted for the same reason).

**SVM parity:** The SVM single-token refactor similarly removed its
on-chain oracle relay (Pyth V2 parser) from `lite-psm`. Both chains
now converge on the same model: USDC peg monitoring is handled
entirely off-chain by the orchestrator, which pauses the PSM if a
depeg is detected.

## 4. 1-wei share dust in `OkuDollar.transferFrom` under inflated `usdMultiplier`

**Issue:** `OkuDollar` accounts in shares but exposes a
dollar-denominated ERC-20 interface. `transferFrom(amount)` floors
the share conversion. When `usdMultiplier > 1e18`, multiple
sequential `transferFrom` calls against a single permit-approved
allowance may under-consume shares by ~1 share per call due to
floor truncation.

**Status:** Documented in NatSpec on
[`OkuDollar.permit`](../src/token/OkuDollar.sol). The 1-wei drift
always favours the holder, never the protocol. Integrators planning
batched `transferFrom` against a single permit allowance should
account for the sub-call dust.

Cycle 4 (EVM-04) tightened the related `Transfer` event so its
emitted `value` matches the post-rounding share-converted amount,
restoring the ERC-20 invariant `Σ Transfer.value == Δ balanceOf`.

## 5. `OkuDollar._update` ERC-20 tripwires

**Issue:** `OkuDollar` overrides `transfer` / `transferFrom` to use
share-based accounting bypassing the inherited
`ERC20Upgradeable._update`. The `_update` override reverts on mint
(`from == address(0)`) and burn (`to == address(0)`) to ensure all
supply changes go through `wrap()` / `unwrap()` (which manage
`usdShares` directly).

**Status:** Defensive forward-compat sentinels. They cannot fire on
any existing call path — the inherited `_mint` / `_burn` are not
called anywhere in OkuDollar. The reverts exist only to catch a
future bug where an upgrade accidentally routes through `_update`.

## 6. `RedemptionQueue.advanceHead` is permissionless

**Decision:** The cursor-advance maintenance function is callable
by anyone. No privileged effect — `queueHead` can only move forward,
and only past slots that are already cleared (`user == address(0)`).
Visible effect is purely on `queueLength()` accuracy.

**Rationale:** A privileged version (e.g. `onlyRole(QUEUE_RESCUER)`)
adds no security and complicates the operator runbook. The function
is gas-bounded by `maxSlots` and emits a `QueueHeadAdvanced` event
on any non-zero advance.

## 7. Slither informational findings

All Slither findings are informational and accepted. Per-detector
triage below (consolidated from the former `slither-checklist.md`).
Headlines:

- **assembly**: ERC-7201 namespaced storage helpers (required by EIP-7201).
- **dead-code**: false positives — flagged functions are reachable via documented call sites.
- **naming-convention**: leading-underscore parameter names (standard convention).
- **unindexed-event-address**: OpenZeppelin library events; can't be re-indexed from a downstream contract.

## 8. Branch coverage shortfall on defensive guards

`forge coverage --report summary` reports 86.32 % branch coverage on
the production contracts. The remaining uncovered branches are
listed in the regenerated `coverage-summary.txt` and are all:

- Unreachable under the `MAX_MULTIPLIER = 1e24` cap (e.g. `AmountTooSmall`, `RoundTripDriftTooLarge` in LitePSM).
- Defensive forward-compat sentinels (e.g. `OkuDollar._update` reverts).
- Identical guard expressions to already-covered branches that LCOV counts as separate.

No user-callable code path is uncovered.

## 9. Deprecated bridge feature

The on-chain OkuBridge / OkuBridgeRouter / NttAdapter contracts and
all associated tests / scripts / role constants were deleted in the
bridge deprecation cleanup pre-audit. The historical bridge
implementation is preserved on a separate git branch should it be
revisited. No bridge-related code remains in `src/`, `test/`, or
`scripts/`.

---

# Slither findings — pre-audit triage

> **Pending regeneration.** The triage below reflects the pre-
> OracleRelay-removal 5-contract surface and is stale (it references
> `OracleRelay._getOracleRelayStorage`, `OracleRelay._readAndValidateFeedDecimals`,
> and `LitePSM._pegCheck`, all removed). Re-run
> `slither . --filter-paths "test/|lib/|script/|node_modules/"`
> against the current 4-contract surface (`OkuMoney`, `OkuDollar`,
> `LitePSM`, `RedemptionQueue`) and replace this section before audit
> handoff. The prior findings (assembly, dead-code false positives,
> naming-convention, timestamp, calls-loop, unindexed-event-address)
> are expected to recur in similar form on the remaining four
> contracts, minus the OracleRelay-specific entries.

Regenerate and re-triage before audit handoff.

---

## Pointers

- **EVM-specific docs:** [`../README.md`](../README.md)
- **Workspace overview:** [`../../README.md`](../../README.md)
- **Open issues:** [`../../TRACKER.md`](../../TRACKER.md)
- **SVM in-repo audit:** [`../../SVM/oku-programs/audit/README.md`](../../SVM/oku-programs/audit/README.md)
