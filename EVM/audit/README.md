# Audit Package — okuMoney EVM contracts

This directory contains the pre-audit deliverables for the OkuMoney EVM
contracts. Reference these files when preparing the audit scope document
(`AUDIT_SCOPE.md`, drafted separately).

## Contents

| File | Description |
|---|---|
| `README.md` | This file. |
| `ACCEPTED_RISKS.md` | Known issues / accepted risks the auditor should NOT re-flag. |
| `coverage-summary.txt` | `forge coverage --report summary` output + per-file disposition of uncovered branches. |
| `contract-sizes.txt` | `forge build --sizes` output for the five production contracts. |
| `slither-checklist.md` | Slither human-readable findings + per-detector triage. |
| `slither-report.json` | Slither machine-readable findings. |
| `test-output-forge-unit.txt` | `forge test --no-match-path 'test/invariants/*'` output. |
| `test-output-forge-invariants.txt` | `forge test --match-path 'test/invariants/*'` output. |
| `test-output-hardhat.txt` | `npx hardhat test` output. |

## Test count headline

| Suite | Tests | Failures |
|---|---:|---:|
| `forge` unit + fuzz | 577 | 0 |
| `forge` invariants | 18 | 0 |
| Hardhat (fork + integration + scenarios) | 28 | 0 |
| **Total** | **623** | **0** |

## Coverage headline

| Metric | Value | Target |
|---|---:|---:|
| Lines | 98.90% | ≥ 95% ✓ |
| Statements | 97.75% | ≥ 95% ✓ |
| Branches | 86.99% | ≥ 90% (see notes) |
| Functions | 99.23% | ≥ 95% ✓ |

The branch metric falls under the 90% target on the aggregate. The remaining
uncovered branches are all defensive guards unreachable through user-callable
paths (full disposition in `coverage-summary.txt`).

## Static analysis headline

Slither 0.11.4 reports **21 informational-severity findings**. None are
actionable; full triage in `slither-checklist.md`. Categories:

- 5 × `assembly` (ERC-7201 namespaced storage helpers — required by EIP-7201).
- 4 × `dead-code` (false positives — Slither cannot follow internal-helper / inheritance-hook call sites; confirmed reachable via grep).
- 5 × `naming-convention` (leading-underscore parameter names — standard convention).
- 3 × `timestamp` (yield-rate windowing on `block.timestamp` — operator-controlled, drift-tolerant, no MEV path).
- 1 × `calls-loop` (`RedemptionQueue.processQueue` burns each entry's OkuM inside the loop — operator-controlled batch size).
- 3 × `unindexed-event-address` (OpenZeppelin library events outside our control).

## Contract sizes headline

All five production contracts are well below the EIP-170 24 KB limit:

| Contract | Runtime size (B) | Margin (B) |
|---|---:|---:|
| `OkuMoney` | 11,742 | 12,834 |
| `OkuDollar` | 16,806 |  7,770 |
| `LitePSM` | 13,137 | 11,439 |
| `RedemptionQueue` |  8,889 | 15,687 |
| `OracleRelay` |  6,268 | 18,308 |

## OracleRelay (USDC peg circuit-breaker)

Added in this audit-prep cycle. The previous Proof-of-Reserves plumbing inside
LitePSM was removed entirely (`_checkReserves`, `configureOracle`, `porOracle`
storage, related errors) and replaced with a separate `OracleRelay` UUPS proxy
(`src/oracle/OracleRelay.sol`) that:

- Wraps a Chainlink USDC/USD aggregator and validates round + freshness + in-band.
- Normalizes the raw answer to 1e18 precision.
- Exposes `checkUsdcPeg()` / `getUsdcPrice()` via `IOracleRelay`.
- Is consumed by `LitePSM` and `RedemptionQueue` at every mint, redeem, and `processQueue` path (when wired; `setOracleRelay(address(0))` is the operational kill switch).

Audit risk #3 in `ACCEPTED_RISKS.md` documents the operator kill switch and
the hardcoded defense-in-depth bounds.

## Dependency pinning

See `../DEPENDENCIES.md` for the full pinned dependency list. Headlines:

- `solc` 0.8.28
- OpenZeppelin contracts (both `contracts` and `contracts-upgradeable`): **5.6.1**, pinned identically in `package.json` and `foundry.lock`.
- Hardhat 2.28.6 (latest 2.x), ethers 6.16.0, hardhat-toolbox 6.1.2.
