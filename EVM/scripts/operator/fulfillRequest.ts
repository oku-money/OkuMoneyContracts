/**
 * Fulfil a pending subscription or redemption request (`REQUEST_FULFILLER`).
 *
 * PRICING HAPPENS HERE, at the live `M_oku` — never at the request block. The
 * user's `minOut` is their protection against an adverse move while they
 * waited; a fulfilment that would breach it reverts `SlippageExceeded` and the
 * request should be rejected or left to expire instead.
 *
 * `REQUEST_FULFILLER` is deliberately a different key from `OKU_RATE_SETTER`:
 * one key can misprice, the other can convert, and neither can do both.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/fulfillRequest.ts --network base --id=7
 *
 * Flags:
 *   --id=<requestId>   request to fulfil (required)
 *   DRY_RUN=true       simulate without submitting
 */

import { operatorContext, submit, requireArg, run, logger, ethers } from "./_shared";

const DIRECTION = ["Subscribe", "Redeem"];
const STATUS = ["Pending", "Fulfilled", "Rejected", "Cancelled"];
const MAX_REQUEST_AGE = 7n * 24n * 3600n;

run(async () => {
  const ctx = await operatorContext("fulfillRequest");
  const module = await ctx.at("SubscriptionModule");
  const okuM = await ctx.at("OkuM");

  const id = BigInt(requireArg("id", "requestId"));
  const req = await (module as any).getRequest(id);

  if (req.user === ethers.ZeroAddress) throw new Error(`Request ${id} does not exist`);

  const status = Number(req.status);
  const direction = Number(req.direction);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const expiresAt = BigInt(req.createdAt) + MAX_REQUEST_AGE;

  logger.info(`Request ${id}`);
  logger.info(`  user:      ${req.user}`);
  logger.info(`  direction: ${DIRECTION[direction]}`);
  logger.info(`  status:    ${STATUS[status]}`);
  logger.info(`  amountIn:  ${req.amountIn}`);
  logger.info(`  minOut:    ${req.minOut}`);
  logger.info(`  createdAt: ${req.createdAt} (expires ${expiresAt})`);

  if (status !== 0) throw new Error(`Request ${id} is ${STATUS[status]}, not Pending`);
  if (now > expiresAt) {
    throw new Error(`Request ${id} expired at ${expiresAt} (now ${now}). It must be resubmitted.`);
  }

  const mOku = await (okuM as any).uiMultiplier();
  logger.info(`  M_oku at fulfilment: ${ethers.formatUnits(mOku, 18)}`);

  const quoted =
    direction === 0
      ? await (module as any).quoteSubscription(req.amountIn)
      : await (module as any).quoteRedemption(req.amountIn);
  logger.info(`  projected out: ${quoted} (minOut ${req.minOut})`);

  if (quoted < req.minOut) {
    throw new Error(
      `Would revert SlippageExceeded: ${quoted} < minOut ${req.minOut}. Reject or let it expire.`
    );
  }

  if (direction === 0) {
    await submit(`fulfillSubscription(${id})`, () => (module as any).fulfillSubscription(id));
  } else {
    await submit(`fulfillRedemption(${id})`, () => (module as any).fulfillRedemption(id));
  }
});
