/**
 * On-chain smoke test for a fresh v0.3 deployment.
 *
 * Replaces v0.2's `test-onchain.ts` (785 L) and `test-bridge-evm-evm.ts` (651 L).
 * Both were built around wrap/unwrap between two tokens and a bridge that had
 * already been removed; neither flow exists now, so they were deleted rather
 * than ported.
 *
 * Exercises, in order:
 *   1. ERC-165 capability detection — the thing every wallet will do first
 *   2. Value/display parity — the invariant tying ERC-8056 to the 4626 views
 *   3. Rate write + continuous accrual (raw static, UI grows)
 *   4. PSM mint, then quote-vs-actual on redeem
 *   5. The max-send rule, both the right way and the wrong way
 *   6. Oracle adapter health
 *
 * Read-only unless `--write` is passed. Default is a diagnostic sweep safe to
 * run against any deployment, including mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/test/smoke.ts --network sepolia
 *   npx hardhat run scripts/test/smoke.ts --network sepolia --write --usdc 10
 */

import { ethers } from "hardhat";

import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";

const WRITE = process.argv.includes("--write");
const USDC_AMOUNT = (() => {
  const f = process.argv.find((x) => x.startsWith("--usdc"));
  if (!f) return "10";
  return f.includes("=") ? f.split("=")[1] : process.argv[process.argv.indexOf(f) + 1] ?? "10";
})();

const IID = {
  core: "0xa60bf13d",
  pending: "0x4bd27648",
  conversion: "0x57854fc3",
  balances: "0xd890fd71",
};

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) logger.success(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    logger.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`rUSDOku smoke test (${ctx.networkName})${WRITE ? " [WRITE]" : " [read-only]"}`);

  const tokenAddr = loadAddress(ctx.bookKey, "OkuDollar");
  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  const adapterAddr = loadAddress(ctx.bookKey, "OkuMultiplierAdapter");
  if (!tokenAddr || !psmAddr || !queueAddr) {
    throw new Error(`Incomplete address book for ${ctx.bookKey}`);
  }

  const token = await ethers.getContractAt("OkuDollar", tokenAddr);
  const psm = await ethers.getContractAt("LitePSM", psmAddr);
  const queue = await ethers.getContractAt("RedemptionQueue", queueAddr);

  // ---- 1. Capability detection ----
  logger.info("");
  logger.info("1. ERC-165 capability detection");
  for (const [name, id] of Object.entries(IID)) {
    check(`supportsInterface(${name}=${id})`, await (token as any).supportsInterface(id));
  }
  check(
    "metadata",
    (await (token as any).symbol()) === "rUSDOku",
    `name="${await (token as any).name()}" symbol="${await (token as any).symbol()}"`
  );

  // ---- 2. Value / display parity ----
  logger.info("");
  logger.info("2. Value / display parity");
  const multiplier: bigint = await (token as any).uiMultiplier();
  const dm: bigint = await (token as any).usdcDecimalMultiplier();
  const cta: bigint = await (token as any).convertToAssets(10n ** 18n);
  check(
    "convertToAssets(1e18) * dm <= uiMultiplier < (cta+1) * dm",
    cta * dm <= multiplier && multiplier < (cta + 1n) * dm,
    `m=${ethers.formatEther(multiplier)} cta=${cta} dm=${dm}`
  );
  check(
    "asset() agrees across token / psm / queue",
    (await (token as any).asset()).toLowerCase() ===
      (await (psm as any).usdc()).toLowerCase() &&
      (await (token as any).asset()).toLowerCase() ===
        (await (queue as any).usdc()).toLowerCase()
  );
  check(
    "decimalMultiplier agrees across all three",
    dm === (await (psm as any).usdcDecimalMultiplier()) &&
      dm === (await (queue as any).usdcDecimalMultiplier())
  );

  // ---- 3. Accrual state ----
  logger.info("");
  logger.info("3. Accrual state");
  const rate: bigint = await (token as any).ratePerSecond();
  const rateEnd: bigint = await (token as any).rateEnd();
  const pending: bigint = await (token as any).newUIMultiplier();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const halted = now >= rateEnd;

  logger.info(`  uiMultiplier    ${ethers.formatEther(multiplier)}`);
  logger.info(`  ratePerSecond   ${rate}`);
  logger.info(`  impliedAprBps   ${await (token as any).impliedAprBps()}`);
  logger.info(`  rateEnd         ${new Date(Number(rateEnd) * 1000).toISOString()}`);
  logger.info(`  accrual         ${halted ? "HALTED" : "LIVE"}`);

  // The ERC-8056 boundary contract.
  if (halted) {
    check("past rateEnd: uiMultiplier == newUIMultiplier", multiplier === pending);
  } else {
    check("before rateEnd: uiMultiplier <= newUIMultiplier", multiplier <= pending);
  }
  if (halted) {
    logger.warning(
      "  Accrual is halted. Holders are not earning. Renew with scripts/operator/setYieldRate.ts."
    );
  }

  // ---- 4. Supply / buffer ----
  logger.info("");
  logger.info("4. Supply and buffer");
  const supply: bigint = await (token as any).totalSupply();
  const supplyUi: bigint = await (token as any).totalSupplyUI();
  logger.info(`  totalSupply     ${ethers.formatEther(supply)} raw`);
  logger.info(`  totalSupplyUI   $${ethers.formatEther(supplyUi)}`);
  logger.info(`  totalAssets     ${ethers.formatUnits(await (token as any).totalAssets(), 6)} USDC`);
  logger.info(`  redeemableNow   ${ethers.formatEther(await (psm as any).redeemableNow())} raw`);
  logger.info(`  queued (raw)    ${ethers.formatEther(await (queue as any).totalQueuedRaw())}`);
  logger.info(`  queued (USDC)   ${ethers.formatUnits(await (queue as any).totalQueuedUsdc(), 6)}`);
  check("totalSupplyUI >= totalSupply (multiplier >= 1)", supplyUi >= supply);
  check(
    "queue escrow is backed",
    (await (queue as any).totalQueuedRaw()) <= (await (token as any).balanceOf(queueAddr))
  );

  // ---- 5. Oracle adapter ----
  if (adapterAddr) {
    logger.info("");
    logger.info("5. Oracle adapter");
    const adapter = await ethers.getContractAt("OkuMultiplierAdapter", adapterAddr);
    check("decimals() == 18 (NOT Chainlink's usual 8)", Number(await (adapter as any).decimals()) === 18);
    const healthy: boolean = await (adapter as any).isHealthy();
    check("isHealthy()", healthy);
    if (healthy) {
      const [, answer] = await (adapter as any).latestRoundData();
      check("answer == uiMultiplier", BigInt(answer) === multiplier);
    } else {
      logger.warning("  Adapter unhealthy — out of bounds or stale. Consumers will revert.");
    }
  } else {
    logger.warning("5. Oracle adapter not in the address book — skipping");
  }

  // ---- 6. Write path ----
  if (!WRITE) {
    logger.info("");
    logger.info("6. Write path skipped (pass --write to exercise mint/redeem)");
  } else {
    logger.info("");
    logger.info("6. Write path");
    const [signer] = await ethers.getSigners();
    const who = await signer.getAddress();
    const usdcAddr = await (token as any).asset();
    const usdc = await ethers.getContractAt("MockUSDC", usdcAddr);
    const decimals = Number(await (usdc as any).decimals());
    const amount = ethers.parseUnits(USDC_AMOUNT, decimals);

    if ((await (usdc as any).balanceOf(who)) < amount) {
      logger.warning(`  Insufficient USDC for ${who} — skipping write path`);
    } else {
      const quotedRaw: bigint = await (psm as any).quoteMint(amount);
      await (await (usdc as any).connect(signer).approve(psmAddr, amount)).wait(1);
      await (await (psm as any).connect(signer).mint(amount)).wait(1);
      const rawAfter: bigint = await (token as any).balanceOf(who);
      check("mint output matches quoteMint", rawAfter >= quotedRaw, `raw=${rawAfter}`);

      // THE MAX-SEND RULE, demonstrated both ways.
      const uiBal: bigint = await (token as any).balanceOfUI(who);
      const wrongWay: bigint = await (token as any).fromUIAmount(uiBal);
      check(
        "round-tripping the display layer never exceeds the raw balance",
        wrongWay <= rawAfter,
        `raw=${rawAfter} viaUI=${wrongWay} (delta ${rawAfter - wrongWay} wei)`
      );

      // Redeem the correct way: derived from raw.
      const quotedUsdc: bigint = await (psm as any).quoteRedeem(rawAfter);
      const capacity: bigint = await (psm as any).redeemableNow();
      if (rawAfter > capacity) {
        logger.warning("  Buffer short — redeem would queue; skipping to keep the run clean");
      } else {
        const usdcBefore: bigint = await (usdc as any).balanceOf(who);
        await (await (token as any).connect(signer).approve(psmAddr, rawAfter)).wait(1);
        await (await (psm as any).connect(signer).redeem(rawAfter)).wait(1);
        const gained = (await (usdc as any).balanceOf(who)) - usdcBefore;
        check("redeem output matches quoteRedeem", gained === quotedUsdc, `usdc=${gained}`);
        check(
          "raw max-redeem clears the balance exactly",
          (await (token as any).balanceOf(who)) === 0n
        );
      }
    }
  }

  logger.info("");
  if (failures === 0) {
    logger.success("Smoke test passed");
  } else {
    throw new Error(`${failures} smoke check(s) failed`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e?.message ?? String(e));
    process.exit(1);
  });
