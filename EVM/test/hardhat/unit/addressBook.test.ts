/**
 * Unit tests for scripts/utils/addressBook.ts.
 *
 * These helpers had NO direct coverage before — only indirect exercise through
 * the hardhat drills — which is how the tracked/ephemeral split below went
 * unnoticed until a `dryRunForks.sh` run showed fork addresses dirtying
 * `addresses.json`.
 *
 * The module resolves its file paths at import time from `__dirname`, so these
 * tests operate on the real `scripts/config/*.json` locations and snapshot /
 * restore both files around every case.
 */

import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
    loadAddressBook,
    saveAddressBook,
    saveAddress,
    loadAddress,
    hasAddress,
    loadNetworkAddresses,
    appendUpgradeRecord,
    loadUpgradeHistory,
    isForkKey,
    UPGRADES_KEY,
    AddressBook,
    UpgradeRecord,
} from "../../../scripts/utils/addressBook";

const CONFIG_DIR = path.join(__dirname, "../../../scripts/config");
const TRACKED = path.join(CONFIG_DIR, "addresses.json");
const LOCAL = path.join(CONFIG_DIR, "addresses.local.json");

function snapshot(p: string): string | null {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function restore(p: string, snap: string | null): void {
    if (snap !== null) fs.writeFileSync(p, snap, "utf8");
    else if (fs.existsSync(p)) fs.unlinkSync(p);
}

describe("scripts/utils/addressBook", () => {
    let trackedSnap: string | null;
    let localSnap: string | null;

    beforeEach(() => {
        trackedSnap = snapshot(TRACKED);
        localSnap = snapshot(LOCAL);
    });

    afterEach(() => {
        restore(TRACKED, trackedSnap);
        restore(LOCAL, localSnap);
    });

    describe("isForkKey", () => {
        it("identifies fork-namespaced book keys", () => {
            expect(isForkKey("fork:sepolia")).to.be.true;
            expect(isForkKey("fork:base")).to.be.true;
            expect(isForkKey("sepolia")).to.be.false;
            expect(isForkKey("base")).to.be.false;
            // Not a prefix match in the middle of the key.
            expect(isForkKey("mainnet-fork:base")).to.be.false;
        });
    });

    describe("tracked / local split", () => {
        it("routes fork: entries to the gitignored local file and live entries to the tracked one", () => {
            saveAddressBook({
                base: { LitePSM: "0x1111111111111111111111111111111111111111" },
                "fork:base": { LitePSM: "0x2222222222222222222222222222222222222222" },
            });

            const tracked = JSON.parse(fs.readFileSync(TRACKED, "utf8"));
            const local = JSON.parse(fs.readFileSync(LOCAL, "utf8"));

            expect(Object.keys(tracked)).to.deep.equal(["base"]);
            expect(Object.keys(local)).to.deep.equal(["fork:base"]);
            expect(tracked["fork:base"]).to.be.undefined;
            expect(local.base).to.be.undefined;
        });

        it("presents both files as one merged book to callers", () => {
            saveAddressBook({
                base: { LitePSM: "0x1111111111111111111111111111111111111111" },
                "fork:base": { LitePSM: "0x2222222222222222222222222222222222222222" },
            });

            const merged = loadAddressBook();
            expect(merged.base.LitePSM).to.equal("0x1111111111111111111111111111111111111111");
            expect(merged["fork:base"].LitePSM).to.equal("0x2222222222222222222222222222222222222222");
        });

        it("saveAddress routes by key without the caller knowing about the split", () => {
            saveAddressBook({});
            saveAddress("fork:sepolia", "OkuMoney", "0x3333333333333333333333333333333333333333");
            saveAddress("sepolia", "OkuMoney", "0x4444444444444444444444444444444444444444");

            const tracked = JSON.parse(fs.readFileSync(TRACKED, "utf8"));
            const local = JSON.parse(fs.readFileSync(LOCAL, "utf8"));

            expect(tracked.sepolia.OkuMoney).to.equal("0x4444444444444444444444444444444444444444");
            expect(tracked["fork:sepolia"]).to.be.undefined;
            expect(local["fork:sepolia"].OkuMoney).to.equal("0x3333333333333333333333333333333333333333");

            // Readers resolve both transparently.
            expect(loadAddress("fork:sepolia", "OkuMoney")).to.equal("0x3333333333333333333333333333333333333333");
            expect(loadAddress("sepolia", "OkuMoney")).to.equal("0x4444444444444444444444444444444444444444");
            expect(hasAddress("fork:sepolia", "OkuMoney")).to.be.true;
            expect(loadNetworkAddresses("fork:sepolia").OkuMoney).to.equal("0x3333333333333333333333333333333333333333");
        });

        it("leaves the TRACKED file byte-identical across a pure fork run", () => {
            // The actual bug: a dry-run / fork deploy must not dirty git state.
            const before = fs.readFileSync(TRACKED, "utf8");

            saveAddress("fork:base", "OkuMoney", "0x5555555555555555555555555555555555555555");
            saveAddress("fork:base", "LitePSM", "0x6666666666666666666666666666666666666666");
            appendUpgradeRecord("fork:base", {
                contract: "LitePSM",
                proxy: "0x6666666666666666666666666666666666666666",
                oldImpl: "0x7777777777777777777777777777777777777777",
                newImpl: "0x8888888888888888888888888888888888888888",
                txHash: "0xdeadbeef",
                timestamp: new Date().toISOString(),
                deployer: "0x9999999999999999999999999999999999999999",
            });

            expect(fs.readFileSync(TRACKED, "utf8")).to.equal(before);
        });

        it("does not create a local file when there is no fork state", () => {
            if (fs.existsSync(LOCAL)) fs.unlinkSync(LOCAL);
            saveAddressBook({ base: { LitePSM: "0x1111111111111111111111111111111111111111" } });
            expect(fs.existsSync(LOCAL)).to.be.false;
        });

        it("removes the local file once the last fork entry is gone", () => {
            saveAddressBook({ "fork:base": { LitePSM: "0x1111111111111111111111111111111111111111" } });
            expect(fs.existsSync(LOCAL)).to.be.true;

            // Mirrors what deploy/index.ts does when it clears a fork book key.
            saveAddressBook({ base: { LitePSM: "0x2222222222222222222222222222222222222222" } });
            expect(fs.existsSync(LOCAL)).to.be.false;
        });
    });

    describe("upgrade audit trail", () => {
        const rec = (proxy: string): UpgradeRecord => ({
            contract: "LitePSM",
            proxy,
            oldImpl: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            newImpl: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            txHash: "0xfeed",
            timestamp: "2026-01-01T00:00:00.000Z",
            deployer: "0xcccccccccccccccccccccccccccccccccccccccc",
        });

        it("partitions upgrade records by book key, same as addresses", () => {
            saveAddressBook({});
            appendUpgradeRecord("base", rec("0x1111111111111111111111111111111111111111"));
            appendUpgradeRecord("fork:base", rec("0x2222222222222222222222222222222222222222"));

            const tracked = JSON.parse(fs.readFileSync(TRACKED, "utf8"));
            const local = JSON.parse(fs.readFileSync(LOCAL, "utf8"));

            expect(tracked[UPGRADES_KEY]).to.have.property("base");
            expect(tracked[UPGRADES_KEY]["fork:base"]).to.be.undefined;
            expect(local[UPGRADES_KEY]).to.have.property("fork:base");
            expect(local[UPGRADES_KEY].base).to.be.undefined;
        });

        it("reads history back through the merged view for both key kinds", () => {
            saveAddressBook({});
            appendUpgradeRecord("base", rec("0x1111111111111111111111111111111111111111"));
            appendUpgradeRecord("fork:base", rec("0x2222222222222222222222222222222222222222"));

            expect(loadUpgradeHistory("base")).to.have.lengthOf(1);
            expect(loadUpgradeHistory("base")[0].proxy).to.equal("0x1111111111111111111111111111111111111111");
            expect(loadUpgradeHistory("fork:base")).to.have.lengthOf(1);
            expect(loadUpgradeHistory("fork:base")[0].proxy).to.equal("0x2222222222222222222222222222222222222222");
        });

        it("keeps the reserved upgrades key out of contract lookups", () => {
            saveAddressBook({});
            appendUpgradeRecord("base", rec("0x1111111111111111111111111111111111111111"));
            expect(loadNetworkAddresses(UPGRADES_KEY)).to.deep.equal({});
            expect(hasAddress(UPGRADES_KEY, "LitePSM")).to.be.false;
        });
    });

    describe("robustness", () => {
        it("treats a missing or empty local file as no fork state", () => {
            if (fs.existsSync(LOCAL)) fs.unlinkSync(LOCAL);
            expect(() => loadAddressBook()).to.not.throw();

            fs.writeFileSync(LOCAL, "   ", "utf8");
            const book: AddressBook = loadAddressBook();
            expect(Object.keys(book).some(isForkKey)).to.be.false;
        });

        it("throws a helpful error when an address is genuinely absent", () => {
            saveAddressBook({});
            expect(() => loadAddress("fork:nowhere", "OkuMoney")).to.throw(/No address found/);
        });
    });
});
