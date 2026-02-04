/**
 * End-to-end test: Full happy path flow
 * Orchestrates deployment and interactions in sequence
 *
 * Usage: NETWORK=localhost npx hardhat run scripts/e2e/full-flow.ts --network localhost
 */

import { execSync } from "child_process";
import { logger } from "../utils/logger";
import { getNetworkName } from "../config/chains";

function runScript(scriptPath: string, description: string, env: Record<string, string> = {}) {
  logger.section(description);

  const network = getNetworkName();
  const envStr = Object.entries({ NETWORK: network, ...env })
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  const command = `${envStr} npx hardhat run ${scriptPath} --network ${network}`;

  try {
    execSync(command, { stdio: "inherit" });
    logger.success(`${description} completed successfully\n`);
  } catch (error) {
    logger.error(`${description} failed`);
    throw error;
  }
}

async function main() {
  const network = getNetworkName();

  logger.section(`Starting Full E2E Flow on ${network}`);
  logger.warning("This will deploy all contracts and run the complete happy path");
  logger.info("Press Ctrl+C to cancel, or wait 3 seconds to continue...\n");

  // Wait 3 seconds for user to cancel
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Phase 1: Deploy contracts
  logger.section("PHASE 1: DEPLOYMENT");

  runScript("scripts/deploy/1-deploy-core.ts", "Step 1: Deploy Core Contracts");
  runScript("scripts/deploy/2-deploy-psm.ts", "Step 2: Deploy LitePSM");
  runScript("scripts/deploy/3-deploy-bridge.ts", "Step 3: Deploy Bridge Router");
  runScript("scripts/deploy/4-configure-roles.ts", "Step 4: Configure Roles");

  // Phase 2: Test interactions
  logger.section("PHASE 2: INTERACTIONS");

  runScript("scripts/interactions/mint-okuusd.ts", "Step 5: Mint OkuUSD", { AMOUNT: "10000" });
  runScript("scripts/interactions/check-balances.ts", "Step 6: Check Initial Balances");
  runScript("scripts/interactions/wrap-okuusd.ts", "Step 7: Wrap to wOkuUSD", { AMOUNT: "5000" });
  runScript("scripts/interactions/check-balances.ts", "Step 8: Check Balances After Wrap");
  runScript("scripts/interactions/rebalance.ts", "Step 9: Rebalance (5% yield)", { MULTIPLIER: "1.05" });
  runScript("scripts/interactions/check-balances.ts", "Step 10: Check Final Balances");

  // Summary
  logger.section("E2E FLOW COMPLETE");
  logger.success("All contracts deployed successfully");
  logger.success("All interactions completed successfully");
  logger.success("Happy path verified!");

  logger.info("\nNext steps:");
  logger.info("1. Run check-balances.ts to verify balances");
  logger.info("2. Test additional mint/wrap cycles");
  logger.info("3. Test multiple rebalances");
  logger.info("4. Verify contract state with direct calls");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`E2E flow failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
