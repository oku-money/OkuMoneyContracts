import { expect } from "chai";
import { participatingChains, parseChainsEnv, DEFAULT_EPOCH_CHAINS, SVM_CHAIN_KEY } from "../../../scripts/config/epochChains";

describe("scripts/config/epochChains", () => {
    it("DEFAULT_EPOCH_CHAINS is the 3-testnet + bscTestnet + SVM MVP set — NOT every CHAIN_METADATA key", () => {
        expect(DEFAULT_EPOCH_CHAINS).to.have.members([
            "sepolia",
            "baseSepolia",
            "arbSepolia",
            "bscTestnet",
            SVM_CHAIN_KEY,
        ]);
        // Explicitly must NOT include either mainnet — the two chains that
        // carry a stale pre-streaming deployment.
        expect(DEFAULT_EPOCH_CHAINS).to.not.include("mainnet");
        expect(DEFAULT_EPOCH_CHAINS).to.not.include("base");
        expect(DEFAULT_EPOCH_CHAINS).to.not.include("bsc");
    });

    it("participatingChains() with no args returns the default set", () => {
        expect(participatingChains()).to.deep.equal([...DEFAULT_EPOCH_CHAINS]);
    });

    it("participatingChains() honours an explicit requested list", () => {
        expect(participatingChains({ requested: ["sepolia"] })).to.deep.equal(["sepolia"]);
    });

    it("participatingChains() throws on an unknown chain name rather than silently dropping it", () => {
        expect(() => participatingChains({ requested: ["sepolia", "not-a-real-chain"] })).to.throw(/unknown chain/i);
    });

    it("REGRESSION (defect #4): participatingChains() refuses a mainnet chain without yesMainnet", () => {
        expect(() => participatingChains({ requested: ["base"] })).to.throw(/mainnet/i);
        expect(() => participatingChains({ requested: ["mainnet", "bsc"] })).to.throw(/mainnet/i);
    });

    it("participatingChains() allows a mainnet chain when yesMainnet=true is explicitly given", () => {
        expect(participatingChains({ requested: ["base"], yesMainnet: true })).to.deep.equal(["base"]);
    });

    it("parseChainsEnv parses a comma-separated CHAINS= value, trimming whitespace and dropping empties", () => {
        expect(parseChainsEnv("sepolia, baseSepolia ,,arbSepolia")).to.deep.equal([
            "sepolia",
            "baseSepolia",
            "arbSepolia",
        ]);
    });

    it("parseChainsEnv returns undefined for unset/empty input (meaning: use the default)", () => {
        expect(parseChainsEnv(undefined)).to.be.undefined;
        expect(parseChainsEnv("")).to.be.undefined;
        expect(parseChainsEnv("   ")).to.be.undefined;
    });
});
