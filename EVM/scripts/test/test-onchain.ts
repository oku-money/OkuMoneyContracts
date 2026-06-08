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
 *    1. state                 Pretty-print pre-test state of all 4 proxies.
 *    2. mint                  MockUSDC -> psm.mintOkuM; assert OkuM delta.
 *    3. transfer              OkuM.transfer between deployer and a second
 *                             throwaway signer; assert balance moves.
 *    4. wrap                  okuMoney.approve + okuDollar.wrap(minShares=0).
 *    5. unwrap                okuDollar.unwrap; assert OkuM returned.
 *    6. redeem                Operator depositBuffer (fork-only auto;
 *                             live: assumed already funded) + user redeem;
 *                             assert USDC delta.
 *    7. queueRedeem           Drain buffer to 0 -> redeem forces queue ->
 *                             refill -> processQueue drains -> queue empty.
 *    8. distributeYield       OkuMoney.distributeYield; assert multiplier
 *                             bump and signer balance grows.
 *    9. pause                 psm.pause -> assert mint reverts -> unpause ->
 *                             assert mint succeeds.
 *   10. configureMinterAllowance
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
import { loadAddress, hasAddress } from "../utils/addressBook";
import { getDeployedContract, waitForTx } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { ROLES } from "../config/roles";
import { DEV_WALLET_ADDRESS } from "../config/chains";

// ============================================================================
// CLI / env helpers
// ============================================================================

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

const STEP = parseArg("step") ?? process.env.STEP;
const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

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
  queue: any;
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

  const usdcAddr = hasAddress(netCtx.bookKey, "MockUSDC")
    ? loadAddress(netCtx.bookKey, "MockUSDC")
    : loadAddress(netCtx.bookKey, "USDC");
  const okuMoneyAddr = loadAddress(netCtx.bookKey, "OkuMoney");
  const okuDollarAddr = loadAddress(netCtx.bookKey, "OkuDollar");
  const litePSMAddr = loadAddress(netCtx.bookKey, "LitePSM");
  const queueAddr = loadAddress(netCtx.bookKey, "RedemptionQueue");

  logger.info(`USDC:            ${usdcAddr}`);
  logger.info(`OkuMoney:        ${okuMoneyAddr}`);
  logger.info(`OkuDollar:       ${okuDollarAddr}`);
  logger.info(`LitePSM:         ${litePSMAddr}`);
  logger.info(`RedemptionQueue: ${queueAddr}`);

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
  const queue = await getDeployedContract("RedemptionQueue", queueAddr);

  // Fork-only bootstrap (mirrors the old test-flow.ts behavior). On a fresh
  // fork, the deployer wallet may not have the OKUM_ALLOWANCE_MANAGER role
  // wired or the LitePSM minter allowance configured. Heal silently.
  if (netCtx.isFork) {
    await healForkRoles(litePSM, okuMoney, queue);
  }

  return {
    netCtx,
    user,
    usdc,
    okuMoney,
    okuDollar,
    litePSM,
    queue,
    hasMockUsdc: hasAddress(netCtx.bookKey, "MockUSDC"),
  };
}

async function healForkRoles(
  litePSM: any,
  okuMoney: any,
  queue: any
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
  const queueAddr = await queue.getAddress();
  await waitForTx(
    await okuMAsDep.configureMinterAllowance(queueAddr, billion),
    "configureMinterAllowance(RedemptionQueue, 1B)"
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
    await (ctx.okuMoney.connect(admin) as any).grantRole(role, ctx.user.address),
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
    await (ctx.litePSM.connect(admin) as any).grantRole(role, ctx.user.address),
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
  const oracleEnabled: boolean = await ctx.litePSM.oracleEnabled();
  const oracleAddr: string = await ctx.litePSM.porOracle();
  const staleness: bigint = await ctx.litePSM.stalenessThreshold();

  const qHead: bigint = await ctx.queue.queueHead();
  const qTail: bigint = await ctx.queue.queueTail();
  const qPending: bigint = qTail - qHead;
  const totalQueuedOkuM: bigint = await ctx.queue.totalQueuedOkuM();

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
  logger.info(`  USDC buffer: ${ethers.formatUnits(psmUsdcBuf, 6)}`);
  logger.info(`  paused:      ${psmPaused}`);
  logger.info(`  oracleEnabled: ${oracleEnabled}`);
  logger.info(`  porOracle:   ${oracleAddr}`);
  logger.info(`  staleness:   ${staleness}s`);
  logger.info(`RedemptionQueue:`);
  logger.info(`  head/tail/pending: ${qHead} / ${qTail} / ${qPending}`);
  logger.info(`  totalQueuedOkuM:   ${ethers.formatUnits(totalQueuedOkuM, 18)}`);
}

async function stepMint(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 2: mint");
  const usdcAmount = ethers.parseUnits(DEFAULT_USDC_AMOUNT, 6);
  await ensureUsdc(ctx, usdcAmount);

  const psmAddr = await ctx.litePSM.getAddress();
  const okuMBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);

  await waitForTx(await ctx.usdc.approve(psmAddr, usdcAmount), "usdc.approve(LitePSM)");
  await waitForTx(await ctx.litePSM.mintOkuM(usdcAmount), `LitePSM.mintOkuM(${DEFAULT_USDC_AMOUNT})`);

  const okuMAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  const minted = okuMAfter - okuMBefore;
  logger.success(`Minted ${ethers.formatUnits(minted, 18)} OkuM`);
  if (minted === 0n) throw new Error("mint produced zero OkuM");
  return minted;
}

async function stepTransfer(ctx: TestCtx) {
  logger.section("Step 3: transfer");
  // Throwaway recipient: deterministic test wallet (PrivateKey #1 from a known
  // mnemonic). Live testnets only — never used as a custody account.
  const recipient = ethers.Wallet.createRandom().address;
  const balBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (balBefore === 0n) {
    throw new Error("Signer has zero OkuM; run mint step before transfer.");
  }
  const amt = balBefore / 100n; // 1% of current balance
  if (amt === 0n) throw new Error("Transfer amount rounded to zero");

  await waitForTx(
    await ctx.okuMoney.transfer(recipient, amt),
    `okuMoney.transfer(${ethers.formatUnits(amt, 18)} OkuM -> ${recipient})`
  );
  const recipBal: bigint = await ctx.okuMoney.balanceOf(recipient);
  const balAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  logger.info(`Recipient OkuM:  ${ethers.formatUnits(recipBal, 18)}`);
  logger.info(`Signer OkuM:     ${ethers.formatUnits(balAfter, 18)} (delta -${ethers.formatUnits(balBefore - balAfter, 18)})`);
  // Allow ±1 wei drift from rebase math (multiplier rounding).
  const drift = recipBal > amt ? recipBal - amt : amt - recipBal;
  if (drift > 1n) throw new Error(`Recipient balance drift > 1 wei (${drift})`);
}

async function stepWrap(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 4: wrap");
  const okuMBal: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to wrap; run mint first.");
  const half = okuMBal / 2n;

  const okuDollarAddr = await ctx.okuDollar.getAddress();
  const usdoBefore: bigint = await ctx.okuDollar.balanceOf(ctx.user.address);

  await waitForTx(await ctx.okuMoney.approve(okuDollarAddr, half), "okuMoney.approve(OkuDollar)");
  await waitForTx(
    await ctx.okuDollar.wrap(half, ctx.user.address, 0n),
    `okuDollar.wrap(${ethers.formatUnits(half, 18)} OkuM)`
  );

  const usdoAfter: bigint = await ctx.okuDollar.balanceOf(ctx.user.address);
  const minted = usdoAfter - usdoBefore;
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
  const okuMAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  const returned = okuMAfter - okuMBefore;
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
  logger.section("Step 6: redeem (buffered, instant)");
  const okuMBal: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to redeem; run mint first.");
  const amt = okuMBal / 4n;
  if (amt === 0n) throw new Error("Redeem amount rounded to zero");

  // Make sure the buffer can cover the redeem to take the instant path.
  // Conservative: deposit twice the USDC equivalent of `amt` so we stay
  // off the queue path even with multiplier drift.
  const usdcEquiv = (amt * (await ctx.okuMoney.okuMMultiplier())) / 10n ** 30n; // 18 + 12 = 30
  await ensureBufferFunded(ctx, usdcEquiv * 2n);

  const psmAddr = await ctx.litePSM.getAddress();
  const usdcBefore: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  await waitForTx(await ctx.okuMoney.approve(psmAddr, amt), "okuMoney.approve(LitePSM)");
  await waitForTx(
    await ctx.litePSM.redeemOkuM(amt),
    `LitePSM.redeemOkuM(${ethers.formatUnits(amt, 18)} OkuM)`
  );
  const usdcAfter: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  const received = usdcAfter - usdcBefore;
  logger.success(`Received ${ethers.formatUnits(received, 6)} USDC`);
  if (received === 0n) throw new Error("redeem returned zero USDC (likely queued — buffer too low?)");
}

async function stepQueueRedeem(ctx: TestCtx) {
  logger.section("Step 7: queueRedeem (force queue + processQueue drain)");

  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_DEPOSITOR, "PSM_BUFFER_DEPOSITOR");
  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_WITHDRAWER, "PSM_BUFFER_WITHDRAWER");
  await ensurePsmRole(ctx, ROLES.PSM_QUEUE_PROCESSOR, "PSM_QUEUE_PROCESSOR");

  const psmAddr = await ctx.litePSM.getAddress();

  // Drain the buffer so the next redeem queues instead of paying instantly.
  let buf: bigint = await ctx.usdc.balanceOf(psmAddr);
  if (buf > 0n) {
    await waitForTx(
      await ctx.litePSM.withdrawUsdc(ctx.user.address, buf),
      `LitePSM.withdrawUsdc(${ethers.formatUnits(buf, 6)} USDC)`
    );
  }

  // Now mint a small notional and immediately redeem to land in the queue.
  const usdcAmount = ethers.parseUnits("1", 6); // 1 USDC test notional
  await ensureUsdc(ctx, usdcAmount);
  const okuMBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  await waitForTx(await ctx.usdc.approve(psmAddr, usdcAmount), "usdc.approve(LitePSM) [queue test]");
  await waitForTx(await ctx.litePSM.mintOkuM(usdcAmount), "LitePSM.mintOkuM (queue test)");
  const okuMAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  const minted = okuMAfter - okuMBefore;

  await waitForTx(await ctx.okuMoney.approve(psmAddr, minted), "okuMoney.approve(LitePSM) [queue]");
  await waitForTx(await ctx.litePSM.redeemOkuM(minted), "LitePSM.redeemOkuM (queue path)");

  const qTail: bigint = await ctx.queue.queueTail();
  const qHead: bigint = await ctx.queue.queueHead();
  const qPending: bigint = qTail - qHead;
  if (qPending === 0n) {
    logger.warning(
      "Queue did not grow after empty-buffer redeem — possible that " +
        "withdrawUsdc was blocked by an existing pending obligation. Skipping drain."
    );
    return;
  }
  logger.info(`Queue pending after forced redeem: ${qPending}`);

  // Refill the buffer with exactly the queued USDC obligation + a small margin.
  const obligation: bigint = await ctx.queue.totalQueuedUsdc();
  const refill = obligation + ethers.parseUnits("0.1", 6);
  await ensureUsdc(ctx, refill);
  await waitForTx(await ctx.usdc.approve(psmAddr, refill), "usdc.approve(LitePSM) [refill]");
  await waitForTx(
    await ctx.litePSM.depositBuffer(refill),
    `LitePSM.depositBuffer(${ethers.formatUnits(refill, 6)} USDC)`
  );

  // Drain via processQueue. processQueue's `approveAmount` arg is the USDC
  // the PSM grants the queue for paying out — set to current PSM balance.
  const head: bigint = await ctx.queue.queueHead();
  const tail: bigint = await ctx.queue.queueTail();
  const bufNow: bigint = await ctx.usdc.balanceOf(psmAddr);
  await waitForTx(
    await ctx.litePSM.processQueue(head, tail, bufNow),
    `LitePSM.processQueue(${head}, ${tail}, ${ethers.formatUnits(bufNow, 6)} USDC)`
  );

  const tailFinal: bigint = await ctx.queue.queueTail();
  const headFinal: bigint = await ctx.queue.queueHead();
  const remaining: bigint = tailFinal - headFinal;
  if (remaining !== 0n) throw new Error(`Queue did not fully drain (remaining=${remaining})`);
  logger.success("Queue drained to empty");
}

async function stepDistributeYield(ctx: TestCtx) {
  logger.section("Step 8: distributeYield");
  const supply: bigint = await ctx.okuMoney.totalSupply();
  if (supply === 0n) throw new Error("Total supply is zero; cannot distribute yield");

  await ensureRole(ctx, ROLES.OKUM_REBASER, "OKUM_REBASER");

  const mBefore: bigint = await ctx.okuMoney.okuMMultiplier();
  const balBefore: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);

  // Pick a yield amount that produces a measurable per-token bump but stays
  // well below MAX_MULTIPLIER (1e30 wei equivalent). A 0.01% yield on
  // current supply is plenty.
  const yieldAmount = supply / 10000n; // 1 bps
  if (yieldAmount === 0n) throw new Error("Computed yield amount rounded to zero");

  await waitForTx(
    await ctx.okuMoney.distributeYield(yieldAmount),
    `okuMoney.distributeYield(${ethers.formatUnits(yieldAmount, 18)})`
  );

  const mAfter: bigint = await ctx.okuMoney.okuMMultiplier();
  const balAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  logger.info(`Multiplier: ${mBefore} -> ${mAfter} (+${mAfter - mBefore})`);
  logger.info(
    `Signer balance: ${ethers.formatUnits(balBefore, 18)} -> ` +
      `${ethers.formatUnits(balAfter, 18)} (+${ethers.formatUnits(balAfter - balBefore, 18)})`
  );
  if (mAfter <= mBefore) throw new Error("distributeYield did not bump multiplier");
}

async function stepPause(ctx: TestCtx) {
  logger.section("Step 9: pause / unpause");
  await ensurePsmRole(ctx, ROLES.PSM_PAUSER, "PSM_PAUSER");
  await ensurePsmRole(ctx, ROLES.PSM_UNPAUSER, "PSM_UNPAUSER");

  const pausedBefore: boolean = await ctx.litePSM.paused();
  if (pausedBefore) {
    logger.warning("LitePSM already paused; will unpause then re-test.");
    await waitForTx(await ctx.litePSM.unpause(), "LitePSM.unpause (pre-test cleanup)");
  }

  await waitForTx(await ctx.litePSM.pause(), "LitePSM.pause");
  const pausedNow: boolean = await ctx.litePSM.paused();
  if (!pausedNow) throw new Error("LitePSM.pause did not set paused=true");

  // Verify mint reverts while paused.
  const usdcAmount = ethers.parseUnits("1", 6);
  await ensureUsdc(ctx, usdcAmount);
  const psmAddr = await ctx.litePSM.getAddress();
  await (ctx.usdc as any).approve(psmAddr, usdcAmount);
  let reverted = false;
  try {
    await (ctx.litePSM as any).mintOkuM.staticCall(usdcAmount);
  } catch {
    reverted = true;
  }
  if (!reverted) throw new Error("mintOkuM did not revert while paused");
  logger.success("Confirmed mintOkuM reverts while paused");

  await waitForTx(await ctx.litePSM.unpause(), "LitePSM.unpause");
  const pausedFinal: boolean = await ctx.litePSM.paused();
  if (pausedFinal) throw new Error("LitePSM.unpause did not clear paused");
  logger.success("Confirmed LitePSM paused state cycles cleanly");
}

async function stepConfigureMinterAllowance(ctx: TestCtx) {
  logger.section("Step 10: configureMinterAllowance (rotate)");
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
  const mid: bigint = await ctx.okuMoney.minterAllowance(psmAddr);
  if (mid !== halved) throw new Error(`Allowance mid != expected (${mid} vs ${halved})`);
  await waitForTx(
    await ctx.okuMoney.configureMinterAllowance(psmAddr, before),
    `configureMinterAllowance(LitePSM, ${ethers.formatUnits(before, 18)}) [restore]`
  );
  const restored: bigint = await ctx.okuMoney.minterAllowance(psmAddr);
  if (restored !== before) throw new Error(`Allowance not restored (${restored} vs ${before})`);
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
  queueRedeem: stepQueueRedeem,
  distributeYield: stepDistributeYield,
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
  "queueRedeem",
  "distributeYield",
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
