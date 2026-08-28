/**
 * On-chain / fork walkthrough of the reviewed-conversion lifecycle.
 *
 * Exercises the real deployed proxies end to end, in the order an operator
 * would actually drive them. Intended for a local fork first, then a testnet.
 *
 * Steps (run all, or one at a time with --step=<name>):
 *
 *   state          Read every proxy's headline state and the solvency invariant.
 *   subscribe      requestSubscription -> fulfillSubscription. Proves pricing
 *                  happens at fulfilment against the live M_oku.
 *   mark           setOkuMultiplier. An oracle write; raises realized backing.
 *   wrap           OkuM -> USDOku through the wrapper, priced at M_oku.
 *   fund           Pre-fund the wrapper with OkuM (required before any rate).
 *   rate           setUsdOkuRate. Reverts unless the projected liability is
 *                  already covered - that is the whole point of pre-funding.
 *   unwrap         USDOku -> OkuM, priced at M_oku and never at M_usd.
 *   redeem         requestRedemption -> fulfillRedemption, paid from treasury.
 *   reject         requestSubscription -> rejectRequest, full refund, no fee.
 *   cancel         requestSubscription -> cancelRequest after MIN_CANCEL_DELAY.
 *
 * Usage:
 *   NETWORK=sepolia npx hardhat run scripts/test/test-onchain.ts --network localhost
 *   NETWORK=sepolia npx hardhat run scripts/test/test-onchain.ts --network sepolia --step=state
 */

import { ethers, network } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { DEV_WALLET_ADDRESS } from "../config/chains";

const PRECISION = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const MIN_CANCEL_DELAY = 3600;

const ALL_STEPS = [
  "state", "subscribe", "mark", "wrap", "fund", "rate", "unwrap", "redeem", "reject", "cancel",
] as const;
type Step = (typeof ALL_STEPS)[number];

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : process.env[name.toUpperCase()];
}

const DRY_RUN = process.env.DRY_RUN === "true";
const YES_MAINNET = process.argv.includes("--yes-mainnet");

/** Fork-only: jump forward so cancellation delays and rate segments elapse. */
async function warp(seconds: number, isFork: boolean): Promise<boolean> {
  if (!isFork) return false;
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
  return true;
}

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`On-chain walkthrough (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const isFork = ctx.isFork || network.name === "localhost" || network.name === "hardhat";

  for (const name of ["OkuM", "USDOku", "USDOkuWrapper", "SubscriptionModule", "MockUSDC"]) {
    if (!hasAddress(ctx.bookKey, name)) {
      throw new Error(`Missing ${name} in the address book for "${ctx.bookKey}". Deploy first.`);
    }
  }

  // On a fork, the deploy script runs as the impersonated dev wallet, so that
  // is the account holding every operational role. Impersonate the same account
  // here or every role-gated step reverts AccessControlUnauthorizedAccount.
  let signer;
  if (isFork) {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET_ADDRESS],
    });
    await network.provider.send("hardhat_setBalance", [
      DEV_WALLET_ADDRESS,
      "0x21e19e0c9bab2400000", // 10k ETH, so gas never limits the walkthrough
    ]);
    signer = await ethers.getSigner(DEV_WALLET_ADDRESS);
    logger.info(`Impersonating role holder: ${DEV_WALLET_ADDRESS}`);
  } else {
    [signer] = await ethers.getSigners();
  }
  const me = await signer.getAddress();

  const okuM = (await getDeployedContract("OkuM", loadAddress(ctx.bookKey, "OkuM")!)).connect(signer) as any;
  const usdOku = (await getDeployedContract("USDOku", loadAddress(ctx.bookKey, "USDOku")!)).connect(signer) as any;
  const wrapper = (await getDeployedContract("USDOkuWrapper", loadAddress(ctx.bookKey, "USDOkuWrapper")!)).connect(signer) as any;
  const mod = (await getDeployedContract("SubscriptionModule", loadAddress(ctx.bookKey, "SubscriptionModule")!)).connect(signer) as any;
  const usdc = (await getDeployedContract("MockUSDC", loadAddress(ctx.bookKey, "MockUSDC")!)).connect(signer) as any;

  const only = parseArg("step") as Step | undefined;
  if (only && !ALL_STEPS.includes(only)) {
    throw new Error(`--step must be one of: ${ALL_STEPS.join(", ")}`);
  }
  const steps: Step[] = only ? [only] : [...ALL_STEPS];
  const should = (s: Step) => steps.includes(s);

  const showSolvency = async () => {
    const covers = await wrapper.backingCoversLiability();
    logger.info(`  liability ${ethers.formatUnits(await wrapper.declaredLiability(), 18)} | backing ${ethers.formatUnits(await wrapper.realizedBacking(), 18)} | covers: ${covers}`);
    if (!covers) logger.error("  SOLVENCY INVARIANT VIOLATED");
  };

  // ---- state --------------------------------------------------------------
  if (should("state")) {
    logger.section("state");
    logger.info(`  M_oku:  ${ethers.formatUnits(await okuM.uiMultiplier(), 18)} (epoch ${await okuM.syncEpoch()})`);
    logger.info(`  M_usd:  ${ethers.formatUnits(await usdOku.usdOkuIndex(), 18)}`);
    logger.info(`  OkuM supply: ${ethers.formatUnits(await okuM.totalSupply(), 18)} / cap ${ethers.formatUnits(await okuM.maxSupply(), 18)}`);
    logger.info(`  USDOku supply: ${ethers.formatUnits(await usdOku.totalSupply(), 18)}`);
    logger.info(`  treasury: ${await mod.treasury()}  tin/tout: ${await mod.tinBps()}/${await mod.toutBps()}`);
    await showSolvency();
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — state only, no transactions submitted");
    return;
  }

  // ---- subscribe ----------------------------------------------------------
  if (should("subscribe")) {
    logger.section("subscribe");
    const amount = 100n * USDC_UNIT;
    await (await usdc.mint(me, amount)).wait();
    await (await usdc.approve(await mod.getAddress(), amount)).wait();

    const before = await okuM.balanceOf(me);
    // One pending request per (user, direction) is enforced on-chain, so a
    // leftover from an earlier run must be reused rather than re-requested.
    let id: bigint = await mod.pendingRequestOf(me, 0);
    if (id !== 0n) {
      logger.warning(`  reusing existing pending subscription id=${id}`);
    } else {
      const tx = await (await mod.requestSubscription(amount, 0)).wait();
      id = await mod.pendingRequestOf(me, 0);
      logger.info(`  requested id=${id} (tx ${tx.hash})`);
    }

    await (await mod.fulfillSubscription(id)).wait();
    const minted = (await okuM.balanceOf(me)) - before;
    logger.success(`  fulfilled: +${ethers.formatUnits(minted, 18)} OkuM at M_oku ${ethers.formatUnits(await okuM.uiMultiplier(), 18)}`);
  }

  // ---- mark ---------------------------------------------------------------
  if (should("mark")) {
    logger.section("mark");
    const current: bigint = await okuM.uiMultiplier();
    const next = current + current / 1000n; // +10bps, well under MAX_STEP_BPS
    const epoch: bigint = (await okuM.syncEpoch()) + 1n;
    await (await okuM.setOkuMultiplier(next, epoch)).wait();
    logger.success(`  M_oku ${ethers.formatUnits(current, 18)} -> ${ethers.formatUnits(next, 18)} (epoch ${epoch})`);
    await showSolvency();
  }

  // ---- wrap ---------------------------------------------------------------
  if (should("wrap")) {
    logger.section("wrap");
    const bal: bigint = await okuM.balanceOf(me);
    const amount = bal / 4n;
    if (amount === 0n) {
      logger.warning("  no OkuM to wrap — run --step=subscribe first");
    } else {
      await (await okuM.approve(await wrapper.getAddress(), amount)).wait();
      const quoted = await wrapper.quoteWrap(amount);
      // Measure in SHARES, not balanceOf. USDOku rebases, so a balanceOf delta
      // across two blocks also captures accrual and would not equal the credit.
      // This is exactly the reason sharesOf is exposed - any integrator that
      // must survive a rebase needs the invariant quantity.
      const sharesBefore: bigint = BigInt(await usdOku.sharesOf(me));
      const idxBefore = await usdOku.usdOkuIndex();
      const returned = await wrapper.wrap.staticCall(amount, me, quoted);
      await (await wrapper.wrap(amount, me, quoted)).wait();
      const sharesGained: bigint = BigInt(await usdOku.sharesOf(me)) - sharesBefore;
      const creditedAtWrapIndex = (sharesGained * BigInt(idxBefore)) / PRECISION;
      logger.success(`  wrapped ${ethers.formatUnits(amount, 18)} OkuM -> ${ethers.formatUnits(returned, 18)} USDOku`);
      logger.info(`  shares gained: ${sharesGained} (~${ethers.formatUnits(creditedAtWrapIndex, 18)} at the wrap index)`);
      if (returned !== quoted) logger.error(`  quote/return mismatch: quoted ${quoted}, returned ${returned}`);
      await showSolvency();
    }
  }

  // ---- fund ---------------------------------------------------------------
  if (should("fund")) {
    logger.section("fund");
    const bal: bigint = await okuM.balanceOf(me);
    const amount = bal / 10n;
    if (amount === 0n) {
      logger.warning("  no OkuM to fund with — run --step=subscribe first");
    } else {
      await (await okuM.transfer(await wrapper.getAddress(), amount)).wait();
      logger.success(`  pre-funded wrapper with ${ethers.formatUnits(amount, 18)} OkuM`);
      logger.info(`  withdrawable surplus: ${ethers.formatUnits(await wrapper.withdrawableSurplus(), 18)}`);
      await showSolvency();
    }
  }

  // ---- rate ---------------------------------------------------------------
  if (should("rate")) {
    logger.section("rate");
    const days = 7n;
    const aprBps = 300n;
    const rate = PRECISION + ((PRECISION * aprBps) / 10_000n) / (365n * 24n * 3600n);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    try {
      await (await usdOku.setUsdOkuRate(rate, now + days * 24n * 3600n)).wait();
      logger.success(`  declared ${aprBps}bps for ${days} days`);
    } catch (e: any) {
      logger.error(`  rate rejected: ${e.shortMessage ?? e.message}`);
      logger.error("  This is the pre-funding requirement. Run --step=fund first.");
    }
    await showSolvency();
  }

  // ---- unwrap -------------------------------------------------------------
  if (should("unwrap")) {
    logger.section("unwrap");
    await warp(3 * 24 * 3600, isFork);
    const bal: bigint = await usdOku.balanceOf(me);
    if (bal === 0n) {
      logger.warning("  no USDOku to unwrap — run --step=wrap first");
    } else {
      const before = await okuM.balanceOf(me);
      // Full balance: under pre-funding this must always succeed.
      await (await wrapper.unwrap(bal, me)).wait();
      const got = (await okuM.balanceOf(me)) - before;
      logger.success(`  unwrapped ${ethers.formatUnits(bal, 18)} USDOku -> ${ethers.formatUnits(got, 18)} OkuM`);
      await showSolvency();
    }
  }

  // ---- redeem -------------------------------------------------------------
  if (should("redeem")) {
    logger.section("redeem");
    const bal: bigint = await okuM.balanceOf(me);
    const amount = bal / 4n;
    if (amount === 0n) {
      logger.warning("  no OkuM to redeem — run --step=subscribe first");
    } else {
      // Redemption is funded from treasury via allowance, which has no on-chain
      // default. If we happen to BE the treasury (the usual fork case), set it
      // so the step exercises the real path instead of the wiring gap.
      const treasuryAddr = await mod.treasury();
      if (treasuryAddr.toLowerCase() === me.toLowerCase()) {
        const current = await usdc.allowance(me, await mod.getAddress());
        if (current === 0n) {
          await (await usdc.mint(me, 1_000_000n * USDC_UNIT)).wait();
          await (await usdc.approve(await mod.getAddress(), ethers.MaxUint256)).wait();
          logger.info("  signer is the treasury — set USDC allowance for the module");
        }
      }
      await (await okuM.approve(await mod.getAddress(), amount)).wait();
      const before = await usdc.balanceOf(me);
      let id: bigint = await mod.pendingRequestOf(me, 1);
      if (id !== 0n) {
        logger.warning(`  reusing existing pending redemption id=${id}`);
      } else {
        await (await mod.requestRedemption(amount, 0)).wait();
        id = await mod.pendingRequestOf(me, 1);
        logger.info(`  requested id=${id}`);
      }
      try {
        const treasuryIsSelf = (await mod.treasury()).toLowerCase() === me.toLowerCase();
        await (await mod.fulfillRedemption(id)).wait();
        const paid = (await usdc.balanceOf(me)) - before;
        logger.success(`  fulfilled: +${ethers.formatUnits(paid, 6)} USDC`);
        if (treasuryIsSelf) {
          logger.info("  (signer is also the treasury, so the USDC transfer nets to zero)");
        }
      } catch (e: any) {
        logger.error(`  fulfilment failed: ${e.shortMessage ?? e.message}`);
        logger.error("  Most likely the treasury has not approved the module.");
      }
    }
  }

  // ---- reject -------------------------------------------------------------
  if (should("reject")) {
    logger.section("reject");
    if ((await mod.pendingRequestOf(me, 0)) !== 0n) {
      logger.warning("  a subscription is already pending — resolve it first; skipping");
    } else {
    const amount = 10n * USDC_UNIT;
    await (await usdc.mint(me, amount)).wait();
    await (await usdc.approve(await mod.getAddress(), amount)).wait();
    const before = await usdc.balanceOf(me);
    await (await mod.requestSubscription(amount, 0)).wait();
    const id = await mod.pendingRequestOf(me, 0);
    await (await mod.rejectRequest(id, ethers.keccak256(ethers.toUtf8Bytes("WALKTHROUGH")))).wait();
    const after = await usdc.balanceOf(me);
    logger.success(`  rejected id=${id}; refunded exactly: ${after === before}`);
    }
  }

  // ---- cancel -------------------------------------------------------------
  if (should("cancel")) {
    logger.section("cancel");
    if ((await mod.pendingRequestOf(me, 0)) !== 0n) {
      logger.warning("  a subscription is already pending — resolve it first; skipping");
    } else {
    const amount = 10n * USDC_UNIT;
    await (await usdc.mint(me, amount)).wait();
    await (await usdc.approve(await mod.getAddress(), amount)).wait();
    const before = await usdc.balanceOf(me);
    await (await mod.requestSubscription(amount, 0)).wait();
    const id = await mod.pendingRequestOf(me, 0);

    if (await warp(MIN_CANCEL_DELAY + 1, isFork)) {
      await (await mod.cancelRequest(id)).wait();
      logger.success(`  cancelled id=${id}; refunded exactly: ${(await usdc.balanceOf(me)) === before}`);
    } else {
      logger.warning(`  live network: wait ${MIN_CANCEL_DELAY}s then cancelRequest(${id}) manually`);
    }
    }
  }

  logger.header("Walkthrough complete");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e?.message ?? String(e));
    console.error(e);
    process.exit(1);
  });
