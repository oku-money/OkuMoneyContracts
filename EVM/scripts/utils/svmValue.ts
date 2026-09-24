/**
 * SVM's contribution to the global value V(t).
 *
 * `globalValue.ts` sums `totalSupply x multiplier` across every chain, and that
 * sum is the DENOMINATOR of every derived yield rate:
 *
 *     rate = (1 + realisedYield / V̄) ^ (1 / windowSeconds)
 *
 * Omitting a chain from V does not merely make the number incomplete — it
 * makes the derived rate too HIGH, so the protocol systematically over-pays
 * yield across every chain including the ones that were counted. SVM must
 * be included.
 *
 * SVM needs its own reader because Solana has no view functions: the canonical
 * multiplier is recomputed off-chain from `PsmConfig` using the shared mirror
 * of the on-chain math (`@okumoney/yield-tooling`, held bit-identical to the
 * Solidity by the differential corpus in `EVM/test/differential`).
 *
 * Deliberately NOT read from the mint's `ScaledUiAmountConfig`: that extension
 * is a lagging display mirror, so pricing V off it would under-count AUM by up
 * to one sync interval and — because V is a denominator — over-pay yield.
 *
 * Decimal asymmetry: OkuM is 18 decimals on EVM and 6 on SVM. Both sides
 * normalise to plain USD `number`s before summing, so the asymmetry is handled
 * at the boundary rather than leaking into the aggregate.
 */

import { computeMultiplier, scheduleFromConfig, PRECISION } from "@okumoney/yield-tooling";
import { logger } from "./logger";

/** SVM token decimals. USDC-matching, unrelated to the 1e18 multiplier scale. */
const SVM_TOKEN_DECIMALS = 6;

/** Seed of the singleton `PsmConfig` PDA. Mirrors `PsmConfig::SEED`. */
const PSM_CONFIG_SEED = "psm_config";

/** Byte offsets of the accrual fields inside the `PsmConfig` account.
 *
 *  Decoded by hand rather than via Anchor so this module does not drag the
 *  entire Anchor/Solana client stack into the EVM package for one read.
 *
 *  Only the accrual block matters here, and it sits at a fixed offset near the
 *  start. `PsmConfig` carries tail padding so future fields can be appended
 *  without moving it, so this checks a MINIMUM length rather than equality —
 *  an equality check would make every tail append a breaking change for this
 *  reader, which is the opposite of what the padding is for. A SHORTER account
 *  than the accrual block requires is a real layout change and still fails. */
const SVM_CONFIG_MIN_LEN = 626;

export interface SvmValueReading {
  /** Dollar value of all OkuM on SVM at this instant. */
  valueUsd: number;
  /** Raw mint supply, 6 decimals. */
  rawSupply: bigint;
  /** Canonical multiplier, WAD-scaled. */
  multiplier: bigint;
}

/**
 * Compute `totalSupply x multiplier` for the SVM deployment.
 *
 * Returns `null` on any read failure. Callers MUST treat that as "omit this
 * chain", never as zero — a transient RPC failure that silently zeroed SVM's
 * contribution would shrink V and over-pay yield, which is the exact failure
 * this module exists to prevent. `globalValue.ts` already follows that
 * convention for EVM chains.
 *
 * @param rpcUrl   Solana RPC endpoint.
 * @param programId  `lite_psm` program ID (for the config PDA derivation).
 * @param okuMMint   OkuM Token-2022 mint address.
 */
export async function readSvmValueUsd(
  rpcUrl: string,
  programId: string,
  okuMMint: string,
): Promise<SvmValueReading | null> {
  try {
    // Imported lazily so the EVM tooling does not pay for the Solana client
    // stack on every invocation that does not touch SVM.
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const { getMint, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");

    const connection = new Connection(rpcUrl, "confirmed");

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PSM_CONFIG_SEED)],
      new PublicKey(programId),
    );

    const [configInfo, mintInfo] = await Promise.all([
      connection.getAccountInfo(configPda),
      getMint(connection, new PublicKey(okuMMint), "confirmed", TOKEN_2022_PROGRAM_ID),
    ]);

    if (!configInfo) {
      logger.warning("svm: PsmConfig account not found");
      return null;
    }
    if (configInfo.data.length < SVM_CONFIG_MIN_LEN) {
      logger.warning(
        `svm: PsmConfig is ${configInfo.data.length} bytes, below the ${SVM_CONFIG_MIN_LEN} ` +
          "this decoder requires. The account layout changed — update svmValue.ts " +
          "before trusting this reading.",
      );
      return null;
    }

    const schedule = scheduleFromConfig(decodePsmConfigSchedule(configInfo.data));
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const multiplier = computeMultiplier(schedule, nowSec);

    const rawSupply = mintInfo.supply;
    // dollars (6dp) = raw (6dp) * multiplier / PRECISION
    const valueRaw = (rawSupply * multiplier) / PRECISION;
    const valueUsd = Number(valueRaw) / 10 ** SVM_TOKEN_DECIMALS;

    return { valueUsd, rawSupply, multiplier };
  } catch (e: any) {
    logger.warning(`svm: value read failed — ${e.message ?? e}`);
    return null;
  }
}

/**
 * Pull the six accrual fields out of a raw `PsmConfig` account.
 *
 * Layout (from `programs/lite-psm/src/state.rs`, pinned by a compile-time
 * assertion there):
 *
 * ```text
 *   0    8   discriminator
 *   8    1   bump
 *   9  416   13 pubkeys (10 authorities + usdc_mint, oku_m_mint, vault_usdc)
 * 425    8   max_supply
 * 433    8   minter_allowance
 * 441    1   is_paused
 * 442    8   last_yield_distribution_slot
 * 450   16   okum_base_multiplier         (u128 LE)
 * 466    8   okum_rate_per_second         (u64  LE)
 * 474    8   okum_last_accrual_time       (i64  LE)
 * 482    8   okum_rate_end                (i64  LE)
 * 490    8   okum_pending_rate_per_second (u64  LE)
 * 498    8   okum_pending_rate_end        (i64  LE)
 * 506    8   last_display_sync_ts         (i64  LE)
 * 514  ...   pending_role_admin, direct_* ...
 * ```
 *
 * Anchor orders account fields exactly as declared, so these offsets follow the
 * struct definition. Note the pubkey count is 13, not 16:
 * `pending_role_admin` and the two `direct_*` keys come AFTER the accrual block.
 *
 * Two guards against drift: the length check in {@link readSvmValueUsd}, and
 * `tests/bankrun/config-layout.ts` on the SVM side, which decodes a real
 * account with these exact offsets and compares against Anchor's own decoding.
 */
function decodePsmConfigSchedule(data: Buffer) {
  const u128 = (off: number): bigint => {
    let v = 0n;
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
    return v;
  };
  const u64 = (off: number): bigint => data.readBigUInt64LE(off);
  const i64 = (off: number): bigint => data.readBigInt64LE(off);

  const ACCRUAL_BASE = 450;
  return {
    okumBaseMultiplier: u128(ACCRUAL_BASE),
    okumRatePerSecond: u64(ACCRUAL_BASE + 16),
    okumLastAccrualTime: i64(ACCRUAL_BASE + 24),
    okumRateEnd: i64(ACCRUAL_BASE + 32),
    okumPendingRatePerSecond: u64(ACCRUAL_BASE + 40),
    okumPendingRateEnd: i64(ACCRUAL_BASE + 48),
  };
}

/** Everything the drift monitor needs from the SVM deployment. */
export interface SvmScheduleReading {
  /** The six accrual fields, as stored on `PsmConfig`. */
  schedule: ReturnType<typeof scheduleFromConfig>;
  /** Canonical multiplier evaluated at {@link chainTimeSec}. */
  multiplier: bigint;
  /** SVM's OWN clock, not wall clock. See below. */
  chainTimeSec: number;
  /** Raw mint supply, 6 decimals. */
  rawSupply: bigint;
}

/**
 * Read SVM's rate schedule and evaluate its multiplier at SVM's OWN clock.
 *
 * The chain's clock, not wall clock: `Clock::unix_timestamp` on Solana is
 * derived from validator vote timestamps and can trail real time. The
 * multiplier is a pure function of it, so a lagging clock yields a lagging
 * multiplier — a **self-correcting lag, not a drift**. Comparing SVM's
 * multiplier against EVM's at the same WALL-clock instant would report
 * divergence that does not exist; the evaluation timestamp is returned
 * alongside the value so callers can evaluate every chain at one common `T`.
 */
export async function readSvmSchedule(
  rpcUrl: string,
  programId: string,
  okuMMint: string,
): Promise<SvmScheduleReading | null> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { getMint, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");

  const connection = new Connection(rpcUrl, "confirmed");
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PSM_CONFIG_SEED)],
    new PublicKey(programId),
  );

  const [configInfo, mintInfo, slot] = await Promise.all([
    connection.getAccountInfo(configPda),
    getMint(connection, new PublicKey(okuMMint), "confirmed", TOKEN_2022_PROGRAM_ID),
    connection.getSlot(),
  ]);

  if (!configInfo) {
    logger.warning("svm: PsmConfig account not found");
    return null;
  }
  if (configInfo.data.length < SVM_CONFIG_MIN_LEN) {
    logger.warning(
      `svm: PsmConfig is ${configInfo.data.length} bytes, below the ${SVM_CONFIG_MIN_LEN} ` +
        "this decoder requires. Layout changed — update svmValue.ts " +
        "(and tests/bankrun/config-layout.ts).",
    );
    return null;
  }

  // Cluster time, falling back to wall clock if the RPC cannot supply it.
  // The fallback is noted rather than silent: it reintroduces exactly the
  // lag-vs-drift confusion this function exists to avoid.
  let chainTimeSec = await connection.getBlockTime(slot).catch(() => null);
  if (chainTimeSec === null) {
    logger.warning("svm: getBlockTime unavailable — falling back to wall clock");
    chainTimeSec = Math.floor(Date.now() / 1000);
  }

  const schedule = scheduleFromConfig(decodePsmConfigSchedule(configInfo.data));
  return {
    schedule,
    multiplier: computeMultiplier(schedule, BigInt(chainTimeSec)),
    chainTimeSec,
    rawSupply: mintInfo.supply,
  };
}
