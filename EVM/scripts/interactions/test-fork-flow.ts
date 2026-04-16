/**
 * Test Full Protocol Flow on Fork
 * 
 * This script tests all core protocol operations on a Sepolia fork:
 * 1. Fork Setup - Configure missing allowances
 * 2. Mint OkuMoney from USDC
 * 3. Wrap OkuMoney to OkuDollar
 * 4. Unwrap OkuDollar to OkuMoney
 * 5. Redeem OkuMoney for USDC
 * 6. Check final balances
 */
import { ethers, network } from "hardhat";
import { getNetworkName } from "../config/chains";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

// Deployer address from Sepolia (for impersonation)
const DEPLOYER = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

interface TestContext {
  user: any;
  usdc: any;
  okuMoney: any;
  okuDollar: any;
  litePSM: any;
  networkName: string;
}

async function setupFork(ctx: TestContext): Promise<boolean> {
  logger.section("Step 0: Fork Setup");
  
  const currentAllowance = await ctx.okuMoney.minterAllowance(await ctx.litePSM.getAddress());
  
  if (currentAllowance > 0n) {
    logger.success("Fork already configured");
    return true;
  }

  logger.info("Configuring minter allowances...");
  
  // Impersonate deployer
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEPLOYER],
  });

  // Fund deployer
  await ctx.user.sendTransaction({
    to: DEPLOYER,
    value: ethers.parseEther("1"),
  });

  const deployer = await ethers.getSigner(DEPLOYER);
  const okuMoney = ctx.okuMoney.connect(deployer);
  
  // Grant ALLOWANCE_MANAGER role
  const ALLOWANCE_MANAGER_ROLE = await okuMoney.OKUM_ALLOWANCE_MANAGER();
  const hasAllowanceManager = await okuMoney.hasRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER);
  
  if (!hasAllowanceManager) {
    await waitForTx(
      await okuMoney.grantRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER),
      "Grant ALLOWANCE_MANAGER"
    );
  }

  // Configure minter allowances
  const minterAllowance = ethers.parseUnits("1000000000", 18);
  const contracts = ["LitePSM", "RedemptionQueue", "OkuBridge", "OkuBridgeRouter"];
  
  for (const name of contracts) {
    const addr = loadAddress(ctx.networkName, name);
    await waitForTx(
      await okuMoney.configureMinterAllowance(addr, minterAllowance),
      `Configure ${name} allowance`
    );
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
  
  // Check/mint USDC
  let usdcBalance = await ctx.usdc.balanceOf(ctx.user.address);
  if (usdcBalance < usdcAmount) {
    logger.info("Minting MockUSDC...");
    await waitForTx(await ctx.usdc.mint(ctx.user.address, usdcAmount), "Mint USDC");
    usdcBalance = await ctx.usdc.balanceOf(ctx.user.address);
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
  const usdOkuBefore = await ctx.okuDollar.balanceOf(ctx.user.address);
  
  logger.info(`Wrapping ${ethers.formatUnits(amount, 18)} OkuM...`);
  
  await waitForTx(await ctx.okuMoney.approve(okuDollarAddr, amount), "Approve OkuM");
  await waitForTx(await ctx.okuDollar.wrap(amount, ctx.user.address, 0n), "Wrap");
  
  const usdOkuAfter = await ctx.okuDollar.balanceOf(ctx.user.address);
  const wrapped = usdOkuAfter - usdOkuBefore;
  logger.success(`Received ${ethers.formatUnits(wrapped, 18)} usdOku`);
  
  return wrapped;
}

async function testUnwrap(ctx: TestContext, shares: bigint): Promise<bigint> {
  logger.section("Step 3: Unwrap OkuDollar to OkuMoney");
  
  const okuMBefore = await ctx.okuMoney.balanceOf(ctx.user.address);
  
  logger.info(`Unwrapping ${ethers.formatUnits(shares, 18)} usdOku...`);
  
  await waitForTx(await ctx.okuDollar.unwrap(shares, ctx.user.address), "Unwrap");
  
  const okuMAfter = await ctx.okuMoney.balanceOf(ctx.user.address);
  const unwrapped = okuMAfter - okuMBefore;
  logger.success(`Received ${ethers.formatUnits(unwrapped, 18)} OkuM`);
  
  return unwrapped;
}

async function testRedeem(ctx: TestContext, amount: bigint): Promise<bigint> {
  logger.section("Step 4: Redeem OkuMoney for USDC");
  
  // First, ensure there's USDC buffer in the PSM for instant redemption
  // We need to deposit buffer as the deployer (who has PSM_BUFFER_DEPOSITOR role)
  const bufferAmount = ethers.parseUnits("1000", 6);
  
  // Impersonate deployer
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
    logger.warning(`Buffer deposit failed (may already have buffer): ${e.message}`);
  }
  
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEPLOYER],
  });

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
  const usdOku = await ctx.okuDollar.balanceOf(ctx.user.address);
  
  logger.info(`USDC: ${ethers.formatUnits(usdc, 6)}`);
  logger.info(`OkuMoney: ${ethers.formatUnits(okuM, 18)}`);
  logger.info(`OkuDollar: ${ethers.formatUnits(usdOku, 18)}`);
}

async function main() {
  const networkName = getNetworkName();
  logger.header(`EVM Fork Protocol Test (${networkName})`);
  
  const [user] = await ethers.getSigners();
  logger.info(`User: ${user.address}`);
  
  // Load contracts
  const usdcAddr = hasAddress(networkName, "MockUSDC")
    ? loadAddress(networkName, "MockUSDC")
    : loadAddress(networkName, "USDC");
  const okuMoneyAddr = loadAddress(networkName, "OkuMoney");
  const okuDollarAddr = loadAddress(networkName, "OkuDollar");
  const litePSMAddr = loadAddress(networkName, "LitePSM");
  
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
  };
  
  // Run tests
  await setupFork(ctx);
  
  const mintAmount = "1000"; // 1000 USDC
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
