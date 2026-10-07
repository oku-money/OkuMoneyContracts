/**
 * Operator drill — walks every operator-script lever against a freshly
 * redeployed contract set on the locally forked chain, importing and calling
 * the SAME functions the CLI
 * scripts call (not spawning processes). This is the fidelity choice: a real
 * bug in a script's argument handling, address-book lookup, or guard logic
 * shows up here exactly as it would for an operator running the CLI, which a
 * hand-rolled "call the contract directly" test would not catch.
 *
 * SCOPE DECISIONS:
 *   - NETWORK is left unset so `resolveNetworkContext()` auto-detects whichever
 *     chain is forked (`FORK_NETWORK`), and the drill reuses that fork's
 *     `fork:<networkName>` address-book namespace; `tryAttach`'s `getCode`
 *     check makes that safe because the chain is reset each run.
 *   - `addresses.json` is TRACKED; the drill backs it up and restores it in
 *     `after()`.
 *   - Contracts come from the REAL deploy script via `runDeploy()`, so the
 *     operator levers run against the deployed role topology (see
 *     `deployDrill.test.ts` for the deploy-side assertions).
 *   - `grantRolesMainnet.ts` is NOT used: it redistributes roles to the
 *     production multisigs, a different topology from the testnet
 *     "deployer holds the operational set" model exercised here.
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
import { runConfigureMinterAllowance } from "../../../scripts/operator/configureMinterAllowance";
import { runSetMaxSupply } from "../../../scripts/operator/setMaxSupply";
import { runSetOkuMMultiplier } from "../../../scripts/operator/setOkuMMultiplier";
import { runSetOkuMYieldRate } from "../../../scripts/operator/setOkuMYieldRate";
import { runPsmOp } from "../../../scripts/operator/psmOps";
import { runVaultOp } from "../../../scripts/operator/vaultOps";
import { appendSample, loadSamples } from "../../../scripts/utils/globalValue";
import { deriveStageSettlement, deriveRollEpoch } from "../../../scripts/operator/deriveEpochSchedule";
import { loadArtifact } from "../../../scripts/utils/epochArtifact";
import { summarizeLedger, upsertLedgerEntry, backfillReconciliation, buildLedgerEntry, loadLedger } from "../../../scripts/utils/carryLedger";

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
const EPOCHS_DIR = path.join(__dirname, "../../../scripts/config/epochs");
const EPOCHS_DIR_BACKUP = path.join(__dirname, "../../../scripts/config/epochs.drill-backup");

describe("Operator drill: exercise every lever on a clean local chain", function () {
    this.timeout(300_000);

    let ctx: NetworkContext;
    let admin: any, user1: any, badActor: any;
    let okuMoney: OkuMoney;
    let okuDollar: any;
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

        // Same backup-and-clear rationale as the two stores above, for the
        // (also gitignored) epoch-schedule artifact directory this drill's
        // deriveEpochSchedule tests write into.
        if (fs.existsSync(EPOCHS_DIR)) fs.renameSync(EPOCHS_DIR, EPOCHS_DIR_BACKUP);

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

        // Real deploy script, not a hand-rolled fixture, so a role the deploy
        // forgets to grant breaks this drill too.
        //
        // The explicit `deployer` override is required: on a fork the CLI path
        // impersonates DEV_WALLET, which would leave `admin` (signers[0])
        // holding none of the roles the levers below exercise.
        const deployed = await runDeploy({ deployer: admin });

        okuMoney = deployed.okuMoney as unknown as OkuMoney;
        okuDollar = deployed.okuDollar;
        psm = deployed.litePSM;
        usdc = await ethers.getContractAt("MockUSDC", deployed.usdcAddress, admin);

        // The deploy grants admin OKUM_MINTER but sets a minter allowance only
        // for LitePSM — `OkuMoney.mint` checks BOTH the
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

        if (fs.existsSync(EPOCHS_DIR)) fs.rmSync(EPOCHS_DIR, { recursive: true, force: true });
        if (fs.existsSync(EPOCHS_DIR_BACKUP)) fs.renameSync(EPOCHS_DIR_BACKUP, EPOCHS_DIR);

        delete process.env.NETWORK;
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("psmOps: mintOkuM (USDC -> OkuM)", async () => {
        const before = await okuMoney.balanceOf(await user1.getAddress());
        const mult = await okuMoney.okuMMultiplier();
        await runPsmOp(ctx, user1, "mintOkuM", 100_000_000_000n, false); // 100k USDC
        const afterBal = await okuMoney.balanceOf(await user1.getAddress());
        // 100k USDC -> dollars (x1e12) -> OkuM (/multiplier). `greaterThan` would
        // have passed on a single wei.
        const expected = (100_000_000_000n * 10n ** 12n * 10n ** 18n) / mult;
        expect(afterBal - before, "mintOkuM credits the exact converted amount").to.equal(expected);
    });

    it("psmOps: mintUsdOku (USDC -> UsdOku)", async () => {
        const before = await okuDollar.balanceOf(await user1.getAddress());
        await runPsmOp(ctx, user1, "mintUsdOku", 50_000_000_000n, false); // 50k USDC
        const afterBal = await okuDollar.balanceOf(await user1.getAddress());
        // usdOku is dollar-denominated, so 50k USDC is 50k usdOku regardless of
        // the multiplier -- that invariance is the point of the vault.
        expect(afterBal - before, "mintUsdOku credits dollar-for-dollar")
            .to.be.closeTo(50_000_000_000n * 10n ** 12n, 10n ** 12n);
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
        const endTimestamp = BigInt((await time.latest()) + 86400); // 24h production epoch
        const PRECISION = 10n ** 18n;
        const { confirmedRate } = await runSetOkuMYieldRate(ctx, admin, {
            mode: "direct",
            rate: PRECISION + 10n ** 10n, // ~0.3% APY per-second, well within [PRECISION, MAX_RATE]
            endTimestamp,
        });
        // The submitted rate is a literal one line above; assert it landed
        // verbatim rather than merely "above PRECISION".
        expect(confirmedRate, "the submitted rate must land verbatim").to.equal(PRECISION + 10n ** 10n);
    });

    it("deriveEpochSchedule: stage-settlement derives and atomically stages the settlement rate", async function () {
        const PRECISION = 10n ** 18n;
        // Deliberately tiny rate (~0.01% APY): prior tests have minted a
        // substantial OkuM supply (~137k), so the target must be sized relative
        // to (rate × supply × time), not a fixed magic number.
        const rateEnd = BigInt((await time.latest()) + 86400); // 24h production epoch
        await runSetOkuMYieldRate(ctx, admin, {
            mode: "direct",
            rate: PRECISION + 10n ** 8n,
            endTimestamp: rateEnd,
        });
        await time.increase(16 * 3600); // 16h into the 22.4h base window (same fraction as the old 20-of-28-days)

        // Target set generously ABOVE what the tiny base rate alone could
        // have distributed over the full window, so settlement has real,
        // positive work to do (not clamped to a halt).
        const supply = Number(ethers.formatEther(await okuMoney.totalSupply()));
        // 0.05% of supply per 24h epoch (~20% APY). Sized deliberately: ~56x above
        // what the tiny base rate alone distributes over the base window (so
        // settlement has real positive work), but only ~5.6% of MAX_RATE's
        // per-24h ceiling (a larger target would clamp at MAX_RATE in a 24h window).
        const realisedYieldUsd = supply * 0.0005;

        // Seed the V(t) store. `deriveStageSettlement` hard-errors on an empty
        // sample set rather than falling back to this chain's local supply —
        // deriving a rate from an unmeasured denominator is the failure that
        // fallback existed to hide. Two samples spanning the elapsed base
        // window are the minimum for a time-weighted average.
        const multNow = Number(await okuMoney.okuMMultiplier()) / 1e18;
        // Anchor read from the contract, not recomputed: the window starts at
        // `okuMLastAccrualTime`, which is the block the rate tx mined in, not
        // the timestamp observed just before sending it.
        const anchorSec = Number(await okuMoney.okuMLastAccrualTime());
        appendSample({
            timestampSec: anchorSec,
            valueUsd: supply * multNow,
            perChain: { [ctx.bookKey]: supply * multNow },
        });
        appendSample({
            timestampSec: await time.latest(),
            valueUsd: supply * multNow,
            perChain: { [ctx.bookKey]: supply * multNow },
        });

        const pendingEnd = rateEnd + BigInt(5760); // one 24h-epoch settlement window (1/15)
        const artifact = await deriveStageSettlement(ctx, admin, {
            epochId: `drill-stage-${Date.now()}`,
            realisedYieldUsd,
            pendingEndTimestamp: pendingEnd,
        });
        expect(BigInt(artifact.schedule.nextRate)).to.be.greaterThan(PRECISION);

        // Derivation and submission are separate steps in the production
        // pipeline (derive once, fan out to every chain); the drill submits the
        // artifact here the same way `applyScheduleSingleChain.ts` does.
        await runSetOkuMYieldRate(ctx, admin, {
            mode: "withSuccessor",
            rate: BigInt(artifact.schedule.rate),
            endTimestamp: BigInt(artifact.schedule.rateEnd),
            nextRate: BigInt(artifact.schedule.nextRate),
            pendingEndTimestamp: BigInt(artifact.schedule.nextRateEnd),
        });
        // The settlement rate must actually be armed as the successor on-chain.
        expect(await okuMoney.okuMPendingRatePerSecond()).to.be.greaterThan(PRECISION);
        expect(await okuMoney.okuMPendingRateEnd()).to.equal(pendingEnd);
    });

    it("deriveEpochSchedule: roll-epoch reconciles and stages the next epoch's base rate", async function () {
        const rateEnd = await okuMoney.okuMRateEnd();
        await time.increaseTo(Number(rateEnd) + 1); // now inside the settlement window

        // Same "target relative to actual supply" fix as the stage-settlement
        // test above, for the same reason.
        const supply = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const nextRealisedYieldUsd = supply * 0.0005;
        const mult = Number(await okuMoney.okuMMultiplier()) / 1e18;

        const artifact = await deriveRollEpoch(ctx, admin, {
            epochId: `drill-roll-${Date.now()}`,
            nextRealisedYieldUsd,
            // One settlement window, NOT a full epoch. `deriveRollEpoch` computes
            // nextRateEnd = <current on-chain rateEnd> + epochLength*(1-1/15),
            // and the contract requires nextRateEnd > rateEnd. A full-epoch
            // value here exceeds that and reverts PendingEndNotAfterRateEnd.
            nextEndTimestamp: BigInt(await time.latest()) + BigInt(5760),
            epochLengthSec: 86400,
            // Single-chain local drill: "global" value IS this chain's value.
            // sampleGlobalValueUsd() is CHAIN_METADATA-driven and cannot be
            // exercised here for the same reason the globalValue test above
            // isn't — see runEpoch.ts's `globalValueUsdOverride` doc.
            globalValueUsdOverride: supply * mult,
        });
        expect(BigInt(artifact.schedule.nextRate)).to.be.greaterThan(10n ** 18n);

        await runSetOkuMYieldRate(ctx, admin, {
            mode: "withSuccessor",
            rate: BigInt(artifact.schedule.rate),
            endTimestamp: BigInt(artifact.schedule.rateEnd),
            nextRate: BigInt(artifact.schedule.nextRate),
            pendingEndTimestamp: BigInt(artifact.schedule.nextRateEnd),
        });
        expect(await okuMoney.okuMPendingRatePerSecond()).to.be.greaterThan(10n ** 18n);
    });

    it("deriveEpochSchedule + broadcastSchedule's carry-ledger wiring: two full derive cycles, exercising artifact identity and the reconciledCarryUsd/carryForwardUsd split end-to-end", async function () {
        // This test exists because `deriveEpochSchedule.ts` /
        // `broadcastSchedule.ts` — unlike `runEpoch.ts` above — had ZERO test
        // coverage before the deploy-readiness audit, which is exactly how
        // defects #1-#4 (no CLI entrypoint, artifact collision, inverted
        // carry semantics, unscoped chain targets) shipped unnoticed. This
        // replicates `broadcastSchedule.ts`'s POST-CONFIRMATION ledger-write
        // sequence directly (backfillReconciliation + upsertLedgerEntry) —
        // the actual subprocess-spawning/multi-chain fan-out is out of scope
        // for a single-chain drill, same as `sampleGlobalValueUsd()` above.
        const EPOCH_A = "drill-epoch-a";
        const EPOCH_B = "drill-epoch-b";
        const PRECISION = 10n ** 18n;

        // ---- Fresh schedule, matching the runEpoch tests' pattern above ----
        const rateEnd = BigInt((await time.latest()) + 86400); // 24h production epoch
        await runSetOkuMYieldRate(ctx, admin, { mode: "direct", rate: PRECISION + 10n ** 8n, endTimestamp: rateEnd });

        const supplyAtAnchor = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const multAtAnchor = Number(await okuMoney.okuMMultiplier()) / 1e18;
        appendSample({ timestampSec: await time.latest(), valueUsd: supplyAtAnchor * multAtAnchor, perChain: {} });

        await time.increase(16 * 3600); // 16h into the 22.4h base window
        const supplyNow = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const multNow = Number(await okuMoney.okuMMultiplier()) / 1e18;
        appendSample({ timestampSec: await time.latest(), valueUsd: supplyNow * multNow, perChain: {} });

        // `deriveRollEpoch` does not touch the carry ledger, so it is empty here.
        // Seed a prior epoch whose carry-in DIFFERS from its carry-forward, so
        // the two candidate values are distinguishable and the guards below are
        // not degenerate (0 === 0, undefined === undefined).
        const SEED_EPOCH = `${EPOCH_A}-seed`;
        upsertLedgerEntry(
            buildLedgerEntry({
                epochId: SEED_EPOCH,
                realisedYieldUsd: 1000,
                carryInUsd: 250,
                measuredAvgValueUsd: supplyNow * multNow,
                conservativeFactor: 1,
                // carryForwardUsd 400 != carryInUsd 250, which is what makes
                // `currentEpochCarryInUsd` and `outstandingCarryUsd` differ.
                result: { ratePerSecond: 1_000_000_000_000_000_000n, carryForwardUsd: 400 },
            })
        );

        const ledgerStateBeforeA = summarizeLedger();
        // Anti-degeneracy: if these ever coincide again, the assertion below
        // stops discriminating and must be re-seeded rather than left green.
        expect(
            ledgerStateBeforeA.currentEpochCarryInUsd,
            "fixture: the two candidate carry values must differ, or defect #3's guard is vacuous"
        ).to.not.equal(ledgerStateBeforeA.outstandingCarryUsd);
        expect(ledgerStateBeforeA.latestEntry?.epochId, "fixture: a prior entry must exist")
            .to.equal(SEED_EPOCH);

        // ---- Phase 1: stage-settlement — derive, apply, verify artifact identity ----
        const realisedYieldUsd = supplyNow * 0.0005;
        const pendingEnd = rateEnd + BigInt(5760); // one 24h-epoch settlement window (1/15)
        const stageArtifact = await deriveStageSettlement(ctx, admin, {
            epochId: EPOCH_A,
            realisedYieldUsd,
            pendingEndTimestamp: pendingEnd,
        });
        expect(stageArtifact.phase).to.equal("stage-settlement");
        // Must equal `currentEpochCarryInUsd` (the carry baked into whatever
        // epoch is CURRENTLY open per the ledger), NOT `outstandingCarryUsd`
        // — this is defect #3's fix, asserted directly.
        expect(stageArtifact.meta.carryInUsd).to.equal(ledgerStateBeforeA.currentEpochCarryInUsd);
        // REGRESSION (defect #2): re-derive under the SAME epochId, different
        // phase, must NOT collide with the artifact above.
        expect(() => loadArtifact(EPOCH_A, "stage-settlement")).to.not.throw();

        // Apply exactly the WAD integers the artifact carries — proves the
        // artifact is what `applyScheduleSingleChain.ts` actually consumes,
        // not a parallel/duplicated derivation.
        await runSetOkuMYieldRate(ctx, admin, {
            mode: "withSuccessor",
            rate: BigInt(stageArtifact.schedule.rate),
            endTimestamp: BigInt(stageArtifact.schedule.rateEnd),
            nextRate: BigInt(stageArtifact.schedule.nextRate),
            pendingEndTimestamp: BigInt(stageArtifact.schedule.nextRateEnd),
        });
        expect(await okuMoney.okuMPendingRatePerSecond()).to.equal(BigInt(stageArtifact.schedule.nextRate));

        // ---- Phase 2: roll-epoch (epoch A, first ever epoch — no prior ledger entry) ----
        await time.increaseTo(Number(await okuMoney.okuMRateEnd()) + 1);
        const supplyAtRoll = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const multAtRoll = Number(await okuMoney.okuMMultiplier()) / 1e18;

        const rollArtifactA = await deriveRollEpoch(ctx, admin, {
            epochId: EPOCH_A,
            nextRealisedYieldUsd: supplyAtRoll * 0.0005,
            // One settlement window, NOT a full epoch. `deriveRollEpoch` computes
            // nextRateEnd = <current on-chain rateEnd> + epochLength*(1-1/15),
            // and the contract requires nextRateEnd > rateEnd. A full-epoch
            // value here exceeds that and reverts PendingEndNotAfterRateEnd.
            nextEndTimestamp: BigInt(await time.latest()) + BigInt(5760),
            epochLengthSec: 86400,
            globalValueUsdOverride: supplyAtRoll * multAtRoll,
        });
        expect(rollArtifactA.phase).to.equal("roll-epoch");
        // Whatever the ledger's latest entry was BEFORE this derivation is
        // what gets reconciled — could be a pre-existing entry from an
        // earlier test in this shared-chain drill, or none.
        // Now a real comparison: the seeded entry is what must get reconciled.
        expect(rollArtifactA.meta.priorEpochId, "roll must reconcile the seeded prior epoch")
            .to.equal(SEED_EPOCH);
        expect(rollArtifactA.meta.carryForwardUsd).to.equal(0); // unknown until epoch A is itself reconciled

        // Apply it, exactly as applyScheduleSingleChain.ts would.
        await runSetOkuMYieldRate(ctx, admin, {
            mode: "withSuccessor",
            rate: BigInt(rollArtifactA.schedule.rate),
            endTimestamp: BigInt(rollArtifactA.schedule.rateEnd),
            nextRate: BigInt(rollArtifactA.schedule.nextRate),
            pendingEndTimestamp: BigInt(rollArtifactA.schedule.nextRateEnd),
        });

        // Simulate broadcastSchedule.ts's post-confirmation ledger write —
        // backfill first, then insert. Unguarded: the seed above guarantees a
        // prior entry exists, so an `if` here would only hide a broken fixture.
        backfillReconciliation(rollArtifactA.meta.priorEpochId!, rollArtifactA.meta.carryInUsd);
        upsertLedgerEntry(
            buildLedgerEntry({
                epochId: rollArtifactA.epochId,
                realisedYieldUsd: rollArtifactA.meta.realisedYieldUsd,
                carryInUsd: rollArtifactA.meta.carryInUsd,
                measuredAvgValueUsd: rollArtifactA.meta.globalValueUsd,
                conservativeFactor: rollArtifactA.meta.conservativeFactor,
                result: { ratePerSecond: BigInt(rollArtifactA.schedule.nextRate), carryForwardUsd: rollArtifactA.meta.carryForwardUsd },
            })
        );
        let summary = summarizeLedger();
        // +1 relative to whatever the ledger held before this test — the
        // shared-chain drill may already have entries from earlier tests.
        expect(summary.epochCount).to.equal(ledgerStateBeforeA.epochCount + 1);
        expect(summary.latestEntry!.epochId).to.equal(EPOCH_A);
        expect(summary.pendingReconciliation).to.equal(true); // epoch A not yet reconciled

        // ---- Phase 3: roll-epoch (epoch B) — THIS is what reconciles epoch A ----
        await time.increase(8 * 3600); // let epoch A's just-applied rate actually accrue something to reconcile
        const supplyAtRollB = Number(ethers.formatEther(await okuMoney.totalSupply()));
        const multAtRollB = Number(await okuMoney.okuMMultiplier()) / 1e18;
        expect(multAtRollB).to.be.greaterThan(multAtRoll); // sanity: time actually passed under a live rate

        const rollArtifactB = await deriveRollEpoch(ctx, admin, {
            epochId: EPOCH_B,
            nextRealisedYieldUsd: supplyAtRollB * 0.0005,
            // One settlement window, NOT a full epoch. `deriveRollEpoch` computes
            // nextRateEnd = <current on-chain rateEnd> + epochLength*(1-1/15),
            // and the contract requires nextRateEnd > rateEnd. A full-epoch
            // value here exceeds that and reverts PendingEndNotAfterRateEnd.
            nextEndTimestamp: BigInt(await time.latest()) + BigInt(5760),
            epochLengthSec: 86400,
            globalValueUsdOverride: supplyAtRollB * multAtRollB,
        });
        // REGRESSION (defect #3): epoch B's carryInUsd is epoch A's
        // RECONCILED carry (ex-post actual-vs-target), NOT epoch A's
        // (always-0) carryForwardUsd — these must be threaded from different
        // sources, per carryLedger.ts's module doc.
        expect(rollArtifactB.meta.priorEpochId).to.equal(EPOCH_A);
        expect(rollArtifactB.meta.carryForwardUsd).to.equal(0); // epoch B's own, unknown until it's reconciled next

        // Simulate broadcastSchedule.ts's post-confirmation sequence again:
        // backfill epoch A FIRST, then insert epoch B.
        backfillReconciliation(rollArtifactB.meta.priorEpochId!, rollArtifactB.meta.carryInUsd);
        upsertLedgerEntry(
            buildLedgerEntry({
                epochId: rollArtifactB.epochId,
                realisedYieldUsd: rollArtifactB.meta.realisedYieldUsd,
                carryInUsd: rollArtifactB.meta.carryInUsd,
                measuredAvgValueUsd: rollArtifactB.meta.globalValueUsd,
                conservativeFactor: rollArtifactB.meta.conservativeFactor,
                result: { ratePerSecond: BigInt(rollArtifactB.schedule.nextRate), carryForwardUsd: rollArtifactB.meta.carryForwardUsd },
            })
        );

        summary = summarizeLedger();
        expect(summary.epochCount).to.equal(ledgerStateBeforeA.epochCount + 2);
        expect(summary.pendingReconciliation).to.equal(true); // epoch B is now the latest, still pending
        // currentEpochCarryInUsd reflects epoch B's OWN carryInUsd (what's
        // baked into ITS target) — this is the value `deriveStageSettlement`
        // would use, NOT `outstandingCarryUsd` (defect #3's fix).
        expect(summary.currentEpochCarryInUsd).to.equal(rollArtifactB.meta.carryInUsd);

        expect(summary.latestEntry!.epochId).to.equal(EPOCH_B);
        // Confirm the backfill actually landed on epoch A specifically.
        const epochAEntry = loadLedger().find((e) => e.epochId === EPOCH_A)!;
        expect(epochAEntry.reconciledCarryUsd).to.equal(rollArtifactB.meta.carryInUsd);
        expect(epochAEntry.carryForwardUsd).to.equal(0); // unchanged — a DIFFERENT field, per the regression guard
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

    it("depositBuffer / withdrawBuffer: PSM USDC buffer management (unpaused, no override block)", async () => {
        const depositResult = await runDepositBuffer(ctx, admin, 10_000_000_000n); // 10k USDC
        expect(depositResult.bufferAfter - depositResult.bufferBefore, "buffer grows by the deposit")
            .to.equal(10_000_000_000n);

        const withdrawResult = await runWithdrawBuffer(ctx, admin, 1_000_000_000n, await admin.getAddress());
        expect(depositResult.bufferAfter - withdrawResult.bufferAfter, "buffer falls by the withdrawal")
            .to.equal(1_000_000_000n);
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

    it("psmOps: redeemOkuM pays out when buffered, reverts InsufficientBuffer when not", async () => {
        const user1Addr = await user1.getAddress();
        const okuMBal = await okuMoney.balanceOf(user1Addr);
        const redeemAmount = okuMBal / 10n;
        await runPsmOp(ctx, user1, "redeemOkuM", redeemAmount, false);
        expect(await okuMoney.balanceOf(user1Addr)).to.be.lessThan(okuMBal);

        // Drain the PSM's USDC buffer: the next redeem must revert.
        const psmUsdcBal = await usdc.balanceOf(await psm.getAddress());
        if (psmUsdcBal > 0n) {
            await runWithdrawBuffer(ctx, admin, psmUsdcBal, await admin.getAddress());
        }
        expect(await usdc.balanceOf(await psm.getAddress())).to.equal(0n);

        const remainingOkuM = await okuMoney.balanceOf(user1Addr);
        await expect(runPsmOp(ctx, user1, "redeemOkuM", remainingOkuM / 2n, false))
            .to.be.revertedWithCustomError(psm, "InsufficientBuffer");
        // Nothing burned on the failed redeem.
        expect(await okuMoney.balanceOf(user1Addr)).to.equal(remainingOkuM);
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
        await okuMoney.connect(admin).mint(await admin.getAddress(), donation);
        await okuMoney.connect(admin).transfer(await okuDollar.getAddress(), donation);
        const before = await okuMoney.balanceOf(await admin.getAddress());
        await runVaultOp(ctx, admin, "rescueDonation", donation, { receiver: await admin.getAddress() });
        expect(await okuMoney.balanceOf(await admin.getAddress())).to.be.greaterThan(before);
    });

    it("psmOps: burn removes OkuM from circulation directly", async () => {
        // admin holds OKUM_MINTER and OKUM_BURNER from initialize(), so this
        // mint is an unconditional precondition.
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
