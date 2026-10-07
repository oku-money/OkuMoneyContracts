/**
 * Mainnet handover drill — runs the REAL `grantRolesMainnet.ts` against a fresh
 * deploy and asserts the end state the mainnet ceremony depends on: every
 * target key holds its roles, LitePSM keeps OKUM_MINTER/OKUM_BURNER, and the
 * deployer key holds NOTHING (no admin, no upgrader, no minter).
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import { runDeploy, expectedRoleGrants, DeployResult } from "../../../scripts/deploy/index";
import { runGrantRolesMainnet, deployerInitRoles } from "../../../scripts/operator/grantRolesMainnet";
import { ROLES } from "../../../scripts/config/roles";

const ADDRESS_BOOK_PATH = path.join(__dirname, "../../../scripts/config/addresses.json");
const ROLE_LEDGER_PATH = path.join(__dirname, "../../../scripts/config/roleGrants.json");

describe("Mainnet handover drill: grantRolesMainnet leaves the deployer with nothing", function () {
    this.timeout(600_000);

    let result: DeployResult;
    let deployer: any, cold: any, warm: any, orch: any;
    const backups: Record<string, string | null> = {};
    const savedEnv: Record<string, string | undefined> = {};
    const ENV = ["MAINNET_COLD_MULTISIG", "MAINNET_WARM_MULTISIG", "MAINNET_ORCHESTRATOR", "DRY_RUN", "NETWORK"];

    before(async () => {
        for (const p of [ADDRESS_BOOK_PATH, ROLE_LEDGER_PATH]) {
            backups[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
        }
        for (const k of ENV) savedEnv[k] = process.env[k];
        delete process.env.NETWORK;
        delete process.env.DRY_RUN;
        await network.provider.request({ method: "hardhat_reset", params: [{}] });
        [deployer, cold, warm, orch] = await ethers.getSigners();
        result = await runDeploy({ deployer });

        process.env.MAINNET_COLD_MULTISIG = await cold.getAddress();
        process.env.MAINNET_WARM_MULTISIG = await warm.getAddress();
        process.env.MAINNET_ORCHESTRATOR = await orch.getAddress();
    });

    after(async () => {
        for (const [p, v] of Object.entries(backups)) {
            if (v !== null) fs.writeFileSync(p, v);
            else if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        for (const k of ENV) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("covers every role initialize granted", () => {
        expect(deployerInitRoles().length).to.equal(
            expectedRoleGrants().filter((g) => g.via === "initialize").length
        );
    });

    it("DRY_RUN changes nothing", async () => {
        process.env.DRY_RUN = "1";
        try {
            await runGrantRolesMainnet();
        } finally {
            delete process.env.DRY_RUN;
        }
        expect(await result.okuMoney.hasRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.DEFAULT_ADMIN_ROLE, await cold.getAddress())).to.be.false;
    });

    it("hands over and leaves the deployer holding no role", async () => {
        await runGrantRolesMainnet();

        const contracts: Record<string, any> = {
            OkuMoney: result.okuMoney,
            OkuDollar: result.okuDollar,
            LitePSM: result.litePSM,
        };
        for (const { contractName, roleName } of deployerInitRoles()) {
            expect(
                await contracts[contractName].hasRole(ROLES[roleName], result.deployerAddress),
                `deployer still holds ${contractName}.${roleName}`
            ).to.be.false;
        }

        const coldAddr = await cold.getAddress();
        for (const c of Object.values(contracts)) {
            expect(await c.hasRole(ROLES.DEFAULT_ADMIN_ROLE, coldAddr)).to.be.true;
        }
        expect(await result.okuMoney.hasRole(ROLES.OKUM_UPGRADER, coldAddr)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_REBASER, await orch.getAddress())).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_PAUSER, await warm.getAddress())).to.be.true;

        // The PSM's own mint/burn grants are untouched.
        const psm = await result.litePSM.getAddress();
        expect(await result.okuMoney.hasRole(ROLES.OKUM_MINTER, psm)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_BURNER, psm)).to.be.true;
    });

    it("is idempotent on re-run", async () => {
        // Deployer is no longer admin; every step must short-circuit on hasRole.
        await runGrantRolesMainnet();
    });
});
