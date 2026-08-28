/**
 * Recover pre-funded OkuM from `USDOkuWrapper` (`WRAPPER_ADMIN`, cold).
 *
 * The counterpart to `fundWrapper.ts`. Safe only because `backing >= liability`
 * is a maintained invariant: the contract computes the POST-withdrawal backing
 * and reverts `WouldBreachBacking` before moving anything, so this can never
 * create the shortfall that would make a USDOku balance unredeemable.
 *
 * Typical reasons for a surplus: a rate was halted before its segment ended, or
 * an `M_oku` step raised backing and covered ground the pre-funding paid for.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/withdrawSurplus.ts --network base --max
 *   NETWORK=base npx hardhat run scripts/operator/withdrawSurplus.ts --network base \
 *       --amount=1000000000000000000 --to=0xabc...
 *
 * Flags:
 *   --amount=<18-dec>  OkuM to withdraw
 *   --max              withdraw the full withdrawableSurplus()
 *   --to=<address>     recipient (default: signer)
 *   DRY_RUN=true       simulate without submitting
 */

import { operatorContext, submit, arg, run, logger, ethers } from "./_shared";

run(async () => {
  const ctx = await operatorContext("withdrawSurplus");
  const wrapper = await ctx.at("USDOkuWrapper");

  const surplus: bigint = await (wrapper as any).withdrawableSurplus();
  const liability: bigint = await (wrapper as any).declaredLiability();
  const backing: bigint = await (wrapper as any).realizedBacking();

  logger.info(`Declared liability:   ${ethers.formatUnits(liability, 18)}`);
  logger.info(`Realized backing:     ${ethers.formatUnits(backing, 18)}`);
  logger.info(`Withdrawable surplus: ${ethers.formatUnits(surplus, 18)} OkuM`);

  if (surplus === 0n) {
    logger.success("No surplus — all backing is committed to declared liability.");
    return;
  }

  const useMax = process.argv.includes("--max");
  const amount = useMax ? surplus : BigInt(arg("amount") ?? "0");
  if (amount === 0n) throw new Error("Required: --amount=<18-dec OkuM> or --max");
  if (amount > surplus) {
    throw new Error(
      `--amount ${ethers.formatUnits(amount, 18)} exceeds withdrawable surplus ${ethers.formatUnits(surplus, 18)} (would revert WouldBreachBacking)`
    );
  }

  const to = arg("to") ?? ctx.signerAddress;
  logger.info(`Withdrawing ${ethers.formatUnits(amount, 18)} OkuM to ${to}`);

  await submit("withdrawSurplus", () => (wrapper as any).withdrawSurplus(amount, to));

  if (!process.env.DRY_RUN) {
    logger.success(`Covers liability: ${await (wrapper as any).backingCoversLiability()}`);
  }
});
