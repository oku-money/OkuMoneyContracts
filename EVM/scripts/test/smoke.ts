/**
 * On-chain smoke test for a fresh OkuMoney (v0.4) deployment.
 *
 * Exercises, in order:
 *   1. ERC-165 capability detection — the thing every wallet does first, and the
 *      one probe the two tokens must answer DIFFERENTLY
 *   2. Value/display parity — the invariant tying ERC-8056 to the 4626 views
 *   3. Index state on both legs, and the relationship between them
 *   4. Supply, buffer and queue
 *   5. Wrapper solvency
 *   6. Oracle adapter health
 *   7. Fail-closed wiring (the three writes without which nothing works)
 *   8. THE FULL WRITE PATH: mint -> step M_oku -> wrap -> unwrap -> redeem
 *
 * Read-only unless `--write` is passed. Default is a diagnostic sweep safe to
 * run against any deployment, including mainnet.
 *
 * THE WRITE PATH STEPS THE MULTIPLIER, which is an oracle write and is
 * irreversible (`M_oku` is strictly monotone — there is no way back down short
 * of an upgrade). It is therefore behind both `--write` and the standard mainnet
 * guard. On a local fork the script time-travels past the sync window the step
 * arms; on a live network it waits it out, which is why a `--write` run there
 * takes a minute or so of wall clock.
 *
 * Usage:
 *   npx hardhat run scripts/test/smoke.ts --network sepolia
 *   WRITE=true USDC=10 npx hardhat run scripts/test/smoke.ts --network sepolia
 *
 * Every flag has a SCREAMING_SNAKE env equivalent, matching the operator
 * scripts, because Hardhat v2's `hardhat run` rejects unknown CLI flags before
 * the script ever sees them. The `--write` / `--usdc` forms only reach us when
 * the script is invoked directly:
 *   HARDHAT_NETWORK=localhost npx ts-node --files scripts/test/smoke.ts --write --usdc 10
 *
 * Environment:
 *   WRITE=true       exercise the write path (irreversible M_oku step)
 *   USDC=<amount>    subscription size in whole USDC (default 10)
 *   YES_MAINNET=true bypass the mainnet guard on a --write run
 */

import { ethers, network } from "hardhat";

import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { resolveOperatorSigner } from "../operator/_shared";

const WRITE = process.argv.includes("--write") || process.env.WRITE === "true";
const YES_MAINNET =
  process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";
const USDC_AMOUNT = (() => {
  const f = process.argv.find((x) => x.startsWith("--usdc"));
  if (f) {
    const v = f.includes("=")
      ? f.split("=")[1]
      : process.argv[process.argv.indexOf(f) + 1];
    if (v) return v;
  }
  return process.env.USDC ?? "10";
})();

const IID = {
  core: "0xa60bf13d",
  pending: "0x4bd27648",
  conversion: "0x57854fc3",
  balances: "0xd890fd71",
};

const PRECISION = 10n ** 18n;
const BASIS_POINTS = 10_000n;
const MAX_STEP_BPS = 100n;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) logger.success(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    logger.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

/**
 * Get past a post-step sync window.
 *
 * On a fork we jump the clock, which is the only way to keep a rehearsal fast.
 * On a live network there is nothing to do but wait: the window has no close
 * instruction by design (each chain fences itself and the lock auto-expires),
 * so "wait it out" is the entire recovery procedure and is bounded by
 * MAX_SYNC_WINDOW at 15 minutes.
 */
async function waitOutSyncWindow(okuM: any, isFork: boolean): Promise<void> {
  if (!(await okuM.isSyncLocked())) return;

  const until: bigint = await okuM.syncLockedUntil();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const remaining = until > now ? until - now : 0n;

  if (isFork) {
    logger.info(`  Sync window engaged for ${remaining}s — advancing fork clock past it`);
    await network.provider.send("evm_increaseTime", [Number(remaining) + 1]);
    await network.provider.send("evm_mine", []);
  } else {
    logger.info(
      `  Sync window engaged for ${remaining}s — waiting it out (there is no close ` +
        `instruction; the lock auto-expires)`
    );
    await new Promise((r) => setTimeout(r, (Number(remaining) + 3) * 1000));
  }

  if (await okuM.isSyncLocked()) {
    throw new Error("Still sync-locked after waiting out the window; investigate.");
  }
}

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(
    `OkuMoney smoke test (${ctx.networkName})${WRITE ? " [WRITE]" : " [read-only]"}`
  );

  // The write path performs an irreversible oracle write. Read-only runs are
  // safe anywhere and skip the guard entirely.
  if (WRITE) {
    mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: false });
  }

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  const moduleAddr = loadAddress(ctx.bookKey, "SubscriptionModule");
  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  const usdOkuAddr = loadAddress(ctx.bookKey, "USDOku");
  const wrapperAddr = loadAddress(ctx.bookKey, "USDOkuWrapper");
  if (!okuMAddr || !moduleAddr || !queueAddr || !usdOkuAddr || !wrapperAddr) {
    throw new Error(`Incomplete address book for ${ctx.bookKey}`);
  }
  const adapterAddr = hasAddress(ctx.bookKey, "OkuMultiplierAdapter")
    ? loadAddress(ctx.bookKey, "OkuMultiplierAdapter")
    : undefined;

  const okuM = (await ethers.getContractAt("OkuM", okuMAddr)) as any;
  const moduleContract = (await ethers.getContractAt("SubscriptionModule", moduleAddr)) as any;
  const queue = (await ethers.getContractAt("RedemptionQueue", queueAddr)) as any;
  const usdOku = (await ethers.getContractAt("USDOku", usdOkuAddr)) as any;
  const wrapper = (await ethers.getContractAt("USDOkuWrapper", wrapperAddr)) as any;

  // ---- 1. Capability detection ----
  logger.info("");
  logger.info("1. ERC-165 capability detection");
  for (const [name, id] of Object.entries(IID)) {
    check(`OkuM supportsInterface(${name}=${id})`, await okuM.supportsInterface(id));
  }
  // The load-bearing negative. USDOku's balanceOf already returns dollars, so an
  // 8056-aware wallet that saw this as true would scale an already-scaled
  // balance and display the value squared.
  check(
    `USDOku does NOT advertise ERC-8056 (${IID.core})`,
    (await usdOku.supportsInterface(IID.core)) === false
  );
  check(
    "OkuM metadata",
    (await okuM.symbol()) === "OkuM",
    `name="${await okuM.name()}" symbol="${await okuM.symbol()}"`
  );
  check(
    "USDOku metadata",
    (await usdOku.symbol()) === "USDOku",
    `name="${await usdOku.name()}" symbol="${await usdOku.symbol()}"`
  );

  // ---- 2. Value / display parity ----
  logger.info("");
  logger.info("2. Value / display parity");
  const multiplier: bigint = await okuM.uiMultiplier();
  const dm: bigint = await okuM.usdcDecimalMultiplier();
  const cta: bigint = await okuM.convertToAssets(PRECISION);
  check(
    "convertToAssets(1e18) * dm <= uiMultiplier < (cta+1) * dm",
    cta * dm <= multiplier && multiplier < (cta + 1n) * dm,
    `m=${ethers.formatEther(multiplier)} cta=${cta} dm=${dm}`
  );
  const okuMAsset: string = await okuM.asset();
  check(
    "asset() agrees across OkuM / module / queue",
    okuMAsset.toLowerCase() === (await moduleContract.usdc()).toLowerCase() &&
      okuMAsset.toLowerCase() === (await queue.usdc()).toLowerCase()
  );
  check(
    "decimalMultiplier agrees across all three",
    dm === (await moduleContract.usdcDecimalMultiplier()) &&
      dm === (await queue.usdcDecimalMultiplier())
  );
  check(
    "wrapper is bound to this OkuM and this USDOku",
    (await wrapper.okuM()).toLowerCase() === okuMAddr.toLowerCase() &&
      (await wrapper.usdOku()).toLowerCase() === usdOkuAddr.toLowerCase()
  );

  // ---- 3. The two indices ----
  logger.info("");
  logger.info("3. Index state");
  const pending: bigint = await okuM.newUIMultiplier();
  const effectiveAt: bigint = await okuM.effectiveAt();
  const lastStepped: bigint = await okuM.lastSteppedAt();
  const highWater: bigint = await okuM.stepHighWaterMark();
  const halted: boolean = await okuM.accrualHalted();
  const mUsd: bigint = await usdOku.usdOkuIndex();
  const usdRate: bigint = await usdOku.ratePerSecond();
  const usdRateEnd: bigint = await usdOku.rateEnd();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.info(`  M_oku (stepwise)   ${ethers.formatEther(multiplier)}`);
  logger.info(`    lastSteppedAt    ${new Date(Number(lastStepped) * 1000).toISOString()}`);
  logger.info(`    stepHighWaterMark ${highWater}bps`);
  logger.info(`    accrualHalted    ${halted}`);
  logger.info(`  M_usd (continuous) ${ethers.formatEther(mUsd)}`);
  logger.info(`    ratePerSecond    ${usdRate}`);
  logger.info(`    impliedAprBps    ${await usdOku.impliedAprBps()}`);
  logger.info(
    `    rateEnd          ${new Date(Number(usdRateEnd) * 1000).toISOString()}` +
      `${now >= usdRateEnd ? "  [STOPPED]" : ""}`
  );

  // Steps are immediate, so the ERC-8056 pending extension is degenerate and
  // this equality is an invariant rather than a genesis coincidence.
  check("M_oku: uiMultiplier == newUIMultiplier (steps are immediate)", multiplier === pending);
  check("M_oku: effectiveAt == lastSteppedAt", effectiveAt === lastStepped);
  if (now >= usdRateEnd) {
    logger.warning(
      "  USDOku accrual has lapsed past rateEnd — dollar-leg holders are not " +
        "earning. Renew with scripts/operator/setUsdOkuRate.ts."
    );
  }
  if (halted) {
    logger.warning(
      "  OkuM stepping is HALTED by the guardian. Cold must call resumeAccrual " +
        "(scripts/operator/resumeAccrual.ts) before yield can be marked again."
    );
  }

  // ---- 4. Supply, buffer and queue ----
  logger.info("");
  logger.info("4. Supply, buffer and queue");
  const supply: bigint = await okuM.totalSupply();
  const supplyUi: bigint = await okuM.totalSupplyUI();
  const usdcDecimals = Number(
    await (await ethers.getContractAt("MockUSDC", okuMAsset)).decimals()
  );
  logger.info(`  OkuM totalSupply    ${ethers.formatEther(supply)} raw`);
  logger.info(`  OkuM totalSupplyUI  $${ethers.formatEther(supplyUi)}`);
  logger.info(
    `  OkuM totalAssets    ${ethers.formatUnits(await okuM.totalAssets(), usdcDecimals)} USDC`
  );
  logger.info(`  USDOku totalSupply  $${ethers.formatEther(await usdOku.totalSupply())}`);
  logger.info(`  USDOku totalShares  ${ethers.formatEther(await usdOku.totalShares())}`);
  logger.info(`  redeemableNow       ${ethers.formatEther(await moduleContract.redeemableNow())} raw`);
  logger.info(`  fees                tin=${await moduleContract.tin()}bps tout=${await moduleContract.tout()}bps`);
  logger.info(`  queued (raw)        ${ethers.formatEther(await queue.totalQueuedRaw())}`);
  logger.info(
    `  queued (USDC)       ${ethers.formatUnits(await queue.totalQueuedUsdc(), usdcDecimals)}`
  );
  check("totalSupplyUI >= totalSupply (M_oku >= 1)", supplyUi >= supply);
  check(
    "queue escrow is backed",
    (await queue.totalQueuedRaw()) <= (await okuM.balanceOf(queueAddr))
  );

  // ---- 5. Wrapper solvency ----
  logger.info("");
  logger.info("5. Wrapper solvency");
  const liability: bigint = await wrapper.declaredLiability();
  const backing: bigint = await wrapper.realizedBacking();
  const gapBps: bigint = await wrapper.solvencyGapBps();
  logger.info(`  declaredLiability   $${ethers.formatEther(liability)}`);
  logger.info(`  realizedBacking     $${ethers.formatEther(backing)}`);
  logger.info(`  solvencyGapBps      ${gapBps}`);
  logger.info(`  wrapEnabled         ${await wrapper.wrapEnabled()}`);
  check(
    "solvency gap within MAX_SOLVENCY_GAP_BPS (100)",
    gapBps <= 100n,
    `gap=${gapBps}`
  );
  check(
    "wrapper OkuM holding matches realizedBacking at M_oku",
    (await okuM.toUIAmount(await okuM.balanceOf(wrapperAddr))) === backing
  );

  // ---- 6. Oracle adapter ----
  if (adapterAddr) {
    logger.info("");
    logger.info("6. Oracle adapter");
    const adapter = (await ethers.getContractAt("OkuMultiplierAdapter", adapterAddr)) as any;
    check("decimals() == 18 (NOT Chainlink's usual 8)", Number(await adapter.decimals()) === 18);
    check(
      "adapter points at this OkuM",
      (await adapter.token()).toLowerCase() === okuMAddr.toLowerCase()
    );
    const healthy: boolean = await adapter.isHealthy();
    check("isHealthy()", healthy);
    if (healthy) {
      const [, answer] = await adapter.latestRoundData();
      check("answer == uiMultiplier", BigInt(answer) === multiplier);
    } else {
      logger.warning(
        "  Adapter unhealthy — out of bounds, or the last step is older than the " +
          "7-day staleness threshold. Consumers will revert."
      );
    }
  } else {
    logger.warning("6. Oracle adapter not in the address book — skipping");
  }

  // ---- 7. Fail-closed wiring ----
  logger.info("");
  logger.info("7. Fail-closed wiring");
  const feeSource: string = await okuM.stepFeeSource();
  const solvencySource: string = await usdOku.solvencySource();
  const tin: bigint = await moduleContract.tin();
  const tout: bigint = await moduleContract.tout();
  check(
    "okuM.stepFeeSource == SubscriptionModule",
    feeSource.toLowerCase() === moduleAddr.toLowerCase(),
    `else every setOkuMultiplier reverts StepNotCovered (got ${feeSource})`
  );
  check(
    "usdOku.solvencySource == USDOkuWrapper",
    solvencySource.toLowerCase() === wrapperAddr.toLowerCase(),
    `else setUsdOkuRate reverts SolvencyGapExceeded (got ${solvencySource})`
  );
  check(
    "tin + tout > 0",
    tin + tout > 0n,
    `coverage=${tin + tout}bps; at zero, NO multiplier step is possible`
  );
  check(
    "tin + tout >= stepHighWaterMark (fee ratchet holds)",
    tin + tout >= highWater,
    `coverage=${tin + tout}bps floor=${highWater}bps`
  );

  // ---- 8. Write path: the full round trip ----
  if (!WRITE) {
    logger.info("");
    logger.info(
      "8. Write path skipped (pass --write to exercise mint -> step -> wrap -> " +
        "unwrap -> redeem). NOTE: --write performs an irreversible M_oku step."
    );
  } else {
    logger.info("");
    logger.info("8. Write path: mint -> step M_oku -> wrap -> unwrap -> redeem");

    // Reuse the operator signer resolution rather than `getSigners()[0]`: on a
    // fork the mnemonic accounts hold neither USDC nor OKU_RATE_SETTER, so the
    // write path would degrade to a no-op that reports success. The dev wallet
    // is the account testnet deploys grant everything to.
    const signer = await resolveOperatorSigner(ctx.isFork);
    const who = await signer.getAddress();
    const usdc = (await ethers.getContractAt("MockUSDC", okuMAsset)).connect(signer) as any;
    const amount = ethers.parseUnits(USDC_AMOUNT, usdcDecimals);

    // Self-fund on a fork. MockUSDC has an unprotected `mint`, which is exactly
    // why it is test-only; on a live network (or against real USDC) this fails
    // and we fall through to the skip below rather than pretending.
    if (ctx.isFork && (await usdc.balanceOf(who)) < amount) {
      try {
        await (await usdc.mint(who, amount * 10n)).wait(1);
        logger.info(`  Fork: minted ${ethers.formatUnits(amount * 10n, usdcDecimals)} MockUSDC to ${who}`);
      } catch {
        logger.warning("  Fork: asset is not MockUSDC-shaped; cannot self-fund");
      }
    }

    if ((await usdc.balanceOf(who)) < amount) {
      logger.warning(`  Insufficient USDC for ${who} — skipping write path`);
    } else {
      await waitOutSyncWindow(okuM, ctx.isFork);

      // ---- 8a. Subscribe ----
      // Recorded so the round-trip economics check at the end knows whether the
      // final position is attributable to THIS run's deposit. Re-running against
      // a deployment where the wallet already holds either leg makes
      // `gained - amount` meaningless, and asserting on it anyway would be a
      // flaky check. Both legs matter: a leftover USDOku balance ends up back in
      // OkuM at the unwrap step and inflates the redemption.
      const rawBeforeMint: bigint = await okuM.balanceOf(who);
      const usdOkuBeforeRun: bigint = await usdOku.sharesOf(who);
      const cleanStart = rawBeforeMint === 0n && usdOkuBeforeRun === 0n;
      const quotedRaw: bigint = await moduleContract.quoteMint(amount);
      await (await usdc.approve(moduleAddr, amount)).wait(1);
      await (await moduleContract.connect(signer).mint(amount)).wait(1);
      const rawAfterMint: bigint = await okuM.balanceOf(who);
      check(
        "mint output matches quoteMint",
        rawAfterMint - rawBeforeMint >= quotedRaw,
        `minted=${rawAfterMint - rawBeforeMint}`
      );

      // THE MAX-SEND RULE, demonstrated both ways. Round-tripping through the
      // display layer must never exceed the raw balance — it stays benign only
      // because `fromUIAmount` floors.
      const uiBal: bigint = await okuM.balanceOfUI(who);
      const wrongWay: bigint = await okuM.fromUIAmount(uiBal);
      check(
        "round-tripping the display layer never exceeds the raw balance",
        wrongWay <= rawAfterMint,
        `raw=${rawAfterMint} viaUI=${wrongWay} (delta ${rawAfterMint - wrongWay} wei)`
      );

      // ---- 8b. Step M_oku ----
      // Sized to what coverage allows, capped at MAX_STEP_BPS. This is the whole
      // step-coverage rule in one expression: the largest legal mark is
      // min(tin + tout, MAX_STEP_BPS).
      const coverage = tin + tout;
      const stepSize = coverage > MAX_STEP_BPS ? MAX_STEP_BPS : coverage;
      let stepped = false;

      if (halted) {
        logger.warning("  Stepping skipped: accrual is halted (AccrualIsHalted).");
      } else if (stepSize === 0n) {
        logger.warning(
          "  Stepping skipped: zero coverage, so no step is possible. This is the " +
            "fail-closed behaviour, not a bug — set fees first."
        );
      } else if (!(await okuM.hasRole(ROLES.OKU_RATE_SETTER, who))) {
        logger.warning(`  Stepping skipped: ${who} does not hold OKU_RATE_SETTER on OkuM.`);
      } else {
        const before: bigint = await okuM.uiMultiplier();
        // Round the target up so the realized step is at least `stepSize` bps,
        // matching the ceilDiv the contract uses to measure it.
        const target = before + (before * stepSize + BASIS_POINTS - 1n) / BASIS_POINTS;
        const supplyBefore: bigint = await okuM.totalSupplyUI();

        await (await okuM.connect(signer).setOkuMultiplier(target)).wait(1);
        stepped = true;

        const after: bigint = await okuM.uiMultiplier();
        check("M_oku stepped up", after === target, `${ethers.formatEther(before)} -> ${ethers.formatEther(after)}`);
        check("uiMultiplier == newUIMultiplier after the step", after === (await okuM.newUIMultiplier()));
        check("stepHighWaterMark ratcheted", (await okuM.stepHighWaterMark()) >= stepSize);
        check(
          "raw balance unchanged by a step; only its dollar value moved",
          (await okuM.balanceOf(who)) === rawAfterMint,
          `totalSupplyUI $${ethers.formatEther(supplyBefore)} -> $${ethers.formatEther(await okuM.totalSupplyUI())}`
        );
        check("the step armed the sync window", await okuM.isSyncLocked());

        // Everything downstream prices through the multiplier, so it is all
        // fenced until the window lifts. Prove the fence exists, then clear it.
        let wrapReverted = false;
        try {
          await wrapper.connect(signer).wrap.staticCall(1n);
        } catch {
          wrapReverted = true;
        }
        check("wrap is blocked while the sync window is engaged", wrapReverted);

        await waitOutSyncWindow(okuM, ctx.isFork);
      }

      // ---- 8c. Wrap ----
      const rawToWrap: bigint = await okuM.balanceOf(who);
      const quotedUsdOku: bigint = await wrapper.quoteWrap(rawToWrap);
      const usdOkuBefore: bigint = await usdOku.balanceOf(who);
      await (await okuM.connect(signer).approve(wrapperAddr, rawToWrap)).wait(1);
      await (await wrapper.connect(signer).wrap(rawToWrap)).wait(1);

      const usdOkuGained = (await usdOku.balanceOf(who)) - usdOkuBefore;
      // Floors on the share credit, so up to 1 wei below the quote.
      check(
        "wrap output matches quoteWrap (within 1 wei of share flooring)",
        usdOkuGained <= quotedUsdOku && quotedUsdOku - usdOkuGained <= 1n,
        `usdOku=${usdOkuGained} quoted=${quotedUsdOku}`
      );
      check("OkuM left the wallet on wrap", (await okuM.balanceOf(who)) === 0n);
      // A wrap adds equal liability and backing at the moment of conversion, so
      // it can only ever SHRINK the gap — which is why wrap is not
      // solvency-gated (that revert would be unreachable code).
      check(
        "wrap kept the solvency gap within bounds",
        (await wrapper.solvencyGapBps()) <= 100n,
        `gap=${await wrapper.solvencyGapBps()}`
      );

      // ---- 8d. Unwrap ----
      // Computed from `sharesOf`, not `balanceOf`: the max-send rule again, and
      // it bites harder here because a rebasing balance moves between the read
      // and the transaction with no transfer to observe.
      const shares: bigint = await usdOku.sharesOf(who);
      const index: bigint = await usdOku.usdOkuIndex();
      const unwrapAmount = (shares * index) / PRECISION;
      const quotedOkuM: bigint = await wrapper.quoteUnwrap(unwrapAmount);

      await (await usdOku.connect(signer).approve(wrapperAddr, unwrapAmount)).wait(1);
      await (await wrapper.connect(signer).unwrap(unwrapAmount)).wait(1);

      const okuMBack: bigint = await okuM.balanceOf(who);
      check(
        "unwrap output matches quoteUnwrap (within 1 wei of double flooring)",
        okuMBack <= quotedOkuM && quotedOkuM - okuMBack <= 1n,
        `okuM=${okuMBack} quoted=${quotedOkuM}`
      );
      // Both directions price at M_oku, so a round trip is value-neutral modulo
      // flooring — this is the load-bearing rule of the two-token design. It
      // would NOT hold if unwrap priced at M_usd.
      check(
        "wrap/unwrap round trip is value-neutral modulo flooring",
        okuMBack <= rawToWrap && rawToWrap - okuMBack <= 2n,
        `in=${rawToWrap} out=${okuMBack} (delta ${rawToWrap - okuMBack} wei)`
      );

      // ---- 8e. Redeem ----
      const quotedUsdcOut: bigint = await moduleContract.quoteRedeem(okuMBack);

      // Tested against the buffer balance, NOT against `redeemableNow()`.
      // `redeemableNow` is deliberately fee-free, which makes it a conservative
      // capacity bound rather than a settle/queue predicate: at a nonzero `tout`
      // it under-reports, because the fee reduces the USDC actually leaving the
      // buffer. The on-chain condition in `_redeem` is exactly
      // `usdc.balanceOf(module) >= usdcOut`, so mirror that.
      let bufferUsdc: bigint = await usdc.balanceOf(moduleAddr);
      logger.info(
        `  buffer ${ethers.formatUnits(bufferUsdc, usdcDecimals)} USDC vs payout ` +
          `${ethers.formatUnits(quotedUsdcOut, usdcDecimals)} ` +
          `(redeemableNow reports ${ethers.formatEther(await moduleContract.redeemableNow())} raw, ` +
          `fee-free and therefore conservative)`
      );

      // MARKING YIELD CREATES AN OBLIGATION THE BUFFER HAS TO FUND, and this is
      // where a smoke run makes that concrete: the deposit put N USDC in, the
      // step made the position worth more than N, so redeeming everything needs
      // more USDC than was ever deposited. That gap is exactly the realized
      // yield, and covering it is `depositBuffer`'s whole purpose.
      //
      // On a fork we top up and continue, which also exercises the buffer path.
      // On a live network we do NOT invent USDC — the redemption queues, which
      // is the correct behaviour and worth observing rather than papering over.
      if (quotedUsdcOut > bufferUsdc && ctx.isFork) {
        const shortfall = quotedUsdcOut - bufferUsdc;
        if (await moduleContract.hasRole(ROLES.PSM_BUFFER_DEPOSITOR, who)) {
          logger.info(
            `  Buffer short by ${ethers.formatUnits(shortfall, usdcDecimals)} USDC — ` +
              `that shortfall IS the marked yield. Funding it via depositBuffer.`
          );
          await (await usdc.mint(who, shortfall)).wait(1);
          await (await usdc.approve(moduleAddr, shortfall)).wait(1);
          await (await moduleContract.connect(signer).depositBuffer(shortfall)).wait(1);
          bufferUsdc = await usdc.balanceOf(moduleAddr);
          check("depositBuffer covered the shortfall", bufferUsdc >= quotedUsdcOut);
        } else {
          logger.warning(`  Buffer short and ${who} lacks PSM_BUFFER_DEPOSITOR — cannot top up`);
        }
      }

      if (quotedUsdcOut > bufferUsdc) {
        logger.warning(
          "  Buffer short — redeem would queue rather than settle; skipping to keep " +
            "the run clean. That is correct behaviour, not a failure: the escrowed " +
            "OkuM keeps appreciating until processQueue runs."
        );
      } else {
        const usdcBefore: bigint = await usdc.balanceOf(who);
        await (await okuM.connect(signer).approve(moduleAddr, okuMBack)).wait(1);
        await (await moduleContract.connect(signer).redeem(okuMBack)).wait(1);
        const gained = (await usdc.balanceOf(who)) - usdcBefore;
        check("redeem output matches quoteRedeem", gained === quotedUsdcOut, `usdc=${gained}`);
        check("raw max-redeem clears the balance exactly", (await okuM.balanceOf(who)) === 0n);

        // Round-trip economics, which is the number the fee schedule exists to
        // control. A step of `stepSize` bps against a round-trip fee of
        // `coverage` bps must not be profitable — that is step coverage working.
        const net = gained - amount;
        logger.info(
          `  Round trip: ${ethers.formatUnits(amount, usdcDecimals)} USDC in, ` +
            `${ethers.formatUnits(gained, usdcDecimals)} out ` +
            `(net ${net >= 0n ? "+" : ""}${ethers.formatUnits(net, usdcDecimals)})`
        );
        if (stepped && cleanStart) {
          check(
            "step coverage held: mint -> step -> redeem was not profitable",
            net <= 0n,
            `net=${ethers.formatUnits(net, usdcDecimals)} USDC across a ${stepSize}bps ` +
              `step with ${coverage}bps of coverage`
          );
        } else if (stepped) {
          logger.info(
            `  Round-trip profitability not asserted: the wallet already held ` +
              `${ethers.formatEther(rawBeforeMint)} raw OkuM and ` +
              `${ethers.formatEther(usdOkuBeforeRun)} USDOku shares before this run, ` +
              `so the payout is not attributable to this deposit. Re-run against a ` +
              `fresh deployment to exercise the step-coverage assertion.`
          );
        }
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
