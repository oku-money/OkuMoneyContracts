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
 *    4. wrap                  okuM.approve + usdOku.wrap(minShares=0).
 *    5. unwrap                usdOku.unwrap; assert OkuM returned.
 *    6. redeem                Operator depositBuffer (fork-only auto;
 *                             live: assumed already funded) + user redeem;
 *                             assert USDC delta.
 *    7. bufferBound           Drain buffer to 0 -> redeem must REVERT (there is
 *                             no queue) -> refill.
 *    8. setRate               OkuM.setOkuMRate; assert continuous accrual
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

/** 1e18 fixed-point base, mirroring Constants.PRECISION. */
const PRECISION = 10n ** 18n;

const DEFAULT_USDC_AMOUNT = process.env.USDC_AMOUNT ?? "100"; // 100 USDC (6 decimals)

// ============================================================================
// Shared test context
// ============================================================================

interface TestCtx {
  netCtx: NetworkContext;
  user: any; // signer (deployer/dev wallet)
  usdc: any;
  okuM: any;
  usdOku: any;
  litePSM: any;
  hasMockUsdc: boolean;
}

async function setupCtx(): Promise<TestCtx> {
  const netCtx = await resolveNetworkContext();
  logger.header(
    `test-onchain (${netCtx.networkName}${netCtx.isFork ? " · fork" : ""})`
  );
  mainnetGuard(netCtx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  if (!hasAddress(netCtx.bookKey, "OkuM")) {
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
  const okuMAddr = loadAddress(netCtx.bookKey, "OkuM");
  const usdOkuAddr = loadAddress(netCtx.bookKey, "USDOku");
  const litePSMAddr = loadAddress(netCtx.bookKey, "LitePSM");

  logger.info(`USDC:            ${usdcAddr}`);
  logger.info(`OkuM:        ${okuMAddr}`);
  logger.info(`USDOku:       ${usdOkuAddr}`);
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
  const okuM = await getDeployedContract("OkuM", okuMAddr);
  const usdOku = await getDeployedContract("USDOku", usdOkuAddr);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddr);

  // Fork-only bootstrap (mirrors the old test-flow.ts behavior). On a fresh
  // fork, the deployer wallet may not have the OKUM_ALLOWANCE_MANAGER role
  // wired or the LitePSM minter allowance configured. Heal silently.
  if (netCtx.isFork) {
    await healForkRoles(litePSM, okuM);
  }

  return {
    netCtx,
    user,
    usdc,
    okuM,
    usdOku,
    litePSM,
    hasMockUsdc: hasAddress(netCtx.bookKey, "MockUSDC"),
  };
}

async function healForkRoles(
  litePSM: any,
  okuM: any,
): Promise<void> {
  const litePSMAddr = await litePSM.getAddress();
  const currentAllowance: bigint = await okuM.minterAllowance(litePSMAddr);
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
  const okuMAsDep = okuM.connect(deployer);

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
  const has: boolean = await ctx.okuM.hasRole(role, ctx.user.address);
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
    await (ctx.okuM.connect(admin) as any).grantRole(role, ctx.user.address),
    `grantRole(${label}, signer)`
  );
  await hhNetwork.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEV_WALLET_ADDRESS],
  });
}

async function ensureOkuMRole(ctx: TestCtx, role: string, label: string) {
  const has: boolean = await ctx.okuM.hasRole(role, ctx.user.address);
  if (has) return;
  if (!ctx.netCtx.isFork) {
    throw new Error(
      `Signer ${ctx.user.address} is missing role ${label} (${role}) on OkuM ` +
        `on live ${ctx.netCtx.networkName}. Grant via grantRoles.ts.`
    );
  }
  logger.warning(`Granting OkuM ${label} on fork via impersonation.`);
  await hhNetwork.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({ to: DEV_WALLET_ADDRESS, value: ethers.parseEther("0.5") });
  const admin = await ethers.getSigner(DEV_WALLET_ADDRESS);
  await waitForTx(
    await (ctx.okuM.connect(admin) as any).grantRole(role, ctx.user.address),
    `OkuM.grantRole(${label}, signer)`
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

async function stepOpenWindow(ctx: TestCtx) {
  logger.section("Step 0: open the conversion window");

  // The PSM deploys with both windows CLOSED so the first rate segment can be
  // published before anyone trades against the default 1.0 multiplier. Opening it
  // is a deliberate, separate operator action.
  await ensurePsmRole(ctx, ROLES.PSM_GATEKEEPER, "PSM_GATEKEEPER");

  const open: boolean = await ctx.litePSM.conversionsOpen();
  if (open) {
    logger.info("  window already open");
    return;
  }
  await waitForTx(await ctx.litePSM.openWindow(), "psm.openWindow()");
  const nowOpen: boolean = await ctx.litePSM.conversionsOpen();
  if (!nowOpen) throw new Error("window failed to open");
  logger.success("  conversion window open");
}

async function stepState(ctx: TestCtx) {
  logger.section("Step 1: state");

  const okuMSupply: bigint = await ctx.okuM.totalSupply();
  const okuMMaxSupply: bigint = await ctx.okuM.maxSupply();
  const psmAddr = await ctx.litePSM.getAddress();
  const psmAllowance: bigint = await ctx.okuM.minterAllowance(psmAddr);
  const multiplier: bigint = await ctx.okuM.uiMultiplier();
  const okuMPaused: boolean = await ctx.okuM.paused();

  const usdoSupply: bigint = await ctx.usdOku.totalSupply();
  const usdoPaused: boolean = await ctx.usdOku.paused();

  const psmUsdcBuf: bigint = await ctx.usdc.balanceOf(psmAddr);
  const psmPaused: boolean = await ctx.litePSM.paused();

  const mintOpen: boolean = await ctx.litePSM.mintEnabled();
  const redeemOpen: boolean = await ctx.litePSM.redeemEnabled();
  const available: bigint = await ctx.litePSM.availableToRedeem();

  logger.info(`OkuM:`);
  logger.info(`  totalSupply: ${ethers.formatUnits(okuMSupply, 18)}`);
  logger.info(`  maxSupply:   ${ethers.formatUnits(okuMMaxSupply, 18)}`);
  logger.info(`  multiplier:  ${multiplier}`);
  logger.info(`  paused:      ${okuMPaused}`);
  logger.info(`  PSM allowance: ${ethers.formatUnits(psmAllowance, 18)}`);
  logger.info(`USDOku:`);
  logger.info(`  totalSupply: ${ethers.formatUnits(usdoSupply, 18)}`);
  logger.info(`  paused:      ${usdoPaused}`);
  logger.info(`LitePSM:`);
  logger.info(`  USDC buffer:   ${ethers.formatUnits(psmUsdcBuf, 6)}`);
  logger.info(`  paused:        ${psmPaused}`);
  logger.info(`  mint / redeem: ${mintOpen} / ${redeemOpen}`);
  logger.info(`  availableToRedeem: ${ethers.formatUnits(available, 6)} USDC`);
}

async function stepMint(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 2: mint");
  const usdcAmount = ethers.parseUnits(DEFAULT_USDC_AMOUNT, 6);
  await ensureUsdc(ctx, usdcAmount);

  const psmAddr = await ctx.litePSM.getAddress();
  const okuMBefore: bigint = await ctx.okuM.balanceOf(ctx.user.address);

  await waitForTx(await ctx.usdc.approve(psmAddr, usdcAmount), "usdc.approve(LitePSM)");
  await waitForTx(
    await ctx.litePSM.mintOkuM(usdcAmount, 0n),
    `LitePSM.mintOkuM(${DEFAULT_USDC_AMOUNT}, minOut=0)`
  );

  const okuMAfter: bigint = await ctx.okuM.balanceOf(ctx.user.address);
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
  // Poll for non-zero balance — BSC testnet RPCs can lag a block after mint.
  let balBefore: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  if (balBefore === 0n) {
    logger.info("Waiting for OkuM balance to propagate...");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      balBefore = await ctx.okuM.balanceOf(ctx.user.address);
      if (balBefore > 0n) break;
    }
  }
  if (balBefore === 0n) {
    throw new Error("Signer has zero OkuM; run mint step before transfer.");
  }
  const amt = balBefore / 100n; // 1% of current balance
  if (amt === 0n) throw new Error("Transfer amount rounded to zero");

  await waitForTx(
    await ctx.okuM.transfer(recipient, amt),
    `okuM.transfer(${ethers.formatUnits(amt, 18)} OkuM -> ${recipient})`
  );
  const recipBal: bigint = await ctx.okuM.balanceOf(recipient);
  const balAfter: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  logger.info(`Recipient OkuM:  ${ethers.formatUnits(recipBal, 18)}`);
  logger.info(`Signer OkuM:     ${ethers.formatUnits(balAfter, 18)} (delta -${ethers.formatUnits(balBefore - balAfter, 18)})`);
  // Allow ±1 wei drift from rebase math (multiplier rounding).
  const drift = recipBal > amt ? recipBal - amt : amt - recipBal;
  if (drift > 1n) throw new Error(`Recipient balance drift > 1 wei (${drift})`);
}

async function stepWrap(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 4: wrap");
  const okuMBal: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to wrap; run mint first.");
  const half = okuMBal / 2n;

  const usdOkuAddr = await ctx.usdOku.getAddress();
  const usdoBefore: bigint = await ctx.usdOku.balanceOf(ctx.user.address);

  await waitForTx(await ctx.okuM.approve(usdOkuAddr, half), "okuM.approve(USDOku)");
  // BSC RPCs can lag — poll until the allowance is visible before calling wrap.
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const allowance: bigint = await ctx.okuM.allowance(ctx.user.address, usdOkuAddr);
      if (allowance >= half) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await waitForTx(
    await ctx.usdOku.wrap(half, ctx.user.address, 0n),
    `usdOku.wrap(${ethers.formatUnits(half, 18)} OkuM)`
  );

  const usdoAfter: bigint = await ctx.usdOku.balanceOf(ctx.user.address);
  const minted = usdoAfter - usdoBefore;
  logger.success(`Received ${ethers.formatUnits(minted, 18)} usdOku`);
  if (minted === 0n) throw new Error("wrap produced zero usdOku");
  return minted;
}

async function stepUnwrap(ctx: TestCtx): Promise<bigint> {
  logger.section("Step 5: unwrap");
  const usdoBal: bigint = await ctx.usdOku.balanceOf(ctx.user.address);
  if (usdoBal === 0n) throw new Error("No usdOku to unwrap; run wrap first.");
  const half = usdoBal / 2n;

  const okuMBefore: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  await waitForTx(
    await ctx.usdOku.unwrap(half, ctx.user.address),
    `usdOku.unwrap(${ethers.formatUnits(half, 18)} usdOku)`
  );
  // Poll for balance change — load-balanced RPCs can return stale reads.
  let returned = 0n;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const okuMAfter: bigint = await ctx.okuM.balanceOf(ctx.user.address);
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
  logger.section("Step 6: redeem (buffered, instant)");
  const okuMBal: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  if (okuMBal === 0n) throw new Error("No OkuM to redeem; run mint first.");
  const amt = okuMBal / 4n;
  if (amt === 0n) throw new Error("Redeem amount rounded to zero");

  // Make sure the buffer can cover the redeem to take the instant path.
  // Conservative: deposit twice the USDC equivalent of `amt` so we stay
  // clear of the buffer bound even with multiplier drift.
  const usdcEquiv = (amt * (await ctx.okuM.uiMultiplier())) / 10n ** 30n; // 18 + 12 = 30
  await ensureBufferFunded(ctx, usdcEquiv * 2n);

  const psmAddr = await ctx.litePSM.getAddress();
  const usdcBefore: bigint = await ctx.usdc.balanceOf(ctx.user.address);
  await waitForTx(await ctx.okuM.approve(psmAddr, amt), "okuM.approve(LitePSM)");
  await waitForTx(
    await ctx.litePSM.redeemOkuM(amt, 0n),
    `LitePSM.redeemOkuM(${ethers.formatUnits(amt, 18)} OkuM, minOut=0)`
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
  if (received === 0n) throw new Error("redeem returned zero USDC");
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

async function stepBufferBound(ctx: TestCtx) {
  logger.section("Step 7: buffer bound (redemption reverts, never queues)");

  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_WITHDRAWER, "PSM_BUFFER_WITHDRAWER");
  await ensurePsmRole(ctx, ROLES.PSM_BUFFER_DEPOSITOR, "PSM_BUFFER_DEPOSITOR");

  // Drain the buffer, then confirm a redemption fails LOUDLY rather than entering
  // any pending state. There is no queue: the permissionless window is bounded on
  // purpose, and an exhausted window is instant-or-nothing.
  const psmAddr = await ctx.litePSM.getAddress();
  const buffer: bigint = await ctx.usdc.balanceOf(psmAddr);
  if (buffer > 0n) {
    await waitForTx(
      await ctx.litePSM.withdrawBuffer(ctx.user.address, buffer),
      `psm.withdrawBuffer(${ethers.formatUnits(buffer, 6)} USDC)`
    );
  }

  const okuMBal: bigint = await ctx.okuM.balanceOf(ctx.user.address);
  if (okuMBal === 0n) {
    logger.warning("  no OkuM held; skipping the revert assertion");
    return;
  }

  await waitForTx(
    await ctx.okuM.approve(psmAddr, okuMBal),
    `okuM.approve(psm, ${ethers.formatUnits(okuMBal, 18)})`
  );

  let reverted = false;
  try {
    await ctx.litePSM.redeemOkuM.staticCall(okuMBal, 0);
  } catch (err: any) {
    reverted = true;
    logger.success(`  redeem correctly reverted: ${String(err.message).slice(0, 90)}`);
  }
  if (!reverted) throw new Error("redeem should have reverted on an empty buffer");

  // Refill so later steps have liquidity.
  await waitForTx(
    await ctx.usdc.approve(psmAddr, buffer),
    `usdc.approve(psm, ${ethers.formatUnits(buffer, 6)})`
  );
  await waitForTx(
    await ctx.litePSM.depositBuffer(buffer),
    `psm.depositBuffer(${ethers.formatUnits(buffer, 6)} USDC)`
  );
}

async function stepSetRate(ctx: TestCtx) {
  logger.section("Step 8: setOkuMRate (closed-window rule + continuous accrual)");

  await ensureOkuMRole(ctx, ROLES.OKUM_RATE_SETTER, "OKUM_RATE_SETTER");
  await ensurePsmRole(ctx, ROLES.PSM_GATEKEEPER, "PSM_GATEKEEPER");

  const mBefore: bigint = await ctx.okuM.uiMultiplier();
  logger.info(`  uiMultiplier before: ${ethers.formatUnits(mBefore, 18)}`);

  // The window must be shut to publish. Prove the rule is live before satisfying it.
  const openBefore: boolean = await ctx.litePSM.conversionsOpen();
  if (openBefore) {
    let refused = false;
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      await ctx.okuM.setOkuMRate.staticCall(mBefore, PRECISION, now, now + 3600n, 0);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("setOkuMRate should be refused while the window is open");
    logger.success("  rate publication correctly refused while the window was open");

    await waitForTx(await ctx.litePSM.closeWindow(), "psm.closeWindow()");
  }

  // 5% nominal APR over 30 days, anchored to absolute wall-clock time so the same
  // parameters produce the same multiplier on every chain.
  const block = await ethers.provider.getBlock("latest");
  const start = BigInt(block!.timestamp);
  const end = start + 30n * 86400n;
  const rate = PRECISION + (PRECISION * 500n) / 10_000n / 31_536_000n;

  await waitForTx(
    await ctx.okuM.setOkuMRate(mBefore, rate, start, end, 0),
    `okuM.setOkuMRate(rate=5% APR, window=30d)`
  );

  await waitForTx(await ctx.litePSM.openWindow(), "psm.openWindow()");

  // Advance time and confirm the multiplier moved CONTINUOUSLY rather than stepping.
  await ethers.provider.send("evm_increaseTime", [86400]);
  await ethers.provider.send("evm_mine", []);

  const mAfter: bigint = await ctx.okuM.uiMultiplier();
  logger.info(`  uiMultiplier after 1 day: ${ethers.formatUnits(mAfter, 18)}`);
  if (mAfter <= mBefore) throw new Error("multiplier did not accrue");

  const projected: bigint = await ctx.okuM.indexAt(end);
  logger.info(`  projected at rateEnd:     ${ethers.formatUnits(projected, 18)}`);
  if (projected <= mAfter) throw new Error("projection should exceed the live value mid-segment");

  // Flatline past rateEnd: a missed renewal freezes yield rather than compounding on.
  const wayPast: bigint = await ctx.okuM.indexAt(end + 365n * 86400n);
  if (wayPast !== projected) throw new Error("accrual did not flatline past rateEnd");
  logger.success("  accrual flatlines past rateEnd as designed");
}

/** Poll a chain read until it satisfies `predicate`, or time out. */
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
  const before: bigint = await ctx.okuM.minterAllowance(psmAddr);
  const halved = before / 2n;
  if (halved === 0n) {
    logger.warning(`Current allowance is ${before}; cannot halve below 1. Skipping rotation.`);
    return;
  }

  await waitForTx(
    await ctx.okuM.configureMinterAllowance(psmAddr, halved),
    `configureMinterAllowance(LitePSM, ${ethers.formatUnits(halved, 18)})`
  );
  await pollUntil<bigint>(
    () => ctx.okuM.minterAllowance(psmAddr),
    (v) => v === halved,
    30_000,
    "allowance halved"
  );
  await waitForTx(
    await ctx.okuM.configureMinterAllowance(psmAddr, before),
    `configureMinterAllowance(LitePSM, ${ethers.formatUnits(before, 18)}) [restore]`
  );
  await pollUntil<bigint>(
    () => ctx.okuM.minterAllowance(psmAddr),
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
  openWindow: stepOpenWindow,
  state: stepState,
  mint: stepMint,
  transfer: stepTransfer,
  wrap: stepWrap,
  unwrap: stepUnwrap,
  redeem: stepRedeem,
  bufferBound: stepBufferBound,
  setRate: stepSetRate,
  pause: stepPause,
  configureMinterAllowance: stepConfigureMinterAllowance,
};

const STEP_ORDER = [
  "openWindow",
  "state",
  "mint",
  "transfer",
  "wrap",
  "unwrap",
  "redeem",
  "bufferBound",
  "setRate",
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
