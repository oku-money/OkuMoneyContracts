import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    resolveNetworkContext,
    chainIdCheckApplies,
    assertChainIdMatches,
} from "../../../scripts/utils/networkContext";
import {
    CHAIN_METADATA,
    MOCK_USDC_NETWORKS,
    isMockUsdcChainId,
    assertMockUsdcAllowed,
    getNetworkNameByChainId,
} from "../../../scripts/config/chains";
import { isMainnetNetwork } from "../../../scripts/utils/mainnetGuard";

/**
 * Cyfrin audit #17. `NETWORK` used to be trusted on a live run: a value left over from a
 * fork session named a different chain than the one connected, the mainnet gate and the
 * real-USDC requirement were decided from that name, and the deploy created a
 * permissionless MockUSDC as the PSM's one-time reserve on a production chain.
 */
describe("networkContext: chainId cross-check (Cyfrin #17)", () => {
    describe("chainIdCheckApplies", () => {
        it("applies everywhere except an auto-detected fork", () => {
            expect(chainIdCheckApplies(false, false)).to.equal(true); // live, name from --network
            expect(chainIdCheckApplies(false, true)).to.equal(true); // live, NETWORK= set
            expect(chainIdCheckApplies(true, true)).to.equal(true); // fork, NETWORK= set
            expect(chainIdCheckApplies(true, false)).to.equal(false); // fork, name derived from chainId
        });
    });

    describe("assertChainIdMatches", () => {
        const base = {
            isFork: false,
            explicit: false,
            networkName: "base",
            hardhatNetworkName: "base",
            expectedChainId: 8453,
        };

        it("passes when the connected chain is the named one", () => {
            expect(() => assertChainIdMatches({ ...base, liveChainId: 8453 })).not.to.throw();
        });

        it("refuses a live chain that is not the named one", () => {
            expect(() => assertChainIdMatches({ ...base, liveChainId: 1 })).to.throw(
                /connected chain .* reports chainId 1, but "base".* expects chainId 8453/
            );
        });

        it("points at a stale NETWORK env var when that is where the name came from", () => {
            expect(() =>
                assertChainIdMatches({ ...base, explicit: true, networkName: "sepolia", expectedChainId: 11155111, liveChainId: 8453 })
            ).to.throw(/from the NETWORK env var; unset a stale one/);
        });

        it("keeps the fork wording for a mismatched fork", () => {
            expect(() =>
                assertChainIdMatches({ ...base, isFork: true, explicit: true, liveChainId: 1 })
            ).to.throw(/local node reports chainId 1, but NETWORK=base expects chainId 8453/);
        });
    });

    describe("resolveNetworkContext on the running node", () => {
        const savedName = network.name;
        const savedEnv = process.env.NETWORK;
        let liveChainId: number;
        let liveName: string;
        let otherName: string;

        before(async () => {
            liveChainId = Number((await ethers.provider.getNetwork()).chainId);
            liveName = getNetworkNameByChainId(liveChainId)!;
            expect(liveName, `no CHAIN_METADATA entry for chainId ${liveChainId}`).to.exist;
            otherName = Object.keys(CHAIN_METADATA).find(
                (n) => n !== "localhost" && CHAIN_METADATA[n].chainId !== liveChainId
            )!;
        });

        afterEach(() => {
            (network as any).name = savedName;
            if (savedEnv === undefined) delete process.env.NETWORK;
            else process.env.NETWORK = savedEnv;
        });

        it("refuses a stale NETWORK on a fork (existing behaviour)", async () => {
            process.env.NETWORK = otherName;
            let err: Error | undefined;
            try {
                await resolveNetworkContext({ silent: true });
            } catch (e: any) {
                err = e;
            }
            expect(err?.message).to.match(/Chain ID mismatch/);
        });

        it("refuses a LIVE network whose name is not the connected chain", async () => {
            // A hardhat network entry pointing at another chain's name, with no fork
            // auto-detect to fall back on: the name decides the mainnet gate and the USDC.
            delete process.env.NETWORK;
            (network as any).name = otherName;
            let err: Error | undefined;
            try {
                await resolveNetworkContext({ silent: true });
            } catch (e: any) {
                err = e;
            }
            expect(err?.message).to.match(/Chain ID mismatch: the connected chain/);
            expect(err?.message).to.include(`"${otherName}"`);
        });

        it("refuses a stale NETWORK on a LIVE network", async () => {
            (network as any).name = liveName; // a live run bound to the right chain...
            process.env.NETWORK = otherName; // ...with a stale name from a fork session
            let err: Error | undefined;
            try {
                await resolveNetworkContext({ silent: true });
            } catch (e: any) {
                err = e;
            }
            expect(err?.message).to.match(/unset a stale one/);
        });

        it("accepts a live network whose name is the connected chain", async () => {
            delete process.env.NETWORK;
            (network as any).name = liveName;
            const ctx = await resolveNetworkContext({ silent: true });
            expect(ctx.isFork).to.equal(false);
            expect(ctx.networkName).to.equal(liveName);
            expect(ctx.chainConfig.chainId).to.equal(liveChainId);
        });
    });
});

describe("MockUSDC reserve allowlist (Cyfrin #17)", () => {
    it("lists testnets only: no entry is a mainnet", () => {
        for (const n of MOCK_USDC_NETWORKS) {
            expect(isMainnetNetwork(n), `${n} is a mainnet`).to.equal(false);
        }
    });

    it("excludes every configured mainnet", () => {
        for (const n of ["mainnet", "optimism", "arbitrum", "base", "bsc"]) {
            expect(isMockUsdcChainId(CHAIN_METADATA[n].chainId), n).to.equal(false);
        }
    });

    it("allows exactly the listed testnet chainIds", () => {
        for (const n of MOCK_USDC_NETWORKS) {
            expect(isMockUsdcChainId(CHAIN_METADATA[n].chainId), n).to.equal(true);
        }
        expect(isMockUsdcChainId(11155111)).to.equal(true);
    });

    it("refuses a chain that is in no list (a new chain never falls into the mock path)", () => {
        // e.g. Monad (143): not in chains.ts at all, so it was never in the mainnet name set either
        expect(isMockUsdcChainId(143)).to.equal(false);
        expect(() => assertMockUsdcAllowed({ isFork: false, liveChainId: 143, networkName: "monad" })).to.throw(
            /Refusing to deploy MockUSDC on chainId 143 \(monad\): not a listed testnet/
        );
    });

    it("refuses a mainnet chainId even under a testnet-looking name", () => {
        expect(() => assertMockUsdcAllowed({ isFork: false, liveChainId: 8453, networkName: "baseSepolia" })).to.throw(
            /chainId 8453/
        );
    });

    it("allows a listed testnet and any fork", () => {
        expect(() => assertMockUsdcAllowed({ isFork: false, liveChainId: 84532, networkName: "baseSepolia" })).not.to.throw();
        expect(() => assertMockUsdcAllowed({ isFork: true, liveChainId: 8453, networkName: "base" })).not.to.throw();
    });
});
