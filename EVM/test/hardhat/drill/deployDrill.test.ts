/**
 * Deploy drill — runs the REAL deployment script (`scripts/deploy/index.ts`)
 * in-process against the local fork and asserts the resulting on-chain state.
 *
 * Every other test builds its own fixture with `upgrades.deployProxy`, so
 * without this drill nothing verifies the script actually run against a
 * testnet (proxy deploys, address-book writes, the role matrix).
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

    it("deploys all four contracts to live addresses with code", async () => {
        const deployed = {
            OkuMoney: await result.okuMoney.getAddress(),
            OkuDollar: await result.okuDollar.getAddress(),
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

        for (const name of ["OkuMoney", "OkuDollar", "LitePSM", "MockUSDC"]) {
            expect(entry[name], `${name} missing from address book`).to.be.a("string");
            expect(ethers.isAddress(entry[name])).to.be.true;
        }

        // The book must agree with what was actually deployed — a stale or
        // crossed entry here is what makes every downstream operator script
        // silently target the wrong contract.
        expect(entry.OkuMoney).to.equal(await result.okuMoney.getAddress());
        expect(entry.OkuDollar).to.equal(await result.okuDollar.getAddress());
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

    it("declares every contract-to-contract role the chain actually recorded", async () => {
        // `verifyDeployment` already proves every declared grant is present, so
        // the dangerous direction is the one tested here: a grant added to
        // `configureRoles` but not declared in `expectedRoleGrants()` would be an
        // unverified live privilege. Enumerate `RoleGranted` events and require
        // each non-deployer grant to be declared.
        const contracts: Record<string, any> = {
            okuMoney: result.okuMoney,
            okuDollar: result.okuDollar,
            litePSM: result.litePSM,
        };
        const psmAddr = (await result.litePSM.getAddress()).toLowerCase();
        const deployerAddr = result.deployerAddress.toLowerCase();

        const matrix = expectedRoleGrants();
        // The full matrix is 16 roles: 2 sent by configureRoles (OKUM_MINTER and
        // OKUM_BURNER to LitePSM) + 14 that `initialize` gives the admin.
        // An emptied matrix would make the check below vacuous.
        expect(matrix.length, "expectedRoleGrants() must not be gutted").to.equal(16);
        const scriptGrants = matrix.filter((g) => g.via === "script");
        expect(scriptGrants.length, "script-sent grants").to.equal(2);
        for (const g of matrix.filter((g) => g.via === "initialize")) {
            expect(g.holder, `${g.label}: initialize only grants to the admin`).to.equal("deployer");
        }

        // Only script-sent grants are declared for the non-deployer check below.
        const declared = new Set(
            scriptGrants.map((g) => {
                const holder = g.holder === "litePSM" ? psmAddr : deployerAddr;
                return `${g.contract}:${g.role}:${holder}`;
            })
        );

        const undeclared: string[] = [];
        let contractToContractGrants = 0;

        for (const [name, c] of Object.entries(contracts)) {
            const events = await c.queryFilter(c.filters.RoleGranted(), 0, "latest");
            for (const ev of events) {
                const role: string = ev.args.role;
                const account: string = ev.args.account.toLowerCase();

                // Grants to the deployer come from `initialize`; the matrix's
                // "initialize" entries are proven with `hasRole` in verifyDeployment.
                if (account === deployerAddr) continue;

                contractToContractGrants++;
                const key = `${name}:${role}:${account}`;
                if (!declared.has(key)) {
                    undeclared.push(`${name} granted ${role} to ${account} — NOT in expectedRoleGrants()`);
                }
            }
        }

        // Anti-vacuity: the contract-to-contract grants are the whole point, so
        // a run that recorded none means the harness broke, not that it passed.
        expect(contractToContractGrants, "no contract-to-contract grants were observed").to.be.greaterThan(0);
        expect(undeclared, `undeclared live role grants:\n  ${undeclared.join("\n  ")}`).to.be.empty;
    });

    it("sets a non-zero minter allowance for LitePSM, the only minting contract", async () => {
        // `OkuMoney.mint` checks BOTH the OKUM_MINTER role and a separate
        // per-minter allowance, so a role grant alone is not sufficient —
        // without the allowance every mint reverts with ExceedsAllowance.
        // `verifyDeployment` also checks this is non-zero, so a bare `> 0` here
        // would just re-run the deploy's own assertion. The value is what matters:
        // it must be large enough that the PSM can mint against the whole supply
        // cap, or minting silently stops working partway through a deployment's life.
        const psmAllowance = await result.okuMoney.minterAllowance(await result.litePSM.getAddress());
        const maxSupply = await result.okuMoney.maxSupply();
        expect(psmAllowance, "PSM allowance must cover the entire supply cap").to.equal(maxSupply);
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

        // PSM must be wired to the USDC and OkuMoney just deployed.
        expect((await result.litePSM.usdc()).toLowerCase()).to.equal(result.usdcAddress.toLowerCase());
        expect((await result.litePSM.okuMoney()).toLowerCase()).to.equal(okuMAddr.toLowerCase());
        expect(await result.litePSM.okuDollar()).to.equal(await result.okuDollar.getAddress());
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
