/**
 * Mainnet handover drill — runs the REAL `grantRolesMainnet.ts` against a fresh
 * deploy and asserts the end state the mainnet ceremony depends on: every
 * target key holds its roles, LitePSM keeps OKUM_MINTER/OKUM_BURNER, and the
 * deployer key holds NOTHING (no admin, no upgrader, no minter).
 *
 * Cyfrin audit #16: the ceremony is TWO runs with a cold-multisig `revokeRole` between
 * them. Run 1 grants and stops with the deployer intact; the deployer is only stripped
 * once the cold key has itself signed on this chain.
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import { runDeploy, expectedRoleGrants, DeployResult } from "../../../scripts/deploy/index";
import {
    runGrantRolesMainnet,
    deployerInitRoles,
    coldRevokedDeployerAdmin,
    EXIT_AWAITING_COLD_REVOKE,
} from "../../../scripts/operator/grantRolesMainnet";
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
            expect(await runGrantRolesMainnet()).to.equal("dry-run");
        } finally {
            delete process.env.DRY_RUN;
        }
        expect(await result.okuMoney.hasRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.DEFAULT_ADMIN_ROLE, await cold.getAddress())).to.be.false;
    });

    function contractsByName(): Record<string, any> {
        return { OkuMoney: result.okuMoney, OkuDollar: result.okuDollar, LitePSM: result.litePSM };
    }

    it("coldRevokedDeployerAdmin: only the named sender revoking the named account counts", async () => {
        // Third parties, so the deployer's own admin (needed below) is untouched.
        const [, , , , , a, b, c] = await ethers.getSigners();
        const [aAddr, bAddr, cAddr] = await Promise.all([a, b, c].map((x) => x.getAddress()));
        const okuMoney = result.okuMoney;
        await (await okuMoney.connect(deployer).grantRole(ROLES.DEFAULT_ADMIN_ROLE, aAddr)).wait();
        await (await okuMoney.connect(deployer).grantRole(ROLES.DEFAULT_ADMIN_ROLE, bAddr)).wait();
        await (await okuMoney.connect(a).revokeRole(ROLES.DEFAULT_ADMIN_ROLE, bAddr)).wait();

        expect(await coldRevokedDeployerAdmin(okuMoney, bAddr, aAddr, 0), "a revoked b").to.be.true;
        // wrong sender, wrong account, nobody: not proof
        expect(await coldRevokedDeployerAdmin(okuMoney, bAddr, cAddr, 0)).to.be.false;
        expect(await coldRevokedDeployerAdmin(okuMoney, aAddr, bAddr, 0)).to.be.false;
        expect(await coldRevokedDeployerAdmin(okuMoney, cAddr, aAddr, 0)).to.be.false;
        // a self-renounce is a RoleRevoked with sender == account: proves nothing about a cold key
        await (await okuMoney.connect(a).renounceRole(ROLES.DEFAULT_ADMIN_ROLE, aAddr)).wait();
        expect(await coldRevokedDeployerAdmin(okuMoney, aAddr, bAddr, 0)).to.be.false;
        // the block floor is honoured
        const latest = await ethers.provider.getBlockNumber();
        expect(await coldRevokedDeployerAdmin(okuMoney, bAddr, aAddr, latest + 1)).to.be.false;
    });

    it("run 1 grants everything, then stops with the deployer still in control", async () => {
        expect(await runGrantRolesMainnet()).to.equal("awaiting-cold-revoke");
        expect(EXIT_AWAITING_COLD_REVOKE).to.equal(2);

        const coldAddr = await cold.getAddress();
        const contracts = contractsByName();
        // everything is granted ...
        for (const c of Object.values(contracts)) {
            expect(await c.hasRole(ROLES.DEFAULT_ADMIN_ROLE, coldAddr)).to.be.true;
        }
        expect(await result.okuMoney.hasRole(ROLES.OKUM_UPGRADER, coldAddr)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_RATE_MANAGER, await orch.getAddress())).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_PAUSER, await warm.getAddress())).to.be.true;
        // ... but nothing was stripped: holding the role proved nothing about the cold key
        for (const { contractName, roleName } of deployerInitRoles()) {
            expect(
                await contracts[contractName].hasRole(ROLES[roleName], result.deployerAddress),
                `deployer lost ${contractName}.${roleName} before the cold key signed`
            ).to.be.true;
        }
    });

    it("run 1 repeated is still held back (the cold key has not signed)", async () => {
        expect(await runGrantRolesMainnet()).to.equal("awaiting-cold-revoke");
        expect(await result.okuMoney.hasRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).to.be.true;
    });

    it("a partial cold revoke (one contract short) still holds the deployer's roles", async () => {
        await (await result.okuMoney.connect(cold).revokeRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).wait();
        await (await result.okuDollar.connect(cold).revokeRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).wait();

        expect(await runGrantRolesMainnet()).to.equal("awaiting-cold-revoke");
        // LitePSM was not revoked by the cold key: its deployer roles must all still be there
        for (const { contractName, roleName } of deployerInitRoles()) {
            if (roleName === "DEFAULT_ADMIN_ROLE") continue;
            expect(
                await contractsByName()[contractName].hasRole(ROLES[roleName], result.deployerAddress),
                `deployer lost ${contractName}.${roleName} with the cold revoke incomplete`
            ).to.be.true;
        }
    });

    it("run 2, after the cold key has signed on every contract, leaves the deployer holding no role", async () => {
        await (await result.litePSM.connect(cold).revokeRole(ROLES.DEFAULT_ADMIN_ROLE, result.deployerAddress)).wait();

        expect(await runGrantRolesMainnet()).to.equal("complete");

        const contracts = contractsByName();
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
        expect(await result.okuMoney.hasRole(ROLES.OKUM_RATE_MANAGER, await orch.getAddress())).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_PAUSER, await warm.getAddress())).to.be.true;

        // The PSM's own mint/burn grants are untouched.
        const psm = await result.litePSM.getAddress();
        expect(await result.okuMoney.hasRole(ROLES.OKUM_MINTER, psm)).to.be.true;
        expect(await result.okuMoney.hasRole(ROLES.OKUM_BURNER, psm)).to.be.true;
    });

    it("is idempotent on re-run", async () => {
        // Deployer is no longer admin; every step must short-circuit on hasRole.
        expect(await runGrantRolesMainnet()).to.equal("complete");
    });
});
