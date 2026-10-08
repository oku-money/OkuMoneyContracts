/**
 * EVM canonical on-chain test runner.
 *
 * Mirrors the structure of `SVM/oku-programs/scripts/test/test-devnet.ts`:
 * runs an ordered suite of single-chain protocol primitives against a live
 * testnet (or a hardhat fork). Each step is independently selectable via
 * `--step=<name>`.
 *
 * Refuses to run on a mainnet network (base/bsc/ethereum) via mainnetGuard.
 * Test scripts move funds; production should use the operator/* CLIs with
 * explicit --yes-mainnet opt-in.
 *
 * Steps (run in order if no --step is given):
 *
 *    1. state                 Pretty-print pre-test state of all 3 proxies.
 *    2. mint                  MockUSDC -> psm.mintOkuM; assert OkuM delta.
 *    3. transfer              OkuM.transfer between deployer and a second
 *                             throwaway signer; assert balance moves.
 *    4. wrap                  okuMoney.approve + okuDollar.wrap(minShares=0).
 *    5. unwrap                okuDollar.unwrap; assert OkuM returned.
 *    6. redeem                Top up the PSM buffer via depositBuffer if short
 *                             (needs PSM_BUFFER_DEPOSITOR; reverts while the PSM
 *                             is paused) + user redeem; assert USDC delta.
 *    7. setOkuMYieldRate      OkuMoney.setOkuMYieldRate (rate derived from an APY
 *                             via utils/yieldRate) + setNextOkuMYieldRate; assert
 *                             the schedule fields, not a discrete multiplier bump.
 *    8. pause                 psm.pause -> assert mint reverts -> unpause ->
 *                             assert mint succeeds.
 *    9. configureMinterAllowance
 *                             Rotate LitePSM allowance through
 *                             current -> halve -> restore; assert post-state.
 *
 * Usage:
 *   # Run the full suite against a live testnet
 *   NETWORK=baseSepolia npx hardhat run scripts/test/test-onchain.ts --network baseSepolia
 *
 *   # Run a single step (any of the names above)
 *   NETWORK=baseSepolia npx hardhat run scripts/test/test-onchain.ts \
 *       --network baseSepolia -- --step=mint
 *
 *   # Run on a fork (auto-detects chain from running fork; impersonates DEPLOYER)
 *   NETWORK=baseSepolia npx hardhat run scripts/test/test-onchain.ts --network localhost
 *
 * Environment:
 *   STEP=<name>          alternative to --step=<name>
 *   USDC_AMOUNT=<6dec>   override the per-test USDC notional (default 100 USDC)
 *   DRY_RUN=true         simulate only (currently honored by mainnetGuard)
 */

import { ethers, network as hhNetwork } from "hardhat";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress, hasAddress, resolveUsdcAddress } from "../utils/addressBook";
import { getDeployedContract, waitForTx } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { ROLES } from "../config/roles";
import { DEV_WALLET_ADDRESS } from "../config/chains";
import { apyToRatePerSecond, describeRate, PRECISION } from "../utils/yieldRate";
import { computeMultiplier } from "@okumoney/yield-tooling";
import {
  EPOCH_ANCHOR_UNIX,
  EPOCH_LENGTH_SECONDS,
} from "../config/epoch";
import { isDryRun } from "../utils/cli";

/** Seconds to observe real accrual in step 7 (override: ACCRUAL_OBSERVE_SEC). */
const ACCRUAL_OBSERVE_SEC = Number(process.env.ACCRUAL_OBSERVE_SEC ?? "20");

/**
 * The next epoch boundary on the declared grid, strictly in the future.
 * Chain-independent, so per-chain runs within one epoch converge on the same
 * absolute `rateEnd`.
 */
function nextEpochBoundarySec(): bigint {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - EPOCH_ANCHOR_UNIX;
  const nextIndex = Math.floor(elapsed / EPOCH_LENGTH_SECONDS) + 1;
  return BigInt(EPOCH_ANCHOR_UNIX + nextIndex * EPOCH_LENGTH_SECONDS);
}

/**
 * Read `okuMMultiplier()` and its block timestamp pinned to the same block, so
 * a block landing between two separate reads cannot skew the comparison.
 */
async function multiplierAtChainTime(
  okuMoney: any
): Promise<{ multiplier: bigint; timestampSec: bigint; blockNumber: number }> {
  const blk = await ethers.provider.getBlock("latest");
  if (!blk) throw new Error("could not read latest block");
  const multiplier: bigint = await okuMoney.okuMMultiplier({ blockTag: blk.number });
  return { multiplier, timestampSec: BigInt(blk.timestamp), blockNumber: blk.number };
}

// ============================================================================
// CLI / env helpers
// ============================================================================

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

const STEP = parseArg("step") ?? process.env.STEP;
const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = isDryRun();

const DEFAULT_USDC_AMOUNT = process.env.USDC_AMOUNT ?? "100"; // 100 USDC (6 decimals)

// ============================================================================
// Shared test context
// ============================================================================

interface TestCtx {
  netCtx: NetworkContext;
  user: any; // signer (deployer/dev wallet)
  usdc: any;
  okuMoney: any;
  okuDollar: any;
  litePSM: any;
  hasMockUsdc: boolean;
}

async function setupCtx(): Promise<TestCtx> {
  const netCtx = await resolveNetworkContext();
  logger.header(
    `test-onchain (${netCtx.networkName}${netCtx.isFork ? " · fork" : ""})`
  );
  mainnetGuard(netCtx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  if (!hasAddress(netCtx.bookKey, "OkuMoney")) {
    throw new Error(
      `No deployment found under address book key "${netCtx.bookKey}".\n` +
        (netCtx.isFork
          ? "  This is a fork run; deploy on the fork first: " +
            "`npx hardhat run scripts/deploy/index.ts --network localhost`"
          : `  No live deployment recorded for "${netCtx.networkName}".`)
    );
  }

  const usdcAddr = resolveUsdcAddress(netCtx.bookKey);
  const okuMoneyAddr = loadAddress(netCtx.bookKey, "OkuMoney");
  const okuDollarAddr = loadAddress(netCtx.bookKey, "OkuDollar");
  const litePSMAddr = loadAddress(netCtx.bookKey, "LitePSM");

  logger.info(`USDC:            ${usdcAddr}`);
  logger.info(`OkuMoney:        ${okuMoneyAddr}`);
  logger.info(`OkuDollar:       ${okuDollarAddr}`);
  logger.info(`LitePSM:         ${litePSMAddr}`);

  const [user] = await ethers.getSigners();
  logger.info(`Signer: ${user.address}`);

  const usdc = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function mint(address,uint256)",
    ],
    usdcAddr
  );
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddr);
  const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddr);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddr);

  // Fork-only bootstrap: a fork may lack the LitePSM minter allowance.
  if (netCtx.isFork) {
    await healForkRoles(litePSM, okuMoney);
  }

  return {
    netCtx,
    user,
    usdc,
    okuMoney,
    okuDollar,
    litePSM,
    hasMockUsdc: hasAddress(netCtx.bookKey, "MockUSDC"),
  };
}

async function healForkRoles(
  litePSM: any,
  okuMoney: any
): Promise<void> {
  const litePSMAddr = await litePSM.getAddress();
  const currentAllowance: bigint = await okuMoney.minterAllowance(litePSMAddr);
  if (currentAllowance > 0n) {
    logger.info("Fork already has minter allowance configured; skipping heal.");
    return;
  }

  logger.warning("Fork detected with zero minter allowance — bootstrapping via impersonation.");
  await hhNetwork.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({
    to: DEV_WALLET_ADDRESS,
    value: ethers.parseEther("1"),
  });
  const deployer = await ethers.getSigner(DEV_WALLET_ADDRESS);
  const okuMAsDep = okuMoney.connect(deployer);

  if (!(await okuMAsDep.hasRole(ROLES.OKUM_ALLOWANCE_MANAGER, DEV_WALLET_ADDRESS))) {
    await waitForTx(
      await okuMAsDep.grantRole(ROLES.OKUM_ALLOWANCE_MANAGER, DEV_WALLET_ADDRESS),
      "Grant OKUM_ALLOWANCE_MANAGER (fork)"
    );
  }

  const billion = ethers.parseUnits("1000000000", 18);
  await waitForTx(
    await okuMAsDep.configureMinterAllowance(litePSMAddr, billion),
    "configureMinterAllowance(LitePSM, 1B)"
  );

  await hhNetwork.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  logger.success("Fork heal complete.");
}

async function ensureUsdc(ctx: TestCtx, amount: bigint): Promise<void> {
  const bal: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  if (bal >= amount) return;
  if (!ctx.hasMockUsdc) {
    throw new Error(
      `Insufficient USDC for signer: have ${bal}, need ${amount}, and ` +
        `no MockUSDC.mint available on this chain.`
    );
  }
  const short = amount - bal;
  await waitForTx(
    await ctx.usdc.mint(ctx.user.address, short),
    `MockUSDC.mint(${ethers.formatUnits(short, 6)} USDC)`
  );
}

async function ensureRole(ctx: TestCtx, role: string, label: string) {
  const has: boolean = await ctx.okuMoney.hasRole(role, ctx.user.address);
  if (has) return;
  if (!ctx.netCtx.isFork) {
    throw new Error(
      `Signer ${ctx.user.address} is missing role ${label} (${role}) on live ` +
        `${ctx.netCtx.networkName}. Grant it via scripts/operator/grantRoles.ts first.`
    );
  }
  // Fork: impersonate dev wallet (admin) and grant.
  logger.warning(`Granting ${label} on fork via impersonation.`);
  await hhNetwork.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({ to: DEV_WALLET_ADDRESS, value: ethers.parseEther("0.5") });
  const admin = await ethers.getSigner(DEV_WALLET_ADDRESS);
  await waitForTx(
    await ctx.okuMoney.connect(admin).grantRole(role, ctx.user.address),
    `grantRole(${label}, signer)`
  );
  await hhNetwork.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEV_WALLET_ADDRESS],
  });
}

async function ensurePsmRole(ctx: TestCtx, role: string, label: string) {
  const has: boolean = await ctx.litePSM.hasRole(role, ctx.user.address);
  if (has) return;
  if (!ctx.netCtx.isFork) {
    throw new Error(
      `Signer ${ctx.user.address} is missing role ${label} (${role}) on LitePSM ` +
        `on live ${ctx.netCtx.networkName}. Grant via grantRoles.ts.`
    );
  }
  logger.warning(`Granting LitePSM ${label} on fork via impersonation.`);
  await hhNetwork.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({ to: DEV_WALLET_ADDRESS, value: ethers.parseEther("0.5") });
  const admin = await ethers.getSigner(DEV_WALLET_ADDRESS);
  await waitForTx(
    await ctx.litePSM.connect(admin).grantRole(role, ctx.user.address),
    `LitePSM.grantRole(${label}, signer)`
  );
  await hhNetwork.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEV_WALLET_ADDRESS],
  });
}

// ============================================================================
// Step implementations
// ============================================================================

async function stepState(ctx: TestCtx) {
  logger.section("Step 1: state");

  const okuMSupply: bigint = await ctx.okuMoney.totalSupply();
  const okuMMaxSupply: bigint = await ctx.okuMoney.maxSupply();
  const psmAddr = await ctx.litePSM.getAddress();
  const psmAllowance: bigint = await ctx.okuMoney.minterAllowance(psmAddr);
  const multiplier: bigint = await ctx.okuMoney.okuMMultiplier();
  const okuMPaused: boolean = await ctx.okuMoney.paused();

  const usdoSupply: bigint = await ctx.okuDollar.totalSupply();
  const usdoPaused: boolean = await ctx.okuDollar.paused();

  const psmUsdcBuf: bigint = await ctx.usdc.balanceOf(psmAddr);
  const psmPaused: boolean = await ctx.litePSM.paused();

  logger.info(`OkuMoney:`);
  logger.info(`  totalSupply: ${ethers.formatUnits(okuMSupply, 18)}`);
  logger.info(`  maxSupply:   ${ethers.formatUnits(okuMMaxSupply, 18)}`);
  logger.info(`  multiplier:  ${multiplier}`);
  logger.info(`  paused:      ${okuMPaused}`);
  logger.info(`  PSM allowance: ${ethers.formatUnits(psmAllowance, 18)}`);
  logger.info(`OkuDollar:`);
  logger.info(`  totalSupply: ${ethers.formatUnits(usdoSupply, 18)}`);
  logger.info(`  paused:      ${usdoPaused}`);
  logger.info(`LitePSM:`);
  logger.info(`  USDC buffer:   ${ethers.formatUnits(psmUsdcBuf, 6)}`);
  logger.info(`  paused:        ${psmPaused}`);
}

async function stepMint(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 2: mint");
  const usdcAmount = ethers.parseUnits(DEFAULT_USDC_AMOUNT, 6);
  await ensureUsdc(ctx, usdcAmount);

  const psmAddr = await ctx.litePSM.getAddress();
  const okuMBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);

  await waitForTx(await ctx.usdc.approve(psmAddr, usdcAmount), "usdc.approve(LitePSM)");
  await waitForTx(await ctx.litePSM.mintOkuM(usdcAmount), `LitePSM.mintOkuM(${DEFAULT_USDC_AMOUNT})`);

  // Load-balanced RPCs can serve a stale read right after `tx.wait()`; poll
  // instead of asserting on a single read.
  const minted = await pollBalanceDelta(
    () => ctx.okuMoney.balanceOf(ctx.user.address),
    okuMBefore,
    /* maxMs */ 30_000
  );
  logger.success(`Minted ${ethers.formatUnits(minted, 18)} OkuM`);
  if (minted === 0n) throw new Error("mint produced zero OkuM");

  // EXACT check: OkuM minted must equal the USDC paid, valued at the current
  // multiplier. `!= 0` alone would pass a PSM that silently retained 99.99% of
  // the deposit, or one with mint/divide inverted in its pricing.
  const multNow: bigint = await ctx.okuMoney.okuMMultiplier();
  const expectedOkuM = (usdcAmount * 10n ** 12n * PRECISION) / multNow;
  const mintDrift = minted > expectedOkuM ? minted - expectedOkuM : expectedOkuM - minted;
  const mintTolerance = expectedOkuM / 1_000_000n + 1n; // 1 ppm + rounding
  if (mintDrift > mintTolerance) {
    throw new Error(
      `mint produced ${minted} OkuM but ${usdcAmount} USDC-units at multiplier ${multNow} ` +
        `implies ${expectedOkuM} (drift=${mintDrift}, tolerance=${mintTolerance}). PSM mint pricing is wrong.`
    );
  }
  logger.success(`Mint amount matches multiplier-implied value (drift ${mintDrift} wei)`);
  return minted;
}

async function stepTransfer(ctx: TestCtx) {
  logger.section("Step 3: transfer");
  // Fixed recipient derived from a seed (no key exists): each run's ~1% lands
  // in one place instead of stranding OkuM on a fresh random address.
  const recipient = ethers.computeAddress(
    ethers.keccak256(ethers.toUtf8Bytes("okumoney-test-onchain-recipient-v1"))
  );
  // Poll for non-zero balance — BSC testnet RPCs can lag a block after mint.
  let balBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (balBefore === 0n) {
    logger.info("Waiting for OkuM balance to propagate...");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      balBefore = await ctx.okuMoney.balanceOf(ctx.user.address);
      if (balBefore > 0n) break;
    }
  }
  if (balBefore === 0n) {
    throw new Error("Signer has zero OkuM; run mint step before transfer.");
  }
  const amt = balBefore / 100n; // 1% of current balance
  if (amt === 0n) throw new Error("Transfer amount rounded to zero");

  // The fixed recipient may hold OkuM from prior runs: assert the delta.
  const recipBalBefore: bigint = await ctx.okuMoney.balanceOf(recipient);

  await waitForTx(
    await ctx.okuMoney.transfer(recipient, amt),
    `okuMoney.transfer(${ethers.formatUnits(amt, 18)} OkuM -> ${recipient})`
  );
  // Poll for the delta (RPC read-replica lag, see stepMint).
  const recipDelta: bigint = await pollBalanceDelta(
    () => ctx.okuMoney.balanceOf(recipient),
    recipBalBefore,
    /* maxMs */ 30_000
  );
  const balAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  logger.info(`Recipient OkuM delta: ${ethers.formatUnits(recipDelta, 18)}`);
  logger.info(`Signer OkuM:     ${ethers.formatUnits(balAfter, 18)} (delta -${ethers.formatUnits(balBefore - balAfter, 18)})`);
  // Exact equality, no tolerance: OkuM is a static-balance, non-rebasing ERC-20,
  // so `transfer` has no multiplier in its path.
  if (recipDelta !== amt) {
    throw new Error(
      `Recipient's balance moved by ${recipDelta}, expected exactly ${amt}. OkuM is ` +
        `non-rebasing — a transfer must move the exact amount with zero drift.`
    );
  }
  if (balBefore - balAfter !== amt) {
    throw new Error(
      `Sender debited ${balBefore - balAfter}, expected exactly ${amt} ` +
        `(before=${balBefore}, after=${balAfter}).`
    );
  }
  logger.success("Transfer moved the exact amount on both sides (non-rebasing, zero drift)");
}

async function stepWrap(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 4: wrap");
  const okuMBal: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to wrap; run mint first.");
  const half = okuMBal / 2n;

  const okuDollarAddr = await ctx.okuDollar.getAddress();
  const usdoBefore: bigint = await ctx.okuDollar.balanceOf(ctx.user.address);

  await waitForTx(await ctx.okuMoney.approve(okuDollarAddr, half), "okuMoney.approve(OkuDollar)");
  // BSC RPCs can lag — poll until the allowance is visible before calling wrap.
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const allowance: bigint = await ctx.okuMoney.allowance(ctx.user.address, okuDollarAddr);
      if (allowance >= half) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await waitForTx(
    await ctx.okuDollar.wrap(half, ctx.user.address, 0n),
    `okuDollar.wrap(${ethers.formatUnits(half, 18)} OkuM)`
  );

  // Poll rather than single-read — see stepMint for why.
  const minted = await pollBalanceDelta(
    () => ctx.okuDollar.balanceOf(ctx.user.address),
    usdoBefore,
    /* maxMs */ 30_000
  );
  logger.success(`Received ${ethers.formatUnits(minted, 18)} usdOku`);
  if (minted === 0n) throw new Error("wrap produced zero usdOku");
  return minted;
}

async function stepUnwrap(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 5: unwrap");
  const usdoBal: bigint = await ctx.okuDollar.balanceOf(ctx.user.address);
  if (usdoBal === 0n) throw new Error("No usdOku to unwrap; run wrap first.");
  const half = usdoBal / 2n;

  const okuMBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  await waitForTx(
    await ctx.okuDollar.unwrap(half, ctx.user.address),
    `okuDollar.unwrap(${ethers.formatUnits(half, 18)} usdOku)`
  );
  // Poll for balance change — load-balanced RPCs can return stale reads.
  let returned = 0n;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const okuMAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
    returned = okuMAfter - okuMBefore;
    if (returned > 0n) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  logger.success(`Received ${ethers.formatUnits(returned, 18)} OkuM`);
  if (returned === 0n) throw new Error("unwrap produced zero OkuM");
  return returned;
}

async function ensureBufferFunded(ctx: TestCtx, minBuffer: bigint) {
  const psmAddr = await ctx.litePSM.getAddress();
  const buf: bigint = await ctx.usdc.balanceOf(psmAddr);
  if (buf >= minBuffer) return;

  const short = minBuffer - buf;
  logger.info(`Buffer short by ${ethers.formatUnits(short, 6)} USDC; topping up.`);

  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_DEPOSITOR, "PSM_BUFFER_DEPOSITOR");
  await ensureUsdc(ctx, short);

  await waitForTx(await ctx.usdc.approve(psmAddr, short), "usdc.approve(LitePSM) [buffer]");
  await waitForTx(
    await ctx.litePSM.depositBuffer(short),
    `LitePSM.depositBuffer(${ethers.formatUnits(short, 6)} USDC)`
  );
}

async function stepRedeem(ctx: TestCtx) {
  logger.section("Step 6: redeem");
  const okuMBal: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to redeem; run mint first.");
  const amt = okuMBal / 4n;
  if (amt === 0n) throw new Error("Redeem amount rounded to zero");

  // The buffer must cover the redeem (else InsufficientBuffer); size it at 2x
  // the USDC equivalent to absorb multiplier drift.
  const usdcEquiv = (amt * (await ctx.okuMoney.okuMMultiplier())) / 10n ** 30n; // 18 + 12 = 30
  await ensureBufferFunded(ctx, usdcEquiv * 2n);

  const psmAddr = await ctx.litePSM.getAddress();
  const usdcBefore: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  await waitForTx(await ctx.okuMoney.approve(psmAddr, amt), "okuMoney.approve(LitePSM)");
  await waitForTx(
    await ctx.litePSM.redeemOkuM(amt),
    `LitePSM.redeemOkuM(${ethers.formatUnits(amt, 18)} OkuM)`
  );
  // Poll: public RPCs can lag a block before the new balance is visible.
  const received = await pollBalanceDelta(
    () => ctx.usdc.balanceOf(ctx.user.address),
    usdcBefore,
    /* maxMs */ 30_000
  );
  logger.success(`Received ${ethers.formatUnits(received, 6)} USDC`);
  if (received === 0n) throw new Error("redeem returned zero USDC");

  // `usdcEquiv` is the expected payout (same multiplier and /1e30 scaling as
  // `MathLib.dollarsToUsdc`). Tolerance covers the floor plus accrual between
  // the sizing read and the redeem landing.
  const redeemDrift = received > usdcEquiv ? received - usdcEquiv : usdcEquiv - received;
  const redeemTolerance = usdcEquiv / 1_000_000n + 2n; // 1 ppm of notional + floor/rounding
  if (redeemDrift > redeemTolerance) {
    throw new Error(
      `redeem paid ${received} USDC-units but the multiplier implies ${usdcEquiv} ` +
        `(drift=${redeemDrift}, tolerance=${redeemTolerance}). PSM redeem pricing is wrong.`
    );
  }
  logger.success(`Redeem payout matches multiplier-implied value (drift ${redeemDrift} units)`);
}

/**
 * Poll `read()` every 1s for up to `maxMs` until the returned bigint differs
 * from `baseline`. Returns the absolute delta (final - baseline). If the
 * value never changes, returns 0 after the timeout.
 */
async function pollBalanceDelta(
  read: () => Promise<bigint>,
  baseline: bigint,
  maxMs: number
): Promise<bigint> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const cur = await read();
    if (cur !== baseline) return cur - baseline;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await read()) - baseline;
}

async function stepSetOkuMYieldRate(ctx: TestCtx) {
  logger.section("Step 7: setOkuMYieldRate");
  // Yield is a streaming rate, not a discrete bump, so the deterministic
  // post-conditions are the schedule fields.
  await ensureRole(ctx, ROLES.OKUM_RATE_MANAGER, "OKUM_RATE_MANAGER");

  const rate = apyToRatePerSecond(0.03); // 3% APY
  // Snap to the epoch grid, not `now + 86400`: the suite runs once per chain,
  // and the design is byte-identical `rateEnd` on every chain (a wall-clock
  // deadline makes checkMultiplierDrift.ts report RATE-END MISMATCH).
  const endTimestamp = nextEpochBoundarySec();

  const mBefore: bigint = await ctx.okuMoney.okuMMultiplier();
  const rateBefore: bigint = await ctx.okuMoney.okuMRatePerSecond();

  await waitForTx(
    await ctx.okuMoney.setOkuMYieldRate(rate, endTimestamp),
    `okuMoney.setOkuMYieldRate(${describeRate(rate)}, end=${endTimestamp})`
  );

  const [rateAfter, endAfter, baseAfter, pendingAfter, mAfter]: bigint[] = await Promise.all([
    ctx.okuMoney.okuMRatePerSecond(),
    ctx.okuMoney.okuMRateEnd(),
    ctx.okuMoney.okuMBaseMultiplier(),
    ctx.okuMoney.okuMPendingRatePerSecond(),
    ctx.okuMoney.okuMMultiplier(),
  ]);

  logger.info(`Rate:       ${describeRate(rateBefore)} -> ${describeRate(rateAfter)}`);
  logger.info(`Rate end:   ${endAfter} (${new Date(Number(endAfter) * 1000).toISOString()})`);
  logger.info(`Multiplier: ${mBefore} -> ${mAfter} (base re-anchored to ${baseAfter})`);

  if (rateAfter !== rate) throw new Error(`okuMRatePerSecond is ${rateAfter}, expected ${rate}`);
  if (endAfter !== endTimestamp) throw new Error(`okuMRateEnd is ${endAfter}, expected ${endTimestamp}`);
  // setOkuMYieldRate re-anchors the base to the current multiplier and clears
  // any armed successor, so the curve is continuous across the write. The
  // `mAfter >= mBefore` check is only a cheap corruption canary.
  if (mAfter < mBefore) throw new Error(`Multiplier went backwards: ${mBefore} -> ${mAfter}`);
  if (baseAfter < mBefore) {
    throw new Error(`Base multiplier ${baseAfter} re-anchored BELOW the pre-write multiplier ${mBefore}`);
  }
  if (pendingAfter !== PRECISION) {
    throw new Error(`Pending rate not cleared: ${pendingAfter}, expected ${PRECISION}`);
  }
  logger.success("Yield rate schedule written and verified");

  // Live differential: on-chain Solidity vs the TS mirror. The offline corpus in
  // `EVM/test/differential` cannot catch a stale implementation, corrupted
  // storage or a bad upgrade on one specific deployment; this reads the
  // schedule from the live contract and evaluates the mirror at the same instant.
  const anchorSec: bigint = await ctx.okuMoney.okuMLastAccrualTime();
  const pendingEnd0: bigint = await ctx.okuMoney.okuMPendingRateEnd();
  const { multiplier: onChain, timestampSec: evalAt } = await multiplierAtChainTime(ctx.okuMoney);
  const mirrored = computeMultiplier(
    {
      baseMultiplier: baseAfter,
      ratePerSecond: rateAfter,
      lastAccrualTime: anchorSec,
      rateEnd: endAfter,
      pendingRatePerSecond: pendingAfter,
      pendingRateEnd: pendingEnd0,
    },
    evalAt
  );
  logger.info(`Differential: on-chain=${onChain} mirror@${evalAt}=${mirrored}`);
  // Same block on both sides: allow 1 wei of integer rounding only.
  const diff = onChain > mirrored ? onChain - mirrored : mirrored - onChain;
  if (diff > 1n) {
    throw new Error(
      `LIVE DIFFERENTIAL FAILED: on-chain okuMMultiplier()=${onChain} vs TS mirror=${mirrored} ` +
        `(diff=${diff}, both pinned to block ${evalAt}). The deployed Solidity and the ` +
        `TypeScript reference disagree about this chain's multiplier — the orchestrator's ` +
        `V(t) and every cross-chain rate derived from it would be wrong for this chain.`
    );
  }
  logger.success(`Live differential OK (on-chain Solidity == TS mirror within 1s of accrual)`);

  // Observed accrual: wait real chain time and require the multiplier to advance
  // by what the published rate implies.
  const { multiplier: m0, timestampSec: t0 } = await multiplierAtChainTime(ctx.okuMoney);
  if (ctx.netCtx.isFork) {
    // A fork's clock only moves when it mines, so warp it instead of sleeping.
    logger.info(`Advancing fork clock by ${ACCRUAL_OBSERVE_SEC}s (no real wait on a fork)...`);
    await hhNetwork.provider.send("evm_increaseTime", [ACCRUAL_OBSERVE_SEC]);
    await hhNetwork.provider.send("evm_mine", []);
  } else {
    logger.info(`Observing accrual for ${ACCRUAL_OBSERVE_SEC}s at ${describeRate(rateAfter)}...`);
    await new Promise((r) => setTimeout(r, ACCRUAL_OBSERVE_SEC * 1000));
  }
  const { multiplier: m1, timestampSec: t1 } = await multiplierAtChainTime(ctx.okuMoney);

  const elapsed = t1 - t0;
  if (elapsed <= 0n) {
    throw new Error(`Chain time did not advance during the accrual window (t0=${t0}, t1=${t1})`);
  }
  const expected = computeMultiplier(
    {
      baseMultiplier: baseAfter,
      ratePerSecond: rateAfter,
      lastAccrualTime: anchorSec,
      rateEnd: endAfter,
      pendingRatePerSecond: pendingAfter,
      pendingRateEnd: pendingEnd0,
    },
    t1
  );
  logger.info(
    `Accrual over ${elapsed}s: ${m0} -> ${m1} (expected ${expected} at t=${t1})`
  );
  if (m1 <= m0) {
    throw new Error(
      `ACCRUAL DEAD: multiplier did not advance over ${elapsed}s of real chain time ` +
        `at ${describeRate(rateAfter)} (${m0} -> ${m1}). Yield is not streaming on this chain.`
    );
  }
  // `m1`, `t1` share a block, so the comparison is exact up to 1 wei of rounding.
  const accrualDiff = m1 > expected ? m1 - expected : expected - m1;
  if (accrualDiff > 1n) {
    throw new Error(
      `ACCRUAL RATE WRONG: after ${elapsed}s the multiplier is ${m1}, but the published ` +
        `schedule implies ${expected} (diff=${accrualDiff}). The chain is accruing at a ` +
        `different rate than the one published.`
    );
  }
  logger.success(`Observed accrual matches the published rate over ${elapsed}s of real chain time`);

  // Stage a successor rate off the bounded window just set. It activates off the
  // absolute okuMRateEnd timestamp with no tx at the boundary. pendingEndTimestamp
  // bounds how long the successor itself can compound unattended.
  const nextRate = apyToRatePerSecond(0.0325); // 3.25% APY
  const pendingEndTimestamp = endAfter + 86_400n; // +1 day past its own activation
  await waitForTx(
    await ctx.okuMoney.setNextOkuMYieldRate(nextRate, pendingEndTimestamp),
    `okuMoney.setNextOkuMYieldRate(${describeRate(nextRate)}, pendingEnd=${pendingEndTimestamp})`
  );
  const staged: bigint = await ctx.okuMoney.okuMPendingRatePerSecond();
  if (staged !== nextRate) throw new Error(`Staged rate is ${staged}, expected ${nextRate}`);
  logger.success(`Successor rate staged, activates at ${new Date(Number(endAfter) * 1000).toISOString()}`);
}

async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  maxMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + maxMs;
  let last: T = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await read();
  }
  if (!predicate(last)) {
    throw new Error(`pollUntil(${label}) timed out; last value=${String(last)}`);
  }
  return last;
}

async function stepPause(ctx: TestCtx) {
  logger.section("Step 8: pause / unpause");
  await ensurePsmRole(ctx, ROLES.PSM_PAUSER, "PSM_PAUSER");
  await ensurePsmRole(ctx, ROLES.PSM_UNPAUSER, "PSM_UNPAUSER");

  const pausedBefore: boolean = await ctx.litePSM.paused();
  if (pausedBefore) {
    logger.warning("LitePSM already paused; will unpause then re-test.");
    await waitForTx(await ctx.litePSM.unpause(), "LitePSM.unpause (pre-test cleanup)");
    await pollUntil<boolean>(
      () => ctx.litePSM.paused(),
      (v) => v === false,
      30_000,
      "pre-test unpause"
    );
  }

  await waitForTx(await ctx.litePSM.pause(), "LitePSM.pause");
  await pollUntil<boolean>(
    () => ctx.litePSM.paused(),
    (v) => v === true,
    30_000,
    "pause"
  );
  logger.success("Confirmed paused=true on chain");

  // Verify mint reverts while paused — with the SPECIFIC reason, not "it threw".
  const usdcAmount = ethers.parseUnits("1", 6);
  await ensureUsdc(ctx, usdcAmount);
  const psmAddr = await ctx.litePSM.getAddress();
  // The approve must be mined (waitForTx), or the staticCall below can revert
  // with ERC20InsufficientAllowance instead of the pause check.
  await waitForTx(
    await ctx.usdc.approve(psmAddr, usdcAmount),
    "usdc.approve(LitePSM) [pause check]"
  );
  let revertReason = "";
  try {
    await ctx.litePSM.mintOkuM.staticCall(usdcAmount);
  } catch (e: any) {
    // Decode the custom error so only the pause revert counts, not any failure.
    const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
    if (data) {
      try {
        const parsed = ctx.litePSM.interface.parseError(data);
        revertReason = parsed?.name ?? "";
      } catch {
        // Non-custom-error revert shape; fall through to the raw message.
      }
    }
    if (!revertReason) revertReason = e?.shortMessage ?? e?.reason ?? e?.message ?? String(e);
  }
  if (!revertReason) throw new Error("mintOkuM did not revert while paused");
  if (!/EnforcedPause/i.test(revertReason)) {
    throw new Error(
      `mintOkuM reverted while paused, but with "${revertReason}" — expected EnforcedPause. ` +
        `A different reason means the pause gate was not what reverted.`
    );
  }
  logger.success(`Confirmed mintOkuM reverts with EnforcedPause while paused`);

  await waitForTx(await ctx.litePSM.unpause(), "LitePSM.unpause");
  await pollUntil<boolean>(
    () => ctx.litePSM.paused(),
    (v) => v === false,
    30_000,
    "unpause"
  );
  logger.success("Confirmed LitePSM paused state cycles cleanly");
}

async function stepConfigureMinterAllowance(ctx: TestCtx) {
  logger.section("Step 9: configureMinterAllowance (rotate)");
  await ensureRole(ctx, ROLES.OKUM_ALLOWANCE_MANAGER, "OKUM_ALLOWANCE_MANAGER");

  const psmAddr = await ctx.litePSM.getAddress();
  const before: bigint = await ctx.okuMoney.minterAllowance(psmAddr);
  const halved = before / 2n;
  if (halved === 0n) {
    logger.warning(`Current allowance is ${before}; cannot halve below 1. Skipping rotation.`);
    return;
  }

  await waitForTx(
    await ctx.okuMoney.configureMinterAllowance(psmAddr, halved),
    `configureMinterAllowance(LitePSM, ${ethers.formatUnits(halved, 18)})`
  );
  await pollUntil<bigint>(
    () => ctx.okuMoney.minterAllowance(psmAddr),
    (v) => v === halved,
    30_000,
    "allowance halved"
  );
  await waitForTx(
    await ctx.okuMoney.configureMinterAllowance(psmAddr, before),
    `configureMinterAllowance(LitePSM, ${ethers.formatUnits(before, 18)}) [restore]`
  );
  await pollUntil<bigint>(
    () => ctx.okuMoney.minterAllowance(psmAddr),
    (v) => v === before,
    30_000,
    "allowance restored"
  );
  logger.success("Allowance rotation cycle complete");
}

// ============================================================================
// Runner
// ============================================================================

const STEPS: Record<string, (ctx: TestCtx) => Promise<unknown>> = {
  state: stepState,
  mint: stepMint,
  transfer: stepTransfer,
  wrap: stepWrap,
  unwrap: stepUnwrap,
  redeem: stepRedeem,
  setOkuMYieldRate: stepSetOkuMYieldRate,
  pause: stepPause,
  configureMinterAllowance: stepConfigureMinterAllowance,
};

const STEP_ORDER = [
  "state",
  "mint",
  "transfer",
  "wrap",
  "unwrap",
  "redeem",
  "setOkuMYieldRate",
  "pause",
  "configureMinterAllowance",
];

async function main() {
  const ctx = await setupCtx();

  if (STEP) {
    const fn = STEPS[STEP];
    if (!fn) {
      throw new Error(
        `Unknown step "${STEP}". Available: ${Object.keys(STEPS).join(", ")}`
      );
    }
    await fn(ctx);
    return;
  }

  for (const name of STEP_ORDER) {
    await STEPS[name](ctx);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    console.error(e);
    process.exit(1);
  });
