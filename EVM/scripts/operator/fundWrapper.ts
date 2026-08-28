/**
 * Pre-fund `USDOkuWrapper` with OkuM so a forward USDOku rate can be declared.
 *
 * Because `MAX_SOLVENCY_GAP_BPS` is zero, declared liability may never exceed
 * realized backing — so the yield must be in the wrapper BEFORE the rate that
 * pays it is declared. Funding is a plain ERC-20 transfer; there is
 * deliberately no privileged deposit path, so anyone can top the wrapper up
 * and the wrapper needs no extra role surface.
 *
 * The counterpart is `withdrawSurplus.ts`, which recovers funding that is no
 * longer committed.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/fundWrapper.ts --network base \
 *       --amount=1000000000000000000000       # 1000 OkuM
 *   NETWORK=base npx hardhat run scripts/operator/fundWrapper.ts --network base \
 *       --cover-apr=500 --days=30             # fund exactly what this rate needs
 *
 * Flags:
 *   --amount=<18-dec>   OkuM to transfer
 *   --cover-apr=<bps>   instead of --amount, compute the funding a rate needs
 *   --days=<n>          segment length for --cover-apr (default 30)
 *   DRY_RUN=true        simulate without submitting
 */

import { operatorContext, submit, arg, run, logger, ethers } from "./_shared";

const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 24n * 3600n;
const BPS = 10_000n;

run(async () => {
  const ctx = await operatorContext("fundWrapper");
  const okuM = await ctx.at("OkuM");
  const wrapper = await ctx.at("USDOkuWrapper");
  const wrapperAddress = await wrapper.getAddress();

  const liability: bigint = await (wrapper as any).declaredLiability();
  const backing: bigint = await (wrapper as any).realizedBacking();
  const mOku: bigint = await (okuM as any).uiMultiplier();

  let okuMAmount: bigint;

  const coverApr = arg("cover-apr");
  if (coverApr) {
    const aprBps = BigInt(coverApr);
    const days = arg("days") ? BigInt(arg("days")!) : 30n;
    const seconds = days * 24n * 3600n;
    // Simple-interest approximation, deliberately rounded UP with a 5% cushion
    // so the compounded figure and any timing slippage stay covered.
    const growthBps = (aprBps * seconds * BPS) / (SECONDS_PER_YEAR * BPS);
    const projected = liability + (liability * growthBps) / BPS;
    const needDollars = projected > backing ? projected - backing : 0n;
    const cushioned = (needDollars * 105n) / 100n;
    okuMAmount = (cushioned * PRECISION) / mOku;
    logger.info(`Covering ${aprBps} bps for ${days} days`);
    logger.info(`  shortfall: ${ethers.formatUnits(needDollars, 18)} dollars`);
    logger.info(`  with 5% cushion: ${ethers.formatUnits(cushioned, 18)} dollars`);
  } else {
    const amountStr = arg("amount");
    if (!amountStr) throw new Error("Required: --amount=<18-dec OkuM> or --cover-apr=<bps>");
    okuMAmount = BigInt(amountStr);
  }

  if (okuMAmount === 0n) {
    logger.success("Nothing to fund — the wrapper already covers the projected liability.");
    return;
  }

  const balance: bigint = await (okuM as any).balanceOf(ctx.signerAddress);
  logger.info(`Signer OkuM balance: ${ethers.formatUnits(balance, 18)}`);
  logger.info(`Funding amount:      ${ethers.formatUnits(okuMAmount, 18)} OkuM`);
  logger.info(`Dollar value:        ${ethers.formatUnits((okuMAmount * mOku) / PRECISION, 18)}`);

  if (balance < okuMAmount) {
    throw new Error(
      `Insufficient OkuM: have ${ethers.formatUnits(balance, 18)}, need ${ethers.formatUnits(okuMAmount, 18)}`
    );
  }

  await submit("fundWrapper (OkuM transfer)", () =>
    (okuM as any).transfer(wrapperAddress, okuMAmount));

  if (!process.env.DRY_RUN) {
    const newBacking: bigint = await (wrapper as any).realizedBacking();
    logger.success(`New backing: ${ethers.formatUnits(newBacking, 18)}`);
    logger.success(`Covers liability: ${await (wrapper as any).backingCoversLiability()}`);
  }
});
