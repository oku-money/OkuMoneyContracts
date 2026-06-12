# EVM Tracker

Working notes for the EVM side of okuMoney. Mirror of the SVM/TRACKER.md
structure (issue queue, in-flight work, accepted risks pointer).

## Audit-readiness snapshot

| Item | State |
|---|---|
| Production contracts | 5 (`OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`, `OracleRelay`) |
| Forge unit + fuzz tests | 577 / 577 |
| Forge invariants | 18 / 18 |
| Hardhat fork + scenarios | 28 / 28 |
| Forge coverage (lines / branches) | 98.90% / 86.99% |
| Slither | 17 informational, 0 actionable |
| OpenZeppelin pin | 5.6.1 (Foundry + Hardhat identical) |
| Solidity / Hardhat / ethers | 0.8.28 / 2.28.6 / 6.16.0 |

Full audit handoff package lives under `audit/`:

- `audit/README.md` — entry point.
- `audit/ACCEPTED_RISKS.md` — known trust-assumptions, in-scope and out-of-scope notes.
- `audit/slither-checklist.md` — per-finding triage.
- `audit/coverage-summary.txt`, `audit/contract-sizes.txt` — metric snapshots.
- `audit/test-output-*.txt` — captured test transcripts.

## Trust model (informs the redundant-feature list below)

okuMoney is a centralized financial product. The operator multisig is trusted
to:

- Set the OkuMoney appreciation multiplier each epoch.
- Set / extend / retire the OkuDollar yield rate.
- Mint and burn against per-minter allowances.
- Manage the LitePSM USDC buffer (deposit / withdraw / queue process).
- Wire and rotate the `OracleRelay` USDC/USD feed.
- Pause and blacklist where required by regulation.

Operator compromise is **out of scope** for the security model. The on-chain
contracts retain a small number of guards that survive operator compromise
(peg-band hard floor/ceiling, `MultiplierCannotDecrease`) but the threat model
does NOT generally include "what if the operator key is malicious." See
`audit/ACCEPTED_RISKS.md` for the formal accepted-risks list.

The PoR (Proof-of-Reserves) plumbing that previously lived inside `LitePSM`
was removed in this audit-prep cycle because the trust model made it
redundant — the operator is already responsible for backing USDC; the
on-chain PoR check did not detect operator-side reserve fraud, only oracle
malfunction. The remaining `OracleRelay` is a USDC peg circuit-breaker, not
a reserves attestation.

## Potentially redundant / unused functions

Tracked for future review. These are NOT dead code (each is reachable and
covered by tests) but each is either redundant given the trust model, or
purely operational convenience that could be removed if the operator runbook
confirms it is unused.

A pruning pass on these should only happen after audit feedback so the
auditor can see the full surface as currently shipped.

### Operator surface that may be unused

- `LitePSM.depositReserves()` (`PSM_BUFFER_DEPOSITOR`).
  Adds USDC to the PSM buffer outside the normal mint flow. The operator can
  equivalently mint OkuM/OkuDollar to themselves to inject buffer, so this
  function is convenience-only. Audit-prep notes flagged it as a candidate
  for removal; user direction is to keep it for now and revisit once the
  operator runbook is finalized.
- `LitePSM.withdrawSurplus()` (`PSM_BUFFER_DEPOSITOR`).
  *(Note: the function is named `withdrawUsdc` in the current code; the
  conceptual pair is the buffer-deposit / buffer-withdraw pair. Treat the
  same way as `depositReserves`.)*

### Defensive guards that are unreachable through user paths

These remain because they fail-loud against future-developer mistakes or
math-sanity edge cases. Removing them would only save a handful of bytes per
guard and is not worth the risk.

- `OracleRelay.getUsdcPrice` — `feedDecimals > 18` branch.
  Forward-compat sentinel. Rejected at `initialize` / `setPriceFeed`, so
  unreachable in production. Kept as a math-safety net rather than an
  `assert`.
- `OkuDollar._update` — `UseWrapInstead` / `UseUnwrapInstead`.
  Block inherited ERC-20 `_mint` / `_burn` paths which would corrupt the
  share-based accounting. Strictly fail-loud rails for future maintainers.
- `LitePSM.mintOkuM` / `LitePSM.mintUsdOku` — `RoundTripDriftTooLarge`.
  Math-regression detector: if MathLib rounding semantics change in a future
  upgrade and break round-trip parity by more than 1 USDC unit, this guard
  reverts before user funds move. Today's MathLib implementations never trip
  it; covered only by fuzz boundary cases.

### Setup-time helpers redundant with deploy scripts

- `RedemptionQueue.assertUsdcMatch(address)`.
  Setup-time runtime helper that checks the queue's USDC matches the PSM's
  USDC. Anyone can call; read-only; no side effects. Useful as a deploy-time
  sanity check, but the deploy script already wires the USDC address from a
  single source of truth, so production deployments don't need to call this
  on-chain. Worth re-evaluating after audit — could be hoisted into the
  Solidity deploy helper (`test/shared/Deploy.sol`) instead of living on the
  proxy.

### Convenience views (off-chain UX only)

- `OkuDollar.getStatus()`.
  Bundles all rate-and-share view state into one call. Pure convenience —
  every field is also exposed via an individual getter. Off-chain consumers
  use this to reduce RPC round-trips. No on-chain caller.

## In-flight work

(none — audit-prep cycle complete)

## Recent decisions

- 2026-06-12 — Removed PoR plumbing from `LitePSM`; replaced with
  `OracleRelay` USDC peg circuit-breaker. Storage-incompatible LitePSM
  change accepted because deployed testnet proxies are throwaway.
- 2026-06-12 — Tightened `OkuMoney.setOkuMMultiplier` to require strict
  increase (rejects equal value). Aligns with `distributeYield`'s
  `YieldTooSmall` guard so a no-op call cannot stamp the sandwich-lock
  block without moving the multiplier.
- 2026-06-12 — Re-doc'd `MAX_MULTIPLIER` and `MultiplierTooHigh` as math
  sanity bounds rather than "defense against compromised rebaser key."
  Operator-compromise is out of scope; the cap exists to bound
  downstream `uint256 * uint256` paths away from overflow.

## Pointers

- Audit handoff: `audit/README.md`
- Accepted risks: `audit/ACCEPTED_RISKS.md`
- Dependency pinning: `DEPENDENCIES.md`
- SVM-side tracker: `../SVM/TRACKER.md`
