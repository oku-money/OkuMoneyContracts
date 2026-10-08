/**
 * PSM-mediated OkuM / UsdOku mint & redeem operations (orchestrator workflow),
 * consolidated into one script.
 *
 *   ACTION=mintOkuM     USDC  -> OkuM   via LitePSM.mintOkuM(usdcAmount)
 *   ACTION=redeemOkuM   OkuM  -> USDC   via LitePSM.redeemOkuM(okuMAmount)
 *                                          (reverts InsufficientBuffer if buffer short)
 *   ACTION=mintUsdOku   USDC  -> UsdOku via LitePSM.mintUsdOku(usdcAmount)
 *   ACTION=redeemUsdOku UsdOku -> USDC  via LitePSM.redeemUsdOku(usdAmount)
 *   ACTION=burn         Burn caller's own OkuM balance (OKUM_BURNER role)
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base ACTION=mintOkuM AMOUNT=1000000000 \
 *       npx hardhat run scripts/operator/psmOps.ts --network base   # 1000 USDC (6 dec)
 *   NETWORK=base ACTION=redeemOkuM AMOUNT=1000000000000000000000 \
 *       npx hardhat run scripts/operator/psmOps.ts --network base   # 1000 OkuM (18 dec)
 *
 * Environment:
 *   ACTION=<mintOkuM|redeemOkuM|mintUsdOku|redeemUsdOku|burn>  (required)
 *   AMOUNT=<units>     input amount, decimals depend on action (USDC=6, OkuM/UsdOku=18)
 *   DRY_RUN=true       simulate without submitting
 *   YES_MAINNET=true   bypass mainnet guard
 *
 * Also exported as `runPsmOp()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress, resolveUsdcAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export type PsmAction = "mintOkuM" | "redeemOkuM" | "mintUsdOku" | "redeemUsdOku" | "burn";

export interface PsmOpResult {
  txHash?: string;
}

/** Run one PSM action (mint/redeem OkuM or UsdOku, or burn) for the signer, approving what it needs. */
export async function runPsmOp(
  ctx: NetworkContext,
  signer: Signer,
  action: PsmAction,
  amount: bigint,
  dryRun = false
): Promise<PsmOpResult> {
  if (amount <= 0n) throw new Error("amount must be > 0");
  const signerAddr = await signer.getAddress();

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  const usdcAddr = resolveUsdcAddress(ctx.bookKey);
  if (!psmAddr || !okuMoneyAddr || !usdcAddr) {
    throw new Error(`Missing LitePSM/OkuMoney/USDC in address book for ${ctx.bookKey}`);
  }

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Action: ${action}`);

  if (action === "mintOkuM" || action === "mintUsdOku") {
    const balance = await usdc.balanceOf(signerAddr);
    logger.info(`USDC balance: ${Number(balance) / 1e6}, spending: ${Number(amount) / 1e6}`);
    if (balance < amount) throw new Error(`Insufficient USDC: have ${Number(balance) / 1e6}, need ${Number(amount) / 1e6}`);
    if (dryRun) {
      logger.success("DRY_RUN=true — not submitting");
      return {};
    }
    const approveTx = await usdc.approve(psmAddr, amount);
    await approveTx.wait(1);
    const tx = action === "mintOkuM" ? await psm.mintOkuM(amount) : await psm.mintUsdOku(amount);
    const receipt = await waitMined(tx);
    logger.success(`${action} tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "redeemOkuM") {
    const balance = await okuMoney.balanceOf(signerAddr);
    logger.info(`OkuM balance: ${ethers.formatEther(balance)}, redeeming: ${ethers.formatEther(amount)}`);
    if (balance < amount) throw new Error(`Insufficient OkuM: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
    if (dryRun) {
      logger.success("DRY_RUN=true — not submitting");
      return {};
    }
    const approveTx = await okuMoney.approve(psmAddr, amount);
    await approveTx.wait(1);
    const tx = await psm.redeemOkuM(amount);
    const receipt = await waitMined(tx);
    logger.success(`redeemOkuM tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "redeemUsdOku") {
    const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
    if (!okuDollarAddr) throw new Error(`Missing OkuDollar in address book for ${ctx.bookKey}`);
    const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddr);
    const balance = await okuDollar.connect(signer).balanceOf(signerAddr);
    logger.info(`UsdOku balance: ${ethers.formatEther(balance)}, redeeming: ${ethers.formatEther(amount)}`);
    if (balance < amount) throw new Error(`Insufficient UsdOku: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
    if (dryRun) {
      logger.success("DRY_RUN=true — not submitting");
      return {};
    }
    const approveTx = await okuDollar.connect(signer).approve(psmAddr, amount);
    await approveTx.wait(1);
    const tx = await psm.redeemUsdOku(amount);
    const receipt = await waitMined(tx);
    logger.success(`redeemUsdOku tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  // action === "burn"
  const balance = await okuMoney.balanceOf(signerAddr);
  logger.info(`OkuM balance: ${ethers.formatEther(balance)}, burning: ${ethers.formatEther(amount)}`);
  if (balance < amount) throw new Error(`Insufficient OkuM: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return {};
  }
  const tx = await okuMoney.burn(amount);
  const receipt = await waitMined(tx);
  logger.success(`burn tx: ${receipt.hash}`);
  return { txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`psmOps (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const action = parseArg("action") as PsmAction | undefined;
    const validActions: PsmAction[] = ["mintOkuM", "redeemOkuM", "mintUsdOku", "redeemUsdOku", "burn"];
    if (!action || !validActions.includes(action)) {
      throw new Error(`Required: --action=${validActions.join("|")}`);
    }
    const amountStr = parseArg("amount");
    if (!amountStr) throw new Error("Required: --amount=<units>");

    const [signer] = await ethers.getSigners();
    await runPsmOp(ctx, signer, action, BigInt(amountStr), isDryRun());
  });
}
