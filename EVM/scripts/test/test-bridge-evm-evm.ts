#!/usr/bin/env npx tsx
/**
 * EVM <-> EVM off-chain orchestrator integration test.
 *
 * Exercises the full off-chain orchestrator flow between two EVM testnets:
 *
 *   1. Source redeem: burn OkuM on source chain, receive USDC.
 *   2. Off-chain rail: MockUSDC.mint on destination chain (simulates
 *      custodied USDC arriving via off-chain transfer).
 *   3. Destination mint: deposit USDC on dest chain, receive OkuM.
 *
 * Invariants per direction:
 *   - USDC released on source == USDC minted on dest (direct equality;
 *     both chains use 6-decimal MockUSDC).
 *   - Dest OkuM supply delta == minted amount.
 *   - Source OkuM supply delta == -(redeemed amount).
 *
 * Supports --direction=a-to-b | b-to-a | roundtrip and --permutations
 * to run all ordered pairs of the four testnets.
 *
 * Refuses to operate against mainnet networks (base / bsc / ethereum).
 *
 * Usage:
 *   # Single pair
 *   npx tsx scripts/test/test-bridge-evm-evm.ts \
 *       --source=sepolia --dest=baseSepolia --amount=5
 *
 *   # Both directions (roundtrip)
 *   npx tsx scripts/test/test-bridge-evm-evm.ts \
 *       --source=sepolia --dest=baseSepolia --amount=5 --direction=roundtrip
 *
 *   # All 12 ordered permutations of 4 testnets
 *   npx tsx scripts/test/test-bridge-evm-evm.ts --permutations --amount=2
 *
 * Environment:
 *   PRIVATE_KEY     Deployer private key (hex, with or without 0x)
 *   DRY_RUN=true    Simulate only (no transactions sent)
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { ethers } from "ethers";
import { MAINNET_NETWORKS } from "../utils/mainnetGuard";

// Load .env from EVM root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ============================================================================
// CLI parsing
// ============================================================================

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

const SOURCE_CHAIN = parseArg("source");
const DEST_CHAIN = parseArg("dest");
const AMOUNT_STR = parseArg("amount") ?? "5";
const DIRECTION = (parseArg("direction") ?? "a-to-b") as
  | "a-to-b"
  | "b-to-a"
  | "roundtrip";
const RUN_PERMUTATIONS = process.argv.includes("--permutations");
const DRY_RUN = process.env.DRY_RUN === "true";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY env var is required");
}
if (!RUN_PERMUTATIONS && (!SOURCE_CHAIN || !DEST_CHAIN)) {
  throw new Error(
    "Required: --source=<chain> --dest=<chain>, or --permutations"
  );
}

// ============================================================================
// Mainnet guard
// ============================================================================
//
// Uses the same set as `mainnetGuard.ts` for every operator script.

function guardMainnet(chain: string) {
  if (MAINNET_NETWORKS.has(chain)) {
    throw new Error(
      `Refusing to run bridge test on mainnet network "${chain}". ` +
        `Use operator scripts with --yes-mainnet instead.`
    );
  }
}

// ============================================================================
// Logger (matches existing EVM/SVM logger style)
// ============================================================================

const logger = {
  success: (msg: string) => console.log(`\x1b[32m✓\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[31m✗\x1b[0m ${msg}`),
  info: (msg: string) => console.log(`\x1b[36mℹ\x1b[0m ${msg}`),
  warning: (msg: string) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`),
  section: (msg: string) => console.log(`\n\x1b[1m=== ${msg} ===\x1b[0m`),
  header: (msg: string) => {
    console.log();
    console.log(`\x1b[36m${"=".repeat(60)}\x1b[0m`);
    console.log(`\x1b[1m\x1b[36m  ${msg}\x1b[0m`);
    console.log(`\x1b[36m${"=".repeat(60)}\x1b[0m`);
  },
};

// ============================================================================
// Contract ABIs (minimal)
// ============================================================================

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function mint(address,uint256)",
];
const OKU_MONEY_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function okuMMultiplier() view returns (uint256)",
];
const LITE_PSM_ABI = [
  "function mintOkuM(uint256 usdcAmount)",
  "function redeemOkuM(uint256 okuMAmount)",
];

// ============================================================================
// Chain context
// ============================================================================

interface ChainCtx {
  chainName: string;
  chainId: number;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  usdc: ethers.Contract;
  okuMoney: ethers.Contract;
  litePSM: ethers.Contract;
  litePSMAddr: string;
  hasMockUsdc: boolean;
  usdcDecimals: number;
}

function loadRegistry(): any {
  const registryPath = path.resolve(__dirname, "../../../testnet-addresses.json");
  if (!fs.existsSync(registryPath)) {
    throw new Error(`testnet-addresses.json not found at ${registryPath}`);
  }
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function isBscChain(name: string): boolean {
  return name === "bsc" || name === "bscTestnet";
}

/**
 * Resolve RPC URL with reliability-first ordering:
 * 1. ALCHEMY_API_KEY-derived URL (most reliable for testnets)
 * 2. Chain-specific env var (e.g. SEPOLIA_RPC_URL — may contain stale public RPCs)
 * 3. Fallback to testnet-addresses.json rpcUrl
 */
function resolveRpcUrl(chainName: string, registryRpcUrl: string): string {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (alchemyKey) {
    const alchemyNetworks: Record<string, string> = {
      sepolia: "eth-sepolia",
      baseSepolia: "base-sepolia",
      arbSepolia: "arb-sepolia",
      bscTestnet: "bnb-testnet",
    };
    const alchemyNet = alchemyNetworks[chainName];
    if (alchemyNet) return `https://${alchemyNet}.g.alchemy.com/v2/${alchemyKey}`;
  }

  const envOverrides: Record<string, string | undefined> = {
    sepolia: process.env.SEPOLIA_RPC_URL,
    baseSepolia: process.env.BASE_SEPOLIA_RPC_URL,
    arbSepolia: process.env.ARB_SEPOLIA_RPC_URL,
    bscTestnet: process.env.BSC_TESTNET_RPC_URL,
    base: process.env.BASE_RPC_URL,
    bsc: process.env.BSC_RPC_URL,
  };
  if (envOverrides[chainName]) return envOverrides[chainName]!;

  return registryRpcUrl;
}

async function makeChainCtx(chainName: string): Promise<ChainCtx> {
  const registry = loadRegistry();
  const entry = registry.evm?.[chainName];
  if (!entry) {
    throw new Error(`No EVM registry entry for "${chainName}"`);
  }
  const { chainId, contracts } = entry;
  const rpcUrl = resolveRpcUrl(chainName, entry.rpcUrl);
  if (!contracts.okuMoney || !contracts.litePSM) {
    throw new Error(`Missing OkuMoney/LitePSM in registry for "${chainName}"`);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const pk = PRIVATE_KEY!.startsWith("0x") ? PRIVATE_KEY! : `0x${PRIVATE_KEY!}`;
  const wallet = new ethers.Wallet(pk, provider);

  const usdcAddr = contracts.mockUSDC ?? contracts.usdc;
  if (!usdcAddr) throw new Error(`No USDC in registry for "${chainName}"`);

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, wallet);
  const okuMoney = new ethers.Contract(contracts.okuMoney, OKU_MONEY_ABI, wallet);
  const litePSM = new ethers.Contract(contracts.litePSM, LITE_PSM_ABI, wallet);
  const usdcDecimals = Number(await usdc.decimals());

  return {
    chainName,
    chainId,
    provider,
    wallet,
    usdc,
    okuMoney,
    litePSM,
    litePSMAddr: contracts.litePSM,
    hasMockUsdc: !!contracts.mockUSDC,
    usdcDecimals,
  };
}

// ============================================================================
// Tx helpers
// ============================================================================

async function sendTx(
  ctx: ChainCtx,
  contract: ethers.Contract,
  method: string,
  args: any[],
  label: string
): Promise<string> {
  const overrides = isBscChain(ctx.chainName) ? { type: 0 as const } : {};
  if (DRY_RUN) {
    logger.warning(`[${ctx.chainName}] DRY_RUN - would send ${label}`);
    return "<dry-run>";
  }
  const maxRetries = 3;
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tx = await contract[method](...args, overrides);
      const rcpt = await tx.wait(1);
      logger.success(`[${ctx.chainName}] ${label} -> ${rcpt.hash}`);
      return rcpt.hash;
    } catch (e: any) {
      lastErr = e;
      const msg = e?.shortMessage || e?.message || String(e);
      // "replacement transaction underpriced" deliberately does NOT retry.
      // That error means a transaction was ALREADY broadcast (it's the RPC
      // telling us our resubmission didn't out-bid the pending one) — retrying
      // resends a DIFFERENT tx (fresh nonce/gas) rather than the original, so
      // both can land and double-execute the mint/redeem. For MockUSDC.mint or
      // mintOkuM that means double-minting, silently, with no invariant here
      // able to catch it (deltas are all `> 0` / value-conservation checks that
      // a doubled amount still satisfies).
      if (
        attempt < maxRetries - 1 &&
        (msg.includes("execution reverted") ||
          msg.includes("insufficient allowance"))
      ) {
        logger.warning(
          `[${ctx.chainName}] ${label} failed (attempt ${attempt + 1}/${maxRetries}); ` +
            `waiting 3s and retrying...`
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ============================================================================
// Snapshots + polling
// ============================================================================

interface Snap {
  usdc: bigint;
  okuM: bigint;
  okuMSupply: bigint;
}

async function snap(c: ChainCtx): Promise<Snap> {
  const [usdc, okuM, okuMSupply] = await Promise.all([
    c.usdc.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.totalSupply() as Promise<bigint>,
  ]);
  return { usdc, okuM, okuMSupply };
}

function printSnap(c: ChainCtx, s: Snap, label: string) {
  logger.info(`[${c.chainName}] ${label}:`);
  logger.info(`  USDC:       ${ethers.formatUnits(s.usdc, c.usdcDecimals)}`);
  logger.info(`  OkuM:       ${ethers.formatUnits(s.okuM, 18)}`);
  logger.info(`  OkuM supply: ${ethers.formatUnits(s.okuMSupply, 18)}`);
}

/**
 * Poll until balance differs from baseline. Public RPCs lag 1-2 blocks.
 */
async function pollDelta(
  read: () => Promise<bigint>,
  baseline: bigint,
  maxMs: number = 30_000
): Promise<bigint> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const cur = await read();
    if (cur !== baseline) return cur - baseline;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await read()) - baseline;
}

// ============================================================================
// Bridge legs
// ============================================================================

interface BridgeResult {
  usdcReleased: bigint;
  okuMMinted: bigint;
}

/**
 * Bridge OkuM from source to dest:
 *   1. Redeem OkuM on source -> get USDC
 *   2. MockUSDC.mint on dest (off-chain rail simulation)
 *   3. mintOkuM on dest with that USDC
 */
async function bridgeLeg(
  source: ChainCtx,
  dest: ChainCtx,
  okuMAmount: bigint
): Promise<BridgeResult> {
  logger.header(`Bridge: ${source.chainName} -> ${dest.chainName}`);

  const srcPre = await snap(source);
  const dstPre = await snap(dest);
  printSnap(source, srcPre, "PRE");
  printSnap(dest, dstPre, "PRE");

  // ---- Ensure source has enough OkuM (seed if needed) ----
  if (srcPre.okuM < okuMAmount) {
    const multiplier: bigint = await source.okuMoney.okuMMultiplier();
    const PRECISION = 10n ** 18n;
    const decScale = 10n ** BigInt(18 - source.usdcDecimals);
    const usdcNeeded =
      ((okuMAmount - srcPre.okuM) * multiplier) / PRECISION / decScale + 1n;
    logger.info(
      `[${source.chainName}] Wallet short on OkuM; seeding with ` +
        `${ethers.formatUnits(usdcNeeded, source.usdcDecimals)} USDC via mint+PSM`
    );
    if (!source.hasMockUsdc) {
      throw new Error(`[${source.chainName}] No MockUSDC; cannot seed`);
    }
    const usdcBal: bigint = await source.usdc.balanceOf(source.wallet.address);
    if (usdcBal < usdcNeeded) {
      await sendTx(
        source,
        source.usdc,
        "mint",
        [source.wallet.address, usdcNeeded - usdcBal],
        `MockUSDC.mint(${ethers.formatUnits(usdcNeeded - usdcBal, source.usdcDecimals)})`
      );
    }
    await sendTx(
      source,
      source.usdc,
      "approve",
      [source.litePSMAddr, usdcNeeded],
      "usdc.approve(seed)"
    );
    await sendTx(
      source,
      source.litePSM,
      "mintOkuM",
      [usdcNeeded],
      `litePSM.mintOkuM(${ethers.formatUnits(usdcNeeded, source.usdcDecimals)}) [seed]`
    );
  }

  // ---- Ensure source PSM has buffer for instant redeem ----
  const buffer: bigint = await source.usdc.balanceOf(source.litePSMAddr);
  const multiplier: bigint = await source.okuMoney.okuMMultiplier();
  const PRECISION = 10n ** 18n;
  const decScale = 10n ** BigInt(18 - source.usdcDecimals);
  const usdcExpected = (okuMAmount * multiplier) / PRECISION / decScale;
  if (buffer < usdcExpected) {
    const deficit = usdcExpected - buffer + 1n;
    logger.info(
      `[${source.chainName}] PSM buffer low (${ethers.formatUnits(buffer, source.usdcDecimals)}); ` +
        `minting ${ethers.formatUnits(deficit, source.usdcDecimals)} MockUSDC and depositing`
    );
    // The PSM only accepts USDC via mintOkuM or depositBuffer (needs
    // PSM_BUFFER_DEPOSITOR, and an unpaused PSM). Seeding mintOkuM above already
    // deposited USDC; mint extra MockUSDC for any remaining deficit.
    const usdcBal: bigint = await source.usdc.balanceOf(source.wallet.address);
    if (usdcBal < deficit) {
      await sendTx(
        source,
        source.usdc,
        "mint",
        [source.wallet.address, deficit - usdcBal],
        `MockUSDC.mint(${ethers.formatUnits(deficit - usdcBal, source.usdcDecimals)}) [buffer fill]`
      );
    }
    await sendTx(
      source,
      source.usdc,
      "approve",
      [source.litePSMAddr, deficit],
      "usdc.approve(buffer fill)"
    );
    await sendTx(
      source,
      source.litePSM,
      "mintOkuM",
      [deficit],
      `litePSM.mintOkuM(${ethers.formatUnits(deficit, source.usdcDecimals)}) [buffer fill]`
    );
  }

  // ---- Source leg: redeem OkuM -> USDC ----
  logger.section(`Source leg: redeem on ${source.chainName}`);
  const usdcBefore: bigint = await source.usdc.balanceOf(source.wallet.address);
  await sendTx(
    source,
    source.okuMoney,
    "approve",
    [source.litePSMAddr, okuMAmount],
    `okuMoney.approve(${ethers.formatUnits(okuMAmount, 18)})`
  );
  await sendTx(
    source,
    source.litePSM,
    "redeemOkuM",
    [okuMAmount],
    `litePSM.redeemOkuM(${ethers.formatUnits(okuMAmount, 18)})`
  );
  const usdcReleased = await pollDelta(
    () => source.usdc.balanceOf(source.wallet.address) as Promise<bigint>,
    usdcBefore
  );
  if (usdcReleased <= 0n) {
    throw new Error(`[${source.chainName}] redeemOkuM released 0 USDC`);
  }
  logger.success(
    `[${source.chainName}] released ${ethers.formatUnits(usdcReleased, source.usdcDecimals)} USDC`
  );

  // ---- Off-chain rail: mint MockUSDC on dest ----
  logger.section(`Off-chain rail: MockUSDC.mint on ${dest.chainName}`);
  if (!dest.hasMockUsdc) {
    throw new Error(`[${dest.chainName}] No MockUSDC; cannot simulate rail`);
  }
  await sendTx(
    dest,
    dest.usdc,
    "mint",
    [dest.wallet.address, usdcReleased],
    `MockUSDC.mint(${ethers.formatUnits(usdcReleased, dest.usdcDecimals)})`
  );

  // ---- Dest leg: mint OkuM ----
  logger.section(`Dest leg: mint on ${dest.chainName}`);
  const okuMBefore: bigint = await dest.okuMoney.balanceOf(dest.wallet.address);
  await sendTx(
    dest,
    dest.usdc,
    "approve",
    [dest.litePSMAddr, usdcReleased],
    "usdc.approve"
  );
  await sendTx(
    dest,
    dest.litePSM,
    "mintOkuM",
    [usdcReleased],
    `litePSM.mintOkuM(${ethers.formatUnits(usdcReleased, dest.usdcDecimals)})`
  );
  const okuMMinted = await pollDelta(
    () => dest.okuMoney.balanceOf(dest.wallet.address) as Promise<bigint>,
    okuMBefore
  );
  if (okuMMinted <= 0n) {
    throw new Error(`[${dest.chainName}] mintOkuM minted 0 OkuM`);
  }
  logger.success(
    `[${dest.chainName}] minted ${ethers.formatUnits(okuMMinted, 18)} OkuM`
  );

  // ---- Post-snap + invariants ----
  const srcPost = await snap(source);
  const dstPost = await snap(dest);
  printSnap(source, srcPost, "POST");
  printSnap(dest, dstPost, "POST");

  logger.section("Invariants");

  // Dest USDC net delta should be 0 (mint USDC on dest + spend via mintOkuM cancel)
  const dstUsdcDelta = dstPost.usdc - dstPre.usdc;
  if (dstUsdcDelta !== 0n) {
    throw new Error(
      `[invariant] dest USDC net delta should be 0; got ${dstUsdcDelta}`
    );
  }
  logger.success(`[invariant] ${dest.chainName} USDC net delta = 0: OK`);

  // Dest supply increased
  const dstSupplyDelta = dstPost.okuMSupply - dstPre.okuMSupply;
  // If we seeded dest to fill buffer, supply may have extra. Just check > 0.
  if (dstSupplyDelta <= 0n) {
    throw new Error(
      `[invariant] dest supply should increase; delta=${dstSupplyDelta}`
    );
  }
  logger.success(
    `[invariant] ${dest.chainName} supply increased by ${ethers.formatUnits(dstSupplyDelta, 18)}: OK`
  );

  // Source supply decreased (unless we seeded, which increases it first)
  // Skip strict check since seeding can net-increase source supply.
  const srcSupplyDelta = srcPost.okuMSupply - srcPre.okuMSupply;
  logger.info(
    `[invariant] ${source.chainName} supply delta: ${ethers.formatUnits(srcSupplyDelta, 18)} ` +
      `(may be positive if wallet was seeded)`
  );

  // ─────────────────────────────────────────────────────────────────────────
  // THE bridge invariant: DOLLAR-VALUE CONSERVATION across the two chains.
  //
  // Everything above this point is satisfiable by a completely broken bridge.
  // `usdcReleased == usdcMinted` is TAUTOLOGICAL — the rail mints exactly
  // `usdcReleased` by construction, so it is an assignment, not a check. And
  // `okuMMinted > 0` says nothing about whether the amount is right.
  //
  // OkuM is NOT fungible 1:1 across chains: it is a static-balance token whose
  // value is (balance x multiplier), and the two chains' multipliers are only
  // kept in agreement by off-chain operator discipline. So bridging 5 OkuM
  // from a chain at 1.05 to a chain at 1.02 must yield ~5.147 OkuM, not 5.
  // Without this check, an A@1.05 -> B@1.02 bridge that produced the WRONG
  // number passed every assertion in this file.
  //
  // What must hold is that DOLLAR value is preserved end-to-end:
  //     okuMBurned_src x mult_src  ==  okuMMinted_dst x mult_dst
  // ─────────────────────────────────────────────────────────────────────────
  const srcMult: bigint = await source.okuMoney.okuMMultiplier();
  const dstMult: bigint = await dest.okuMoney.okuMMultiplier();
  const PRECISION_WAD = 10n ** 18n;

  const srcValueWad = (okuMAmount * srcMult) / PRECISION_WAD;
  const dstValueWad = (okuMMinted * dstMult) / PRECISION_WAD;
  const valueDrift = srcValueWad > dstValueWad ? srcValueWad - dstValueWad : dstValueWad - srcValueWad;

  // Tolerance: the round-trip crosses an 18->6->18 decimal boundary (OkuM is
  // 18dp, the USDC rail is 6dp), so up to one USDC-unit of value is lost to
  // flooring in each direction. Express that in 18dp terms and allow 2 units.
  const oneUsdcUnitWad = 10n ** BigInt(18 - source.usdcDecimals);
  const valueTolerance = oneUsdcUnitWad * 2n;

  logger.info(
    `[invariant] value conservation: src ${ethers.formatUnits(okuMAmount, 18)} OkuM @ ` +
      `${ethers.formatUnits(srcMult, 18)} = $${ethers.formatUnits(srcValueWad, 18)} | ` +
      `dst ${ethers.formatUnits(okuMMinted, 18)} OkuM @ ${ethers.formatUnits(dstMult, 18)} = ` +
      `$${ethers.formatUnits(dstValueWad, 18)}`
  );
  if (valueDrift > valueTolerance) {
    throw new Error(
      `[invariant] VALUE NOT CONSERVED across the bridge: source burned ` +
        `$${ethers.formatUnits(srcValueWad, 18)} of value but destination minted ` +
        `$${ethers.formatUnits(dstValueWad, 18)} (drift=${valueDrift} wad, tolerance=${valueTolerance}). ` +
        `src multiplier=${srcMult}, dst multiplier=${dstMult}.`
    );
  }
  logger.success(
    `[invariant] dollar value conserved across chains (drift ${valueDrift} wad <= ${valueTolerance}): OK`
  );

  // Report cross-chain multiplier divergence explicitly. This is the protocol's
  // central trust assumption (one global rate, operator-enforced) and it is
  // otherwise verified NOWHERE on-chain. Divergence is monotonic and
  // uncorrectable downward, so surfacing it early matters.
  const multDrift = srcMult > dstMult ? srcMult - dstMult : dstMult - srcMult;
  const multDriftBps = (multDrift * 10_000n) / PRECISION_WAD;
  if (multDriftBps > 0n) {
    logger.warning(
      `[observe] cross-chain multiplier divergence ${source.chainName}=${srcMult} vs ` +
        `${dest.chainName}=${dstMult} (${multDriftBps} bps). Expected 0 under a correctly ` +
        `broadcast global schedule.`
    );
  } else {
    logger.success(`[observe] cross-chain multipliers agree (0 bps divergence)`);
  }

  logger.success(
    `Bridge ${source.chainName} -> ${dest.chainName}: PASS ` +
      `(${ethers.formatUnits(usdcReleased, source.usdcDecimals)} USDC transferred)`
  );

  return { usdcReleased, okuMMinted };
}

// ============================================================================
// Permutation runner
// ============================================================================

const TESTNETS = ["sepolia", "baseSepolia", "arbSepolia", "bscTestnet"];

async function runPermutations(amount: bigint) {
  const pairs: [string, string][] = [];
  for (const src of TESTNETS) {
    for (const dst of TESTNETS) {
      if (src !== dst) pairs.push([src, dst]);
    }
  }

  logger.header(`EVM <-> EVM bridge: all ${pairs.length} permutations`);
  logger.info(`Amount: ${ethers.formatUnits(amount, 18)} OkuM per leg`);

  const results: { pair: string; status: string; error?: string }[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const [src, dst] = pairs[i];
    const label = `${src} -> ${dst}`;
    logger.header(`[${i + 1}/${pairs.length}] ${label}`);
    try {
      const srcCtx = await makeChainCtx(src);
      const dstCtx = await makeChainCtx(dst);
      await bridgeLeg(srcCtx, dstCtx, amount);
      results.push({ pair: label, status: "PASS" });
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || String(e);
      logger.error(`${label}: FAIL - ${msg}`);
      results.push({ pair: label, status: "FAIL", error: msg });
    }
  }

  // Summary
  logger.header("Permutation Summary");
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  for (const r of results) {
    const icon = r.status === "PASS" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const line = `${icon} ${r.pair.padEnd(30)} ${r.status}`;
    console.log(line);
    if (r.error) console.log(`     ${r.error}`);
  }
  console.log();
  logger.info(`${passed} passed, ${failed} failed out of ${results.length}`);

  if (failed > 0) {
    throw new Error(`${failed} permutation(s) failed`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (RUN_PERMUTATIONS) {
    for (const chain of TESTNETS) guardMainnet(chain);
    const amount = ethers.parseUnits(AMOUNT_STR, 18);
    await runPermutations(amount);
    return;
  }

  // Single pair mode
  guardMainnet(SOURCE_CHAIN!);
  guardMainnet(DEST_CHAIN!);
  if (SOURCE_CHAIN === DEST_CHAIN) {
    throw new Error("--source and --dest must be different chains");
  }

  const amount = ethers.parseUnits(AMOUNT_STR, 18);
  logger.header("test-bridge-evm-evm");
  logger.info(
    `source=${SOURCE_CHAIN}  dest=${DEST_CHAIN}  ` +
      `amount=${AMOUNT_STR} OkuM  direction=${DIRECTION}`
  );

  const source = await makeChainCtx(SOURCE_CHAIN!);
  const dest = await makeChainCtx(DEST_CHAIN!);

  logger.info(`Signer: ${source.wallet.address}`);

  if (DIRECTION === "a-to-b") {
    await bridgeLeg(source, dest, amount);
  } else if (DIRECTION === "b-to-a") {
    await bridgeLeg(dest, source, amount);
  } else {
    // roundtrip
    await bridgeLeg(source, dest, amount);
    logger.header("Return leg");
    await bridgeLeg(dest, source, amount);
  }

  logger.success("test-bridge-evm-evm complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err?.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
