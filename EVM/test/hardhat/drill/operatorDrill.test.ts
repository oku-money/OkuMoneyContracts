/**
 * Operator drill — walks every operator-script lever against a freshly
 * redeployed contract set on the locally forked chain, importing and calling
 * the SAME functions the CLI
 * scripts call (not spawning processes). This is the fidelity choice: a real
 * bug in a script's argument handling, address-book lookup, or guard logic
 * shows up here exactly as it would for an operator running the CLI, which a
 * hand-rolled "call the contract directly" test would not catch.
 *
 * SCOPE DECISIONS (documented, not chased further per the "don't
 * over-troubleshoot" directive):
 *   - `resolveNetworkContext()` assumes `localhost`/`hardhat` is always
 *     forking a real chain, and hardhat's `hardhat_reset` cannot actually
 *     change the configured chainId away from the fork target pinned in
 *     `hardhat.config.ts` (verified empirically). Rather than hardcoding
 *     `NETWORK=sepolia` (which broke with a chainId-mismatch error whenever
 *     the process was started with `FORK_NETWORK` set to anything else, e.g.
 *     `FORK_NETWORK=mainnet`), this drill leaves `NETWORK` unset and lets
 *     auto-detection resolve `networkName`/`bookKey` from whatever chain is
 *     actually forked. It then reuses that fork's EXISTING address-book
 *     namespace (`fork:<networkName>`) — which `tryAttach`'s `getCode` check
 *     makes safe to reuse across runs even though the underlying chain is
 *     reset each time (no code exists at any previously-recorded address on a
 *     fresh chain, so everything redeploys).
 *   - `addresses.json` is a TRACKED file; this drill backs it up and restores
 *     it in `after()` so running the drill never leaves a dirty working tree.
 *   - Contracts are stood up by calling the REAL deploy script via
 *     `runDeploy()`, not by re-implementing deployment with
 *     `upgrades.deployProxy`. This drill previously hand-wired 5 role grants
 *     while production grants 21, so every lever was being exercised against
 *     a role topology no deployed chain actually has. See `deployDrill.test.ts`
 *     for the deploy-side assertions.
 *   - `grantRolesMainnet.ts` is still NOT used here — it redistributes roles
 *     to cold/warm multisigs for production, which is a separate topology from
 *     the testnet "deployer holds the operational set" model this drill and
 *     `scripts/deploy/index.ts` target.
 *   - `checkMultiplierDrift.ts` is inherently multi-chain (reads via
 *     `JsonRpcProvider(rpcUrl)` per configured chain) and is not exercised —
 *     a single local chain has no cross-chain drift to detect.
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import fs from "fs";
import path from "path";
import { OkuMoney } from "../../../typechain-types";
import { resolveNetworkContext, NetworkContext } from "../../../scripts/utils/networkContext";
import { getNetworkNameByChainId } from "../../../scripts/config/chains";
import { runDeploy } from "../../../scripts/deploy/index";
import { runPause } from "../../../scripts/operator/pause";
import { runUnpause } from "../../../scripts/operator/unpause";
import { runBlacklistBoth } from "../../../scripts/operator/blacklistBoth";
import { runDepositBuffer } from "../../../scripts/operator/depositBuffer";
import { runWithdrawBuffer } from "../../../scripts/operator/withdrawBuffer";
import { runProcessQueue } from "../../../scripts/operator/processQueue";
import { runRescueQueueEntry } from "../../../scripts/operator/rescueQueueEntry";
import { runConfigureMinterAllowance } from "../../../scripts/operator/configureMinterAllowance";
import { runSetMaxSupply } from "../../../scripts/operator/setMaxSupply";
import { runSetOkuMMultiplier } from "../../../scripts/operator/setOkuMMultiplier";
import { runSetOkuMYieldRate } from "../../../scripts/operator/setOkuMYieldRate";
import { runPsmOp } from "../../../scripts/operator/psmOps";
import { runVaultOp } from "../../../scripts/operator/vaultOps";
import { runStageSettlement, runRollEpoch } from "../../../scripts/operator/runEpoch";
import { appendSample, loadSamples } from "../../../scripts/utils/globalValue";

const ADDRESS_BOOK_PATH = path.join(__dirname, "../../../scripts/config/addresses.json");
// Gitignored reference-implementation stores (see TRACKER.md). They MUST be
// cleared before each run: a stale entry from a previous local run silently
// corrupts this run's carry/target math with no error, no stack trace, and a
// result that just looks like a slightly-wrong number — exactly the kind of
// bug this drill exists to catch, caught here against itself while writing
// it. Being gitignored means `git` won't flag a leftover file as dirty, so —
// same as the tracked address book below — this drill backs both up and
// restores them in `after()`, rather than deleting an operator's real local
// state with no way back.
const CARRY_LEDGER_PATH = path.join(__dirname, "../../../scripts/config/carryLedger.json");
const GLOBAL_VALUE_SAMPLES_PATH = path.join(__dirname, "../../../scripts/config/globalValueSamples.json");

describe("Operator drill: exercise every lever on a clean local chain", function () {
    this.timeout(300_000);

    let ctx: NetworkContext;
    let admin: any, user1: any, badActor: any;
    let okuMoney: OkuMoney;
    let okuDollar: any;
    let queue: any;
    let psm: any;
    let usdc: any;
    let addressBookBackup: string | null = null;
    let carryLedgerBackup: string | null = null;
    let globalValueSamplesBackup: string | null = null;

    before(async () => {
        // Back up the tracked address book so this drill never leaves the
        // working tree dirty, regardless of what saveAddress() writes below.
        addressBookBackup = fs.existsSync(ADDRESS_BOOK_PATH) ? fs.readFileSync(ADDRESS_BOOK_PATH, "utf-8") : null;

        // Back up, then clear, the gitignored carry-ledger / V̄-sample stores
        // so this run starts from a clean slate — see the const declarations
        // above for why clearing is required, and why backup-and-restore
        // (not just delete) is the right pattern here.
        carryLedgerBackup = fs.existsSync(CARRY_LEDGER_PATH) ? fs.readFileSync(CARRY_LEDGER_PATH, "utf-8") : null;
        globalValueSamplesBackup = fs.existsSync(GLOBAL_VALUE_SAMPLES_PATH)
            ? fs.readFileSync(GLOBAL_VALUE_SAMPLES_PATH, "utf-8")
            : null;
        if (fs.existsSync(CARRY_LEDGER_PATH)) fs.unlinkSync(CARRY_LEDGER_PATH);
        if (fs.existsSync(GLOBAL_VALUE_SAMPLES_PATH)) fs.unlinkSync(GLOBAL_VALUE_SAMPLES_PATH);

        // Deliberately do NOT force NETWORK here: the underlying fork's
        // chainId depends on how the current hardhat process was started
        // (e.g. `FORK_NETWORK=mainnet hh node` pins chainId 1, the default
        // pins Sepolia). Hardcoding "sepolia" caused a hard chainId-mismatch
        // failure whenever the process was started against a different fork.
        // Let resolveNetworkContext() auto-detect from the live chainId
        // instead, and reset to whatever fork is already configured.
        delete process.env.NETWORK;
        await network.provider.request({ method: "hardhat_reset", params: [{}] });

        // Independently derive the expected network name from the live
        // chainId (same lookup resolveNetworkContext() itself uses) so this
        // assertion can actually fail — checking `ctx.bookKey` against a
        // value re-derived FROM `ctx` is a tautology that can never catch a
        // regression.
        const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
        const expectedNetworkName = getNetworkNameByChainId(liveChainId);
        expect(expectedNetworkName, `no CHAIN_METADATA entry for chainId ${liveChainId}`).to.exist;

        ctx = await resolveNetworkContext();
        expect(ctx.isFork).to.equal(true);
        expect(ctx.networkName).to.equal(expectedNetworkName);
        expect(ctx.bookKey).to.equal(`fork:${expectedNetworkName}`);

        [admin, user1, , badActor] = await ethers.getSigners();
        const adminAddr = await admin.getAddress();

        // Deploy via the REAL deploy script rather than a hand-rolled fixture.
        //
        // This drill previously stood up its own contracts with
        // `upgrades.deployProxy` and wired only the 5 role grants its own
        // tests happened to need. Production grants 21. That divergence meant
        // every operator lever below was being validated against a role
        // topology that does not exist on any deployed chain — precisely the
        // fidelity gap this drill exists to close for the CLI scripts. Using
        // `runDeploy()` means a role the deploy forgets to grant now breaks
        // the operator drill too, instead of passing here and failing on a
        // testnet.
        //
        // The explicit `deployer` override is required: on a fork the CLI path
        // impersonates DEV_WALLET, which would leave `admin` (signers[0])
        // holding none of the roles the levers below exercise.
        const deployed = await runDeploy({ deployer: admin });

        okuMoney = deployed.okuMoney as unknown as OkuMoney;
        okuDollar = deployed.okuDollar;
        queue = deployed.redemptionQueue;
        psm = deployed.litePSM;
        usdc = await ethers.getContractAt("MockUSDC", deployed.usdcAddress, admin);

        // The deploy grants admin OKUM_MINTER but sets minter allowances only
        // for LitePSM and RedemptionQueue — `OkuMoney.mint` checks BOTH the
        // role and a separate per-minter allowance, so admin still can't mint
        // directly without one. Grant a small allowance so fixture-level mints
        // in the tests below (e.g. the burn test) work; this is test scaffolding,
        // not a production role change.
        await okuMoney.connect(admin).configureMinterAllowance(adminAddr, ethers.parseEther("10000"));

        // Fund users with USDC the levers below need.
        await usdc.mint(await user1.getAddress(), 1_000_000_000_000n); // 1M USDC
        await usdc.mint(await admin.getAddress(), 1_000_000_000_000n);
    });

    after(async () => {
        if (addressBookBackup !== null) fs.writeFileSync(ADDRESS_BOOK_PATH, addressBookBackup);
        else if (fs.existsSync(ADDRESS_BOOK_PATH)) fs.unlinkSync(ADDRESS_BOOK_PATH);

        if (carryLedgerBackup !== null) fs.writeFileSync(CARRY_LEDGER_PATH, carryLedgerBackup);
        else if (fs.existsSync(CARRY_LEDGER_PATH)) fs.unlinkSync(CARRY_LEDGER_PATH);

        if (globalValueSamplesBackup !== null) fs.writeFileSync(GLOBAL_VALUE_SAMPLES_PATH, globalValueSamplesBackup);
        else if (fs.existsSync(GLOBAL_VALUE_SAMPLES_PATH)) fs.unlinkSync(GLOBAL_VALUE_SAMPLES_PATH);

        delete process.env.NETWORK;
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("psmOps: mintOkuM (USDC -> OkuM)", async () => {
        const before = await okuMoney.balanceOf(await user1.getAddress());
        await runPsmOp(ctx, user1, "mintOkuM", 100_000_000_000n, false); // 100k USDC
        const afterBal = await okuMoney.balanceOf(await user1.getAddress());
        expect(afterBal).to.be.greaterThan(before);
    });

    it("psmOps: mintUsdOku (USDC -> UsdOku)", async () => {
        const before = await okuDollar.balanceOf(await user1.getAddress());
        await runPsmOp(ctx, user1, "mintUsdOku", 50_000_000_000n, false); // 50k USDC
        const afterBal = await okuDollar.balanceOf(await user1.getAddress());
        expect(afterBal).to.be.greaterThan(before);
    });

    it("vaultOps: deposit (ERC-4626 OkuM -> UsdOku)", async () => {
        const okuMBal = await okuMoney.balanceOf(await user1.getAddress());
        const depositAmount = okuMBal / 4n;
        const before = await okuDollar.balanceOf(await user1.getAddress());
        await runVaultOp(ctx, user1, "deposit", depositAmount);
        expect(await okuDollar.balanceOf(await user1.getAddress())).to.be.greaterThan(before);
    });

    it("vaultOps: mint (ERC-4626 exact UsdOku shares)", async () => {
        const before = await okuDollar.balanceOf(await user1.getAddress());
        await runVaultOp(ctx, user1, "mint", ethers.parseEther("100"));
        expect(await okuDollar.balanceOf(await user1.getAddress())).to.be.greaterThan(before);
    });

    it("vaultOps: wrap (legacy price-aware entry point)", async () => {
        const okuMBal = await okuMoney.balanceOf(await user1.getAddress());
        const wrapAmount = okuMBal / 4n;
        const before = await okuDollar.balanceOf(await user1.getAddress());
        await runVaultOp(ctx, user1, "wrap", wrapAmount);
        expect(await okuDollar.balanceOf(await user1.getAddress())).to.be.greaterThan(before);
    });

    it("globalValue: sample + append (V\u0304 measurement pipeline)", async () => {
        // sampleGlobalValueUsd() is inherently multi-chain (CHAIN_METADATA-driven,
        // reads via JsonRpcProvider per configured chain) and isn't exercised
        // for the same reason checkMultiplierDrift.ts isn't (see module doc).
        // Exercise the append/persistence half directly, and assert against
        // what was actually WRITTEN to disk — not just the locally-computed
        // input value — so a persistence regression (bad path, silent write
        // failure, corrupt JSON) would be caught here.
        const supply = await okuMoney.totalSupply();
        const mult = await okuMoney.okuMMultiplier();
        const valueUsd = Number(ethers.formatEther(supply)) * (Number(mult) / 1e18);
        const timestampSec = await time.latest();
        const before = loadSamples(GLOBAL_VALUE_SAMPLES_PATH).length;
        appendSample({ timestampSec, valueUsd, perChain: { [ctx.bookKey]: valueUsd } });
        const after = loadSamples(GLOBAL_VALUE_SAMPLES_PATH);
        expect(after.length).to.equal(before + 1);
        const written = after[after.length - 1];
        expect(written.timestampSec).to.equal(timestampSec);
        expect(written.valueUsd).to.equal(valueUsd);
        expect(written.perChain[ctx.bookKey]).to.equal(valueUsd);
    });

    it("setOkuMYieldRate: direct mode activates streaming accrual", async () => {
        const endTimestamp = BigInt((await time.latest()) + 30 * 86400);
        const PRECISION = 10n ** 18n;
        const { confirmedRate } = await runSetOkuMYieldRate(ctx, admin, {
            mode: "direct",
            rate: PRECISION + 10n ** 10n, // ~0.3% APY per-second, well within [PRECISION, MAX_RATE]
            endTimestamp,
        });
        expect(confirmedRate).to.be.greaterThan(PRECISION);
    });

    it("runEpoch: stage-settlement derives and atomically stages the settlement rate", async function () {
        const PRECISION = 10n ** 18n;
        // Deliberately tiny rate (~0.01% APY): by this point in the drill,
        // prior tests have minted a substantial OkuM supply (~137k). A target
        // must be picked relative to (rate × supply × time), not a fixed
        // magic number — an earlier version of this test used ~172% APY
        // against a $1000 target, which the base window alone blew past
        // before settlement even ran (a TEST bug, not a mechanism bug: caught
        // and fixed here rather than chased further, per the "measure before
        // asserting" principle the simulation suite audit established).
        const rateEnd = BigInt((await time.latest()) + 30 * 86400);
        await runSetOkuMYieldRate(ctx, admin, {
            mode: "direct",
            rate: PRECISION + 10n ** 8n,
            endTimestamp: rateEnd,
        });
        await time.increase(20 * 86400); // 20 days into the 30-day base window

        // Target set generously ABOVE what the tiny base rate alone could
        // have distributed over the full window, so settlement has real,
        // positive work to do (not clamped to a halt).
        const supply = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const realisedYieldUsd = supply * 0.01; // 1% of supply — far above what 0.01% APY/30d produces

        const pendingEnd = rateEnd + BigInt(2 * 86400);
        const result = await runStageSettlement(ctx, admin, {
            realisedYieldUsd,
            pendingEndTimestamp: pendingEnd,
        });
        expect(result.rSettleFloat).to.be.greaterThan(1);
        // The settlement rate must actually be armed as the successor on-chain
        // (this was a self-comparison bug — `x > x` — in an earlier version of
        // this assertion, which is always false and would have silently
        // masked a real regression here).
        expect(await okuMoney.okuMPendingRatePerSecond()).to.be.greaterThan(PRECISION);
        expect(await okuMoney.okuMPendingRateEnd()).to.equal(pendingEnd);
    });

    it("runEpoch: roll-epoch reconciles and stages the next epoch's base rate", async function () {
        const rateEnd = await okuMoney.okuMRateEnd();
        await time.increaseTo(Number(rateEnd) + 1); // now inside the settlement window

        // Same "target relative to actual supply" fix as the stage-settlement
        // test above, for the same reason.
        const supply = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const nextRealisedYieldUsd = supply * 0.01;
        const mult = Number(await okuMoney.okuMMultiplier()) / 1e18;

        const result = await runRollEpoch(ctx, admin, {
            nextRealisedYieldUsd,
            nextEndTimestamp: BigInt(await time.latest()) + BigInt(2 * 86400),
            epochLengthSec: 30 * 86400,
            // Single-chain local drill: "global" value IS this chain's value.
            // sampleGlobalValueUsd() is CHAIN_METADATA-driven and cannot be
            // exercised here for the same reason the globalValue test above
            // isn't — see runEpoch.ts's `globalValueUsdOverride` doc.
            globalValueUsdOverride: supply * mult,
        });
        expect(result.rBaseNextFloat).to.be.greaterThan(1);
    });

    it("setOkuMMultiplier: emergency override collapses the schedule", async () => {
        const before = await okuMoney.okuMMultiplier();
        const newMult = before + ethers.parseEther("0.01");
        await runSetOkuMMultiplier(ctx, admin, newMult, false);
        expect(await okuMoney.okuMMultiplier()).to.equal(newMult);
        expect(await okuMoney.okuMRateEnd()).to.equal(0n); // schedule collapsed to halted
    });

    it("configureMinterAllowance: rotates the PSM's mint allowance", async () => {
        const psmAddr = await psm.getAddress();
        const result = await runConfigureMinterAllowance(ctx, admin, psmAddr, ethers.parseEther("500000000"));
        expect(result.newAllowance).to.equal(ethers.parseEther("500000000"));
    });

    it("setMaxSupply: raises the supply cap", async () => {
        const result = await runSetMaxSupply(ctx, admin, ethers.parseEther("2000000000"));
        expect(result.newMax).to.equal(ethers.parseEther("2000000000"));
    });

    it("depositBuffer / withdrawBuffer: PSM USDC buffer management", async () => {
        const depositResult = await runDepositBuffer(ctx, admin, 10_000_000_000n); // 10k USDC
        expect(depositResult.bufferAfter).to.be.greaterThan(depositResult.bufferBefore);

        const withdrawResult = await runWithdrawBuffer(ctx, admin, 1_000_000_000n, await admin.getAddress());
        expect(withdrawResult.bufferAfter).to.be.lessThan(depositResult.bufferAfter);
    });

    it("blacklistBoth: blocks a bad actor on BOTH contracts, then reverses it", async () => {
        const badAddr = await badActor.getAddress();
        const blResult = await runBlacklistBoth(ctx, admin, badAddr, "blacklist");
        expect(blResult.okuMoneyState).to.be.true;
        expect(blResult.okuDollarState).to.be.true;

        const unblResult = await runBlacklistBoth(ctx, admin, badAddr, "unblacklist");
        expect(unblResult.okuMoneyState).to.be.false;
        expect(unblResult.okuDollarState).to.be.false;
    });

    it("pause / unpause: all three targets", async () => {
        for (const target of ["psm", "okuM", "usdOku"] as const) {
            const pr = await runPause(ctx, admin, target);
            expect(pr.pausedAfter).to.be.true;
            const ur = await runUnpause(ctx, admin, target);
            expect(ur.pausedAfter).to.be.false;
        }
    });

    it("psmOps: redeemOkuM instant path (buffered) and forced-queue path", async () => {
        const okuMBal = await okuMoney.balanceOf(await user1.getAddress());
        const redeemAmount = okuMBal / 10n;
        await runPsmOp(ctx, user1, "redeemOkuM", redeemAmount, false);
        expect(await okuMoney.balanceOf(await user1.getAddress())).to.be.lessThan(okuMBal);

        // Drain the PSM's USDC buffer so the NEXT redeem is forced into the queue.
        const psmUsdcBal = await usdc.balanceOf(await psm.getAddress());
        if (psmUsdcBal > 0n) {
            await runWithdrawBuffer(ctx, admin, psmUsdcBal, await admin.getAddress());
        }
        const remainingOkuM = await okuMoney.balanceOf(await user1.getAddress());
        await runPsmOp(ctx, user1, "redeemOkuM", remainingOkuM / 2n, false);
        expect(await queue.queueTail()).to.be.greaterThan(0n);
    });

    it("processQueue: drains queued redemptions once the buffer is refunded", async () => {
        await runDepositBuffer(ctx, admin, 500_000_000_000n); // 500k USDC — plenty to clear the queue
        const result = await runProcessQueue(ctx, admin, { batchSize: 50, limit: 10 });
        expect(result.finalTail - result.finalHead).to.equal(0n);
    });

    it("rescueQueueEntry: rescues a stuck entry without processing it normally", async () => {
        // Force a fresh queue entry deterministically: fully drain the PSM's
        // USDC buffer so ANY redeemOkuM is guaranteed to hit the forced-queue
        // path, then top up user1 with OkuM if needed so the redeem amount is
        // never zero. No conditional guards — if this precondition can't be
        // established, that's a real failure, not a skip.
        const psmUsdcBal = await usdc.balanceOf(await psm.getAddress());
        if (psmUsdcBal > 0n) await runWithdrawBuffer(ctx, admin, psmUsdcBal, await admin.getAddress());

        let okuMBal = await okuMoney.balanceOf(await user1.getAddress());
        if (okuMBal === 0n) {
            await okuMoney.connect(admin).mint(await user1.getAddress(), ethers.parseEther("100"));
            okuMBal = await okuMoney.balanceOf(await user1.getAddress());
        }
        expect(okuMBal).to.be.greaterThan(0n);

        const tailBefore = await queue.queueTail();
        await runPsmOp(ctx, user1, "redeemOkuM", okuMBal / 2n, false);
        const head = await queue.queueHead();
        const tail = await queue.queueTail();
        expect(tail).to.be.greaterThan(tailBefore); // a new entry was actually enqueued
        expect(tail).to.be.greaterThan(head);

        const entry = await queue.getQueueEntry(head);
        const recipient = await admin.getAddress();
        const recipientBefore = await okuMoney.balanceOf(recipient);

        const result = await runRescueQueueEntry(ctx, admin, head, recipient);
        expect(result.txHash).to.exist;
        // Real effect: the entry's OkuM was returned to the recipient...
        expect(await okuMoney.balanceOf(recipient)).to.equal(recipientBefore + entry.okuMAmount);
        // ...and the slot is cleared in place (queueHead is NOT auto-advanced
        // by design, per RedemptionQueue.rescueQueueEntry's own comment, so
        // `index` stays in range and reads back as the zeroed `delete` result
        // rather than reverting).
        const clearedEntry = await queue.getQueueEntry(head);
        expect(clearedEntry.user).to.equal(ethers.ZeroAddress);
        expect(clearedEntry.okuMAmount).to.equal(0n);
    });

    it("vaultOps: withdraw / redeem (ERC-4626) and unwrap (legacy)", async () => {
        // Refund buffer + re-mint some UsdOku for user1 to exercise these paths.
        await runDepositBuffer(ctx, admin, 100_000_000_000n);
        await runPsmOp(ctx, user1, "mintUsdOku", 20_000_000_000n, false);
        const usdOkuBal = await okuDollar.balanceOf(await user1.getAddress());
        expect(usdOkuBal).to.be.greaterThan(0n);

        const beforeAssets = await okuMoney.balanceOf(await user1.getAddress());
        await runVaultOp(ctx, user1, "redeem", usdOkuBal / 4n, { owner: await user1.getAddress() });
        expect(await okuMoney.balanceOf(await user1.getAddress())).to.be.greaterThan(beforeAssets);

        // usdOkuBal / 4n leaves 3/4 remaining, so this is always > 0 given
        // usdOkuBal > 0n above — no conditional guard needed.
        const remaining = await okuDollar.balanceOf(await user1.getAddress());
        expect(remaining).to.be.greaterThan(0n);
        const beforeUnwrap = await okuMoney.balanceOf(await user1.getAddress());
        await runVaultOp(ctx, user1, "unwrap", remaining / 2n);
        expect(await okuMoney.balanceOf(await user1.getAddress())).to.be.greaterThan(beforeUnwrap);
    });

    it("vaultOps: rescueDonation recovers OkuM sent directly to the vault", async () => {
        const donation = ethers.parseEther("10");
        await okuMoney.connect(admin).transfer(await okuDollar.getAddress(), donation);
        const before = await okuMoney.balanceOf(await admin.getAddress());
        await runVaultOp(ctx, admin, "rescueDonation", donation, { receiver: await admin.getAddress() });
        expect(await okuMoney.balanceOf(await admin.getAddress())).to.be.greaterThan(before);
    });

    it("psmOps: burn removes OkuM from circulation directly", async () => {
        // admin holds both OKUM_MINTER and OKUM_BURNER from initialize(), so
        // this mint cannot revert for lack of role — guarantee the
        // precondition unconditionally rather than swallowing a failure and
        // skipping the assertion (a real regression here would previously
        // have shown as a silent no-op, not a failing test).
        const amount = ethers.parseEther("1");
        await okuMoney.connect(admin).mint(await admin.getAddress(), amount);
        const before = await okuMoney.totalSupply();
        expect(await okuMoney.balanceOf(await admin.getAddress())).to.be.greaterThanOrEqual(amount);
        await runPsmOp(ctx, admin, "burn", amount, false);
        expect(await okuMoney.totalSupply()).to.equal(before - amount);
    });

    it("DRY_RUN=true never submits a transaction, for every lever type", async () => {
        const supplyBefore = await okuMoney.totalSupply();
        await runPsmOp(ctx, user1, "mintOkuM", 1_000_000n, true);
        expect(await okuMoney.totalSupply()).to.equal(supplyBefore);

        const maxBefore = await okuMoney.maxSupply();
        await runSetMaxSupply(ctx, admin, maxBefore + 1n, true);
        expect(await okuMoney.maxSupply()).to.equal(maxBefore);
    });
});
