# Audit Package — okuMoney EVM Contracts

Pre-audit deliverables for the OkuMoney EVM contracts. Reference
these files when preparing the audit scope document. Post-Tier-A
surface-pruning baseline (2026-06-23).

## Contents

| File | Description |
|---|---|
| `README.md` | This file — accepted risks, slither triage, tool snapshots. |
| `coverage-summary.txt` | `forge coverage --report summary` output + per-file disposition of uncovered branches. |
| `contract-sizes.txt` | `forge build --sizes` output for the five production contracts. |
| `slither-report.json` | Slither machine-readable findings. |
| `test-output-forge-unit.txt` | `forge test --no-match-path 'test/invariants/*'` output. |
| `test-output-forge-invariants.txt` | `forge test --match-path 'test/invariants/*'` output. |
| `test-output-hardhat.txt` | `npx hardhat test` output. |

## Test count headline (post-Tier-A)

| Suite | Tests | Failures |
|---|---:|---:|
| `forge` unit + fuzz | 574 | 0 |
| `forge` invariants | 18 | 0 |
| Hardhat (fork + integration + scenarios) | 28 | 0 |
| **Total** | **620** | **0** |

Test deltas vs. cycle-4 baseline (623 → 620, −3): Tier A surface
pruning removed 4 permit-redemption tests in
`test/psm/LitePSM.t.sol`, 1 permit test in
`test/psm/LitePSMRebasingRedeem.t.sol`, 1 `getStatus` test in
`test/token/OkuDollar.t.sol`, and 2 `assertUsdcMatch` tests in
`test/psm/LitePSM.t.sol` — 8 deletions offset by 5 new coverage
additions (saturation, balance invariants, blacklist tests).

## Coverage headline

| Metric | Value | Target |
|---|---:|---:|
| Lines | 98.85 % | ≥ 95 % ✓ |
| Statements | 97.49 % | ≥ 95 % ✓ |
| Branches | 84.96 % | ≥ 90 % (see notes) |
| Functions | 99.30 % | ≥ 95 % ✓ |

Branch metric falls under 90 % on the aggregate. Remaining uncovered
branches are defensive guards unreachable through user-callable
paths — full disposition in `coverage-summary.txt` and in the
"Forge coverage notes" section of `../README.md`.

CI gates `forge coverage` at ≥ 95 % per-file line coverage (see
`.github/workflows/test.yml`).

## Static analysis headline

Slither 0.11.4 reports **21 informational-severity findings**. None
are actionable; per-detector triage collapsed inline below.

## Contract sizes headline

All five production contracts well below the EIP-170 24 KB limit:

| Contract | Runtime size (B) | Margin (B) |
|---|---:|---:|
| `OkuMoney` | 11,853 | 12,723 |
| `OkuDollar` | 16,596 |  7,980 |
| `LitePSM` | 12,341 | 12,235 |
| `RedemptionQueue` |  9,255 | 15,321 |
| `OracleRelay` |  6,268 | 18,308 |

Tier A pruning shrank `LitePSM` by 796 B (removed
`redeemOkuMWithPermit`, `redeemUsdOkuWithPermit`) and `OkuDollar`
by 210 B (removed `getStatus`, `OkuDollarStatus` struct).
`RedemptionQueue` and `OkuMoney` grew slightly from unrelated
cycle work; `OracleRelay` unchanged.

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
- `PSM_*` roles: oracle config, queue processing, buffer custody.
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

## 3. USDC peg circuit-breaker (`OracleRelay`)

`OracleRelay` (`src/oracle/OracleRelay.sol`) reads a Chainlink
USDC/USD aggregator, validates round completeness + freshness +
in-band price, and exposes `checkUsdcPeg()` to `LitePSM` and
`RedemptionQueue`. Every mint, redeem, and `processQueue` path gates
on the relay when wired. The previous Proof-of-Reserves plumbing
was removed entirely (operator-side reserve fraud isn't a threat
the on-chain code can detect — managed via off-chain MSB controls).

**Operator kill switch (intentional):** both consumers expose
`setOracleRelay(address(0))` (gated on `PSM_ORACLE_MANAGER` /
`QUEUE_ORACLE_MANAGER`), which disables the peg check. Cycle 4
(EVM-03) added an explicit `OracleRelayDisabled` event alongside
the standard `OracleRelayUpdated` so monitoring tooling can
distinguish a kill-switch trip from a routine rotation. The disable
path is reachable only by the operator multisig.

**Hardcoded defense-in-depth bounds:**

- Band setter bounded by `ORACLE_USDC_PRICE_FLOOR = 0.95e18` and `ORACLE_USDC_PRICE_CEILING = 1.05e18`.
- Staleness setter bounded by `ORACLE_MIN_STALENESS = 60 s` and `ORACLE_MAX_STALENESS = 7 days`.
- Feed decimals must be `<= 18`.

**Default initial band:** `[0.97e18, 1.03e18]` (±3 %). To be
revisited based on observed Chainlink feed jitter in production.

**SVM mirror:** The SVM single-token refactor removed the on-chain
oracle relay (`oracle_relay.rs`, Pyth V2 parser) from `lite-psm`.
USDC peg monitoring on SVM is now handled entirely off-chain by
the orchestrator, which pauses the PSM if a depeg is detected.
The EVM side retains the on-chain `OracleRelay` circuit-breaker
(Chainlink USDC/USD aggregator) as described above.

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

`forge coverage --report summary` reports 89.08 % branch coverage on
the production contracts. The remaining uncovered branches are
listed in `coverage-summary.txt` and are all:

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

Tool: `slither 0.11.4`. Command:
`slither . --filter-paths "test/|lib/|script/|node_modules/"`.

All 21 findings are **Informational** severity. None are actionable.

## Triage summary

| Detector | Count | Disposition |
|---|---:|---|
| `assembly` | 5 | Accepted — all five are ERC-7201 namespaced storage helpers (`_getXStorage()`) on OkuMoney, OkuDollar, LitePSM, RedemptionQueue, OracleRelay. Inline assembly is required by the EIP-7201 pattern. |
| `dead-code` | 4 | False positives. Hits: `LitePSM._pegCheck` (called from every mint/redeem path), `LitePSM._redeemOkuMFromSelf` (called from `_redeemUsdOku`), `OkuDollar._update` (ERC-20 inheritance hook used by `super._update`), `OracleRelay._readAndValidateFeedDecimals` (called from `initialize` and `setPriceFeed`). |
| `naming-convention` | 5 | Accepted convention. Leading-underscore parameter names on constructor / init args (standard OpenZeppelin style). |
| `timestamp` | 3 | Accepted. All three are in `OkuDollar` and gate yield-rate windowing on `block.timestamp` comparisons. Operator-controlled, drift-tolerant, no MEV path. |
| `calls-loop` | 1 | Accepted. `RedemptionQueue.processQueue` calls `$.okuMoney.burn(...)` inside the loop body. The burn is intrinsic to processing each entry; batch size is operator-controlled via `startIndex`/`endIndex`. |
| `unindexed-event-address` | 3 | Out of scope. All three events (`IERC1967.AdminChanged`, `Pausable.Paused`, `Pausable.Unpaused`) live in OpenZeppelin libraries; can't be redeclared with `indexed`. |

Net actionable items: **0**.

## Original Slither output (excerpt)

```
Summary
 - assembly (5 results) (Informational)
 - dead-code (4 results) (Informational)
 - naming-convention (5 results) (Informational)
 - unindexed-event-address (3 results) (Informational)

## assembly
[OkuDollar._getOkuDollarStorage()] uses assembly (ERC-7201 namespaced storage)
[OracleRelay._getOracleRelayStorage()] uses assembly (ERC-7201 namespaced storage)
[OkuMoney._getOkuMoneyStorage()] uses assembly (ERC-7201 namespaced storage)
[LitePSM._getLitePSMStorage()] uses assembly (ERC-7201 namespaced storage)
[RedemptionQueue._getRedemptionQueueStorage()] uses assembly (ERC-7201 namespaced storage)

## dead-code
[LitePSM._redeemOkuMFromSelf(address,uint256)] — false positive (reachable via _redeemUsdOku)
[OkuDollar._update(address,address,uint256)] — false positive (ERC-20 inheritance hook)
[LitePSM._pegCheck(LitePSM.LitePSMStorage)] — false positive (reachable via every mint/redeem path)
[OracleRelay._readAndValidateFeedDecimals(address)] — false positive (reachable via initialize, setPriceFeed)

## naming-convention
Parameters [_okuMoney], [_admin], [_priceFeed] etc — leading-underscore init params, OZ convention

## unindexed-event-address
[IERC1967.AdminChanged] — OpenZeppelin library event
[PausableUpgradeable.Unpaused], [PausableUpgradeable.Paused] — OpenZeppelin library events
```

Full per-line triage of each ID was captured in the cycle-3 review;
no IDs have changed since.

---

## Pointers

- **EVM-specific docs:** [`../README.md`](../README.md)
- **Workspace overview:** [`../../README.md`](../../README.md)
- **Open issues:** [`../../TRACKER.md`](../../TRACKER.md)
- **SVM in-repo audit:** [`../../SVM/oku-programs/audit/README.md`](../../SVM/oku-programs/audit/README.md)
