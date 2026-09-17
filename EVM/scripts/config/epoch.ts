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
 * are a backend constant. If 30 days proves wrong, it is an edit here and a
 * redeploy of nothing.
 *
 * The trade is that a fat-fingered `endTimestamp` on one chain cannot be
 * rejected on-chain — it is caught by `checkMultiplierDrift.ts`'s grid-alignment
 * check instead, which is why that check should be enabled in the runbook
 * rather than left optional.
 */

/**
 * Epoch length, in seconds. **30 days.**
 *
 * Chosen on operational grounds, not measured accuracy. The simulation's
 * epoch-length axis showed flat error (2.27–2.29%) from 1 hour to 90 days, but
 * that is a mechanism smoke test rather than an accuracy comparison — the
 * shock's position is specified as a fraction of the epoch, so it scales with
 * the epoch under test. **Do not cite it as evidence either way.**
 *
 * The decisive constraint is the settlement-staging window. At
 * `DEFAULT_SETTLEMENT_FRACTION = 1/15`, 30 days yields a ~2-day window in which
 * to land the settlement transaction on every chain — comfortable. A 1-hour
 * epoch yields 4 minutes, which is not a window, it is a race.
 *
 * The counter-pressure, recorded so the trade is explicit: shorter epochs bound
 * the early-shock overshoot (`TRACKER.md` § Early-shock detection), because a
 * shock has less time to compound before the next re-anchor. 30 days maximises
 * operational comfort and therefore maximises that exposure.
 */
export const EPOCH_LENGTH_SECONDS = 30 * 24 * 60 * 60; // 2_592_000

/**
 * Unix timestamp of epoch 0's start: **2026-01-01T00:00:00Z**.
 *
 * A round UTC instant purely so grid arithmetic is checkable by hand — given
 * any `rateEnd`, `(rateEnd - EPOCH_ANCHOR_UNIX) % EPOCH_LENGTH_SECONDS` should
 * be 0 (or within the settlement tolerance below), and that is something an
 * operator can verify mentally rather than by running a script.
 */
export const EPOCH_ANCHOR_UNIX = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000; // 1_767_225_600

/**
 * Slack permitted off the exact grid when checking alignment.
 *
 * Non-zero because the base+settlement split means a rate window legitimately
 * ends at the *base* boundary (`1 - settlementFraction` through the epoch)
 * rather than the epoch boundary. One settlement window of tolerance accepts
 * both without accepting a genuinely drifted schedule.
 */
export const EPOCH_GRID_TOLERANCE_SECONDS = Math.round(EPOCH_LENGTH_SECONDS / 15);

/** Env-var form, for scripts that read the grid from the environment. */
export const EPOCH_ENV = {
  EPOCH_LENGTH_SECONDS: String(EPOCH_LENGTH_SECONDS),
  EPOCH_ANCHOR_UNIX: String(EPOCH_ANCHOR_UNIX),
  EPOCH_GRID_TOLERANCE_SECONDS: String(EPOCH_GRID_TOLERANCE_SECONDS),
} as const;
