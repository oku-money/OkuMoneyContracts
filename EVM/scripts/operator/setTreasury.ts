/**
 * Repoint SubscriptionModule's treasury (`SUB_TREASURY_MANAGER`).
 *
 * The treasury both receives subscription USDC and funds redemption payouts via
 * allowance. Repointing does NOT migrate the allowance — the new treasury must
 * approve the module or every `fulfillRedemption` reverts
 * `InsufficientTreasuryAllowance`.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setTreasury.ts --network base --to=0xabc...
 */

import { operatorContext, submit, requireArg, run, logger, ethers } from "./_shared";

run(async () => {
  const ctx = await operatorContext("setTreasury");
  const module = await ctx.at("SubscriptionModule");
  const usdc = await (module as any).usdc();

  const to = requireArg("to", "address");
  if (!ethers.isAddress(to)) throw new Error(`--to is not an address: ${to}`);

  const current = await (module as any).treasury();
  logger.info(`Current treasury: ${current}`);
  logger.info(`New treasury:     ${to}`);

  const moduleAddress = await module.getAddress();
  const erc20 = new ethers.Contract(
    usdc,
    ["function allowance(address,address) view returns (uint256)"],
    ethers.provider
  );
  const newAllowance = await erc20.allowance(to, moduleAddress);
  logger.info(`New treasury USDC allowance to module: ${ethers.formatUnits(newAllowance, 6)}`);
  if (newAllowance === 0n) {
    logger.warning("New treasury has NOT approved the module. Redemptions will revert until it does.");
  }

  await submit("setTreasury", () => (module as any).setTreasury(to));
});
