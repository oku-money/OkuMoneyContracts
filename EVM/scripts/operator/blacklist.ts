/**
 * Add or remove an address from the token blacklists.
 *
 * `--add` requires `OKU_BLACKLISTER` (warm multisig).
 * `--remove` requires `OKU_UNBLACKLISTER` (cold multisig) — deliberately a
 * different role, so a compromised warm key can freeze but never unfreeze.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT IS BOTH TOKENS, AND THE HISTORY HERE IS WORTH KNOWING.
 * ---------------------------------------------------------------------------
 *
 * v0.2 shipped `blacklistBoth.ts` because the blacklist was duplicated across
 * two token contracts sharing one role hash: forgetting the second call left an
 * address blacklisted on one token and free on the other. v0.3 collapsed to a
 * single token and the footgun disappeared, so this script was written
 * single-target.
 *
 * v0.4 brought back two tokens, and with them the same hazard — with a sharper
 * edge, because the two are CONVERTIBLE. Blacklisting only OkuM leaves the
 * holder able to unwrap USDOku into... nothing, actually: the wrapper's
 * `safeTransfer` of OkuM to a blacklisted recipient reverts. But blacklisting
 * only USDOku leaves them free to move OkuM, and blacklisting only OkuM leaves
 * them free to move USDOku peer-to-peer. Either half-measure is a hole, so the
 * default is `both` and the single-token modes exist for deliberate,
 * narrower actions.
 *
 * WORKS WHILE PAUSED, by design — the pause-then-blacklist incident protocol
 * depends on it, and so does the reverse ordering.
 *
 * WHAT IT ACTUALLY BLOCKS. On OkuM the guard lives in the `_update` hook, so it
 * catches transfer, mint AND burn — it is not a transfer-only filter, and a
 * blacklisted holder cannot redeem out either. On USDOku the guard sits in
 * `_transferShares` and on `mint`, with the same practical effect. `permit` is
 * blocked on both for owner and spender, so a pre-signed approval cannot be used
 * to escape.
 *
 * IT DOES NOT SEIZE ANYTHING. The balance stays where it is, and on OkuM it
 * keeps appreciating with `M_oku` while frozen.
 *
 * Usage:
 *   npx hardhat run scripts/operator/blacklist.ts --network base --add 0xabc...
 *   npx hardhat run scripts/operator/blacklist.ts --network base --remove 0xabc...
 *   npx hardhat run scripts/operator/blacklist.ts --network base --add 0xabc... --target=okuM
 *   DRY_RUN=true ADD=0xabc... npx hardhat run scripts/operator/blacklist.ts --network base
 *
 * Flags:
 *   --add=<address>             blacklist (OKU_BLACKLISTER, warm)
 *   --remove=<address>          unblacklist (OKU_UNBLACKLISTER, cold)
 *   --target=okuM|usdOku|both   default "both"
 *   DRY_RUN=true                simulate
 *   --yes-mainnet               required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";

import { logger } from "../utils/logger";
import { DRY_RUN, attachAlso, parseArg, runScript, setup, submit } from "./_shared";

type Target = "okuM" | "usdOku" | "both";

/**
 * Apply the change on one token.
 *
 * Note this is intentionally NOT fail-fast across tokens on the
 * already-in-that-state case. `blacklist` reverts `AlreadyBlacklisted` and
 * `unblacklist` reverts `NotBlacklisted`, so a partially-applied previous run —
 * exactly the situation this script's `both` default exists to prevent — would
 * otherwise be impossible to finish. Skip the redundant leg, do the missing one.
 */
async function applyTo(
  label: string,
  token: Contract,
  account: string,
  add: boolean
): Promise<{ changed: boolean }> {
  logger.section(`${label} — ${add ? "blacklist" : "unblacklist"} ${account}`);

  const already: boolean = await (token as any).isBlacklisted(account);
  const balance: bigint = await (token as any).balanceOf(account);

  logger.info(`Currently blacklisted: ${already}`);
  logger.info(`Balance:               ${ethers.formatEther(balance)}`);

  if (add && already) {
    logger.warning(
      `${label}: already blacklisted — skipping (the contract would revert ` +
        `AlreadyBlacklisted).`
    );
    return { changed: false };
  }
  if (!add && !already) {
    logger.warning(
      `${label}: not blacklisted — skipping (the contract would revert NotBlacklisted).`
    );
    return { changed: false };
  }

  if (DRY_RUN) {
    logger.success(`DRY_RUN=true — not submitting ${label} change`);
    return { changed: false };
  }

  if (add) {
    await submit(`${label}.blacklist(${account})`, () => (token as any).blacklist(account));
  } else {
    await submit(`${label}.unblacklist(${account})`, () => (token as any).unblacklist(account));
  }

  const confirmed: boolean = await (token as any).isBlacklisted(account);
  if (confirmed !== add) {
    throw new Error(
      `POST-CONDITION FAILED: ${label}.isBlacklisted(${account}) is ${confirmed}, ` +
        `expected ${add}`
    );
  }
  logger.success(`${label}: isBlacklisted(${account}) = ${confirmed}`);
  return { changed: true };
}

async function main() {
  const target = (parseArg("target") ?? "both").trim() as Target;
  if (!["okuM", "usdOku", "both"].includes(target)) {
    throw new Error(`--target must be one of okuM|usdOku|both (got "${target}")`);
  }

  const { contract: okuM, signer, bookKey } = await setup("blacklist", "OkuM");

  const add = parseArg("add");
  const remove = parseArg("remove");
  if (!!add === !!remove) {
    throw new Error("Provide exactly one of --add=<address> or --remove=<address>");
  }
  const account = (add ?? remove)!;
  if (!ethers.isAddress(account)) throw new Error(`Not an address: ${account}`);

  const isAdd = !!add;
  logger.info("");
  logger.info(`Account: ${account}`);
  logger.info(`Action:  ${isAdd ? "ADD (warm, OKU_BLACKLISTER)" : "REMOVE (cold, OKU_UNBLACKLISTER)"}`);
  logger.info(`Target:  ${target}`);

  // Dollar value of the OkuM position, since the raw figure understates it once
  // the multiplier has moved and the freeze is usually a value judgement.
  logger.info(
    `OkuM UI balance: $${ethers.formatEther(await (okuM as any).balanceOfUI(account))}`
  );

  let changes = 0;
  if (target === "okuM" || target === "both") {
    const { changed } = await applyTo("OkuM", okuM, account, isAdd);
    if (changed) changes++;
  }
  if (target === "usdOku" || target === "both") {
    const usdOku = await attachAlso("USDOku", bookKey, signer);
    const { changed } = await applyTo("USDOku", usdOku, account, isAdd);
    if (changed) changes++;
  }

  logger.info("");
  if (target !== "both") {
    logger.warning(
      `Single-target run: ${account} is ${isAdd ? "still free" : "still frozen"} on the ` +
        `other token. OkuM and USDOku are convertible through the wrapper, so a ` +
        `one-sided blacklist leaves a path open unless that was the intent.`
    );
  }
  logger.warning(
    "Blacklisting does NOT seize funds. It blocks send, receive, mint and burn for " +
      "this address — including redemption — so the holder is frozen in place, not " +
      "dispossessed. On OkuM the frozen balance keeps appreciating with M_oku."
  );
  if (changes === 0 && !DRY_RUN) {
    logger.info("No state changed; every requested leg was already in the desired state.");
  }
}

runScript(main);
