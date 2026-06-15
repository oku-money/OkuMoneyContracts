/**
 * Pyth V2 `SolanaPriceAccount` test fixture builder.
 *
 * Shared between `tests/bankrun/oracle-relay.ts` (which exercises every
 * gated path) and `tests/bankrun/lite-psm.ts` (which uses it to wire a
 * valid feed for the role-gating / missing-account-at-mint tests that
 * used to rely on the now-removed `oracleAccount: null` bypass on
 * `set_oracle_relay_feed`).
 *
 * Byte offsets are annotated in
 * `programs/lite-psm/src/helpers/oracle_relay.rs`.
 */

const PYTH_PRICE_ACCOUNT_LEN = 3312;
const PYTH_MAGIC = 0xa1b2c3d4;

export const enum PythStatus {
  Unknown = 0,
  Trading = 1,
  Halted = 2,
  Auction = 3,
}

/** Encode $1.00 at expo=-8 as the raw Pyth price field (1e8). */
export const ONE_DOLLAR_AT_EXPO_M8 = 100_000_000n;

export interface PythFixtureOpts {
  unixTimestamp: bigint;
  /** Pyth aggregate `price` field (i64). Real value = price × 10^expo. */
  priceRaw: bigint;
  /** Pyth `expo` field (i32). USDC/USD uses -8. */
  expo?: number;
  status?: PythStatus;
}

export function buildPythFixture(opts: PythFixtureOpts): Uint8Array {
  const buf = Buffer.alloc(PYTH_PRICE_ACCOUNT_LEN);
  buf.writeUInt32LE(PYTH_MAGIC, 0);
  buf.writeUInt32LE(2, 4); // ver = 2
  buf.writeUInt32LE(3, 8); // atype = Price
  buf.writeUInt32LE(PYTH_PRICE_ACCOUNT_LEN, 12);
  buf.writeInt32LE(opts.expo ?? -8, 20);
  buf.writeBigInt64LE(opts.unixTimestamp, 96);
  buf.writeBigInt64LE(opts.priceRaw, 208);
  buf.writeBigUInt64LE(0n, 216);
  buf.writeUInt8(opts.status ?? PythStatus.Trading, 224);
  buf.writeUInt8(0, 225);
  buf.writeBigUInt64LE(1n, 232);
  return new Uint8Array(buf);
}
