/**
 * Stop yield accrual immediately (`OKU_GUARDIAN`, warm multisig).
 *
 * THE EMERGENCY LEVER against a compromised rate setter. No timelock.
 *
 * Monotone-safe by construction on both tokens: it stops growth without reducing
 * anything already accrued, so the worst a compromised guardian key can do is
 * withhold FUTURE yield until cold overrides. That asymmetry is the whole reason
 * the role sits on the warm multisig rather than cold — being unable to stop a
 * bad rate setter for as long as it takes to convene cold is strictly worse than
 * being exposed to a nuisance pause.
 *
 * ---------------------------------------------------------------------------
 * TWO TOKENS, TWO DIFFERENT HALTS. The difference matters operationally.
 * ---------------------------------------------------------------------------
 *
 *   OkuM   `haltAccrual()` sets a STICKY FLAG. `accrualHalted` becomes true and
 *          every subsequent `setOkuMultiplier` reverts `AccrualIsHalted`. The
 *          multiplier itself does not move — it was already only moving on
 *          explicit writes, so there is nothing to freeze.
 *
 *          THIS CHANGED IN v0.4. Under the old continuous model the halt froze
 *          a running rate and pulled `rateEnd` to now; there was no flag and
 *          recovery was simply "set a rate again". Now recovery requires COLD:
 *          `OKU_CAP_MANAGER` must call `resumeAccrual()` (resumeAccrual.ts).
 *          The warm key can stop marking but cannot restart it.
 *
 *          Deliberately does NOT arm the sync window: nothing about the current
 *          multiplier changes, so there is nothing to fence, and arming would
 *          hand the warm key a repeatable mint/redeem block that the RBAC model
 *          denies it.
 *
 *   USDOku `haltUsdOkuAccrual()` FREEZES THE INDEX. It snapshots
 *          `baseIndex = usdOkuIndex()`, sets `ratePerSecond` back to 1e18 and
 *          pulls `rateEnd` to now, so balances stop growing this second. There
 *          is no flag and no cold gate on recovery: `OKU_RATE_SETTER` simply
 *          calls `setUsdOkuRate` again. A compromised rate setter can therefore
 *          undo this one immediately — which is exactly why the OkuM halt is
 *          sticky, and why in a genuine key-compromise incident you halt BOTH
 *          and then revoke the role.
 *
 * DEFAULT IS BOTH, and that is a deliberate reversal of the v0.2-era "one script
 * per token" habit. `OKU_RATE_SETTER` is a single role covering both writes, so
 * a compromise of it is a compromise of both indices; halting one and forgetting
 * the other is the same footgun the old `blacklistBoth.ts` existed to fix.
 *
 * Usage:
 *   npx hardhat run scripts/operator/haltAccrual.ts --network base --yes-mainnet
 *   npx hardhat run scripts/operator/haltAccrual.ts --network base --target=okuM
 *   DRY_RUN=true npx hardhat run scripts/operator/haltAccrual.ts --network base
 *
 * Flags:
 *   --target=okuM|usdOku|both   default "both"
 *   DRY_RUN=true                simulate
 *   --yes-mainnet               required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  DRY_RUN,
  attachAlso,
  impliedAprBps,
  parseArg,
  runScript,
  setup,
  submit,
} from "./_shared";

type Target = "okuM" | "usdOku" | "both";

async function haltOkuM(okuM: any): Promise<void> {
  logger.section("OkuM — block further multiplier steps");

  const multiplier: bigint = await okuM.uiMultiplier();
  const halted: boolean = await okuM.accrualHalted();
  const lastStepped: bigint = await okuM.lastSteppedAt();
  const highWater: bigint = await okuM.stepHighWaterMark();

  logger.info(`uiMultiplier:      ${ethers.formatEther(multiplier)}`);
  logger.info(`accrualHalted:     ${halted}`);
  logger.info(
    `lastSteppedAt:     ${new Date(Number(lastStepped) * 1000).toISOString()}`
  );
  logger.info(`stepHighWaterMark: ${highWater}bps`);

  if (halted) {
    logger.warning(
      "Already halted — this call is a no-op. It does NOT revert (the flag write " +
        "is unconditional), so a duplicate guardian action is harmless."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting OkuM halt");
    return;
  }

  await submit("okuM.haltAccrual", () => okuM.haltAccrual());

  const after: bigint = await okuM.uiMultiplier();
  const nowHalted: boolean = await okuM.accrualHalted();
  const pending: bigint = await okuM.newUIMultiplier();

  if (!nowHalted) {
    throw new Error("POST-CONDITION FAILED: accrualHalted is still false after haltAccrual.");
  }
  if (after !== multiplier) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier moved (${multiplier} -> ${after}) across ` +
        `a halt. A halt must not change the value — only block further steps. A ` +
        `concurrent setOkuMultiplier landed in between, which means the rate setter ` +
        `is still active and you should revoke the role, not just halt.`
    );
  }
  if (after !== pending) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier (${after}) != newUIMultiplier (${pending}).`
    );
  }

  logger.success(`OkuM steps blocked. M_oku frozen at ${ethers.formatEther(after)}.`);
  logger.warning(
    "Recovery requires COLD: OKU_CAP_MANAGER must call resumeAccrual() " +
      "(scripts/operator/resumeAccrual.ts). The rate setter cannot lift this."
  );
}

async function haltUsdOku(usdOku: any): Promise<void> {
  logger.section("USDOku — freeze the rebase index");

  const indexBefore: bigint = await usdOku.usdOkuIndex();
  const rate: bigint = await usdOku.ratePerSecond();
  const end: bigint = await usdOku.rateEnd();
  const supply: bigint = await usdOku.totalSupply();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.info(`usdOkuIndex:       ${ethers.formatEther(indexBefore)}`);
  logger.info(`ratePerSecond:     ${rate} (${impliedAprBps(rate)}bps APR)`);
  logger.info(
    `rateEnd:           ${new Date(Number(end) * 1000).toISOString()}` +
      `${now >= end ? "  [already stopped]" : ""}`
  );
  logger.info(`totalSupply:       $${ethers.formatEther(supply)} (declared liability)`);

  if (now >= end) {
    logger.warning(
      "Accrual has already lapsed past rateEnd, so balances are already static. " +
        "The call still normalises the state (rate -> 1e18, anchor -> now), which " +
        "makes 'halted' read unambiguously rather than as 'a live rate that " +
        "happens to yield nothing'."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting USDOku halt");
    return;
  }

  await submit("usdOku.haltUsdOkuAccrual", () => usdOku.haltUsdOkuAccrual());

  const indexAfter: bigint = await usdOku.usdOkuIndex();
  const rateAfter: bigint = await usdOku.ratePerSecond();
  const endAfter: bigint = await usdOku.rateEnd();

  if (indexAfter < indexBefore) {
    throw new Error(
      `POST-CONDITION FAILED: index went backwards (${indexBefore} -> ${indexAfter}). ` +
        `A halt withholds future yield; it must never claw back accrued value.`
    );
  }
  if (rateAfter !== 10n ** 18n) {
    throw new Error(
      `POST-CONDITION FAILED: ratePerSecond is ${rateAfter}, expected 1e18 (no yield).`
    );
  }

  logger.success(`M_usd frozen at ${ethers.formatEther(indexAfter)}`);
  logger.info(
    `rateEnd pulled to ${new Date(Number(endAfter) * 1000).toISOString()} — nothing pending.`
  );
  logger.warning(
    "This halt is NOT sticky. OKU_RATE_SETTER can resume it immediately with " +
      "setUsdOkuRate. If you are halting because that key is compromised, revoke " +
      "the role — do not rely on this call holding."
  );
}

async function main() {
  const target = (parseArg("target") ?? "both").trim() as Target;
  if (!["okuM", "usdOku", "both"].includes(target)) {
    throw new Error(`--target must be one of okuM|usdOku|both (got "${target}")`);
  }

  // Load OkuM first regardless of target: `setup` is what applies the mainnet
  // guard and resolves the signer, and OkuM is present in every deployment.
  const { contract: okuM, signer, bookKey } = await setup("haltAccrual", "OkuM");

  if (target === "okuM") {
    await haltOkuM(okuM as any);
    return;
  }

  const usdOku = await attachAlso("USDOku", bookKey, signer);

  if (target === "usdOku") {
    await haltUsdOku(usdOku as any);
    return;
  }

  // BOTH. OkuM first: its halt is the sticky one, so if the second tx fails for
  // any reason (gas, nonce, a revoked role) the more durable protection is
  // already in place.
  await haltOkuM(okuM as any);
  await haltUsdOku(usdOku as any);

  logger.info("");
  logger.warning(
    "Both indices are now withholding. Neither holder balance nor raw ledger was " +
      "reduced. Next: establish whether OKU_RATE_SETTER is compromised, and if so " +
      "revoke it from cold before resuming anything."
  );
}

runScript(main);
