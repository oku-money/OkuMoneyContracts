/**
 * Reject a pending request (`REQUEST_FULFILLER`). Immediate, refunds in full.
 *
 * The reason code is an opaque `bytes32` resolved off-chain, so no compliance
 * detail lands on-chain. Rejection charges NO fee — a declined user has not
 * transacted.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/rejectRequest.ts --network base \
 *       --id=7 --reason=KYC_FAILED
 *
 * Flags:
 *   --id=<requestId>   request to reject (required)
 *   --reason=<string>  hashed to bytes32 (default: UNSPECIFIED)
 *   DRY_RUN=true       simulate without submitting
 */

import { operatorContext, submit, requireArg, arg, run, logger, ethers } from "./_shared";

const STATUS = ["Pending", "Fulfilled", "Rejected", "Cancelled"];

run(async () => {
  const ctx = await operatorContext("rejectRequest");
  const module = await ctx.at("SubscriptionModule");

  const id = BigInt(requireArg("id", "requestId"));
  const reason = arg("reason") ?? "UNSPECIFIED";
  const reasonCode = ethers.keccak256(ethers.toUtf8Bytes(reason));

  const req = await (module as any).getRequest(id);
  if (req.user === ethers.ZeroAddress) throw new Error(`Request ${id} does not exist`);

  const status = Number(req.status);
  logger.info(`Request ${id} — user ${req.user}, status ${STATUS[status]}`);
  logger.info(`Reason: "${reason}" -> ${reasonCode}`);

  if (status !== 0) throw new Error(`Request ${id} is ${STATUS[status]}, not Pending`);

  logger.warning("Rejection is immediate and refunds the input in full (no fee).");

  await submit(`rejectRequest(${id})`, () => (module as any).rejectRequest(id, reasonCode));
});
