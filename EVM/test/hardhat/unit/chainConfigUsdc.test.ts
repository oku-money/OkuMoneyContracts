import { expect } from "chai";
import { CHAIN_ADDRESSES, resolveNativeUsdc } from "../../../scripts/config/chains";
import {
  isInternalTestingMainnet,
  isInternalTestingMainnetConfirmed,
} from "../../../scripts/utils/mainnetGuard";

describe("mainnet USDC resolved from @gfxlabs/oku-chains", () => {
  it("Arbitrum One resolves to native USDC, not bridged USDC.e", () => {
    expect(CHAIN_ADDRESSES.arbitrum.tokens.usdc).to.equal("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(CHAIN_ADDRESSES.arbitrum.tokens.usdc.toLowerCase()).to.not.equal(
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"
    );
  });

  it("BSC resolves to the Binance-Peg USDC (18 decimals)", () => {
    expect(CHAIN_ADDRESSES.bsc.tokens.usdc).to.equal("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
  });

  it("ethereum, base and optimism keep their canonical USDC", () => {
    expect(CHAIN_ADDRESSES.mainnet.tokens.usdc).to.equal("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(CHAIN_ADDRESSES.base.tokens.usdc).to.equal("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(CHAIN_ADDRESSES.optimism.tokens.usdc).to.equal("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
  });

  it("an explicit in-repo override wins over chain-config", () => {
    expect(resolveNativeUsdc(42161, "0x0000000000000000000000000000000000000001")).to.equal(
      "0x0000000000000000000000000000000000000001"
    );
  });
});

describe("INTERNAL_TESTING_MAINNET gate", () => {
  afterEach(() => {
    delete process.env.INTERNAL_TESTING_MAINNET;
    delete process.env.YES_MAINNET;
  });

  it("is off by default", () => {
    expect(isInternalTestingMainnet("bsc")).to.equal(false);
    expect(isInternalTestingMainnet("arbitrum")).to.equal(false);
  });

  it("applies only to bsc and arbitrum", () => {
    process.env.INTERNAL_TESTING_MAINNET = "true";
    expect(isInternalTestingMainnet("bsc")).to.equal(true);
    expect(isInternalTestingMainnet("arbitrum")).to.equal(true);
    for (const n of ["mainnet", "ethereum", "base", "optimism", "sepolia"]) {
      expect(isInternalTestingMainnet(n), n).to.equal(false);
    }
  });

  it("the confirmed form also needs YES_MAINNET", () => {
    process.env.INTERNAL_TESTING_MAINNET = "true";
    expect(isInternalTestingMainnetConfirmed("bsc")).to.equal(false);
    process.env.YES_MAINNET = "true";
    expect(isInternalTestingMainnetConfirmed("bsc")).to.equal(true);
    expect(isInternalTestingMainnetConfirmed("base")).to.equal(false);
  });
});
