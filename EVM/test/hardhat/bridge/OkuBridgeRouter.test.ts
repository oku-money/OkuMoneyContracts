import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  OkuBridge,
  OkuBridgeRouter,
  OkuUSD,
  WOkuUSD,
  MockBridgeAdapterHH,
  OkuBridge__factory,
  OkuBridgeRouter__factory,
  OkuUSD__factory,
  WOkuUSD__factory,
  MockBridgeAdapterHH__factory,
} from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OkuBridgeRouter", function () {
  let okuUSD: OkuUSD;
  let wokuUSD: WOkuUSD;
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

  // Role hashes — no _ROLE suffix, matching contract constants
  const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"));
  const ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER"));
  const ADAPTER_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ADAPTER_MANAGER"));
  const BRIDGE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_MANAGER"));

  beforeEach(async function () {
    [admin, orchestratorSigner, feeRecipient, user1, user2] = await ethers.getSigners();

    // Deploy OkuUSD (UUPS proxy)
    okuUSD = (await upgrades.deployProxy(
      new OkuUSD__factory(admin),
      ["OkuUSD", "OKUSD", admin.address, MAX_SUPPLY],
      { kind: "uups" }
    )) as unknown as OkuUSD;
    await okuUSD.waitForDeployment();

    // Deploy wOkuUSD (UUPS proxy)
    wokuUSD = (await upgrades.deployProxy(
      new WOkuUSD__factory(admin),
      [await okuUSD.getAddress(), "Wrapped OkuUSD", "wOKUSD", admin.address],
      { kind: "uups" }
    )) as unknown as WOkuUSD;
    await wokuUSD.waitForDeployment();

    // Deploy OkuBridge (transparent proxy)
    okuBridge = (await upgrades.deployProxy(
      new OkuBridge__factory(admin),
      [await okuUSD.getAddress(), orchestratorSigner.address, feeRecipient.address, admin.address],
      { kind: "transparent", unsafeAllow: ["constructor"] }
    )) as unknown as OkuBridge;
    await okuBridge.waitForDeployment();

    // Deploy OkuBridgeRouter (UUPS proxy)
    bridgeRouter = (await upgrades.deployProxy(
      new OkuBridgeRouter__factory(admin),
      [
        await wokuUSD.getAddress(),
        await okuUSD.getAddress(),
        await okuBridge.getAddress(),
        admin.address,
      ],
      { kind: "uups" }
    )) as unknown as OkuBridgeRouter;
    await bridgeRouter.waitForDeployment();

    // Deploy mock adapter
    mockAdapter = await new MockBridgeAdapterHH__factory(admin).deploy();
    await mockAdapter.waitForDeployment();

    // Setup roles
    await okuUSD.connect(admin).grantRole(ALLOWANCE_MANAGER, admin.address);
    await okuUSD.connect(admin).grantRole(MINTER, admin.address);

    // OkuBridge needs MINTER (burns from router in native path, mints fee)
    await okuUSD.connect(admin).grantRole(MINTER, await okuBridge.getAddress());
    await okuUSD
      .connect(admin)
      .configureMinterAllowance(await okuBridge.getAddress(), MAX_SUPPLY);

    // Router needs MINTER (burns OkuUSD in adapter path)
    await okuUSD.connect(admin).grantRole(MINTER, await bridgeRouter.getAddress());
    await okuUSD
      .connect(admin)
      .configureMinterAllowance(await bridgeRouter.getAddress(), MAX_SUPPLY);

    // Configure minter allowances for admin (for minting test tokens)
    await okuUSD.connect(admin).configureMinterAllowance(admin.address, MAX_SUPPLY);

    // Register mock adapter
    await bridgeRouter.connect(admin).configureAdapter(await mockAdapter.getAddress(), true);
  });

  // ============ Initialization ============

  describe("Initialization", function () {
    it("should set correct addresses and roles", async function () {
      expect(await bridgeRouter.wOkuUsd()).to.equal(await wokuUSD.getAddress());
      expect(await bridgeRouter.okuUsd()).to.equal(await okuUSD.getAddress());
      expect(await bridgeRouter.okuBridge()).to.equal(await okuBridge.getAddress());

      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      expect(await bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await bridgeRouter.hasRole(ADAPTER_MANAGER, admin.address)).to.be.true;
      expect(await bridgeRouter.hasRole(BRIDGE_MANAGER, admin.address)).to.be.true;
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

  // ============ Native Path: bridgeWrapped ============

  describe("Native Path: bridgeWrapped()", function () {
    async function setupWrapped(amount: bigint) {
      await okuUSD.connect(admin).mint(user1.address, amount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), amount);
      const wokuShares = await wokuUSD.connect(user1).deposit(amount, user1.address);
      return wokuShares;
    }

    it("should bridge wOkuUSD via native OkuBridge path", async function () {
      const okuAmount = ethers.parseEther("1000");

      // Wrap OkuUSD
      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      const tx = await bridgeRouter
        .connect(user1)
        .bridgeWrapped(wokuBalance, ARBITRUM_CHAIN_ID, user2.address);
      await tx.wait();

      // OkuBridge nonce incremented (proves bridgeBurn was called)
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);

      // Router holds at most dust (1-2 wei from integer division in fee-adjusted share calc)
      expect(await okuUSD.balanceOf(await bridgeRouter.getAddress())).to.be.lessThanOrEqual(2n);

      // User has no wOkuUSD
      expect(await wokuUSD.balanceOf(user1.address)).to.equal(0n);
    });

    it("should emit NativeBridgeInitiated event", async function () {
      const okuAmount = ethers.parseEther("500");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await expect(
        bridgeRouter.connect(user1).bridgeWrapped(wokuBalance, ARBITRUM_CHAIN_ID, user2.address)
      ).to.emit(bridgeRouter, "NativeBridgeInitiated");
    });

    it("should collect OkuBridge fee on native path", async function () {
      const okuAmount = ethers.parseEther("10000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await bridgeRouter
        .connect(user1)
        .bridgeWrapped(wokuBalance, ARBITRUM_CHAIN_ID, user2.address);

      // Fee recipient received OkuUSD (0.1% default fee)
      const feeBalance = await okuUSD.balanceOf(feeRecipient.address);
      expect(feeBalance).to.be.greaterThan(0n);
    });

    it("should revert when paused", async function () {
      const okuAmount = ethers.parseEther("1000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);

      await bridgeRouter.connect(admin).pause();

      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);
      await expect(
        bridgeRouter.connect(user1).bridgeWrapped(wokuBalance, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });

    it("should revert for zero recipient", async function () {
      const okuAmount = ethers.parseEther("1000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrapped(wokuBalance, ARBITRUM_CHAIN_ID, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidRecipient");
    });
  });

  // ============ Native Path: bridgeDirect ============

  describe("Native Path: bridgeDirect()", function () {
    it("should bridge OkuUSD directly via native OkuBridge path", async function () {
      const okuAmount = ethers.parseEther("1000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);

      await bridgeRouter.connect(user1).bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2.address);

      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);
      expect(await okuUSD.balanceOf(user1.address)).to.equal(0n);
      // Router holds at most dust from integer division in fee-adjusted share calc
      expect(await okuUSD.balanceOf(await bridgeRouter.getAddress())).to.be.lessThanOrEqual(2n);
    });

    it("should emit NativeBridgeInitiated event", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);

      await expect(
        bridgeRouter.connect(user1).bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2.address)
      ).to.emit(bridgeRouter, "NativeBridgeInitiated");
    });

    it("should revert when paused", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await bridgeRouter.connect(admin).pause();

      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await expect(
        bridgeRouter.connect(user1).bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });

    it("should revert for zero recipient", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidRecipient");
    });
  });

  // ============ Adapter Path: bridgeWrappedVia ============

  describe("Adapter Path: bridgeWrappedVia()", function () {
    it("should bridge wOkuUSD via third-party adapter (pre-burn model)", async function () {
      const okuAmount = ethers.parseEther("1000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await bridgeRouter
        .connect(user1)
        .bridgeWrappedVia(wokuBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address);

      // Adapter received the bridge call (not OkuBridge)
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
      const pending = await mockAdapter.getLastBridge();
      expect(pending.amount).to.equal(okuAmount);
      expect(pending.recipient).to.equal(user2.address);

      // OkuBridge nonce NOT incremented (adapter path, not native path)
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(0n);

      // Router holds no OkuUSD
      expect(await okuUSD.balanceOf(await bridgeRouter.getAddress())).to.equal(0n);
    });

    it("should emit BridgeInitiated event", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(wokuBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      )
        .to.emit(bridgeRouter, "BridgeInitiated")
        .withArgs(user1.address, await mockAdapter.getAddress(), okuAmount, ARBITRUM_CHAIN_ID, user2.address);
    });

    it("should revert for unsupported adapter", async function () {
      const okuAmount = ethers.parseEther("100");
      const unsupported = ethers.Wallet.createRandom().address;

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(wokuBalance, unsupported, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "UnsupportedAdapter");
    });

    it("should revert when paused", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await wokuUSD.getAddress(), okuAmount);
      await wokuUSD.connect(user1).deposit(okuAmount, user1.address);

      const wokuBalance = await wokuUSD.balanceOf(user1.address);
      await bridgeRouter.connect(admin).pause();

      await wokuUSD.connect(user1).approve(await bridgeRouter.getAddress(), wokuBalance);
      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeWrappedVia(wokuBalance, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });
  });

  // ============ Adapter Path: bridgeDirectVia ============

  describe("Adapter Path: bridgeDirectVia()", function () {
    it("should bridge OkuUSD via third-party adapter (pre-burn model)", async function () {
      const okuAmount = ethers.parseEther("1000");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);

      await bridgeRouter
        .connect(user1)
        .bridgeDirectVia(okuAmount, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address);

      // Adapter received the bridge call
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
      const pending = await mockAdapter.getLastBridge();
      expect(pending.amount).to.equal(okuAmount);
      expect(pending.recipient).to.equal(user2.address);

      // OkuBridge NOT used
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(0n);

      // Tokens burned
      expect(await okuUSD.balanceOf(user1.address)).to.equal(0n);
      expect(await okuUSD.balanceOf(await bridgeRouter.getAddress())).to.equal(0n);
    });

    it("should revert for unsupported adapter", async function () {
      const okuAmount = ethers.parseEther("100");
      const unsupported = ethers.Wallet.createRandom().address;

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);

      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeDirectVia(okuAmount, unsupported, ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "UnsupportedAdapter");
    });

    it("should revert when paused", async function () {
      const okuAmount = ethers.parseEther("100");

      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await bridgeRouter.connect(admin).pause();

      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await expect(
        bridgeRouter
          .connect(user1)
          .bridgeDirectVia(okuAmount, await mockAdapter.getAddress(), ARBITRUM_CHAIN_ID, user2.address)
      ).to.be.revertedWithCustomError(bridgeRouter, "EnforcedPause");
    });
  });

  // ============ Path Distinction ============

  describe("Path Distinction", function () {
    it("native path increments OkuBridge nonce; adapter path does not", async function () {
      const okuAmount = ethers.parseEther("500");

      // Native path: bridgeDirect
      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await bridgeRouter.connect(user1).bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2.address);
      expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n);
      expect(await mockAdapter.pendingBridgesCount()).to.equal(0n);

      // Adapter path: bridgeDirectVia
      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await bridgeRouter
        .connect(user1)
        .bridgeDirectVia(okuAmount, await mockAdapter.getAddress(), OPTIMISM_CHAIN_ID, user2.address);
      expect(await okuBridge.outboundNonce(OPTIMISM_CHAIN_ID)).to.equal(0n); // unchanged
      expect(await mockAdapter.pendingBridgesCount()).to.equal(1n);
    });

    it("native path collects OkuBridge fee; adapter path does not", async function () {
      const okuAmount = ethers.parseEther("10000");

      // Native path
      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await bridgeRouter.connect(user1).bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2.address);
      const nativeFee = await okuUSD.balanceOf(feeRecipient.address);
      expect(nativeFee).to.be.greaterThan(0n);

      // Adapter path
      await okuUSD.connect(admin).mint(user1.address, okuAmount);
      await okuUSD.connect(user1).approve(await bridgeRouter.getAddress(), okuAmount);
      await bridgeRouter
        .connect(user1)
        .bridgeDirectVia(okuAmount, await mockAdapter.getAddress(), OPTIMISM_CHAIN_ID, user2.address);
      // Fee recipient balance unchanged after adapter path
      expect(await okuUSD.balanceOf(feeRecipient.address)).to.equal(nativeFee);
    });
  });
});
