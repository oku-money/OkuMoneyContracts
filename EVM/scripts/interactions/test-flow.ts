/**
 * Test Full Protocol Flow
 * 
 * Works on both local forks (Hardhat fork of Sepolia) and live networks.
 * Tests all core protocol operations:
 * 1. Mint OkuMoney from USDC
 * 2. Wrap OkuMoney to OkuDollar
 * 3. Unwrap OkuDollar to OkuMoney
 * 4. Redeem OkuMoney for USDC
 * 
 * Usage:
 *   # On Hardhat fork of Sepolia (must have node running with --fork)
 *   NETWORK=sepolia npx hardhat run scripts/interactions/test-flow.ts --network localhost
 * 
 *   # On live Sepolia
 *   NETWORK=sepolia npx hardhat run scripts/interactions/test-flow.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { DEV_WALLET_ADDRESS } from "../config/chains";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { resolveNetworkContext } from "../utils/networkContext";

// Use centralized deployer address from chains config
const DEPLOYER = DEV_WALLET_ADDRESS;

interface TestContext {
  user: any;
  usdc: any;
  okuMoney: any;
  okuDollar: any;
  litePSM: any;
  networkName: string; // chain target (e.g. "base", "sepolia") — for logging only
  bookKey: string;     // address book key ("fork:base" / "base") — used for all read/write
  isForked: boolean;
}

async function setupForkIfNeeded(ctx: TestContext): Promise<boolean> {
  if (!ctx.isForked) {
    logger.info("Running on live network - skipping fork setup");
    return true;
  }

  logger.section("Step 0: Fork Setup");
  
  const litePSMAddr = await ctx.litePSM.getAddress();
  const currentAllowance = await ctx.okuMoney.minterAllowance(litePSMAddr);
  
  if (currentAllowance > 0n) {
    logger.success("Fork already configured (minter allowance exists)");
    return true;
  }

  logger.info("Configuring minter allowances on fork...");
  
  // Impersonate deployer
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEPLOYER],
  });

  // Fund deployer with ETH for gas
  await ctx.user.sendTransaction({
    to: DEPLOYER,
    value: ethers.parseEther("1"),
  });

  const deployer = await ethers.getSigner(DEPLOYER);
  const okuMoney = ctx.okuMoney.connect(deployer);
  
  // Grant ALLOWANCE_MANAGER role if needed. Role aliases were removed from the contracts
  // in favour of the shared `Roles` library; scripts reference the centralized ROLES map.
  const ALLOWANCE_MANAGER_ROLE = ROLES.OKUM_ALLOWANCE_MANAGER;
  const hasAllowanceManager = await okuMoney.hasRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER);
  
  if (!hasAllowanceManager) {
    await waitForTx(
      await okuMoney.grantRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER),
      "Grant ALLOWANCE_MANAGER"
    );
  }

  // Configure minter allowances for all minting contracts
  const minterAllowance = ethers.parseUnits("1000000000", 18);
  const contracts = ["LitePSM", "RedemptionQueue", "OkuBridge", "OkuBridgeRouter"];
  
  for (const name of contracts) {
    if (hasAddress(ctx.bookKey, name)) {
      const addr = loadAddress(ctx.bookKey, name);
      await waitForTx(
        await okuMoney.configureMinterAllowance(addr, minterAllowance),
        `Configure ${name} allowance`
      );
    }
  }

  // Stop impersonating
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEPLOYER],
  });

  logger.success("Fork setup complete");
  return true;
}

async function testMint(ctx: TestContext, amount: string): Promise<bigint> {
  logger.section("Step 1: Mint OkuMoney from USDC");
  
  const usdcAmount = ethers.parseUnits(amount, 6);
  
  // Check USDC balance, mint if needed (only works with MockUSDC)
  let usdcBalance = await ctx.usdc.balanceOf(ctx.user.address);
  if (usdcBalance < usdcAmount) {
    if (hasAddress(ctx.bookKey, "MockUSDC")) {
      logger.info("Minting MockUSDC...");
      await waitForTx(await ctx.usdc.mint(ctx.user.address, usdcAmount), "Mint USDC");
      usdcBalance = await ctx.usdc.balanceOf(ctx.user.address);
    } else {
      throw new Error(`Insufficient USDC balance: ${ethers.formatUnits(usdcBalance, 6)} < ${amount}`);
    }
  }
  logger.info(`USDC balance: ${ethers.formatUnits(usdcBalance, 6)}`);

  const okuMBefore = await ctx.okuMoney.balanceOf(ctx.user.address);
  logger.info(`OkuM balance before: ${ethers.formatUnits(okuMBefore, 18)}`);

  // Approve and mint
  const litePSMAddr = await ctx.litePSM.getAddress();
  await waitForTx(await ctx.usdc.approve(litePSMAddr, usdcAmount), "Approve USDC");
  await waitForTx(await ctx.litePSM.mintOkuM(usdcAmount), "Mint OkuM");

  const okuMAfter = await ctx.okuMoney.balanceOf(ctx.user.address);
  const minted = okuMAfter - okuMBefore;
  logger.success(`Minted ${ethers.formatUnits(minted, 18)} OkuM`);
  
  return minted;
}

async function testWrap(ctx: TestContext, amount: bigint): Promise<bigint> {
  logger.section("Step 2: Wrap OkuMoney to OkuDollar");
  
  const okuDollarAddr = await ctx.okuDollar.getAddress();
  const okuDollarBefore = await ctx.okuDollar.balanceOf(ctx.user.address);
  
  logger.info(`Wrapping ${ethers.formatUnits(amount, 18)} OkuM...`);
  
  await waitForTx(await ctx.okuMoney.approve(okuDollarAddr, amount), "Approve OkuM");
  await waitForTx(await ctx.okuDollar.wrap(amount, ctx.user.address, 0n), "Wrap");
  
  const okuDollarAfter = await ctx.okuDollar.balanceOf(ctx.user.address);
  const wrapped = okuDollarAfter - okuDollarBefore;
  logger.success(`Received ${ethers.formatUnits(wrapped, 18)} okuDollar`);
  
  return wrapped;
}

async function testUnwrap(ctx: TestContext, shares: bigint): Promise<bigint> {
  logger.section("Step 3: Unwrap OkuDollar to OkuMoney");
  
  const okuMBefore = await ctx.okuMoney.balanceOf(ctx.user.address);
  
  logger.info(`Unwrapping ${ethers.formatUnits(shares, 18)} okuDollar...`);
  
  await waitForTx(await ctx.okuDollar.unwrap(shares, ctx.user.address), "Unwrap");
  
  const okuMAfter = await ctx.okuMoney.balanceOf(ctx.user.address);
  const unwrapped = okuMAfter - okuMBefore;
  logger.success(`Received ${ethers.formatUnits(unwrapped, 18)} OkuM`);
  
  return unwrapped;
}

async function testRedeem(ctx: TestContext, amount: bigint): Promise<bigint> {
  logger.section("Step 4: Redeem OkuMoney for USDC");
  
  // On fork, we need to deposit buffer as deployer first
  if (ctx.isForked) {
    const bufferAmount = ethers.parseUnits("1000", 6);
    
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEPLOYER],
    });
    await ctx.user.sendTransaction({ to: DEPLOYER, value: ethers.parseEther("0.1") });
    
    const deployer = await ethers.getSigner(DEPLOYER);
    const usdcAsDeployer = ctx.usdc.connect(deployer);
    const psmAsDeployer = ctx.litePSM.connect(deployer);
    
    // Mint USDC to deployer and deposit as buffer
    const deployerUsdcBal = await ctx.usdc.balanceOf(DEPLOYER);
    if (deployerUsdcBal < bufferAmount) {
      await waitForTx(await usdcAsDeployer.mint(DEPLOYER, bufferAmount), "Mint buffer USDC");
    }
    await waitForTx(await usdcAsDeployer.approve(await ctx.litePSM.getAddress(), bufferAmount), "Approve buffer");
    
    try {
      await waitForTx(await psmAsDeployer.depositBuffer(bufferAmount), "Deposit buffer");
    } catch (e: any) {
      logger.warning(`Buffer deposit skipped (may already exist): ${e.message?.slice(0, 50)}`);
    }
    
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [DEPLOYER],
    });
  }

  // Now redeem as user
  const usdcBefore = await ctx.usdc.balanceOf(ctx.user.address);
  
  logger.info(`Redeeming ${ethers.formatUnits(amount, 18)} OkuM...`);
  
  const litePSMAddr = await ctx.litePSM.getAddress();
  await waitForTx(await ctx.okuMoney.approve(litePSMAddr, amount), "Approve OkuM for redeem");
  await waitForTx(await ctx.litePSM.redeemOkuM(amount), "Redeem");
  
  const usdcAfter = await ctx.usdc.balanceOf(ctx.user.address);
  const redeemed = usdcAfter - usdcBefore;
  logger.success(`Received ${ethers.formatUnits(redeemed, 6)} USDC`);
  
  return redeemed;
}

async function showFinalBalances(ctx: TestContext) {
  logger.section("Final Balances");
  
  const usdc = await ctx.usdc.balanceOf(ctx.user.address);
  const okuM = await ctx.okuMoney.balanceOf(ctx.user.address);
  const okuDollar = await ctx.okuDollar.balanceOf(ctx.user.address);
  const eth = await ctx.user.provider.getBalance(ctx.user.address);
  
  logger.info(`ETH: ${ethers.formatEther(eth)}`);
  logger.info(`USDC: ${ethers.formatUnits(usdc, 6)}`);
  logger.info(`OkuMoney: ${ethers.formatUnits(okuM, 18)}`);
  logger.info(`OkuDollar: ${ethers.formatUnits(okuDollar, 18)}`);
}

async function main() {
  const { networkName, bookKey, isFork: isForked } = await resolveNetworkContext();

  logger.header(`EVM Protocol Test (${networkName}${isForked ? " fork" : ""})`);

  const [user] = await ethers.getSigners();
  logger.info(`User: ${user.address}`);
  logger.info(`Mode: ${isForked ? "Fork (impersonation available)" : "Live network"}`);
  logger.info(`Address book key: ${bookKey}`);

  // Load contracts from the resolved bookKey ("<chain>" or "fork:<chain>").
  // If running on a fork that hasn't had its own deploy yet (i.e. no entries
  // under "fork:<chain>"), fail early with a useful message rather than the
  // confusing "no address found for OkuMoney on network fork:base".
  if (!hasAddress(bookKey, "OkuMoney")) {
    throw new Error(
      `No deployment found under address book key "${bookKey}".\n` +
      (isForked
        ? `  This is a fork run; you need to deploy on the fork first:\n` +
          `    npx hardhat run scripts/deploy/index.ts --network localhost`
        : `  No live deployment recorded for "${networkName}".`)
    );
  }

  const usdcAddr = hasAddress(bookKey, "MockUSDC")
    ? loadAddress(bookKey, "MockUSDC")
    : loadAddress(bookKey, "USDC");
  const okuMoneyAddr = loadAddress(bookKey, "OkuMoney");
  const okuDollarAddr = loadAddress(bookKey, "OkuDollar");
  const litePSMAddr = loadAddress(bookKey, "LitePSM");

  logger.info(`USDC: ${usdcAddr}`);
  logger.info(`OkuMoney: ${okuMoneyAddr}`);
  logger.info(`OkuDollar: ${okuDollarAddr}`);
  logger.info(`LitePSM: ${litePSMAddr}`);

  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)", "function mint(address,uint256)"],
    usdcAddr
  );
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddr);
  const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddr);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddr);

  const ctx: TestContext = {
    user,
    usdc,
    okuMoney,
    okuDollar,
    litePSM,
    networkName,
    bookKey,
    isForked,
  };
  
  // Run tests
  await setupForkIfNeeded(ctx);
  
  const mintAmount = "100"; // 100 USDC
  const minted = await testMint(ctx, mintAmount);
  
  const wrapAmount = minted / 2n; // Wrap half
  const wrapped = await testWrap(ctx, wrapAmount);
  
  const unwrapAmount = wrapped / 2n; // Unwrap half of wrapped
  const unwrapped = await testUnwrap(ctx, unwrapAmount);
  
  const redeemAmount = unwrapped / 2n; // Redeem half of unwrapped
  await testRedeem(ctx, redeemAmount);
  
  await showFinalBalances(ctx);
  
  logger.section("Test Summary");
  logger.success("All protocol operations completed successfully!");
  logger.info("Operations tested:");
  logger.info("  - Mint OkuMoney from USDC via LitePSM");
  logger.info("  - Wrap OkuMoney to OkuDollar");
  logger.info("  - Unwrap OkuDollar to OkuMoney");
  logger.info("  - Redeem OkuMoney for USDC via LitePSM");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
