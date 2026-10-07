/**
 * Upgrade drill — runs the REAL upgrade script (`scripts/upgrade/index.ts`)
 * against a fresh deploy from the REAL deploy script, with V2 fixtures from
 * `test/mocks/UpgradeDrillMocks.sol`.
 *
 * Covers what an operator relies on when shipping an upgrade fast:
 *   - direct upgrade: impl swapped, state preserved, record + baseline written;
 *   - re-run with unchanged code is a no-op that records nothing;
 *   - DRY_RUN sends nothing and deploys nothing;
 *   - a storage-incompatible implementation is refused before any tx;
 *   - a proxy missing from the OZ manifest is refused (never forceImported —
 *     audit U-01);
 *   - propose -> (Safe executes) -> verify, including the Safe batch calldata.
 */

import { expect } from "chai";
import hre, { ethers, network, upgrades } from "hardhat";
import fs from "fs";
import os from "os";
import path from "path";
import { Manifest } from "@openzeppelin/upgrades-core";
import { runDeploy, DeployResult } from "../../../scripts/deploy/index";
import { runUpgrade } from "../../../scripts/upgrade/index";
import { loadUpgradeHistory } from "../../../scripts/utils/addressBook";
import { loadBaseline } from "../../../scripts/utils/upgradeBaseline";
import { ROLES } from "../../../scripts/config/roles";

const CONFIG = path.join(__dirname, "../../../scripts/config");
const BACKED_UP = [
    path.join(CONFIG, "addresses.json"),
    path.join(CONFIG, "addresses.local.json"),
    path.join(CONFIG, "upgradeBaselines.json"),
    path.join(CONFIG, "upgradeBaselines.local.json"),
];

describe("Upgrade drill: the real upgrade script, end to end", function () {
    this.timeout(600_000);

    let result: DeployResult;
    let deployer: any;
    let safe: any;
    let bookKey: string;
    let proposalDir: string;
    const backups: Record<string, string | null> = {};

    const implOf = (proxy: string) => upgrades.erc1967.getImplementationAddress(proxy);

    before(async () => {
        for (const p of BACKED_UP) backups[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
        delete process.env.NETWORK;
        delete process.env.DRY_RUN;
        delete process.env.SKIP_BYTECODE_CHECK;
        await network.provider.request({ method: "hardhat_reset", params: [{}] });
        [deployer, , , , safe] = await ethers.getSigners();
        result = await runDeploy({ deployer });
        bookKey = result.bookKey;
        proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), "okum-proposals-"));
    });

    after(async () => {
        for (const [p, v] of Object.entries(backups)) {
            if (v !== null) fs.writeFileSync(p, v);
            else if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        fs.rmSync(proposalDir, { recursive: true, force: true });
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("deploy recorded a layout baseline for every proxy", async () => {
        for (const name of ["OkuMoney", "OkuDollar", "LitePSM"]) {
            const b = loadBaseline(bookKey, name);
            expect(b, `${name} baseline`).to.exist;
            const proxy = await (result as any)[name[0].toLowerCase() + name.slice(1)].getAddress();
            expect(b!.impl.toLowerCase()).to.equal((await implOf(proxy)).toLowerCase());
        }
    });

    it("re-running with unchanged code does nothing and records nothing", async () => {
        const before = loadUpgradeHistory(bookKey).length;
        const r = await runUpgrade({ bookKey, signer: deployer, mode: "direct", dryRun: false, targets: [{ name: "LitePSM" }] });
        expect(r.outcomes[0].txHash).to.equal("<bytecode-unchanged>");
        expect(loadUpgradeHistory(bookKey).length).to.equal(before);
    });

    it("DRY_RUN validates without deploying or sending anything", async () => {
        const proxy = await result.okuMoney.getAddress();
        const implBefore = await implOf(proxy);
        const blockBefore = await ethers.provider.getBlockNumber();
        const r = await runUpgrade({
            bookKey, signer: deployer, mode: "direct", dryRun: true,
            targets: [{ name: "OkuMoney", factory: "OkuMoneyV2Mock" }],
        });
        expect(r.outcomes[0].txHash).to.equal("<dry-run>");
        expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore);
        expect(await implOf(proxy)).to.equal(implBefore);
    });

    it("direct upgrade swaps the implementation, preserves state, records + re-baselines", async () => {
        const proxy = await result.okuMoney.getAddress();
        const oldImpl = await implOf(proxy);
        const supply = await result.okuMoney.maxSupply();

        const r = await runUpgrade({
            bookKey, signer: deployer, mode: "direct", dryRun: false,
            targets: [{ name: "OkuMoney", factory: "OkuMoneyV2Mock" }],
        });

        const newImpl = await implOf(proxy);
        expect(newImpl).to.not.equal(oldImpl);
        expect(r.outcomes[0].newImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
        const v2 = await ethers.getContractAt("OkuMoneyV2Mock", proxy);
        expect(await v2.upgradeDrillVersion()).to.equal(2n);
        expect(await v2.maxSupply()).to.equal(supply);

        const rec = loadUpgradeHistory(bookKey).at(-1)!;
        expect(rec.contract).to.equal("OkuMoney");
        expect(rec.newImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
        expect(rec.mode).to.equal("direct");
        expect(rec.preState?.maxSupply).to.equal(supply.toString());
        expect(loadBaseline(bookKey, "OkuMoney")!.impl.toLowerCase()).to.equal(newImpl.toLowerCase());
    });

    it("refuses a storage-incompatible implementation before sending anything", async () => {
        const proxy = await result.litePSM.getAddress();
        const implBefore = await implOf(proxy);
        const blockBefore = await ethers.provider.getBlockNumber();
        let err: any;
        try {
            await runUpgrade({
                bookKey, signer: deployer, mode: "direct", dryRun: false,
                targets: [{ name: "LitePSM", factory: "LitePSMBadLayoutMock" }],
            });
        } catch (e) {
            err = e;
        }
        expect(err, "bad layout was accepted").to.exist;
        expect(String(err.message)).to.match(/storage-INCOMPATIBLE/);
        expect(await implOf(proxy)).to.equal(implBefore);
        expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore);
    });

    it("refuses when the OZ manifest is missing — never forceImports", async () => {
        const manifest = await Manifest.forNetwork(hre.network.provider);
        const saved = fs.readFileSync(manifest.file);
        fs.unlinkSync(manifest.file);
        const proxy = await result.litePSM.getAddress();
        const implBefore = await implOf(proxy);
        try {
            let err: any;
            try {
                await runUpgrade({
                    bookKey, signer: deployer, mode: "direct", dryRun: false,
                    targets: [{ name: "LitePSM", factory: "LitePSMV3Mock" }],
                });
            } catch (e) {
                err = e;
            }
            expect(err, "missing manifest was accepted").to.exist;
            expect(String(err.message)).to.match(/will NOT forceImport/);
            expect(fs.existsSync(manifest.file), "the script recreated the manifest").to.be.false;
            expect(await implOf(proxy)).to.equal(implBefore);
        } finally {
            fs.writeFileSync(manifest.file, saved);
        }
    });

    it("propose writes a Safe batch; nothing moves until the Safe executes; verify records it", async () => {
        const proxy = await result.litePSM.getAddress();
        const safeAddr = await safe.getAddress();
        await (await result.litePSM.connect(deployer).grantRole(ROLES.PSM_UPGRADER, safeAddr)).wait();
        const oldImpl = await implOf(proxy);

        const proposed = await runUpgrade({
            bookKey, signer: deployer, mode: "propose", dryRun: false, safe: safeAddr, proposalDir,
            targets: [{ name: "LitePSM", factory: "LitePSMV2Mock" }],
        });
        expect(await implOf(proxy), "propose must not upgrade").to.equal(oldImpl);
        const newImpl = proposed.outcomes[0].newImpl;

        const batch = JSON.parse(fs.readFileSync(proposed.safeBatchPath!, "utf-8"));
        expect(batch.meta.createdFromSafeAddress).to.equal(safeAddr);
        expect(batch.transactions).to.have.length(1);
        const tx = batch.transactions[0];
        expect(tx.to).to.equal(proxy);
        const decoded = result.litePSM.interface.decodeFunctionData("upgradeToAndCall", tx.data);
        expect(decoded[0].toLowerCase()).to.equal(newImpl.toLowerCase());

        // The "Safe" executes the batch.
        await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: 0 })).wait();
        expect((await implOf(proxy)).toLowerCase()).to.equal(newImpl.toLowerCase());

        const before = loadUpgradeHistory(bookKey).length;
        await runUpgrade({ bookKey, signer: deployer, mode: "verify", dryRun: false, proposalPath: proposed.proposalPath });
        const rec = loadUpgradeHistory(bookKey);
        expect(rec.length).to.equal(before + 1);
        expect(rec.at(-1)!.mode).to.equal("multisig");
        expect(rec.at(-1)!.deployer).to.equal(safeAddr);
        expect(loadBaseline(bookKey, "LitePSM")!.impl.toLowerCase()).to.equal(newImpl.toLowerCase());
    });
});
