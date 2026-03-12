import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  OkuBridge,
  OkuBridgeRouter,
  OkuMoney,
  OkuDollar,
  MockBridgeAdapterHH,
  OkuBridge__factory,
  OkuBridgeRouter__factory,
  OkuMoney__factory,
  OkuDollar__factory,
  MockBridgeAdapterHH__factory,
} from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OkuBridgeRouter", function () {
  let okuMoney: OkuMoney;
  let okuUsd: OkuDollar;
  let okuBridge: OkuBridge;
  let bridgeRouter: OkuBridgeRouter;
  let mockAdapter: MockBridgeAdapterHH;

  let admin: SignerWithAddress;
  let orchestratorSigner: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const ARBITRUM_CHAIN_ID = 42161;
  const OPTIMISM_CHAIN_ID = 10;
  const MAX_SUPPLY = ethers.parseEther("1000000000");

  // Helper to convert an address to bytes32 (left-padded with zeros)
  function addressToBytes32(addr: string): string {
    return ethers.zeroPadValue(addr, 32);
  }

  // Role hashes — no _ROLE suffix, matching contract constants
  const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"));
  const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"));
  const ROUTER_ADAPTER_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ROUTER_ADAPTER_MANAGER"));
  const ROUTER_BRIDGE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ROUTER_BRIDGE_MANAGER"));

  beforeEach(async function () {
    [admin, orchestratorSigner, feeRecipient, user1, user2] = await ethers.getSigners();

    // Deploy OkuMoney (UUPS proxy)
    okuMoney = (await upgrades.deployProxy(
      new OkuMoney__factory(admin),
      ["OkuMoney", "OkuM", admin.address, MAX_SUPPLY],
      { kind: "uups" }
    )) as unknown as OkuMoney;
    await okuMoney.waitForDeployment();

    // Deploy OkuDollar vault (UUPS proxy)
    okuUsd = (await upgrades.deployProxy(
      new OkuDollar__factory(admin),
      [await okuMoney.getAddress(), "OkuDollar", "usdOku", admin.address, ethers.parseEther("0.95")],
      { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuDollar;
    await okuUsd.waitForDeployment();

    // Deploy OkuBridge (UUPS proxy)
    // OZ v5 ReentrancyGuard is @custom:stateless (ERC-7201 namespaced slot) — safe for proxies
    okuBridge = (await upgrades.deployProxy(
      new OkuBridge__factory(admin),
      [await okuMoney.getAddress(), orchestratorSigner.address, feeRecipient.address, admin.address, [ARBITRUM_CHAIN_ID, OPTIMISM_CHAIN_ID]], // initialChains
      { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuBridge;
    await okuBridge.waitForDeployment();

    // Deploy OkuBridgeRouter (UUPS proxy)
    bridgeRouter = (await upgrades.deployProxy(
      new OkuBridgeRouter__factory(admin),
      [
        await okuUsd.getAddress(),
        await okuMoney.getAddress(),
        await okuBridge.getAddress(),
        admin.address,
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuBridgeRouter;
    await bridgeRouter.waitForDeployment();

    // Deploy mock adapter
    mockAdapter = await new MockBridgeAdapterHH__factory(admin).deploy();
    await mockAdapter.waitForDeployment();

    // Setup roles on OkuNote
    await okuMoney.connect(admin).grantRole(OKUM_ALLOWANCE_MANAGER, admin.address);
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, admin.address);

    // OkuBridge needs MINTER (burns from router in native path, mints fee)
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await okuBridge.getAddress());
    await okuMoney
      .connect(admin)
      .configureMinterAllowance(await okuBridge.getAddress(), MAX_SUPPLY);

    // Router needs MINTER (burns OkuMoney in adapter path)
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await bridgeRouter.getAddress());
    await okuMoney
      .connect(admin)
      .configureMinterAllowance(await bridgeRouter.getAddress(), MAX_SUPPLY);

    // Configure minter allowances for admin (for minting test tokens)
    await okuMoney.connect(admin).configureMinterAllowance(admin.address, MAX_SUPPLY);

    // Register mock adapter
    await bridgeRouter.connect(admin).configureAdapter(await mockAdapter.getAddress(), true);
  });

  // ============ Initialization ============

  describe("Initialization", function () {
    it("should set correct addresses and roles", async function () {
      expect(await bridgeRouter.usdOku()).to.equal(await okuUsd.getAddress());
      expect(await bridgeRouter.okuMoney()).to.equal(await okuMoney.getAddress());
      expect(await bridgeRouter.okuBridge()).to.equal(await okuBridge.getAddress());

      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      expect(await bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await bridgeRouter.hasRole(ROUTER_ADAPTER_MANAGER, admin.address)).to.be.true;
      expect(await bridgeRouter.hasRole(ROUTER_BRIDGE_MANAGER, admin.address)).to.be.true;
    });

    it("should register mock adapter as supported", async function () {
      expect(await bridgeRouter.supportedAdapters(await mockAdapter.getAddress())).to.be.true;
    });
  });

  // ============ Admin Functions ============

  describe("Admin Functions", function () {
    it("should configure adapter", async function () {
      const newAdapter = ethers.Wallet.createRandom().address;
      await bridgeRouter.connect(admin).configureAdapter(newAdapter, true);
      expect(await bridgeRouter.supportedAdapters(newAdapter)).to.be.true;
    });

    it("should remove adapter", async function () {
      await bridgeRouter.connect(admin).configureAdapter(await mockAdapter.getAddress(), false);
      expect(await bridgeRouter.supportedAdapters(await mockAdapter.getAddress())).to.be.false;
    });

    it("should update OkuBridge address", async function () {
      const newBridge = ethers.Wallet.createRandom().address;
      await bridgeRouter.connect(admin).updateOkuBridge(newBridge);
      expect(await bridgeRouter.okuBridge()).to.equal(newBridge);
    });

    it("should revert updateOkuBridge for zero address", async function () {
      await expect(
        bridgeRouter.connect(admin).updateOkuBridge(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bridgeRouter, "ZeroAddress");
    });

    it("should revert updateOkuBridge if not BRIDGE_MANAGER", async function () {
      await expect(
        bridgeRouter.connect(user1).updateOkuBridge(ethers.Wallet.createRandom().address)
      ).to.be.revertedWithCustomError(bridgeRouter, "AccessControlUnauthorizedAccount");
    });

    it("should pause and unpause", async function () {
      await bridgeRouter.connect(admin).pause();
      expect(await bridgeRouter.paused()).to.be.true;

      await bridgeRouter.connect(admin).unpause();
      expect(await bridgeRouter.paused()).to.be.false;
    });
  });

  // ============ Native Path: bridgeUsdOku ============

  describe("Native Path: bridgeUsdOku()", function () {
    async function setupWrapped(amount: bigint) {
      await okuMoney.connect(admin).mint(user1.address, amount);
      await okuMoney.connect(user1).approve(await okuUsd.getAddress(), amount);
      await okuUsd.connect(user1).wrap(amount, user1.address, 0);
    }

    it("should bridge OkuDollar via native OkuBridge path", async function () {
      const noteAmount = ethers.parseEther("1000");

      // Mint OkuMoney, wrap into OkuUSD
      await setupWrapped(noteAmount);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      const tx = await bridgeRouter
        .connect(user1)
        .bridgeUsdOku(okuUsdBalance, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address));
      await tx.wait();

      // OkuBridge nonce incremented (proves bridgeBurn was called)
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);

      // Router holds at most dust (1-2 wei from integer division in fee-adjusted share calc)
      expect(await okuMoney.balanceOf(await bridgeRouter.getAddress())).to.be.lessThanOrEqual(2n);

      // User has no OkuUSD
      expect(await okuUsd.balanceOf(user1.address)).to.equal(0n);
    });

    it("should emit NativeBridgeInitiated event", async function () {
      const noteAmount = ethers.parseEther("500");

      await setupWrapped(noteAmount);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await expect(
        bridgeRouter.connect(user1).bridgeUsdOku(okuUsdBalance, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address))
      ).to.emit(bridgeRouter, "NativeBridgeInitiated");
    });

    it("should collect OkuBridge fee on native path", async function () {
      const noteAmount = ethers.parseEther("10000");

      await setupWrapped(noteAmount);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await bridgeRouter
        .connect(user1)
        .bridgeUsdOku(okuUsdBalance, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address));

      // Fee recipient received OkuMoney (0.1% default fee)
      const feeBalance = await okuMoney.balanceOf(feeRecipient.address);
      expect(feeBalance).to.be.greaterThan(0n);
    });

    it("should revert when paused", async function () {
      const noteAmount = ethers.parseEther("1000");

      await setupWrapped(noteAmount);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);

      await bridgeRouter.connect(admin).pause();

      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);
      await expect(
        bridgeRouter.connect(user1).bridgeUsdOku(okuUsdBalance, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address))
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });

    it("should revert for zero recipient", async function () {
      const noteAmount = ethers.parseEther("1000");

      await setupWrapped(noteAmount);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeUsdOku(okuUsdBalance, ARBITRUM_CHAIN_ID, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidRecipient");
    });
  });

  // ============ Native Path: bridge_OkuNote ============

  describe("Native Path: bridgeOkuM()", function () {
    it("should bridge OkuMoney directly via native OkuBridge path", async function () {
      const noteAmount = ethers.parseEther("1000");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);

      await bridgeRouter.connect(user1).bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address));

      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);
      expect(await okuMoney.balanceOf(user1.address)).to.equal(0n);
      // Router holds at most dust from integer division in fee-adjusted share calc
      expect(await okuMoney.balanceOf(await bridgeRouter.getAddress())).to.be.lessThanOrEqual(2n);
    });

    it("should emit NativeBridgeInitiated event", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);

      await expect(
        bridgeRouter.connect(user1).bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address))
      ).to.emit(bridgeRouter, "NativeBridgeInitiated");
    });

    it("should revert when paused", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await bridgeRouter.connect(admin).pause();

      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await expect(
        bridgeRouter.connect(user1).bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address))
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });

    it("should revert for zero recipient", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidRecipient");
    });
  });

  // ============ Adapter Path: bridgeWrappedVia ============

  describe("Adapter Path: bridgeWrappedVia()", function () {
    it("should bridge OkuDollar via third-party adapter (pre-burn model)", async function () {
      const noteAmount = ethers.parseEther("1000");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await okuUsd.getAddress(), noteAmount);
      await okuUsd.connect(user1).wrap(noteAmount, user1.address, 0);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await bridgeRouter
        .connect(user1)
        .bridgeWrappedVia(okuUsdBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address);

      // Adapter received the bridge call (not OkuBridge)
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
      const pending = await mockAdapter.getLastBridge();
      expect(pending.amount).to.equal(noteAmount);
      expect(pending.recipient).to.equal(user2.address);

      // OkuBridge nonce NOT incremented (adapter path, not native path)
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(0n);

      // Router holds no OkuNote
      expect(await okuMoney.balanceOf(await bridgeRouter.getAddress())).to.equal(0n);
    });

    it("should emit BridgeInitiated event", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await okuUsd.getAddress(), noteAmount);
      await okuUsd.connect(user1).wrap(noteAmount, user1.address, 0);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(okuUsdBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      )
        .to.emit(bridgeRouter, "BridgeInitiated")
        .withArgs(user1.address, await mockAdapter.getAddress(), noteAmount, ARBITRUM_CHAIN_ID, user2.address);
    });

    it("should revert for unsupported adapter", async function () {
      const noteAmount = ethers.parseEther("100");
      const unsupported = ethers.Wallet.createRandom().address;

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await okuUsd.getAddress(), noteAmount);
      await okuUsd.connect(user1).wrap(noteAmount, user1.address, 0);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(okuUsdBalance, unsupported, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "UnsupportedAdapter");
    });

    it("should revert when paused", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await okuUsd.getAddress(), noteAmount);
      await okuUsd.connect(user1).wrap(noteAmount, user1.address, 0);

      const okuUsdBalance = await okuUsd.balanceOf(user1.address);
      await bridgeRouter.connect(admin).pause();

      await okuUsd.connect(user1).approve(await bridgeRouter.getAddress(), okuUsdBalance);
      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(okuUsdBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });
  });

  // ============ Adapter Path: bridgeVia ============

  describe("Adapter Path: bridgeVia()", function () {
    it("should bridge OkuMoney via third-party adapter (pre-burn model)", async function () {
      const noteAmount = ethers.parseEther("1000");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);

      await bridgeRouter
        .connect(user1)
        .bridgeVia(noteAmount, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address);

      // Adapter received the bridge call
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
      const pending = await mockAdapter.getLastBridge();
      expect(pending.amount).to.equal(noteAmount);
      expect(pending.recipient).to.equal(user2.address);

      // OkuBridge NOT used
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(0n);

      // Tokens burned
      expect(await okuMoney.balanceOf(user1.address)).to.equal(0n);
      expect(await okuMoney.balanceOf(await bridgeRouter.getAddress())).to.equal(0n);
    });

    it("should revert for unsupported adapter", async function () {
      const noteAmount = ethers.parseEther("100");
      const unsupported = ethers.Wallet.createRandom().address;

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeVia(noteAmount, unsupported, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "UnsupportedAdapter");
    });

    it("should revert when paused", async function () {
      const noteAmount = ethers.parseEther("100");

      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await bridgeRouter.connect(admin).pause();

      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeVia(noteAmount, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });
  });

  // ============ Path Distinction ============

  describe("Path Distinction", function () {
    it("native path increments OkuBridge nonce; adapter path does not", async function () {
      const noteAmount = ethers.parseEther("500");

      // Native path: bridge_OkuNote
      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await bridgeRouter.connect(user1).bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address));
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);
      expect(await mockAdapter.pendingBridgesCount()).to.equal(0n);

      // Adapter path: bridgeVia
      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await bridgeRouter
        .connect(user1)
        .bridgeVia(noteAmount, await mockAdapter.getAddress(), OPTIMISM_CHAIN_ID, user2.address);
      expect(await okuBridge.outboundNonce(OPTIMISM_CHAIN_ID)).to.equal(0n); // unchanged
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
    });

    it("native path collects OkuBridge fee; adapter path does not", async function () {
      const noteAmount = ethers.parseEther("10000");

      // Native path
      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await bridgeRouter.connect(user1).bridgeOkuM(noteAmount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address));
      const nativeFee = await okuMoney.balanceOf(feeRecipient.address);
      expect(nativeFee).to.be.greaterThan(0n);

      // Adapter path
      await okuMoney.connect(admin).mint(user1.address, noteAmount);
      await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), noteAmount);
      await bridgeRouter
        .connect(user1)
        .bridgeVia(noteAmount, await mockAdapter.getAddress(), OPTIMISM_CHAIN_ID, user2.address);
      // Fee recipient balance unchanged after adapter path
      expect(await okuMoney.balanceOf(feeRecipient.address)).to.equal(nativeFee);
    });
  });
});
