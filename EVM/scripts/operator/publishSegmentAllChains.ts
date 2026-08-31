/**
 * Multichain segment fan-out + verified sync post-condition.
 *
 * `setOkuMRate.ts` derives a segment's parameters and prints them for the
 * operator to paste into one invocation per chain. That is correct but
 * unverified: nothing confirms the four chains actually ended up agreeing
 * after every publication landed. This script closes that gap:
 *
 *   1. Derive ONE set of segment parameters (or accept them explicitly).
 *   2. Submit the identical `setOkuMRate` call to every chain that has OkuM
 *      deployed, via a raw JSON-RPC provider per chain (bypassing Hardhat's
 *      one-network-per-invocation limitation - no hardhat network switching).
 *   3. After every chain has confirmed, sample `indexAt(t)` on ALL of them at
 *      several future timestamps and assert they agree.
 *
 * This turns "the contracts make cross-chain sync possible" into "sync was
 * checked after this specific publication" - a verified post-condition
 * instead of an operator following a procedure correctly by hand.
 *
 * Deliberately simple: sequential per-chain submission (not parallel), plain
 * ethers.JsonRpcProvider + a Wallet from PRIVATE_KEY (no Hardhat runtime
 * network needed since every chain is addressed directly). No retry/backoff
 * beyond what ethers does natively - if a chain's tx fails, the script stops
 * and reports which chains already got the segment so the operator can
 * finish the rest by hand with `setOkuMRate.ts` before re-running the verify
 * step alone via `--verify-only`.
 *
 * Usage: same `--flag=value` / `FLAG_NAME=value` dual convention as every
 * other operator script (see `_shared.ts:parseArg`). Under `hardhat run`,
 * Hardhat v2 rejects unrecognized CLI flags before the script sees them, so
 * the ENV VAR form is what actually works there; the `--flag` form works only
 * when invoking the compiled script directly (e.g. via `ts-node`).
 *
 *   # Derive parameters and preview without submitting anywhere:
 *   DRY_RUN=true APR_BPS=500 DURATION=2592000 START=1735000000 \
 *     npx hardhat run scripts/operator/publishSegmentAllChains.ts --network localhost
 *
 *   # Submit to every chain with an OkuM address in the book, then verify:
 *   APR_BPS=500 DURATION=2592000 START=1735000000 REALIZED=412000 YES_MAINNET=true \
 *     PRIVATE_KEY=0x... \
 *     npx hardhat run scripts/operator/publishSegmentAllChains.ts --network localhost
 *
 *   # Only verify agreement across chains already published (no submission):
 *   VERIFY_ONLY=true \
 *     npx hardhat run scripts/operator/publishSegmentAllChains.ts --network localhost
 *
 *   # Restrict to a subset (e.g. testnets only):
 *   CHAINS=sepolia,baseSepolia APR_BPS=500 DURATION=2592000 START=1735000000 \
 *     npx hardhat run scripts/operator/publishSegmentAllChains.ts --network localhost
 *
 * `START` MUST be explicit and in the future here - this script is for the
 * ROUTINE multichain path only. It refuses to default to "now", since a
 * per-chain-local "now" would defeat the entire point of fanning out one
 * absolute anchor. Use `setOkuMRate.ts` directly, once, for a single-chain
 * catch-up re-anchor (which DOES accept the `start=0` "now" sentinel).
 *
 * Environment:
 *   DRY_RUN=true       Derive and print, submit nothing.
 *   VERIFY_ONLY=true   Skip submission; only sample and diff indexAt() across
 *                      chains already published.
 *   YES_MAINNET=true   Required to submit when any target chain is mainnet.
 *   CHAINS=a,b,c       Restrict the target set (default: every chain with an
 *                      OkuM address in the book).
 *   PRIVATE_KEY        Signer for every chain (same key must hold
 *                      OKUM_RATE_SETTER on all of them).
 */

import { ethers as hardhatEthers } from "hardhat";
import { ethers } from "ethers";
import { logger } from "../utils/logger";
import { loadNetworkAddresses } from "../utils/addressBook";
import { CHAIN_METADATA } from "../config/chains";
import {
  parseArg,
  ratePerSecondForAprBps,
  aprBpsForRatePerSecond,
  PRECISION,
  MAX_RATE_PER_SECOND,
  MAX_RATE_DURATION,
} from "./_shared";

// Minimal ABI - just what this script calls. Keeps it independent of a
// Hardhat artifact/network binding per target chain.
const OKUM_ABI = [
  "function indexAt(uint256 t) view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
  "function setOkuMRate(uint256 baseIndex, uint256 ratePerSecond, uint64 startTime, uint64 endTime, uint256 realizedYieldBacking) external",
];

const DRY_RUN = process.env.DRY_RUN === "true";
// CLI flags only work when this script is run directly via `ts-node`; Hardhat
// v2's `hardhat run` rejects unrecognized flags before the script sees them
// (same limitation documented in grantRolesMainnet.ts). The env var fallback
// is the one that actually works under `hardhat run`.
const VERIFY_ONLY = process.argv.includes("--verify-only") || process.env.VERIFY_ONLY === "true";
const YES_MAINNET =
  process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";

// Every chain with a live OkuM deployment is a fan-out target by default.
// Testnets deliberately included - the fan-out logic is identical, and this
// is also how you'd rehearse the sync check before a mainnet publication.
const DEFAULT_CHAINS = [
  "sepolia",
  "baseSepolia",
  "arbSepolia",
  "bscTestnet",
  "base",
  "bsc",
];

const MAINNET_CHAINS = new Set(["base", "bsc", "mainnet", "optimism", "arbitrum"]);

interface ChainTarget {
  name: string;
  rpcUrl: string;
  okuM: string;
}

function resolveChains(): ChainTarget[] {
  const requested = parseArg("chains")?.split(",").map((s) => s.trim()) ?? DEFAULT_CHAINS;
  const targets: ChainTarget[] = [];
  for (const name of requested) {
    const meta = CHAIN_METADATA[name];
    if (!meta) {
      logger.warning(`  Skipping "${name}" - not in CHAIN_METADATA.`);
      continue;
    }
    const addrs = loadNetworkAddresses(name);
    if (!addrs.OkuM) {
      logger.warning(`  Skipping "${name}" - no OkuM address in the book.`);
      continue;
    }
    targets.push({ name, rpcUrl: meta.rpcUrl, okuM: addrs.OkuM });
  }
  return targets;
}

async function main() {
  const targets = resolveChains();
  if (targets.length < 2) {
    throw new Error(
      `Need at least 2 chains with a deployed OkuM to check cross-chain sync; ` +
        `found ${targets.length}. Check the address book and --chains filter.`
    );
  }

  logger.header(`Multichain segment fan-out (${targets.length} chains)`);
  for (const t of targets) logger.info(`  ${t.name.padEnd(14)} OkuM=${t.okuM}`);

  if (!VERIFY_ONLY) {
    if (targets.some((t) => MAINNET_CHAINS.has(t.name)) && !YES_MAINNET && !DRY_RUN) {
      throw new Error(
        "Mainnet chain(s) in the target set. Re-run with --yes-mainnet to confirm, " +
          "or --chains=<testnets only> to rehearse first."
      );
    }

    const startArg = parseArg("start");
    if (!startArg) {
      throw new Error(
        "This script requires an EXPLICIT future --start. It fans out one absolute " +
          "anchor to every chain; a per-chain-local \"now\" sentinel would defeat " +
          "that. For a single-chain catch-up re-anchor, use setOkuMRate.ts directly."
      );
    }
    const start = BigInt(startArg);
    const durationArg = parseArg("duration");
    const end = parseArg("end")
      ? BigInt(parseArg("end")!)
      : start + (durationArg ? BigInt(durationArg) : MAX_RATE_DURATION);
    const rate = parseArg("rate")
      ? BigInt(parseArg("rate")!)
      : ratePerSecondForAprBps(BigInt(parseArg("apr-bps") ?? "0"));
    const realized = parseArg("realized") ? ethers.parseUnits(parseArg("realized")!, 18) : 0n;

    if (rate < PRECISION || rate > MAX_RATE_PER_SECOND) {
      throw new Error(
        `rate ${rate} outside [${PRECISION}, ${MAX_RATE_PER_SECOND}] ` +
          `(implied APR ${aprBpsForRatePerSecond(rate)} bps exceeds the cap)`
      );
    }
    if (end < start) throw new Error("end is before start");
    if (end - start > MAX_RATE_DURATION) {
      throw new Error(`window ${end - start}s exceeds MAX_RATE_DURATION ${MAX_RATE_DURATION}s`);
    }

    // `base` is derived ONCE against the first chain's live curve and reused
    // VERBATIM everywhere - re-deriving per chain is exactly the mistake that
    // breaks agreement (see setOkuMRate.ts).
    const firstProvider = new ethers.JsonRpcProvider(targets[0].rpcUrl);
    const firstOkuM = new ethers.Contract(targets[0].okuM, OKUM_ABI, firstProvider);
    const base = parseArg("base")
      ? BigInt(parseArg("base")!)
      : BigInt(await firstOkuM.indexAt(start));

    logger.info("");
    logger.info("  Segment (identical on every chain)");
    logger.info(`    base           ${base}`);
    logger.info(`    ratePerSecond  ${rate}`);
    logger.info(`    start          ${start}  (${new Date(Number(start) * 1000).toISOString()})`);
    logger.info(`    end            ${end}  (${new Date(Number(end) * 1000).toISOString()})`);
    logger.info(`    realized       ${ethers.formatUnits(realized, 18)}`);

    if (DRY_RUN) {
      logger.warning("");
      logger.warning("DRY_RUN - not submitting to any chain.");
      return;
    }

    if (!process.env.PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY env var required to submit (unset for --verify-only).");
    }

    logger.info("");
    logger.section("Submitting");
    const submitted: string[] = [];
    for (const t of targets) {
      const provider = new ethers.JsonRpcProvider(t.rpcUrl);
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
      const okuM = new ethers.Contract(t.okuM, OKUM_ABI, wallet);
      try {
        const tx = await okuM.setOkuMRate(base, rate, start, end, realized);
        const receipt = await tx.wait();
        logger.success(`  ${t.name}: ${receipt.hash}`);
        submitted.push(t.name);
      } catch (e: any) {
        logger.error(`  ${t.name}: FAILED - ${e.message ?? e}`);
        logger.error(
          `  Already published to: ${submitted.join(", ") || "none"}. Finish the ` +
            `remaining chains by hand with setOkuMRate.ts using the EXACT parameters ` +
            `above, then re-run this script with --verify-only.`
        );
        throw e;
      }
    }
  }

  // ---- Verified post-condition: sample indexAt(t) on every chain and diff ----
  logger.info("");
  logger.section("Verifying cross-chain agreement");

  const now = Math.floor(Date.now() / 1000);
  const sampleOffsets = [0, 60, 3600, 86400, 7 * 86400, Number(MAX_RATE_DURATION)];
  const samples = sampleOffsets.map((offset) => BigInt(now + offset));

  const readings: Record<string, bigint[]> = {};
  for (const t of targets) {
    const provider = new ethers.JsonRpcProvider(t.rpcUrl);
    const okuM = new ethers.Contract(t.okuM, OKUM_ABI, provider);
    readings[t.name] = await Promise.all(samples.map((t2) => okuM.indexAt(t2)));
  }

  let allAgree = true;
  for (let i = 0; i < samples.length; i++) {
    const values = targets.map((t) => readings[t.name][i]);
    const reference = values[0];
    const agree = values.every((v) => v === reference);
    const tOffset = sampleOffsets[i];
    logger.info(
      `  t+${String(tOffset).padStart(7)}s   ${agree ? "✓ agree" : "✗ DIVERGE"}   ${reference}`
    );
    if (!agree) {
      allAgree = false;
      for (const t of targets) {
        logger.error(`      ${t.name.padEnd(14)} ${readings[t.name][i]}`);
      }
    }
  }

  if (!allAgree) {
    throw new Error(
      "Chains DO NOT agree on indexAt() at one or more sampled timestamps. " +
        "Do not treat this publication as complete - investigate before opening " +
        "the conversion window on any affected chain."
    );
  }
  logger.success(`All ${targets.length} chains agree at every sampled timestamp.`);
}

main().catch((e) => {
  logger.error(e.message ?? String(e));
  process.exit(1);
});

// Referenced only to keep hardhat's provider wiring from tree-shaking the
// import when this file is invoked via `hardhat run` (required for --network
// resolution even though this script talks to chains directly).
void hardhatEthers;
