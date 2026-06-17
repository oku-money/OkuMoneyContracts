# EVM Tracker

Currently-open issues + blockers for the okuMoney EVM stack.
Resolved items are removed; full history lives in git +
[`audit/README.md`](audit/README.md) (cycle-4 findings section).

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

---

## 🟡 Should-fix before external audit

### Key custody + change-management documentation

Auditors of centralized stablecoin contracts evaluate operational
controls, not on-chain delay mechanisms. What's expected and
currently missing from the repo:

- **Key custody procedures.** Where are the cold / warm multisig
  hardware devices stored? What's the off-boarding process when a
  signer leaves? What's the recovery process if a device is lost?
- **Change-management runbook per admin action class.** For each
  cold-multisig action (`configureRelay`, `configureMinterAllowance`,
  `setMaxSupply`, role grants, upgrade ceremonies): who proposes?
  Who reviews the proposed tx data? Who signs? What's the dry-run /
  fork-test requirement before mainnet?
- **Segregation-of-duties statement.** Which humans hold cold vs
  warm vs orchestrator keys? Do any individuals hold keys in more
  than one tier? (The system allows overlap on-chain; operational
  policy should prohibit it.)
- **Incident response procedures.** Specific runbooks for:
  compromised orchestrator key, compromised warm multisig,
  unexpected admin event detected by monitoring.

**Effort:** 2–4 days (writing, not implementation). This is what
audit reports flag for centralized stablecoin projects, not missing
timelocks.

### Health-check / monitoring scripts

Standalone scripts that exit non-zero on out-of-band conditions —
needed for day-1 operator dashboards and alerting:

- Oracle staleness (`updatedAt` vs `stalenessThreshold`).
- Queue depth and age of oldest entry.
- Buffer solvency (`vault_usdc >= total_queued_oku_m × oku_m_price / 1e9`).
- Pause state.
- Supply vs cap headroom.
- Minter allowance headroom.

Both EVM and SVM need this. Output JSON for
Prometheus / alertmanager consumption. **Effort:** 2–4 days total
across both sides.

---

## ⚪ Post-launch / low-priority

### Potentially redundant / unused functions

Tracked for future review. None are dead code (each is reachable
and covered by tests) but each is either redundant given the
centralized trust model or operational convenience that could be
removed if the operator runbook confirms it is unused.

A pruning pass should only happen after audit feedback so the
auditor sees the full surface as currently shipped.

**Operator surface:**

- `LitePSM.depositReserves()` (`PSM_BUFFER_DEPOSITOR`) — adds USDC
  to the PSM buffer outside the normal mint flow. The operator can
  equivalently mint OkuM/OkuDollar to themselves to inject buffer.
  Convenience-only.
- `LitePSM.withdrawUsdc()` (`PSM_BUFFER_WITHDRAWER`) — symmetric
  to the above. Treat the same way.

**Defensive guards (unreachable through user paths):**

- `OracleRelay.getUsdcPrice` — `feedDecimals > 18` branch. Rejected
  at `initialize` / `setPriceFeed`, so unreachable in production.
  Kept as math-safety net.
- `OkuDollar._update` — `UseWrapInstead` / `UseUnwrapInstead`. Block
  inherited ERC-20 `_mint` / `_burn` paths that would corrupt
  share-based accounting. Strictly fail-loud rails for future
  maintainers.
- `LitePSM.mintOkuM` / `mintUsdOku` — `RoundTripDriftTooLarge`.
  Math-regression detector. Today's MathLib never trips it.

**Setup-time helpers redundant with deploy scripts:**

- `RedemptionQueue.assertUsdcMatch(address)`. Read-only sanity check
  that the queue's USDC matches the PSM's USDC. Worth re-evaluating
  after audit — could be hoisted into the Solidity deploy helper
  instead of living on the proxy.

**Convenience views (off-chain UX only):**

- `OkuDollar.getStatus()`. Bundles all rate-and-share view state
  into one call. Pure convenience; no on-chain caller.

### `OracleRelay` UUPS overhead

The relay holds 5 storage fields (feed, staleness, min/max band,
cached feed decimals) and a small read-only consumer surface. The
only mutable state is operator-set config, rotated via existing
`RELAY_FEED_MANAGER` / `RELAY_CONFIG_MANAGER` setters — not via a
logic upgrade. Operator-side kill switch lives on the consumer
(`setOracleRelay(address(0))` on `LitePSM` and `RedemptionQueue`),
so even bricking the relay implementation is recoverable without a
UUPS upgrade.

**Recommendation (follow-up cycle):** drop the UUPS scaffolding
(`UUPSUpgradeable` import, `_authorizeUpgrade`, `RELAY_UPGRADER`
role, `__disableInitializers` constructor pattern) and ship
`OracleRelay` as a plain stateful contract that operators redeploy
on rotation. Saves audit surface area and matches the SVM mirror,
which embeds the peg-check directly inside `lite-psm` with no
upgradeability of its own.

### `RedemptionQueue.QueueEntry` storage packing

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 okuMAmount` (~7.9e28 max — large
enough for any realistic OkuM amount given `MAX_MULTIPLIER` and
`maxSupply`) + `uint48 timestamp` would pack into two slots.

**Caution:** storage-layout change on a UUPS proxy. Only do this
in a v2 upgrade with a careful migration. Defer to v2.

### `cargo fmt --check` / `cargo deny check` style CI for EVM-side TS

Both exist for SVM; EVM-side TypeScript linting is currently
ESLint-only. Worth aligning so `npm run lint` covers both.

---

## Pointers

- [`README.md`](README.md) — EVM-specific docs (contracts, deployment, runbook, dependencies, coverage notes)
- [`audit/README.md`](audit/README.md) — accepted risks + slither triage + tool snapshots
- [`../README.md`](../README.md) — workspace overview + orchestrator runbook
- [`../../audit/README.md`](../../audit/README.md) — cross-chain parity matrix + cycle headline
- [`../SVM/TRACKER.md`](../SVM/TRACKER.md) — SVM-side tracker
