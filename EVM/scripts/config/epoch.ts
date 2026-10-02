/**
 * The epoch grid — the protocol's yield calendar.
 *
 * Deliberately off-chain: nothing on-chain knows epochs exist; contracts see
 * only `(rate, rateEnd)` absolute timestamps. So
 * changing these values is cheap — they are a backend constant no contract or
 * program reads. The trade is that a fat-fingered `endTimestamp` on one chain
 * cannot be rejected on-chain; it is caught by `checkMultiplierDrift.ts`'s
 * grid-alignment check instead, so keep that check enabled in the runbook.
 */

/**
 * Epoch length, in seconds. **24 hours.** Shorter epochs bound the early-shock
 * overshoot (`TRACKER.md` § Early-shock detection); every epoch boundary is
 * UTC midnight (see `EPOCH_ANCHOR_UNIX` below).
 *
 * Cost: the settlement-staging window scales with the epoch. At
 * `DEFAULT_SETTLEMENT_FRACTION = 1/15`, 24h yields a **1.6-hour** window
 * (base window 22.4h) in which the settlement transaction must land on every
 * chain. Ample for an automated broadcast, but NOT a window a human can be
 * relied on to notice and act inside — the daily cadence is expected to be
 * driven by an external scheduler, which is why these scripts stay
 * non-interactive and exit-code-clean.
 *
 * Headroom: `MAX_RATE` (`src/lib/Constants.sol:45`) caps growth at ~0.8677%
 * per 24h; a 5% APY target needs 5%/365 ≈ 0.0137% per day — roughly **63x
 * headroom**. The per-second rate is essentially epoch-length-invariant for a
 * fixed APY. The failure mode to watch is a *monthly-sized dollar target*
 * streamed over an 86400s window (e.g. a stale `REALISED_YIELD_USD`), which
 * lands at only ~2.1x headroom. Every rate-producing path clamps to `MAX_RATE`
 * and carries the shortfall forward rather than reverting.
 */
export const EPOCH_LENGTH_SECONDS = 24 * 60 * 60; // 86_400

/**
 * Unix timestamp of epoch 0's start: **2026-01-01T00:00:00Z**.
 *
 * A round UTC instant so grid arithmetic is checkable by hand — given any
 * `rateEnd`, `(rateEnd - EPOCH_ANCHOR_UNIX) % EPOCH_LENGTH_SECONDS` should be
 * 0 (or within the settlement tolerance below). This value is `20454 * 86400`
 * exactly, so under the 24h grid every epoch boundary falls on UTC midnight.
 */
export const EPOCH_ANCHOR_UNIX = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000; // 1_767_225_600

/**
 * Slack permitted off the exact grid when checking alignment.
 *
 * Non-zero because the base+settlement split means a rate window legitimately
 * ends at the *base* boundary (`1 - settlementFraction` through the epoch)
 * rather than the epoch boundary. Both positions must pass.
 *
 * Must NOT be `EPOCH_LENGTH_SECONDS / 15`: that makes the tolerance exactly
 * equal to the legitimate `baseEnd` offset, leaving zero slack under
 * `checkMultiplierDrift.ts`'s strict `distanceToGrid > tolerance` compare, so
 * any one-second rounding flips a healthy fleet to `EPOCH-GRID MISALIGNMENT`
 * and exit 1. `/10` accepts the epoch boundary (0s off-grid) and the base
 * boundary (5760s off-grid at 24h) with ~48 minutes to spare, while still
 * catching a chain that has genuinely drifted.
 */
export const EPOCH_GRID_TOLERANCE_SECONDS = Math.round(EPOCH_LENGTH_SECONDS / 10);

/** Env-var form, for scripts that read the grid from the environment. */
export const EPOCH_ENV = {
  EPOCH_LENGTH_SECONDS: String(EPOCH_LENGTH_SECONDS),
  EPOCH_ANCHOR_UNIX: String(EPOCH_ANCHOR_UNIX),
  EPOCH_GRID_TOLERANCE_SECONDS: String(EPOCH_GRID_TOLERANCE_SECONDS),
} as const;
