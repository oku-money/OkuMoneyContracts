/**
 * Refuse an active-rate write that repeats a stored segment this chain's own Clock has not
 * reached, or has already left (Cyfrin audit #13 follow-up). In its own module so a test can
 * import it without running the script.
 *
 * `rearm_anchor` keeps every chain's stored schedule identical only when each chain processes
 * the broadcast inside the segment it re-arms. Solana's Clock trails wall clock, so a write
 * repeating the armed SUCCESSOR can arrive while the Clock is still inside the active window:
 * the program takes it as a plain rate change, re-anchors at the lagging time and replaces the
 * rest of the active window with the successor's rate. This chain then diverges from the
 * others and nothing on-chain says so. `rearmWindowProblem` (yield-tooling) names the case.
 */

import { rearmWindowProblem, type Schedule } from '@okumoney/yield-tooling';

export function assertRearmWindow(
  schedule: Schedule,
  chainNowSec: number,
  rate: bigint,
  endSec: number,
): void {
  const problem = rearmWindowProblem(schedule, BigInt(chainNowSec), rate, BigInt(endSec));
  if (problem === 'segment-not-started') {
    throw new Error(
      `This chain's Clock (${chainNowSec}) has not reached the segment this write re-arms: it ` +
        `repeats the armed successor, but the active window runs until ${schedule.rateEnd}. ` +
        `Sending it now would replace the rest of the active window with the successor's rate ` +
        `and leave this chain diverged from the others. Wait until the Clock passes ` +
        `${schedule.rateEnd}, then retry.`,
    );
  }
  if (problem === 'segment-ended') {
    throw new Error(
      `The segment this write re-arms (ending ${endSec}) has already ended on this chain ` +
        `(Clock ${chainNowSec}). Re-derive the schedule; the program would reject it ` +
        `(EndTimestampInPast).`,
    );
  }
}
