/**
 * Shared plumbing for operator CLIs.
 *
 * Every script that touches a rate goes through here so the safety checks cannot
 * drift apart between them.
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";

export const PRECISION = 10n ** 18n;
export const BASIS_POINTS = 10_000n;
export const SECONDS_PER_YEAR = 31_536_000n;

/** Mirrors Constants.MAX_RATE_PER_SECOND. */
export const MAX_RATE_PER_SECOND = PRECISION + 3_170_979_198n;
/** Mirrors Constants.MAX_RATE_DURATION. */
export const MAX_RATE_DURATION = 30n * 86_400n;

export function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

/** Per-second compounding rate delivering a given nominal (simple) APR in bps. */
export function ratePerSecondForAprBps(aprBps: bigint): bigint {
  return PRECISION + (PRECISION * aprBps) / BASIS_POINTS / SECONDS_PER_YEAR;
}

/** Nominal APR in bps implied by a per-second rate. Inverse of the above. */
export function aprBpsForRatePerSecond(rate: bigint): bigint {
  if (rate <= PRECISION) return 0n;
  return ((rate - PRECISION) * SECONDS_PER_YEAR * BASIS_POINTS) / PRECISION;
}

/**
 * Compounded value of `base` after `elapsed` seconds. Float-based and for DISPLAY
 * ONLY — never use this to derive a value that gets submitted on-chain. The
 * contract's integer `rpow` is authoritative, and cross-chain determinism depends
 * on every chain using it rather than a float approximation.
 */
export function projectDisplay(base: bigint, rate: bigint, elapsed: bigint): number {
  const r = Number(rate) / 1e18;
  return (Number(base) / 1e18) * Math.pow(r, Number(elapsed));
}

export interface OperatorCtx {
  networkName: string;
  bookKey: string;
  okuM: any;
  usdOku: any;
  litePSM: any;
  signer: any;
  signerAddr: string;
}

export async function operatorCtx(label: string): Promise<OperatorCtx> {
  const ctx = await resolveNetworkContext();
  logger.header(`${label} (${ctx.networkName})`);

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  const usdOkuAddr = loadAddress(ctx.bookKey, "USDOku");
  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  if (!okuMAddr || !psmAddr) {
    throw new Error(`Missing OkuM or LitePSM in the address book for ${ctx.bookKey}`);
  }

  const [signer] = await ethers.getSigners();
  return {
    networkName: ctx.networkName,
    bookKey: ctx.bookKey,
    okuM: await getDeployedContract("OkuM", okuMAddr),
    usdOku: usdOkuAddr ? await getDeployedContract("USDOku", usdOkuAddr) : null,
    litePSM: await getDeployedContract("LitePSM", psmAddr),
    signer,
    signerAddr: await signer.getAddress(),
  };
}
