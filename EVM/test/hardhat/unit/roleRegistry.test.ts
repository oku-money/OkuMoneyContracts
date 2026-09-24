import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    recordRoleGrant,
    loadRoleGrants,
    deriveLedgerHolders,
    RoleGrantRecord,
} from "../../../scripts/utils/roleRegistry";

/**
 * The grant ledger is the only durable record of who holds privilege: the
 * contracts use `AccessControlUpgradeable` (no on-chain enumeration) and at
 * least one deployed chain has pruned the deployment-era logs, so this file is
 * not reconstructible from chain state.
 */
describe("roleRegistry", () => {
    let ledgerPath: string;

    const rec = (over: Partial<RoleGrantRecord> = {}): RoleGrantRecord => ({
        at: "2026-01-01T00:00:00.000Z",
        chain: "sepolia",
        contract: "OkuMoney",
        contractAddress: "0x9b2E1Ed079E1453641AFD2f91cf9E9c14Ae3c6eE",
        role: "OKUM_MINTER",
        roleHash: "0xabc",
        grantee: "0x971A3e2b0031dE23715Fa1ce53843B5B045dae00",
        granteeLabel: "MASTER_EOA",
        action: "grant",
        granter: "0x3CB68a6762041aA05E762814A8791CA9d98E79A0",
        txHash: "0xdead",
        script: "test",
        ...over,
    });

    beforeEach(() => {
        ledgerPath = path.join(os.tmpdir(), `roleGrants.${Date.now()}.${Math.random()}.json`);
    });

    afterEach(() => {
        if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
    });

    it("persists a grant and reads it back", () => {
        expect(recordRoleGrant(rec(), ledgerPath).ok).to.equal(true);
        const rows = loadRoleGrants(ledgerPath);
        expect(rows).to.have.length(1);
        expect(rows[0].grantee).to.equal("0x971A3e2b0031dE23715Fa1ce53843B5B045dae00");
    });

    it("is idempotent for an identical re-run", () => {
        recordRoleGrant(rec(), ledgerPath);
        recordRoleGrant(rec(), ledgerPath);
        expect(loadRoleGrants(ledgerPath)).to.have.length(1);
    });

    it("keeps a genuinely separate grant with a different tx", () => {
        recordRoleGrant(rec(), ledgerPath);
        recordRoleGrant(rec({ txHash: "0xbeef" }), ledgerPath);
        expect(loadRoleGrants(ledgerPath)).to.have.length(2);
    });

    it("returns an error rather than throwing when the path is unwritable", () => {
        // A grant already landed on-chain when this is called; aborting the
        // script mid-sequence would be worse than losing the row.
        // Path sits UNDER a regular file, so mkdir/write cannot succeed.
        const blocker = path.join(os.tmpdir(), `blocker.${Date.now()}.${Math.random()}`);
        fs.writeFileSync(blocker, "not a directory");
        try {
            const res = recordRoleGrant(rec(), path.join(blocker, "nested", "here.json"));
            expect(res.ok).to.equal(false);
        } finally {
            fs.unlinkSync(blocker);
        }
    });

    describe("deriveLedgerHolders", () => {
        it("replays grant then revoke in timestamp order", () => {
            const holders = deriveLedgerHolders([
                rec({ at: "2026-01-01T00:00:00.000Z", action: "grant" }),
                rec({ at: "2026-01-02T00:00:00.000Z", action: "revoke" }),
            ]);
            expect(holders.get("sepolia|OkuMoney|OKUM_MINTER")?.size ?? 0).to.equal(0);
        });

        it("re-grants after a revoke", () => {
            const holders = deriveLedgerHolders([
                rec({ at: "2026-01-01T00:00:00.000Z", action: "grant" }),
                rec({ at: "2026-01-02T00:00:00.000Z", action: "revoke" }),
                rec({ at: "2026-01-03T00:00:00.000Z", action: "grant" }),
            ]);
            expect(holders.get("sepolia|OkuMoney|OKUM_MINTER")?.size).to.equal(1);
        });

        it("is order-independent of array position (sorts by timestamp)", () => {
            const holders = deriveLedgerHolders([
                rec({ at: "2026-01-02T00:00:00.000Z", action: "revoke" }),
                rec({ at: "2026-01-01T00:00:00.000Z", action: "grant" }),
            ]);
            expect(holders.get("sepolia|OkuMoney|OKUM_MINTER")?.size ?? 0).to.equal(0);
        });

        it("ignores dry-run rows — they record intent, not privilege", () => {
            const holders = deriveLedgerHolders([rec({ dryRun: true })]);
            expect(holders.get("sepolia|OkuMoney|OKUM_MINTER")?.size ?? 0).to.equal(0);
        });

        it("keys separately per chain", () => {
            const holders = deriveLedgerHolders([rec(), rec({ chain: "baseSepolia" })]);
            expect(holders.get("sepolia|OkuMoney|OKUM_MINTER")?.size).to.equal(1);
            expect(holders.get("baseSepolia|OkuMoney|OKUM_MINTER")?.size).to.equal(1);
        });
    });
});
