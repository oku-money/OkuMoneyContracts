/**
 * The chain's own clock, which is what a program anchors at.
 *
 * `yield_ops::set_okum_yield_rate` re-anchors the schedule at `Clock::unix_timestamp`, the
 * stake-weighted validator time, which can lag wall clock by tens of seconds. A script that
 * sizes a window from `Date.now()` therefore hands the program a LONGER window than the rate
 * was derived for whenever that lag exceeds the landing delay, and a catch-up lands ABOVE its
 * target for good, since the multiplier never decreases (Cyfrin audit #19).
 *
 * Read the same clock the program reads: the Clock sysvar. No wall-clock fallback: a
 * silent fallback is exactly the failure this exists to prevent.
 */

import { Connection, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';

/** Clock sysvar layout: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp. */
const CLOCK_LEN = 40;
const UNIX_TIMESTAMP_OFFSET = 32;

/** `unix_timestamp` out of raw Clock sysvar account data. */
export function parseClockUnixTimestamp(data: Buffer | Uint8Array): number {
  if (data.length < CLOCK_LEN) {
    throw new Error(`Clock sysvar data is ${data.length} bytes, expected ${CLOCK_LEN}.`);
  }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Number(buf.readBigInt64LE(UNIX_TIMESTAMP_OFFSET));
}

/**
 * Current chain time in unix seconds, as `Clock::unix_timestamp` reports it to a program.
 * Throws if the clock cannot be read; retry instead of falling back to wall clock.
 */
export async function chainNowSec(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info) {
    throw new Error('Clock sysvar not found; retry instead of using wall clock.');
  }
  const t = parseClockUnixTimestamp(info.data);
  if (t <= 0) {
    throw new Error(`Clock sysvar reports unix_timestamp ${t}; retry instead of using wall clock.`);
  }
  return t;
}
