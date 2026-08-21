/**
 * Add or remove an address from the OkuDollar blacklist.
 *
 * `--add` requires `OKU_BLACKLISTER` (warm multisig).
 * `--remove` requires `OKU_UNBLACKLISTER` (cold multisig) — deliberately a
 * different role, so a compromised warm key can freeze but never unfreeze.
 *
 * Replaces v0.2's `blacklistBoth.ts`. That script existed because the blacklist
 * was duplicated across two token contracts sharing one role hash, which was a
 * documented operational footgun: forgetting the second call left an address
 * blacklisted on one token and free on the other. With a single token the
 * footgun is gone.
 *
 * Works while paused, by design — the pause-then-blacklist incident protocol
 * depends on it.
 *
 * Note the guard lives in the token's `_update` hook, so it also blocks mint to,
 * and burn from, a blacklisted address. It is not a transfer-only filter.
 *
 * Usage:
 *   npx hardhat run scripts/operator/blacklist.ts --network base --add 0xabc...
 *   npx hardhat run scripts/operator/blacklist.ts --network base --remove 0xabc...
 *   DRY_RUN=true ADD=0xabc... npx hardhat run scripts/operator/blacklist.ts --network base
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, parseArg, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: token } = await setup("blacklist", "OkuDollar");

  const add = parseArg("add");
  const remove = parseArg("remove");
  if (!!add === !!remove) {
    throw new Error("Provide exactly one of --add=<address> or --remove=<address>");
  }

  const account = (add ?? remove)!;
  if (!ethers.isAddress(account)) throw new Error(`Not an address: ${account}`);

  const already: boolean = await (token as any).isBlacklisted(account);
  logger.info(`Account:            ${account}`);
  logger.info(`Currently blacklisted: ${already}`);
  logger.info(`Balance (raw):      ${ethers.formatEther(await (token as any).balanceOf(account))}`);
  logger.info(`Balance (UI $):     ${ethers.formatEther(await (token as any).balanceOfUI(account))}`);

  if (add && already) throw new Error("Already blacklisted; the contract reverts AlreadyBlacklisted");
  if (remove && !already) throw new Error("Not blacklisted; the contract reverts NotBlacklisted");

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  if (add) {
    await submit(`blacklist(${account})`, () => (token as any).blacklist(account));
  } else {
    await submit(`unblacklist(${account})`, () => (token as any).unblacklist(account));
  }

  logger.success(`isBlacklisted(${account}) = ${await (token as any).isBlacklisted(account)}`);
  logger.warning(
    "Blacklisting does NOT seize funds. It blocks send, receive, mint and burn for this address."
  );
}

runScript(main);
