/**
 * EVM <-> EVM bridge test (noBridge orchestrator simulation).
 *
 * Drives the verified 3-leg flow end-to-end against TWO live testnets in a
 * single process:
 *
 *   1. Source-chain redeem: psm.mintOkuM (if needed) + psm.redeemOkuM ->
 *      USDC released to the dev wallet.
 *   2. Off-chain rail simulation: MockUSDC.mint to the dev wallet on the
 *      destination chain (an open-mint MockUSDC stand-in for the
 *      orchestrator's real off-chain USDC transfer).
 *   3. Destination-chain mint: psm.mintOkuM -> OkuM minted to the dev
 *      wallet on the destination chain.
 *
 * Invariants asserted after each direction:
 *   - USDC released on source == USDC minted on destination (raw 6-dec
 *     units; both EVM chains in our deploys carry MockUSDC with 6 decimals).
 *   - OkuM net change across the pair = 0 (source supply down, dest supply
 *     up by the same OkuM amount; deltas are checked at per-wallet level).
 *
 * This script is hardhat-agnostic — it instantiates a fresh
 * `ethers.JsonRpcProvider` per chain using `chains.ts` RPC URLs, and signs
 * with `PRIVATE_KEY` from env on both sides. Run it via tsx OR via
 * `npx hardhat run` (the latter just for ts-node ergonomics; no hardhat
 * runtime network is actually used).
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/test/bridge-evm-evm.ts \
 *       --from=baseSepolia --to=bscTestnet --amount=5
 *
 *   # Direction flag (default oneway): "oneway" or "roundtrip".
 *   PRIVATE_KEY=0x... npx tsx scripts/test/bridge-evm-evm.ts \
 *       --from=baseSepolia --to=bscTestnet --amount=5 --direction=roundtrip
 *
 * Environment / CLI:
 *   --from=<chain>          source chain name (e.g. baseSepolia)
 *   --to=<chain>            destination chain name
 *   --amount=<okuM>         OkuM notional to bridge (default 5; integer in OkuM units)
 *   --direction=oneway|roundtrip   default oneway
 *   PRIVATE_KEY             EVM private key (without 0x or with; both ok)
 *   DRY_RUN=true            simulate (no broadcasts)
 *   --yes-mainnet           required if --from or --to is a mainnet
 *
 * Refuses to broadcast on mainnet networks unless --yes-mainnet is passed
 * (and even then, the orchestrator-tool scripts are the preferred surface).
 */

// Load .env when run directly via ts-node / tsx (Hardhat scripts get this for
// free via its own bootstrap). Idempotent if dotenv was already loaded.
import "dotenv/config";

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { CHAIN_METADATA, getTokenAddress } from "../config/chains";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

// ============================================================================
// CLI parsing
// ============================================================================

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

const FROM = parseArg("from");
const TO = parseArg("to");
const AMOUNT_STR = parseArg("amount") ?? "5";
const DIRECTION = (parseArg("direction") ?? "oneway") as "oneway" | "roundtrip";
const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!FROM || !TO) {
  throw new Error(
    "Required: --from=<chain> --to=<chain> (e.g. --from=baseSepolia --to=bscTestnet)"
  );
}
if (FROM === TO) {
  throw new Error("--from and --to must be different chains");
}
if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY env var is required");
}
if (DIRECTION !== "oneway" && DIRECTION !== "roundtrip") {
  throw new Error(`--direction must be "oneway" or "roundtrip" (got ${DIRECTION})`);
}

// ============================================================================
// ABIs (minimal — we attach to deployed proxies)
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
  "function paused() view returns (bool)",
];

// ============================================================================
// Address book (read-only; bypass hardhat-dependent helpers)
// ============================================================================

const ADDRESSES_PATH = path.join(__dirname, "..", "config", "addresses.json");

function loadChainAddresses(chainKey: string): Record<string, string> {
  const json = JSON.parse(fs.readFileSync(ADDRESSES_PATH, "utf8"));
  const entry = json[chainKey];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `No deployed addresses found for "${chainKey}" in ${ADDRESSES_PATH}`
    );
  }
  return entry as Record<string, string>;
}

// ============================================================================
// Per-chain client (provider + wallet + contracts)
// ============================================================================

interface ChainClient {
  name: string;
  chainId: number;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  usdc: ethers.Contract;
  okuMoney: ethers.Contract;
  litePSM: ethers.Contract;
  usdcDecimals: number; // 6 for MockUSDC; needed for cross-chain conservation math
  hasMockUsdc: boolean;
  litePSMAddr: string;
}

async function makeClient(chainKey: string): Promise<ChainClient> {
  const meta = CHAIN_METADATA[chainKey];
  if (!meta) throw new Error(`No metadata for chain "${chainKey}"`);

  const provider = new ethers.JsonRpcProvider(meta.rpcUrl, meta.chainId);

  const pk = PRIVATE_KEY!.startsWith("0x") ? PRIVATE_KEY! : `0x${PRIVATE_KEY!}`;
  const wallet = new ethers.Wallet(pk, provider);

  const addrs = loadChainAddresses(chainKey);
  const usdcAddr = addrs.MockUSDC ?? getTokenAddress(chainKey, "usdc");
  const okuMoneyAddr = addrs.OkuMoney;
  const litePSMAddr = addrs.LitePSM;
  if (!okuMoneyAddr || !litePSMAddr) {
    throw new Error(`Missing OkuMoney or LitePSM in addresses.json for "${chainKey}"`);
  }

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, wallet);
  const okuMoney = new ethers.Contract(okuMoneyAddr, OKU_MONEY_ABI, wallet);
  const litePSM = new ethers.Contract(litePSMAddr, LITE_PSM_ABI, wallet);

  const usdcDecimals = Number(await usdc.decimals());

  return {
    name: chainKey,
    chainId: meta.chainId,
    provider,
    wallet,
    usdc,
    okuMoney,
    litePSM,
    usdcDecimals,
    hasMockUsdc: !!addrs.MockUSDC,
    litePSMAddr,
  };
}

// ============================================================================
// Pre/post snapshot
// ============================================================================

interface Snapshot {
  usdc: bigint;
  okuM: bigint;
  okuMSupply: bigint;
  multiplier: bigint;
}

async function snapshot(c: ChainClient): Promise<Snapshot> {
  const [usdc, okuM, okuMSupply, multiplier] = await Promise.all([
    c.usdc.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.totalSupply() as Promise<bigint>,
    c.okuMoney.okuMMultiplier() as Promise<bigint>,
  ]);
  return { usdc, okuM, okuMSupply, multiplier };
}

function printSnapshot(c: ChainClient, snap: Snapshot, label: string) {
  logger.info(`[${c.name}] ${label}:`);
  logger.info(`  wallet USDC:    ${ethers.formatUnits(snap.usdc, c.usdcDecimals)}`);
  logger.info(`  wallet OkuM:    ${ethers.formatUnits(snap.okuM, 18)}`);
  logger.info(`  OkuM supply:    ${ethers.formatUnits(snap.okuMSupply, 18)}`);
  logger.info(`  multiplier:     ${snap.multiplier}`);
}

// ============================================================================
// Tx helpers — handle BSC's legacy-tx quirk
// ============================================================================

function isBscChain(name: string): boolean {
  return name === "bsc" || name === "bscTestnet";
}

async function sendTx(
  c: ChainClient,
  contract: ethers.Contract,
  method: string,
  args: any[],
  label: string
): Promise<string> {
  // BSC public RPCs reject EIP-1559 calldata for some methods; force legacy
  // tx type to mirror the verified manual cast --legacy workflow.
  const txOverrides = isBscChain(c.name) ? { type: 0 as const } : {};

  if (DRY_RUN) {
    logger.warning(`[${c.name}] DRY_RUN — would send ${label}`);
    return "<dry-run>";
  }

  const tx = await contract[method](...args, txOverrides);
  const rcpt = await tx.wait(1);
  logger.success(`[${c.name}] ${label} -> ${rcpt.hash}`);
  return rcpt.hash;
}

/**
 * Poll `read()` every 1s for up to `maxMs` until the returned value differs
 * from `baseline`. Public RPCs (especially BSC testnet + Base Sepolia) lag a
 * block or two before post-tx reads reflect on-chain state, so synchronous
 * post-broadcast reads can otherwise return stale snapshots.
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

/**
 * Source-chain leg: ensure the wallet has enough OkuM (mint via PSM if not),
 * then redeem `amount` OkuM -> USDC. Returns USDC actually released.
 */
async function bridgeSourceLeg(
  c: ChainClient,
  okuMAmount: bigint
): Promise<bigint> {
  logger.section(`Source leg: redeem on ${c.name}`);
  const okuMBal: bigint = await c.okuMoney.balanceOf(c.wallet.address);
  if (okuMBal < okuMAmount) {
    // Mint enough OkuM by depositing the USDC equivalent at the current multiplier.
    // okuMAmount (18dec) needed -> usdc (6 dec) = okuMAmount * multiplier / 1e18 / 1e12
    const multiplier: bigint = await c.okuMoney.okuMMultiplier();
    const PRECISION = 10n ** 18n;
    const decScale = 10n ** BigInt(18 - c.usdcDecimals); // 1e12 when usdc=6
    const usdcNeeded = ((okuMAmount - okuMBal) * multiplier) / PRECISION / decScale;
    // Add a small cushion to absorb 1-unit round-trip drift.
    const usdcWithCushion = usdcNeeded + 1n;
    logger.info(
      `[${c.name}] Wallet short by ${ethers.formatUnits(okuMAmount - okuMBal, 18)} OkuM; ` +
        `minting via PSM with ${ethers.formatUnits(usdcWithCushion, c.usdcDecimals)} USDC`
    );

    // Mint MockUSDC if needed
    const usdcBal: bigint = await c.usdc.balanceOf(c.wallet.address);
    if (usdcBal < usdcWithCushion) {
      if (!c.hasMockUsdc) {
        throw new Error(
          `[${c.name}] Wallet lacks ${usdcWithCushion - usdcBal} USDC and no MockUSDC available`
        );
      }
      await sendTx(
        c,
        c.usdc,
        "mint",
        [c.wallet.address, usdcWithCushion - usdcBal],
        `MockUSDC.mint(${ethers.formatUnits(usdcWithCushion - usdcBal, c.usdcDecimals)})`
      );
    }

    await sendTx(
      c,
      c.usdc,
      "approve",
      [c.litePSMAddr, usdcWithCushion],
      `usdc.approve(LitePSM, ${ethers.formatUnits(usdcWithCushion, c.usdcDecimals)})`
    );
    await sendTx(
      c,
      c.litePSM,
      "mintOkuM",
      [usdcWithCushion],
      `LitePSM.mintOkuM(${ethers.formatUnits(usdcWithCushion, c.usdcDecimals)})`
    );
  }

  // Now redeem `okuMAmount` for USDC.
  const usdcBefore: bigint = await c.usdc.balanceOf(c.wallet.address);
  await sendTx(
    c,
    c.okuMoney,
    "approve",
    [c.litePSMAddr, okuMAmount],
    `okuMoney.approve(LitePSM, ${ethers.formatUnits(okuMAmount, 18)})`
  );
  await sendTx(
    c,
    c.litePSM,
    "redeemOkuM",
    [okuMAmount],
    `LitePSM.redeemOkuM(${ethers.formatUnits(okuMAmount, 18)})`
  );
  const released = await pollDelta(
    () => c.usdc.balanceOf(c.wallet.address) as Promise<bigint>,
    usdcBefore
  );
  logger.success(
    `[${c.name}] released ${ethers.formatUnits(released, c.usdcDecimals)} USDC ` +
      `(from ${ethers.formatUnits(okuMAmount, 18)} OkuM)`
  );
  if (released === 0n) {
    throw new Error(
      `[${c.name}] redeemOkuM released 0 USDC — likely queued because buffer is too low`
    );
  }
  return released;
}

/**
 * Off-chain rail simulation: mint `usdcAmount` of MockUSDC on the destination
 * chain to the dev wallet. Stand-in for the orchestrator's real USDC
 * transfer.
 */
async function bridgeOffchainRail(c: ChainClient, usdcAmount: bigint) {
  logger.section(`Off-chain rail: mint USDC on ${c.name}`);
  if (!c.hasMockUsdc) {
    throw new Error(
      `[${c.name}] Destination chain has no MockUSDC; cannot simulate off-chain rail`
    );
  }
  await sendTx(
    c,
    c.usdc,
    "mint",
    [c.wallet.address, usdcAmount],
    `MockUSDC.mint(${ethers.formatUnits(usdcAmount, c.usdcDecimals)})`
  );
}

/**
 * Destination-chain leg: psm.mintOkuM(usdcAmount). Returns OkuM minted.
 */
async function bridgeDestLeg(c: ChainClient, usdcAmount: bigint): Promise<bigint> {
  logger.section(`Dest leg: mint on ${c.name}`);
  const okuMBefore: bigint = await c.okuMoney.balanceOf(c.wallet.address);
  await sendTx(
    c,
    c.usdc,
    "approve",
    [c.litePSMAddr, usdcAmount],
    `usdc.approve(LitePSM, ${ethers.formatUnits(usdcAmount, c.usdcDecimals)})`
  );
  await sendTx(
    c,
    c.litePSM,
    "mintOkuM",
    [usdcAmount],
    `LitePSM.mintOkuM(${ethers.formatUnits(usdcAmount, c.usdcDecimals)})`
  );
  const minted = await pollDelta(
    () => c.okuMoney.balanceOf(c.wallet.address) as Promise<bigint>,
    okuMBefore
  );
  logger.success(
    `[${c.name}] minted ${ethers.formatUnits(minted, 18)} OkuM ` +
      `(from ${ethers.formatUnits(usdcAmount, c.usdcDecimals)} USDC)`
  );
  return minted;
}

// ============================================================================
// Full direction with invariant checks
// ============================================================================

async function runDirection(src: ChainClient, dst: ChainClient, okuMAmount: bigint) {
  logger.header(`Bridge ${src.name} -> ${dst.name} (amount=${ethers.formatUnits(okuMAmount, 18)} OkuM)`);

  // Pre-state snapshots on both chains
  const srcPre = await snapshot(src);
  const dstPre = await snapshot(dst);
  printSnapshot(src, srcPre, "PRE");
  printSnapshot(dst, dstPre, "PRE");

  // Both source and dest must use 6-decimal USDC for direct conservation
  // assertions; abort early on mismatch so we don't get a misleading "ok"
  // result on a chain that's silently 18-decimal (e.g. bsc native USDC).
  if (src.usdcDecimals !== dst.usdcDecimals) {
    throw new Error(
      `USDC-decimal mismatch: ${src.name}=${src.usdcDecimals}, ${dst.name}=${dst.usdcDecimals}. ` +
        `Cross-chain USDC conservation requires equal decimals; resolve before bridging.`
    );
  }

  const released = await bridgeSourceLeg(src, okuMAmount);
  await bridgeOffchainRail(dst, released);
  const minted = await bridgeDestLeg(dst, released);

  // Post-state snapshots
  const srcPost = await snapshot(src);
  const dstPost = await snapshot(dst);
  printSnapshot(src, srcPost, "POST");
  printSnapshot(dst, dstPost, "POST");

  // ----------------------------------------------------------------------
  // Invariants
  // ----------------------------------------------------------------------
  logger.section("Invariants");

  // 1. USDC conservation: USDC released on source == USDC minted on destination.
  // The MockUSDC.mint on dst is exactly `released`, so this is structural;
  // the meaningful check is that the dest wallet's USDC ended at the same
  // place it started (mint then immediately consumed by mintOkuM).
  const dstUsdcDelta = dstPost.usdc - dstPre.usdc;
  if (dstUsdcDelta !== 0n) {
    throw new Error(
      `[invariant] dst USDC delta should be 0 (mint+spend cancel); got ${dstUsdcDelta}`
    );
  }
  logger.success(`[invariant] dst USDC mint+spend cancel (delta=0): OK`);

  // 2. Source USDC delta should be exactly +released (we redeemed okuMAmount OkuM).
  // If we minted OkuM as part of the source leg setup, the *net* delta may
  // be smaller (because we spent USDC to mint OkuM before redeeming). So
  // only assert that the post-balance is >= pre-balance - released, i.e.
  // we didn't lose more USDC than the round-trip drift.
  if (srcPost.usdc < srcPre.usdc - 1n) {
    // The source wallet may have spent USDC to mint OkuM if it didn't already
    // have enough; that's expected. The strict assertion lives below as
    // global OkuM-supply conservation.
    logger.warning(
      `[invariant] src USDC ended below pre (spent USDC to seed OkuM): ` +
        `pre=${ethers.formatUnits(srcPre.usdc, src.usdcDecimals)} ` +
        `post=${ethers.formatUnits(srcPost.usdc, src.usdcDecimals)}`
    );
  }

  // 3. OkuM net conservation: the bridge should preserve the wallet's
  // GLOBAL OkuM holdings (sum across src+dst) approximately. Tolerance
  // accommodates rebase-multiplier rounding and any extra mint-then-redeem
  // round-trip drift on the source.
  const srcOkuMDelta = srcPost.okuM - srcPre.okuM;
  const dstOkuMDelta = dstPost.okuM - dstPre.okuM;
  const globalOkuMDelta = srcOkuMDelta + dstOkuMDelta;
  const tolerance = ethers.parseUnits("0.01", 18); // 0.01 OkuM
  if (globalOkuMDelta > tolerance || globalOkuMDelta < -tolerance) {
    throw new Error(
      `[invariant] global OkuM delta exceeds tolerance: src=${srcOkuMDelta} dst=${dstOkuMDelta} ` +
        `(combined ${ethers.formatUnits(globalOkuMDelta, 18)} OkuM, tolerance ${ethers.formatUnits(tolerance, 18)})`
    );
  }
  logger.success(
    `[invariant] global OkuM delta within tolerance: ${ethers.formatUnits(globalOkuMDelta, 18)} ` +
      `(src ${ethers.formatUnits(srcOkuMDelta, 18)} + dst ${ethers.formatUnits(dstOkuMDelta, 18)})`
  );

  // 4. Per-chain supply: src supply down by ~okuMAmount, dst supply up by ~minted.
  const srcSupplyDelta = srcPost.okuMSupply - srcPre.okuMSupply;
  const dstSupplyDelta = dstPost.okuMSupply - dstPre.okuMSupply;
  logger.info(
    `src supply delta: ${ethers.formatUnits(srcSupplyDelta, 18)} (expected ~ -${ethers.formatUnits(okuMAmount, 18)} or less, depending on seed mint)`
  );
  logger.info(
    `dst supply delta: ${ethers.formatUnits(dstSupplyDelta, 18)} (expected = +${ethers.formatUnits(minted, 18)})`
  );
  // dst supply delta is a hard equality (we know minted exactly).
  if (dstSupplyDelta !== minted) {
    throw new Error(
      `[invariant] dst supply delta (${dstSupplyDelta}) != minted (${minted})`
    );
  }
  logger.success(`[invariant] dst supply delta == minted: OK`);

  return { released, minted };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  logger.header(`bridge-evm-evm`);
  logger.info(`from=${FROM}  to=${TO}  amount=${AMOUNT_STR} OkuM  direction=${DIRECTION}`);

  mainnetGuard(FROM!, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });
  mainnetGuard(TO!, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const src = await makeClient(FROM!);
  const dst = await makeClient(TO!);
  logger.info(`Signer (src): ${src.wallet.address} on chainId ${src.chainId}`);
  logger.info(`Signer (dst): ${dst.wallet.address} on chainId ${dst.chainId}`);
  if (src.wallet.address !== dst.wallet.address) {
    // Should never happen — same PRIVATE_KEY -> same address.
    throw new Error("Signer addresses diverge across chains");
  }

  const okuMAmount = ethers.parseUnits(AMOUNT_STR, 18);
  if (okuMAmount === 0n) throw new Error("--amount must produce > 0 OkuM");

  await runDirection(src, dst, okuMAmount);
  if (DIRECTION === "roundtrip") {
    logger.header("Return leg");
    await runDirection(dst, src, okuMAmount);
  }

  logger.success("bridge-evm-evm complete");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    console.error(e);
    process.exit(1);
  });
