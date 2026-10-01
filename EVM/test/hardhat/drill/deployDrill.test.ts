/**
 * Deploy drill — runs the REAL deployment script (`scripts/deploy/index.ts`)
 * in-process against the local fork and asserts the resulting on-chain state.
 *
 * Why this exists: before this drill, `scripts/deploy/index.ts` (~900 lines,
 * 21 role grants, proxy deploys, address-book persistence, retry logic) had
 * ZERO automated coverage. Every other test in the suite — including the
 * operator drill — constructed its own fixture with `upgrades.deployProxy`,
 * which means the thing actually run against a testnet was the one thing
 * nothing verified. Role misconfiguration is the failure mode most likely to
 * brick a fresh deploy or silently leave a privilege hole, and it is invisible
 * to a fixture that grants its own roles.
 *
 * SCOPE DECISIONS:
 *   - Asserts against `expectedRoleGrants()` exported from the deploy script
 *     itself, rather than a hand-copied list here. A local copy would drift
 *     from `configureRoles()` the moment a role is added or removed, and the
 *     drill would keep passing while the deploy silently changed shape.
 *   - `runDeploy({ deployer })` is passed an explicit signer. The CLI path
 *     impersonates DEV_WALLET on a fork; anchoring the role matrix to a signer
 *     the test also controls is what lets the operator drill reuse this deploy.
 *   - Etherscan verification and the repo-root registry mirror are already
 *     gated on `!isFork` inside the script, so neither runs here.
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import { runDeploy, expectedRoleGrants, DeployResult } from "../../../scripts/deploy/index";
import { loadAddressBook } from "../../../scripts/utils/addressBook";
import { ROLES } from "../../../scripts/config/roles";

const ADDRESS_BOOK_PATH = path.join(__dirname, "../../../scripts/config/addresses.json");
const LOCAL_ADDRESS_BOOK_PATH = path.join(__dirname, "../../../scripts/config/addresses.local.json");

describe("Deploy drill: the real deploy script produces a correctly-wired chain", function () {
    this.timeout(600_000);

    let result: DeployResult;
    let deployer: any;
    let outsider: any;
    let addressBookBackup: string | null = null;

    before(async () => {
        // `addresses.json` is TRACKED; the deploy writes to it. Back up and
        // restore so running this drill never dirties the working tree.
        addressBookBackup = fs.existsSync(ADDRESS_BOOK_PATH)
            ? fs.readFileSync(ADDRESS_BOOK_PATH, "utf-8")
            : null;

        // Auto-detect the fork's chain (see operatorDrill.test.ts for why
        // NETWORK must not be hardcoded here).
        delete process.env.NETWORK;
        await network.provider.request({ method: "hardhat_reset", params: [{}] });

        [deployer, outsider] = await ethers.getSigners();

        // MockUSDC is what the drill wants on a fork; the live-USDC path is
        // exercised by dryRunForks.sh against real chain configs.
        delete process.env.SKIP_MOCK_USDC;

        result = await runDeploy({ deployer });
    });

    after(async () => {
        if (addressBookBackup !== null) fs.writeFileSync(ADDRESS_BOOK_PATH, addressBookBackup);
        else if (fs.existsSync(ADDRESS_BOOK_PATH)) fs.unlinkSync(ADDRESS_BOOK_PATH);
        delete process.env.NETWORK;
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("deploys all five contracts to live addresses with code", async () => {
        const deployed = {
            OkuMoney: await result.okuMoney.getAddress(),
            OkuDollar: await result.okuDollar.getAddress(),
            RedemptionQueue: await result.redemptionQueue.getAddress(),
            LitePSM: await result.litePSM.getAddress(),
            MockUSDC: result.usdcAddress,
        };

        for (const [name, addr] of Object.entries(deployed)) {
            expect(ethers.isAddress(addr), `${name} address malformed: ${addr}`).to.be.true;
            expect(addr, `${name} deployed to the zero address`).to.not.equal(ethers.ZeroAddress);
            const code = await ethers.provider.getCode(addr);
            expect(code, `${name} has no code at ${addr}`).to.not.equal("0x");
        }
    });

    it("writes every contract to the address book under the fork's book key", async () => {
        expect(result.bookKey).to.equal(`fork:${result.ctx.networkName}`);

        // Read through `loadAddressBook()`, not the raw tracked file: `fork:*`
        // entries live in the gitignored `addresses.local.json` (see
        // scripts/utils/addressBook.ts), and the helper returns the merged view
        // that every operator script actually resolves against.
        const book = loadAddressBook();
        const entry = book[result.bookKey];
        expect(entry, `no address-book entry for ${result.bookKey}`).to.exist;

        for (const name of ["OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM", "MockUSDC"]) {
            expect(entry[name], `${name} missing from address book`).to.be.a("string");
            expect(ethers.isAddress(entry[name])).to.be.true;
        }

        // The book must agree with what was actually deployed — a stale or
        // crossed entry here is what makes every downstream operator script
        // silently target the wrong contract.
        expect(entry.OkuMoney).to.equal(await result.okuMoney.getAddress());
        expect(entry.OkuDollar).to.equal(await result.okuDollar.getAddress());
        expect(entry.RedemptionQueue).to.equal(await result.redemptionQueue.getAddress());
        expect(entry.LitePSM).to.equal(await result.litePSM.getAddress());
    });

    it("does NOT write fork entries into the TRACKED address book", async () => {
        // The actual regression this split exists to prevent: a fork deploy
        // must leave `addresses.json` byte-identical, so `git status` stays
        // clean and ephemeral fork addresses can't be committed by accident.
        const tracked = JSON.parse(fs.readFileSync(ADDRESS_BOOK_PATH, "utf-8"));
        const forkKeys = Object.keys(tracked).filter((k) => k.startsWith("fork:"));
        expect(forkKeys, `tracked address book leaked fork keys: ${forkKeys.join(", ")}`).to.be.empty;

        // ...and the entry really is in the gitignored local file.
        expect(fs.existsSync(LOCAL_ADDRESS_BOOK_PATH), "addresses.local.json was not created").to.be.true;
        const local = JSON.parse(fs.readFileSync(LOCAL_ADDRESS_BOOK_PATH, "utf-8"));
        expect(local[result.bookKey], `local book missing ${result.bookKey}`).to.exist;
    });

    it("grants the COMPLETE role matrix the deploy script declares", async () => {
        const contracts: Record<string, any> = {
            okuMoney: result.okuMoney,
            okuDollar: result.okuDollar,
            redemptionQueue: result.redemptionQueue,
            litePSM: result.litePSM,
        };
        const holders: Record<string, string> = {
            litePSM: await result.litePSM.getAddress(),
            redemptionQueue: await result.redemptionQueue.getAddress(),
            deployer: result.deployerAddress,
        };

        const grants = expectedRoleGrants();
        // Guard against the list being emptied/gutted — an empty matrix would
        // make the loop below vacuously pass.
        expect(grants.length).to.be.greaterThan(15);

        for (const g of grants) {
            const held = await contracts[g.contract].hasRole(g.role, holders[g.holder]);
            expect(held, `missing role grant: ${g.label}`).to.be.true;
        }
    });

    it("sets a non-zero minter allowance for LitePSM, the only minting contract", async () => {
        // `OkuMoney.mint` checks BOTH the OKUM_MINTER role and a separate
        // per-minter allowance, so a role grant alone is not sufficient —
        // without the allowance every mint reverts with ExceedsAllowance.
        const psmAllowance = await result.okuMoney.minterAllowance(await result.litePSM.getAddress());
        expect(psmAllowance).to.be.greaterThan(0n);
    });

    it("grants RedemptionQueue NEITHER the minter role NOR an allowance — it only burns", async () => {
        // RedemptionQueue previously received OKUM_MINTER plus a 1e27
        // allowance, justified by a comment ("mints rebase deltas") describing
        // the pre-streaming-accrual design. The current contract calls exactly
        // two OkuMoney methods — `burn` and `okuMMultiplier` — so that was a
        // live, unused mint-anything capability on an upgradeable contract.
        //
        // Asserted as an explicit NEGATIVE rather than just deleted from the
        // positive matrix: a future re-grant, or a stale prior deployment
        // being reused through the address book, must fail loudly rather than
        // silently restoring the capability.
        const queueAddr = await result.redemptionQueue.getAddress();
        expect(
            await result.okuMoney.hasRole(ROLES.OKUM_MINTER, queueAddr),
            "RedemptionQueue must not hold OKUM_MINTER"
        ).to.be.false;
        expect(
            await result.okuMoney.minterAllowance(queueAddr),
            "RedemptionQueue must have zero minter allowance"
        ).to.equal(0n);
        // ...but it MUST still be able to burn, or processQueue reverts.
        expect(
            await result.okuMoney.hasRole(ROLES.OKUM_BURNER, queueAddr),
            "RedemptionQueue still needs OKUM_BURNER"
        ).to.be.true;
    });

    it("does NOT grant privileged roles to an unrelated address", async () => {
        // Positive role checks alone can't catch an over-broad grant (e.g. a
        // role accidentally given to address(0) or to every signer). Assert
        // the negative case explicitly for the most dangerous roles.
        const outsiderAddr = await outsider.getAddress();
        const dangerous = [
            ROLES.OKUM_MINTER,
            ROLES.OKUM_BURNER,
            ROLES.OKUM_REBASER,
            ROLES.OKUM_CAP_MANAGER,
            ROLES.OKUM_ALLOWANCE_MANAGER,
        ];

        for (const role of dangerous) {
            expect(
                await result.okuMoney.hasRole(role, outsiderAddr),
                `outsider unexpectedly holds role ${role}`
            ).to.be.false;
            expect(
                await result.okuMoney.hasRole(role, ethers.ZeroAddress),
                `zero address unexpectedly holds role ${role}`
            ).to.be.false;
        }
    });

    it("wires the contracts to each other consistently", async () => {
        const okuMAddr = await result.okuMoney.getAddress();

        // OkuDollar's underlying asset must be the OkuMoney just deployed.
        expect(await result.okuDollar.okuMoney()).to.equal(okuMAddr);

        // PSM and queue must agree on USDC — a mismatch here is the exact
        // condition configureRoles() aborts on before granting anything, and
        // (for a fresh pair) LitePSM.initialize itself reverts on
        // (QueueUsdcMismatch).
        const psmUsdc = await result.litePSM.usdc();
        const queueUsdc = await result.redemptionQueue.usdc();
        expect(psmUsdc.toLowerCase()).to.equal(queueUsdc.toLowerCase());
        expect(psmUsdc.toLowerCase()).to.equal(result.usdcAddress.toLowerCase());

        // PSM and queue must also agree on OkuMoney — same class of check,
        // guarding LitePSM.initialize's QueueOkuMoneyMismatch revert.
        const psmOkuMoney = await result.litePSM.okuMoney();
        const queueOkuMoney = await result.redemptionQueue.okuMoney();
        expect(psmOkuMoney.toLowerCase()).to.equal(queueOkuMoney.toLowerCase());
        expect(psmOkuMoney.toLowerCase()).to.equal(okuMAddr.toLowerCase());

        // The PSM's own view of its queue must match the queue instance this
        // drill actually deployed (guards the verifyDeployment post-hoc check
        // added for the stale-address-book-reuse case).
        expect(await result.litePSM.redemptionQueue()).to.equal(
            await result.redemptionQueue.getAddress()
        );
    });

    it("produces a chain where a real mint actually works end-to-end", async () => {
        // The ultimate check that the wiring is correct: exercise the PSM mint
        // path against the freshly deployed chain. If any of the role grants,
        // allowances, or address wiring were wrong, this reverts.
        const usdc = await ethers.getContractAt("MockUSDC", result.usdcAddress, deployer);
        const psmAddr = await result.litePSM.getAddress();
        const deployerAddr = result.deployerAddress;

        const depositAmount = 10_000_000_000n; // 10k USDC (6dp)
        await usdc.mint(deployerAddr, depositAmount);
        await usdc.approve(psmAddr, depositAmount);

        const before = await result.okuMoney.balanceOf(deployerAddr);
        await result.litePSM.connect(deployer).mintOkuM(depositAmount);
        const after = await result.okuMoney.balanceOf(deployerAddr);

        expect(after).to.be.greaterThan(before);
    });
});
