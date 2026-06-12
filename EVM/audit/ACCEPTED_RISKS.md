# Accepted Risks — OkuMoney EVM

This document lists known issues and design choices that have been explicitly
accepted by the protocol team. Auditors should be aware of these so the same
ground is not re-covered as new findings. Each item links to the relevant
NatSpec / test where applicable.

---

## 1. Centralized operator model — no on-chain timelock

**Decision:** OkuMoney v1 ships as a centralized financial product, modeled
on similar yield-bearing stablecoins (Ondo Finance, Circle USDC). No
`TimelockController` sits between the operator multisig and any contract.

**Scope of operator powers:**

- `OKUM_REBASER`: writes `okuMMultiplier` and `lastYieldDistributionBlock`. Bounded by `MAX_MULTIPLIER` and monotonic-increase invariants.
- `VAULT_REBASER`: writes USD yield rate. Bounded by `MAX_RATE` and `MAX_MULTIPLIER`.
- `VAULT_RESERVE_MANAGER`: deposits / withdraws OkuMoney from vault reserves. Withdrawals are gated by `minCollateralRatio` post-condition and `whenYieldNotDistributing`.
- `OKUM_MINTER`: bounded by per-minter allowance + global `maxSupply`. PSM and Queue are the only intended holders.
- `PSM_*` roles: oracle config, queue processing, buffer custody.
- `OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER`: shared blacklist for OkuMoney + OkuDollar.

**Mitigations on-chain:**

- All multiplier-write operations stamp `lastYieldDistributionBlock` and the `whenYieldNotDistributing` modifier prevents same-block sandwich attacks on every PSM and vault operation that reads the multiplier.
- Defense-in-depth ceilings (`MAX_MULTIPLIER = 1e24`, `MAX_RATE = PRECISION + 1e11`) cap the blast radius of a single-call compromise.
- Monotonic guards (`MultiplierCannotDecrease`, `RateAlreadyExpired`) prevent backward writes.

**Operational expectations:**

- Each operational role must rotate to a multisig before mainnet launch.
- `VAULT_REBASER` and `VAULT_RESERVE_MANAGER` must be held by separate keys / multisigs (see Risk 2).

---

## 2. `VAULT_REBASER` + `VAULT_RESERVE_MANAGER` cross-block opsec

**Issue:** If both `VAULT_REBASER` and `VAULT_RESERVE_MANAGER` are held by the
same key, that key can sequence a `setUsdYieldRate` (or `distributeYield`)
in block N followed by a `withdrawSurplus` in block N+1 to extract value
that was just added to the apparent reserve dollar valuation.

**On-chain mitigation:** `whenYieldNotDistributing` prevents the SAME-block
attack. Cross-block manipulation is NOT mitigated on-chain — it would
require either a timelock (rejected, see Risk 1) or stale-multiplier checks
that themselves depend on the same compromised key.

**Off-chain mitigation:** The two roles MUST be held by separate
keys / multisigs, both rotated to multisigs before mainnet operation.
This is documented in NatSpec on
[`OkuDollar.withdrawSurplus`](../src/token/OkuDollar.sol).

---

## 3. USDC peg circuit-breaker now in scope (`OracleRelay`)

`OracleRelay` (`src/oracle/OracleRelay.sol`) reads a Chainlink USDC/USD
aggregator, validates round completeness + freshness + in-band price, and
exposes `checkUsdcPeg()` to `LitePSM` and `RedemptionQueue`. Every mint,
redeem, and `processQueue` path gates on the relay when it is wired. The
previous Proof-of-Reserves plumbing was removed entirely.

**Operator kill switch (intentional):** both consumers expose
`setOracleRelay(address(0))` (gated on `PSM_ORACLE_MANAGER` and
`QUEUE_ORACLE_MANAGER` respectively), which disables the peg check. This is
the documented incident-response mechanism. Auditors should review the
disable path and confirm it can only be reached by the operator multisig.

**Hardcoded defense-in-depth bounds:**

- Band setter is bounded by `ORACLE_USDC_PRICE_FLOOR = 0.95e18` and
  `ORACLE_USDC_PRICE_CEILING = 1.05e18` (see `src/lib/Constants.sol`).
- Staleness setter is bounded by `ORACLE_MIN_STALENESS = 60s` and
  `ORACLE_MAX_STALENESS = 7 days`.
- Feed decimals must be `<= 18`; the relay rejects feeds with more.

**Default initial band:** `[0.97e18, 1.03e18]` (±3%). To be revisited based
on observed Chainlink feed jitter in production. Set at proxy initialization
and tunable later via `setPriceBand`.

**SVM mirror:** out of scope for this audit; the SVM TRACKER carries a
parallel work item for a `lite-psm`-consumed peg check program / PDA on
Solana that matches these constants.

---

## 4. 1-wei share dust in `OkuDollar.transferFrom` under inflated `usdMultiplier`

**Issue:** `OkuDollar` accounts in shares but exposes a dollar-denominated
ERC-20 interface. `transferFrom(amount)` floors the share conversion. When
`usdMultiplier > 1e18`, multiple sequential `transferFrom` calls against a
single permit-approved allowance may under-consume shares by ~1 share per
call due to floor truncation.

**Status:** Documented in NatSpec on
[`OkuDollar.permit`](../src/token/OkuDollar.sol). The 1-wei drift always
favors the holder, never the protocol. Integrators that plan batched
`transferFrom` against a single permit allowance should account for the
sub-call dust.

---

## 5. `OkuDollar._update` ERC-20 tripwires

**Issue:** `OkuDollar` overrides `transfer` / `transferFrom` to use share-based
accounting that bypasses the inherited `ERC20Upgradeable._update`. The
`_update` override reverts on mint (`from == address(0)`) and burn
(`to == address(0)`) to ensure all supply changes go through `wrap()` /
`unwrap()` which manage `usdShares` directly.

**Status:** Defensive forward-compat sentinels. They cannot fire on any
existing call path — the inherited `_mint` / `_burn` are not called anywhere
in OkuDollar. The reverts exist only to catch a future bug where an upgrade
accidentally routes through `_update`.

---

## 6. `RedemptionQueue.advanceHead` is permissionless

**Decision:** The cursor-advance maintenance function is callable by anyone.
It has no privileged effect — `queueHead` can only move forward, and only
past slots that are already cleared (`user == address(0)`). The visible
effect is purely on `queueLength()` accuracy.

**Rationale:** A privileged version (e.g. `onlyRole(QUEUE_RESCUER)`) adds
no security and complicates the operator runbook. The function is
gas-bounded by `maxSlots` and emits a `QueueHeadAdvanced` event on any
non-zero advance.

---

## 7. Slither informational findings

All 16 Slither findings are informational and accepted. See
`slither-checklist.md` for the per-detector triage. Headlines:

- **assembly**: ERC-7201 namespaced storage helpers (required by EIP-7201).
- **dead-code**: false positives; the flagged functions are reachable via documented call sites.
- **naming-convention**: leading-underscore parameter names (standard convention).
- **unindexed-event-address**: OpenZeppelin library events; can't be re-indexed from a downstream contract.

---

## 8. Branch coverage shortfall on defensive guards

`forge coverage --report summary` reports 89.08% branch coverage on the
production contracts. The remaining uncovered branches are listed in
`coverage-summary.txt` and are all:

- Unreachable under the `MAX_MULTIPLIER = 1e24` cap (e.g. `AmountTooSmall`, `RoundTripDriftTooLarge` in LitePSM).
- Defensive forward-compat sentinels (e.g. `OkuDollar._update` reverts, `_checkReserves` `OracleNotConfigured`).
- Identical guard expressions to already-covered branches that LCOV counts as separate.

No user-callable code path is uncovered.

---

## 9. Deprecated bridge feature

The on-chain OkuBridge / OkuBridgeRouter / NttAdapter contracts and all
associated tests / scripts / role constants were deleted in the bridge
deprecation cleanup pre-audit. The historical bridge implementation is
preserved on a separate git branch should it be revisited. No bridge-related
code remains in `src/`, `test/`, or `scripts/`.
