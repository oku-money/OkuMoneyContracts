import { expect } from "chai";
import { mainnetGuard, MAINNET_NETWORKS, isMainnetNetwork } from "../../../scripts/utils/mainnetGuard";
import { CHAIN_METADATA } from "../../../scripts/config/chains";

/**
 * The guard is the last thing between a mistyped `--network` and a live
 * broadcast. Its failure mode is silence: a network absent from the set is
 * simply allowed through.
 */
describe("mainnetGuard", () => {
    describe("network set", () => {
        it("covers every mainnet in CHAIN_METADATA", () => {
            // Any configured mainnet missing from the set bypasses the gate.
            const KNOWN_TESTNETS = new Set([
                "sepolia", "baseSepolia", "arbSepolia", "bscTestnet",
                "opSepolia", "localhost", "hardhat",
            ]);
            const mainnetsInMetadata = Object.keys(CHAIN_METADATA).filter(
                (n) => !KNOWN_TESTNETS.has(n) && !n.startsWith("fork:")
            );
            for (const n of mainnetsInMetadata) {
                expect(isMainnetNetwork(n), `${n} is configured but not guarded`).to.equal(true);
            }
        });

        it("includes optimism and arbitrum specifically", () => {
            expect(MAINNET_NETWORKS.has("optimism")).to.equal(true);
            expect(MAINNET_NETWORKS.has("arbitrum")).to.equal(true);
        });

        it("does not classify testnets as mainnet", () => {
            for (const n of ["sepolia", "baseSepolia", "arbSepolia", "bscTestnet", "localhost"]) {
                expect(isMainnetNetwork(n), `${n} misclassified`).to.equal(false);
            }
        });
    });

    describe("gate behaviour", () => {
        it("throws on a mainnet without opt-in", () => {
            // Match the message, not a bare `.to.throw()`: this is the last gate
            // before a mainnet broadcast and an unrelated TypeError must not pass.
            expect(() => mainnetGuard("base", {})).to.throw(/Refusing to broadcast/i);
            expect(() => mainnetGuard("optimism", {})).to.throw(/Refusing to broadcast/i);
        });

        it("allows a mainnet with explicit opt-in", () => {
            expect(() => mainnetGuard("base", { yesMainnet: true })).to.not.throw();
        });

        it("allows a dry run on a mainnet", () => {
            expect(() => mainnetGuard("base", { dryRun: true })).to.not.throw();
        });

        it("is a no-op on testnets", () => {
            expect(() => mainnetGuard("sepolia", {})).to.not.throw();
            expect(() => mainnetGuard("localhost", {})).to.not.throw();
        });
    });
});
