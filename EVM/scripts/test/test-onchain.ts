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
 *    8. setOkuMYieldRate      OkuMoney.setOkuMYieldRate (rate derived from an APY
 *                             via utils/yieldRate) + setNextOkuMYieldRate; assert
 *                             the schedule fields, not a discrete multiplier bump.
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
import { apyToRatePerSecond, describeRate, PRECISION } from "../utils/yieldRate";
import { computeMultiplier } from "@okumoney/yield-tooling";
import {
  EPOCH_ANCHOR_UNIX,
  EPOCH_LENGTH_SECONDS,
} from "../config/epoch";

/**
 * Seconds to wait while observing real accrual on a live chain (step 8).
 * Short enough not to stall a run, long enough that a 3% APY rate moves the
 * multiplier well clear of rounding. Override with ACCRUAL_OBSERVE_SEC.
 */
const ACCRUAL_OBSERVE_SEC = Number(process.env.ACCRUAL_OBSERVE_SEC ?? "20");

/**
 * The next epoch boundary on the declared grid, strictly in the future.
 *
 * Chain-INDEPENDENT by construction: every chain running this within the same
 * epoch derives the identical absolute timestamp, which is what makes a
 * per-chain invocation of this suite converge the fleet rather than scatter it.
 */
function nextEpochBoundarySec(): bigint {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - EPOCH_ANCHOR_UNIX;
  const nextIndex = Math.floor(elapsed / EPOCH_LENGTH_SECONDS) + 1;
  return BigInt(EPOCH_ANCHOR_UNIX + nextIndex * EPOCH_LENGTH_SECONDS);
}

/**
 * Read `okuMMultiplier()` and the chain timestamp it corresponds to ATOMICALLY,
 * by pinning both to the same block number.
 *
 * Reading them as two independent calls is subtly wrong: a block can land
 * between the two reads, so the multiplier reflects a later instant than the
 * timestamp. On a 12s chain that skew is usually invisible; on BSC's ~3s blocks
 * it produced a full second of unexplained accrual and failed an otherwise
 * correct assertion. Pinning to `blockTag` removes the race entirely instead of
 * papering over it with a wider tolerance.
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
  logger.info(`  USDC buffer:   ${ethers.formatUnits(psmUsdcBuf, 6)}`);
  logger.info(`  paused:        ${psmPaused}`);
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

  // Load-balanced RPCs (Alchemy, public endpoints) are eventually consistent:
  // the read issued immediately after `tx.wait()` can be served by a replica
  // that has not yet applied the block, returning a stale balance. Observed
  // repeatedly on Base Sepolia — the tx was mined and correct on-chain while
  // this read reported no change. Poll instead of asserting on a single read.
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
  // FIXED, deterministic recipient — same address on every run.
  //
  // This used to be `ethers.Wallet.createRandom().address`, a fresh address
  // every invocation. That permanently strands ~1% of the signer's OkuM on a
  // brand-new, uncontrolled address EVERY time the suite runs — on four live
  // testnets, run repeatedly over a session, that adds up to real fragmented
  // supply with no way to recover it. A deterministic recipient just
  // accumulates in one place instead, which is what a throwaway destination
  // whose only job is "prove a transfer credited someone else" should do.
  //
  // Derived from a fixed, documented seed — not a real private key anyone
  // needs to hold. Nothing is ever sent FROM this address.
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

  // Recipient is now FIXED (reused across runs, see above), so its balance can
  // already be non-zero from a prior run. Capture the baseline before sending
  // and assert the DELTA, not the absolute post-transfer balance.
  const recipBalBefore: bigint = await ctx.okuMoney.balanceOf(recipient);

  await waitForTx(
    await ctx.okuMoney.transfer(recipient, amt),
    `okuMoney.transfer(${ethers.formatUnits(amt, 18)} OkuM -> ${recipient})`
  );
  // Poll for the delta rather than a single immediate read — tolerates RPC
  // read-replica lag (see stepMint).
  const recipDelta: bigint = await pollBalanceDelta(
    () => ctx.okuMoney.balanceOf(recipient),
    recipBalBefore,
    /* maxMs */ 30_000
  );
  const balAfter: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  logger.info(`Recipient OkuM delta: ${ethers.formatUnits(recipDelta, 18)}`);
  logger.info(`Signer OkuM:     ${ethers.formatUnits(balAfter, 18)} (delta -${ethers.formatUnits(balBefore - balAfter, 18)})`);
  // EXACT equality — no tolerance.
  //
  // OkuM is a STATIC-BALANCE, NON-rebasing ERC-20: `transfer` is plain
  // `ERC20Upgradeable._update` with no multiplier anywhere in the path. The
  // old "±1 wei drift from rebase math" tolerance asserted the opposite of the
  // token's defining property, and would have masked a real rounding bug.
  if (recipDelta !== amt) {
    throw new Error(
      `Recipient's balance moved by ${recipDelta}, expected exactly ${amt}. OkuM is ` +
        `non-rebasing — a transfer must move the exact amount with zero drift.`
    );
  }
  // The sender side was previously only logged, so a double-debit passed.
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
    await ctx.litePSM.depositBuffer(short, false, 0, 0, 0),
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
  // Some public RPCs (e.g. baseSepolia) lag a block or two before tx state
  // is visible to subsequent reads. Poll the USDC balance until it changes
  // or a short timeout elapses; reverts here surface as 0-delta which the
  // assertion below catches.
  const received = await pollBalanceDelta(
    () => ctx.usdc.balanceOf(ctx.user.address),
    usdcBefore,
    /* maxMs */ 30_000
  );
  logger.success(`Received ${ethers.formatUnits(received, 6)} USDC`);
  if (received === 0n) throw new Error("redeem returned zero USDC (likely queued — buffer too low?)");

  // EXACT value check, not `!= 0`.
  //
  // `usdcEquiv` above is already the correct expected payout — same
  // `okuMMultiplier()` the contract prices against, same /1e30 scaling
  // `MathLib.dollarsToUsdc` performs. It was computed purely to size the
  // buffer and then discarded, which meant a PSM paying 1 USDC-unit for 25
  // OkuM passed this step. Allow 1 unit for dollarsToUsdc's floor, plus any
  // accrual between the sizing read and the redeem tx landing.
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

async function stepQueueRedeem(ctx: TestCtx) {
  logger.section("Step 7: queueRedeem (force queue + processQueue drain)");

  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_DEPOSITOR, "PSM_BUFFER_DEPOSITOR");
  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_WITHDRAWER, "PSM_BUFFER_WITHDRAWER");
  await ensurePsmRole(ctx, ROLES.PSM_QUEUE_PROCESSOR, "PSM_QUEUE_PROCESSOR");

  const psmAddr = await ctx.litePSM.getAddress();

  // We need (a) some OkuM on the signer to redeem and (b) the PSM USDC
  // buffer to be empty when we call `redeemOkuM`. Order of operations:
  //   1. If signer holds < 1 OkuM, mint 1 OkuM first (this puts 1 USDC into
  //      the buffer as a side effect).
  //   2. Drain the entire buffer via `withdrawUsdc` so it sits at 0.
  //   3. Call `redeemOkuM(1 OkuM)` — the buffer is empty so the program
  //      escrows the OkuM and pushes a queue entry.
  const queueRedeemAmt = ethers.parseUnits("1", 18);
  let signerOkuM: bigint = await ctx.okuMoney.balanceOf(ctx.user.address);
  if (signerOkuM < queueRedeemAmt) {
    const seedUsdc = ethers.parseUnits("1", 6);
    await ensureUsdc(ctx, seedUsdc);
    await waitForTx(
      await ctx.usdc.approve(psmAddr, seedUsdc),
      "usdc.approve(LitePSM) [queue seed]"
    );
    await waitForTx(
      await ctx.litePSM.mintOkuM(seedUsdc),
      "LitePSM.mintOkuM (queue seed)"
    );
  }

  // Tail BEFORE the forced redeem — the assertion below must prove THIS run
  // enqueued something, not that some entry happens to be pending.
  const qTailBefore: bigint = await ctx.queue.queueTail();

  // Drain the buffer to zero — must happen AFTER any seeding mint that
  // would re-fill it.
  //
  // ⚠ This deliberately empties a LIVE PSM. Everything from here to the end of
  // the step runs inside a try/finally that restores the drained amount, so an
  // RPC hiccup mid-step cannot leave the chain with a zero buffer and a live
  // unpayable queue entry (which would also brick `withdrawUsdc` behind
  // `WouldStrandQueue` until an operator intervened).
  const buf: bigint = await ctx.usdc.balanceOf(psmAddr);
  if (buf > 0n) {
    await waitForTx(
      await ctx.litePSM.withdrawUsdc(ctx.user.address, buf),
      `LitePSM.withdrawUsdc(${ethers.formatUnits(buf, 6)} USDC)`
    );
  }

  try {
    await runQueueDrain(ctx, psmAddr, queueRedeemAmt, qTailBefore);
  } finally {
    // Restore the buffer we drained, regardless of outcome. Without this,
    // every run of the suite left the live PSM at ~0.1 USDC with the drained
    // funds stranded in the deployer EOA, forcing every subsequent user
    // redemption onto the queue path.
    const bufNow: bigint = await ctx.usdc.balanceOf(psmAddr);
    if (bufNow < buf) {
      const restore = buf - bufNow;
      try {
        await ensureUsdc(ctx, restore);
        await waitForTx(
          await ctx.usdc.approve(psmAddr, restore),
          "usdc.approve(LitePSM) [buffer restore]"
        );
        await waitForTx(
          await ctx.litePSM.depositBuffer(restore, false, 0, 0, 0),
          `LitePSM.depositBuffer(${ethers.formatUnits(restore, 6)} USDC) [restore drained buffer]`
        );
        logger.success(`Restored PSM buffer to its pre-test level (${ethers.formatUnits(buf, 6)} USDC)`);
      } catch (e: any) {
        logger.error(
          `FAILED to restore the PSM buffer (wanted ${ethers.formatUnits(restore, 6)} USDC): ` +
            `${e?.message ?? e}. The live PSM is left under-funded — refill it manually with ` +
            `operator:depositBuffer before relying on instant redemptions on this chain.`
        );
      }
    }
  }
}

/** The forced-queue body of step 7, factored out so the caller can guarantee
 *  buffer restoration in a `finally` even when an assertion throws. */
async function runQueueDrain(
  ctx: TestCtx,
  psmAddr: string,
  queueRedeemAmt: bigint,
  qTailBefore: bigint
) {
  // Redeem with empty buffer -> queue path.
  await waitForTx(
    await ctx.okuMoney.approve(psmAddr, queueRedeemAmt),
    "okuMoney.approve(LitePSM) [queue]"
  );
  await waitForTx(
    await ctx.litePSM.redeemOkuM(queueRedeemAmt),
    "LitePSM.redeemOkuM (queue path)"
  );

  // Poll for the tail to advance rather than single-reading it. Load-balanced
  // RPCs serve reads from replicas that can lag the block the redeem landed in
  // (observed repeatedly on Base Sepolia), so a single read here reports the
  // pre-redeem tail and makes a correctly-queued redemption look like a
  // non-event. Poll, then assert.
  await pollBalanceDelta(() => ctx.queue.queueTail(), qTailBefore, /* maxMs */ 30_000);
  const qTail: bigint = await ctx.queue.queueTail();
  const qHead: bigint = await ctx.queue.queueHead();
  const qPending: bigint = qTail - qHead;
  // MUST grow relative to the PRE-REDEEM tail, and must be a hard failure.
  //
  // Previously this compared `qPending === 0n` and `return`ed with a warning —
  // so the one step whose entire purpose is proving the queue path works
  // reported SUCCESS when the queue never engaged. The `=== 0` form was also
  // satisfiable by a stale pending entry from an earlier aborted run, without
  // this run enqueuing anything.
  if (qTail <= qTailBefore) {
    throw new Error(
      `Queue did NOT grow after an empty-buffer redeem (tail ${qTailBefore} -> ${qTail}). ` +
        `The queue fallback path did not engage — this is the behaviour this step exists to verify.`
    );
  }
  logger.info(`Queue pending after forced redeem: ${qPending} (tail ${qTailBefore} -> ${qTail})`);

  // Refill the buffer with exactly the queued USDC obligation + a small margin.
  const obligation: bigint = await ctx.queue.totalQueuedUsdc();
  const refill = obligation + ethers.parseUnits("0.1", 6);
  await ensureUsdc(ctx, refill);
  await waitForTx(await ctx.usdc.approve(psmAddr, refill), "usdc.approve(LitePSM) [refill]");
  await waitForTx(
    await ctx.litePSM.depositBuffer(refill, false, 0, 0, 0),
    `LitePSM.depositBuffer(${ethers.formatUnits(refill, 6)} USDC)`
  );

  // Drain via processQueue. processQueue's `approveAmount` arg is the USDC
  // the PSM grants the queue for paying out — set to current PSM balance.
  const head: bigint = await ctx.queue.queueHead();
  const tail: bigint = await ctx.queue.queueTail();
  const bufNow: bigint = await ctx.usdc.balanceOf(psmAddr);
  // Snapshot the claimant's USDC so we can verify they were actually PAID.
  // Previously the step only checked that head advanced past the slot, which a
  // processQueue paying 1 wei per entry satisfies.
  const claimantUsdcBefore: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  await waitForTx(
    await ctx.litePSM.processQueue(head, tail, bufNow),
    `LitePSM.processQueue(${head}, ${tail}, ${ethers.formatUnits(bufNow, 6)} USDC)`
  );
  const claimantPaid = await pollBalanceDelta(
    () => ctx.usdc.balanceOf(ctx.user.address),
    claimantUsdcBefore,
    /* maxMs */ 30_000
  );
  if (claimantPaid < obligation) {
    throw new Error(
      `Queued claimant was under-paid: received ${claimantPaid} USDC-units but the queue's ` +
        `recorded obligation was ${obligation}. processQueue cleared the slot without settling it.`
    );
  }
  logger.success(
    `Queued claimant paid ${ethers.formatUnits(claimantPaid, 6)} USDC (obligation ${ethers.formatUnits(obligation, 6)})`
  );

  // processQueue clears entries (sets user=address(0)) but does NOT
  // auto-advance queueHead. Call advanceHead to move it past cleared slots.
  await waitForTx(
    await ctx.queue.advanceHead(tail - head),
    `queue.advanceHead(${tail - head})`
  );

  // Poll for head to catch up to tail. `advanceHead` has already mined at this
  // point, but a lagging read replica can still report the pre-advance head and
  // make a fully-drained queue look stuck.
  await pollBalanceDelta(() => ctx.queue.queueHead(), head, /* maxMs */ 30_000);
  const tailFinal: bigint = await ctx.queue.queueTail();
  const headFinal: bigint = await ctx.queue.queueHead();
  const remaining: bigint = tailFinal - headFinal;
  if (remaining !== 0n) throw new Error(`Queue did not fully drain (remaining=${remaining})`);
  logger.success("Queue drained to empty");
}

async function stepSetOkuMYieldRate(ctx: TestCtx) {
  logger.section("Step 8: setOkuMYieldRate");
  // REMOVED: the old distributeYield assertions (yield amount derived from local
  // totalSupply, immediate multiplier bump). Yield is now a RATE that streams
  // continuously, so there is no discrete bump to assert against right after the
  // write — the multiplier is re-anchored to its current value and grows with
  // elapsed time. The deterministic post-conditions are the schedule fields.
  await ensureRole(ctx, ROLES.OKUM_REBASER, "OKUM_REBASER");

  const rate = apyToRatePerSecond(0.03); // 3% APY
  // Snap to the declared epoch grid (UTC midnight under the 24h grid) rather
  // than `now + 86400`.
  //
  // This previously used a wall-clock-relative deadline, which made THIS SCRIPT
  // the protocol's largest source of cross-chain divergence: the suite is
  // invoked once per chain (`test:onchain:sepolia`, `:baseSepolia`, ...), so
  // each run stamped a different `rateEnd`, and `checkMultiplierDrift.ts` then
  // reported both RATE-END MISMATCH and EPOCH-GRID MISALIGNMENT across the
  // fleet — while this script exited 0 claiming success. Observed live: the
  // four testnets ended up 128-233s apart.
  //
  // The design is "one global rate, byte-identical absolute timestamps on every
  // chain". A grid-snapped boundary is chain-independent, so running this on
  // all four testnets now converges them instead of scattering them.
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
  // setOkuMYieldRate re-anchors the base to the multiplier at write time and clears
  // any armed successor, so the curve is continuous across the write (no step).
  // NOTE: `mAfter >= mBefore` is a THEOREM (rate >= PRECISION is enforced on-chain
  // and the base re-anchors to the current multiplier), not a test — it is kept
  // only as a cheap corruption canary. The real verification is below.
  if (mAfter < mBefore) throw new Error(`Multiplier went backwards: ${mBefore} -> ${mAfter}`);
  if (baseAfter < mBefore) {
    throw new Error(`Base multiplier ${baseAfter} re-anchored BELOW the pre-write multiplier ${mBefore}`);
  }
  if (pendingAfter !== PRECISION) {
    throw new Error(`Pending rate not cleared: ${pendingAfter}, expected ${PRECISION}`);
  }
  logger.success("Yield rate schedule written and verified");

  // ───────────────────────────────────────────────────────────────────────
  // LIVE DIFFERENTIAL: on-chain Solidity vs the TypeScript mirror.
  //
  // `EVM/test/differential` replays a committed OFFLINE corpus, which cannot
  // catch a proxy pointing at a stale implementation, a corrupted storage
  // slot, or a bad upgrade on ONE specific deployment. This reads the six
  // schedule getters from THIS live contract, evaluates the TS mirror at the
  // same instant, and requires exact agreement.
  //
  // This is the only place any test compares on-chain multiplier math to an
  // independent implementation against a real chain.
  // ───────────────────────────────────────────────────────────────────────
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
  // Both sides are pinned to the SAME block, so this should be exact. Allow a
  // single wei for integer-rounding differences between the two
  // implementations, nothing more.
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

  // ───────────────────────────────────────────────────────────────────────
  // OBSERVED ACCRUAL: the protocol's core value proposition.
  //
  // Wait real wall-clock time on a real chain and require the multiplier to
  // have advanced by the amount the published rate implies. Nothing else in
  // the on-chain suite verifies that yield actually accrues.
  // ───────────────────────────────────────────────────────────────────────
  const { multiplier: m0, timestampSec: t0 } = await multiplierAtChainTime(ctx.okuMoney);
  if (ctx.netCtx.isFork) {
    // A local fork only advances `block.timestamp` when it mines, and it mines
    // only on a transaction. Sleeping would leave the clock frozen and make
    // this check fail for a reason that has nothing to do with accrual. Warp
    // the fork's clock explicitly instead — the assertion below is identical
    // either way because it compares against the schedule evaluated at the
    // chain's OWN post-warp timestamp.
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
  // `m1` and `t1` come from the same block, and `expected` is the schedule
  // evaluated at exactly `t1` — so this is an exact comparison, not a
  // tolerance-based one. 1 wei for integer rounding.
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
  logger.section("Step 9: pause / unpause");
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
  // MUST wait for mining, not just submission. The approve tx was previously
  // only awaited to the point of being accepted by the RPC (ethers' default
  // `await contract.method(...)` resolves on submission, not confirmation),
  // so the following staticCall could race an un-mined approve on a live
  // chain and revert with ERC20InsufficientAllowance instead of the pause
  // check — which the bare `catch {}` below then couldn't distinguish from
  // the thing this step is actually trying to prove.
  await waitForTx(
    await ctx.usdc.approve(psmAddr, usdcAmount),
    "usdc.approve(LitePSM) [pause check]"
  );
  let revertReason = "";
  try {
    await ctx.litePSM.mintOkuM.staticCall(usdcAmount);
  } catch (e: any) {
    // A bare `catch {}` here previously accepted ANY failure — a malformed
    // ABI call, an RPC timeout, or a wrong-reason revert would all report
    // "Confirmed mintOkuM reverts while paused" without the pause having
    // anything to do with it. Decode the specific custom error instead.
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
        `A different revert reason means this isn't actually testing the pause gate ` +
        `(e.g. it could be an allowance/balance failure that happens to also revert).`
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
  queueRedeem: stepQueueRedeem,
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
  "queueRedeem",
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
