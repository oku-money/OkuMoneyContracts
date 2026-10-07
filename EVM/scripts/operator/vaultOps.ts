/**
 * OkuDollar vault operations — wrap/unwrap and the full ERC-4626 surface,
 * consolidated into one script.
 *
 *   ACTION=wrap             OkuM -> UsdOku, price-aware, with slippage floor
 *   ACTION=unwrap           UsdOku -> OkuM, price-aware
 *   ACTION=deposit          ERC-4626: OkuM assets -> UsdOku shares
 *   ACTION=mint             ERC-4626: mint exact UsdOku shares, spending OkuM assets
 *   ACTION=withdraw         ERC-4626: withdraw exact OkuM assets, burning UsdOku shares
 *   ACTION=redeem           ERC-4626: redeem exact UsdOku shares for OkuM assets
 *   ACTION=rescueDonation   VAULT_RESCUER: rescue OkuM donated directly to the vault
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base ACTION=wrap AMOUNT=1000000000000000000000 \
 *       npx hardhat run scripts/operator/vaultOps.ts --network base   # 1000 OkuM (18 dec)
 *
 * Environment:
 *   ACTION=<wrap|unwrap|deposit|mint|withdraw|redeem|rescueDonation>  (required)
 *   AMOUNT=<18-dec units>   input amount (assets for deposit/withdraw/wrap/unwrap,
 *                           shares for mint/redeem, raw OkuM for rescueDonation)
 *   RECEIVER=0x...          defaults to signer
 *   OWNER=0x...             withdraw/redeem only; defaults to signer
 *   MIN_AMOUNT_OUT=<units>  wrap only; defaults to 0 (no slippage floor)
 *   DRY_RUN=true            simulate without submitting
 *   YES_MAINNET=true        bypass mainnet guard
 *
 * Also exported as `runVaultOp()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { isAddress, Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export type VaultAction = "wrap" | "unwrap" | "deposit" | "mint" | "withdraw" | "redeem" | "rescueDonation";

export interface VaultOpResult {
  txHash?: string;
  returnValue?: bigint;
}

export interface VaultOpOpts {
  receiver?: string;
  owner?: string;
  minAmountOut?: bigint;
  dryRun?: boolean;
}

export async function runVaultOp(
  ctx: NetworkContext,
  signer: Signer,
  action: VaultAction,
  amount: bigint,
  opts: VaultOpOpts = {}
): Promise<VaultOpResult> {
  if (amount <= 0n) throw new Error("amount must be > 0");
  const signerAddr = await signer.getAddress();
  const receiver = opts.receiver && isAddress(opts.receiver) ? opts.receiver : signerAddr;
  const owner = opts.owner && isAddress(opts.owner) ? opts.owner : signerAddr;
  const dryRun = opts.dryRun ?? false;

  const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuDollarAddr || !okuMoneyAddr) {
    throw new Error(`Missing OkuDollar/OkuMoney in address book for ${ctx.bookKey}`);
  }

  const okuDollar = (await getDeployedContract("OkuDollar", okuDollarAddr)).connect(signer);
  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);

  logger.info(`Signer:   ${signerAddr}`);
  logger.info(`Action:   ${action}`);
  logger.info(`Amount:   ${ethers.formatEther(amount)}`);
  logger.info(`Receiver: ${receiver}`);

  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return {};
  }

  if (action === "wrap") {
    const balance = await okuMoney.balanceOf(signerAddr);
    if (balance < amount) throw new Error(`Insufficient OkuM: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
    const approveTx = await okuMoney.approve(okuDollarAddr, amount);
    await approveTx.wait(1);
    const tx = await okuDollar.wrap(amount, receiver, opts.minAmountOut ?? 0n);
    const receipt = await waitMined(tx);
    logger.success(`wrap tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "unwrap") {
    const balance = await okuDollar.balanceOf(signerAddr);
    if (balance < amount) throw new Error(`Insufficient UsdOku: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
    const tx = await okuDollar.unwrap(amount, receiver);
    const receipt = await waitMined(tx);
    logger.success(`unwrap tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "deposit") {
    const balance = await okuMoney.balanceOf(signerAddr);
    if (balance < amount) throw new Error(`Insufficient OkuM: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amount)}`);
    const approveTx = await okuMoney.approve(okuDollarAddr, amount);
    await approveTx.wait(1);
    const tx = await okuDollar.deposit(amount, receiver);
    const receipt = await waitMined(tx);
    logger.success(`deposit tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "mint") {
    // ERC-4626 mint(shares): amount here is the SHARE target; the vault derives
    // and spends the required OkuM assets via previewMint (ceil-rounded).
    const requiredAssets: bigint = await okuDollar.previewMint(amount);
    const balance = await okuMoney.balanceOf(signerAddr);
    if (balance < requiredAssets) {
      throw new Error(`Insufficient OkuM: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(requiredAssets)} (previewMint)`);
    }
    const approveTx = await okuMoney.approve(okuDollarAddr, requiredAssets);
    await approveTx.wait(1);
    const tx = await okuDollar.mint(amount, receiver);
    const receipt = await waitMined(tx);
    logger.success(`mint tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "withdraw") {
    const tx = await okuDollar.withdraw(amount, receiver, owner);
    const receipt = await waitMined(tx);
    logger.success(`withdraw tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  if (action === "redeem") {
    const tx = await okuDollar.redeem(amount, receiver, owner);
    const receipt = await waitMined(tx);
    logger.success(`redeem tx: ${receipt.hash}`);
    return { txHash: receipt.hash };
  }

  // action === "rescueDonation"
  const tx = await okuDollar.rescueDonation(amount, receiver);
  const receipt = await waitMined(tx);
  logger.success(`rescueDonation tx: ${receipt.hash}`);
  return { txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`vaultOps (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const action = parseArg("action") as VaultAction | undefined;
    const validActions: VaultAction[] = ["wrap", "unwrap", "deposit", "mint", "withdraw", "redeem", "rescueDonation"];
    if (!action || !validActions.includes(action)) {
      throw new Error(`Required: --action=${validActions.join("|")}`);
    }
    const amountStr = parseArg("amount");
    if (!amountStr) throw new Error("Required: --amount=<18-dec units>");
    const minAmountOutStr = parseArg("minAmountOut");

    const [signer] = await ethers.getSigners();
    await runVaultOp(ctx, signer, action, BigInt(amountStr), {
      receiver: parseArg("receiver"),
      owner: parseArg("owner"),
      minAmountOut: minAmountOutStr ? BigInt(minAmountOutStr) : undefined,
      dryRun: isDryRun(),
    });
  });
}
