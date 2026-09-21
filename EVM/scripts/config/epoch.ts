/**
 * The epoch grid — the protocol's yield calendar.
 *
 * ## This is deliberately off-chain
 *
 * Nothing on-chain knows epochs exist. The contracts see only
 * `(rate, rateEnd)` — absolute timestamps — and `OkuMoney` has no concept of a
 * grid, a length, or an anchor. Storing `epochLength` / `epochAnchor` on-chain
 * and validating alignment in the setters was considered and declined
 * (`SVM/DECISIONS.md` D-22): it is business policy, not a maths invariant, and
 * it would hard-code a tunable parameter into six live contracts, turning a
 * config edit into an upgrade cycle.
 *
 * The consequence worth understanding: **changing these values is cheap.** They
 * are a backend constant. If the epoch length proves wrong, it is an edit here
 * and a redeploy of nothing. (This has already been exercised once: the grid
 * moved from 30 days to 24 hours with zero contract or program changes.)
 *
 * The trade is that a fat-fingered `endTimestamp` on one chain cannot be
 * rejected on-chain — it is caught by `checkMultiplierDrift.ts`'s grid-alignment
 * check instead, which is why that check should be enabled in the runbook
 * rather than left optional.
 */

/**
 * Epoch length, in seconds. **24 hours.**
 *
 * ## Why 24h
 *
 * Shorter epochs bound the early-shock overshoot (`TRACKER.md` § Early-shock
 * detection): a supply shock has less time to compound before the next
 * re-anchor. A daily grid also makes the yield calendar trivially legible —
 * every epoch boundary is UTC midnight (see `EPOCH_ANCHOR_UNIX` below).
 *
 * ## What this costs, stated explicitly
 *
 * The settlement-staging window scales with the epoch. At
 * `DEFAULT_SETTLEMENT_FRACTION = 1/15`, 24h yields a **1.6-hour** window
 * (base window 22.4h) in which the settlement transaction must land on every
 * chain. That is ample for an automated broadcast — `broadcastSchedule` fans
 * out to 5 chains sequentially in minutes — but it is NOT a window a human
 * can be relied on to notice and act inside. The daily cadence is expected to
 * be driven by an external scheduler; these scripts stay non-interactive and
 * exit-code-clean precisely so that something else can drive them.
 *
 * ## Headroom check (why this is safe)
 *
 * `MAX_RATE` (`src/lib/Constants.sol:45`) caps growth at ~0.8677% per 24h.
 * At a 5% APY target the daily requirement is 5%/365 ≈ 0.0137% — roughly
 * **63x headroom**. The per-second rate is essentially epoch-length-invariant
 * for a fixed APY, so shortening the epoch does not by itself raise the rate.
 * The failure mode to watch is a *monthly-sized dollar target* being streamed
 * over an 86400s window (e.g. a stale `REALISED_YIELD_USD`), which lands at
 * only ~2.1x headroom. Every rate-producing path clamps to `MAX_RATE` and
 * carries the shortfall forward rather than reverting.
 *
 * ## Changing this is cheap
 *
 * Nothing on-chain knows epochs exist (see the module doc above). This is a
 * backend constant; no contract or program reads it.
 */
export const EPOCH_LENGTH_SECONDS = 24 * 60 * 60; // 86_400

/**
 * Unix timestamp of epoch 0's start: **2026-01-01T00:00:00Z**.
 *
 * A round UTC instant purely so grid arithmetic is checkable by hand — given
 * any `rateEnd`, `(rateEnd - EPOCH_ANCHOR_UNIX) % EPOCH_LENGTH_SECONDS` should
 * be 0 (or within the settlement tolerance below), and that is something an
 * operator can verify mentally rather than by running a script.
 *
 * This value is `20454 * 86400` exactly, so under the 24h grid every epoch
 * boundary falls on UTC midnight. It required no change when the epoch moved
 * from 30 days to 24 hours — it was already daily-aligned.
 */
export const EPOCH_ANCHOR_UNIX = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000; // 1_767_225_600

/**
 * Slack permitted off the exact grid when checking alignment.
 *
 * Non-zero because the base+settlement split means a rate window legitimately
 * ends at the *base* boundary (`1 - settlementFraction` through the epoch)
 * rather than the epoch boundary. Both positions must pass.
 *
 * ## Why this is NOT `EPOCH_LENGTH_SECONDS / 15`
 *
 * It used to be, which silently made the tolerance *exactly equal* to the
 * legitimate `baseEnd` offset (both `epochLength / 15`). The alignment check
 * (`checkMultiplierDrift.ts`) compares `distanceToGrid > tolerance`, so a
 * correctly-scheduled `baseEnd` passed only because the comparison is strict —
 * `distanceToGrid == tolerance` exactly, with zero slack. Any one-second
 * rounding anywhere in the derivation flipped a healthy fleet to
 * `EPOCH-GRID MISALIGNMENT` and exit 1.
 *
 * `/10` keeps the two concerns independent: it accepts the epoch boundary (0s
 * off-grid) and the base boundary (5760s off-grid at 24h) with ~48 minutes to
 * spare, while still catching a chain that has genuinely drifted. Since the
 * production path broadcasts one absolute timestamp set to every chain, real
 * drift is large — a tolerance this tight is only ever tripped by a real fault.
 */
export const EPOCH_GRID_TOLERANCE_SECONDS = Math.round(EPOCH_LENGTH_SECONDS / 10);

/** Env-var form, for scripts that read the grid from the environment. */
export const EPOCH_ENV = {
  EPOCH_LENGTH_SECONDS: String(EPOCH_LENGTH_SECONDS),
  EPOCH_ANCHOR_UNIX: String(EPOCH_ANCHOR_UNIX),
  EPOCH_GRID_TOLERANCE_SECONDS: String(EPOCH_GRID_TOLERANCE_SECONDS),
} as const;
