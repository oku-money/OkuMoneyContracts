/**
 * Fix Bridge Fee Recipient (devnet patch)
 *
 * Updates the bridge fee recipient to a PDA-based address to avoid
 * "duplicate mutable account" errors when user == feeRecipient.
 *
 * Root cause: scripts/config/authorities.ts::allRolesToSingleKey collapses
 * all 23 roles (including feeRecipient) to the deployer wallet on non-mainnet
 * deployments. Fix tracked in keys/README.md — once resolved, this script
 * becomes obsolete.
 *
 * Usage:
 *   npm run fix:fee-recipient            # dry-run (shows proposed change)
 *   npm run fix:fee-recipient:yes        # execute
 */

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { createProvider, detectNetwork } from "../../utils/network";
import { loadDeployment, saveDeployment } from "../../utils/addressBook";
import { logger } from "../../utils/logger";
import { deriveBridgeFeeTreasuryPDA } from "../../utils/pdaHelpers";
import { LitePsm } from "../../../target/types/lite_psm";

async function main() {
  const network = detectNetwork();
  const autoConfirm = process.argv.includes("--yes");

  logger.header(`Fix Bridge Fee Recipient (${network})`);

  if (network !== "devnet" && network !== "devnet-fork") {
    logger.error("This script is only for devnet. For mainnet, use a proper treasury address.");
    process.exit(1);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Fee Manager: ${wallet.publicKey.toBase58()}`);

  const deployment = loadDeployment(network === "devnet-fork" ? "devnet" : network);
  if (!deployment) {
    throw new Error(`No deployment found for ${network}`);
  }

  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    programId
  );

  const config = await program.account.bridgeConfig.fetch(bridgeConfig);

  logger.section("Current Configuration");
  logger.info(`Bridge Config PDA: ${bridgeConfig.toBase58()}`);
  logger.info(`Current Fee Recipient: ${config.feeRecipient.toBase58()}`);
  logger.info(`Fee Manager: ${config.feeManager.toBase58()}`);
  logger.info(`Bridge Fee: ${config.bridgeFeeBps} bps`);

  if (!config.feeManager.equals(wallet.publicKey)) {
    logger.error(`Wallet is not the fee manager!`);
    logger.error(`Expected: ${config.feeManager.toBase58()}`);
    logger.error(`Got: ${wallet.publicKey.toBase58()}`);
    process.exit(1);
  }

  // Use a PDA-derived fee recipient so fees accumulate in a known, recoverable location.
  const [newFeeRecipient] = deriveBridgeFeeTreasuryPDA(programId);

  logger.section("Proposed Change");
  logger.info(`New Fee Recipient (PDA): ${newFeeRecipient.toBase58()}`);
  logger.warning(
    "Fees will accumulate at this PDA. A future program upgrade can add a withdrawal instruction."
  );

  if (!autoConfirm) {
    logger.log("");
    logger.warning("Run with --yes to execute this change");
    process.exit(0);
  }

  logger.section("Executing Update");

  try {
    const tx = await program.methods
      .updateFeeRecipient(newFeeRecipient)
      .accountsPartial({
        feeManager: wallet.publicKey,
        bridgeConfig: bridgeConfig,
      })
      .rpc();

    logger.success(`Transaction: ${tx}`);

    const updatedConfig = await program.account.bridgeConfig.fetch(bridgeConfig);
    logger.success(`Fee recipient updated to: ${updatedConfig.feeRecipient.toBase58()}`);

    if (deployment.authorities) {
      deployment.authorities.feeRecipient = newFeeRecipient.toBase58();
      saveDeployment(network === "devnet-fork" ? "devnet" : network, deployment);
      logger.success("Deployment file updated");
    }
  } catch (error: any) {
    logger.error(`Failed to update fee recipient: ${error.message}`);
    console.error(error);
    process.exit(1);
  }

  logger.header("Fix Complete");
  logger.info("You can now run bridge:burn without the duplicate account error");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Script failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
