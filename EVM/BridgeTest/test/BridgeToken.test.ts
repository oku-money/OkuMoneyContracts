import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  BridgeToken,
  NttBridgeAdapter,
  OFTBridgeAdapter,
  MockNttManager,
  MockOFTAdapter,
} from "../typechain-types";

describe("BridgeToken", function () {
  let bridgeToken: BridgeToken;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    const BridgeTokenFactory = await ethers.getContractFactory("BridgeToken");
    bridgeToken = await BridgeTokenFactory.deploy(
      "BridgeTestToken",
      "BTT",
      admin.address
    );
  });

  describe("Deployment", function () {
    it("should set correct name and symbol", async function () {
      expect(await bridgeToken.name()).to.equal("BridgeTestToken");
      expect(await bridgeToken.symbol()).to.equal("BTT");
    });

    it("should grant admin DEFAULT_ADMIN_ROLE", async function () {
      const DEFAULT_ADMIN_ROLE = await bridgeToken.DEFAULT_ADMIN_ROLE();
      expect(await bridgeToken.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be
        .true;
    });

    it("should grant admin MINTER_ROLE", async function () {
      const MINTER_ROLE = await bridgeToken.MINTER_ROLE();
      expect(await bridgeToken.hasRole(MINTER_ROLE, admin.address)).to.be.true;
    });
  });

  describe("Minting", function () {
    it("should allow MINTER_ROLE to mint", async function () {
      const amount = ethers.parseEther("1000");
      await bridgeToken.connect(admin).mint(user1.address, amount);
      expect(await bridgeToken.balanceOf(user1.address)).to.equal(amount);
    });

    it("should revert if non-minter tries to mint", async function () {
      const amount = ethers.parseEther("1000");
      await expect(
        bridgeToken.connect(user1).mint(user1.address, amount)
      ).to.be.reverted;
    });
  });

  describe("Burning", function () {
    beforeEach(async function () {
      const amount = ethers.parseEther("1000");
      await bridgeToken.connect(admin).mint(user1.address, amount);
    });

    it("should allow MINTER_ROLE to burn", async function () {
      const amount = ethers.parseEther("500");
      await bridgeToken.connect(admin).burn(user1.address, amount);
      expect(await bridgeToken.balanceOf(user1.address)).to.equal(
        ethers.parseEther("500")
      );
    });

    it("should revert if non-minter tries to burn", async function () {
      const amount = ethers.parseEther("500");
      await expect(
        bridgeToken.connect(user1).burn(user1.address, amount)
      ).to.be.reverted;
    });
  });
});

describe("NttBridgeAdapter", function () {
  let bridgeToken: BridgeToken;
  let mockNttManager: MockNttManager;
  let nttAdapter: NttBridgeAdapter;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const OPTIMISM_CHAIN_ID = 10;
  const WORMHOLE_OPTIMISM_ID = 24;

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    // Deploy BridgeToken
    const BridgeTokenFactory = await ethers.getContractFactory("BridgeToken");
    bridgeToken = await BridgeTokenFactory.deploy(
      "BridgeTestToken",
      "BTT",
      admin.address
    );

    // Deploy MockNttManager
    const MockNttManagerFactory = await ethers.getContractFactory(
      "MockNttManager"
    );
    mockNttManager = await MockNttManagerFactory.deploy(
      await bridgeToken.getAddress()
    );

    // Deploy NttBridgeAdapter
    const NttBridgeAdapterFactory = await ethers.getContractFactory(
      "NttBridgeAdapter"
    );
    nttAdapter = await NttBridgeAdapterFactory.deploy(
      await mockNttManager.getAddress(),
      await bridgeToken.getAddress(),
      admin.address
    );

    // Grant MINTER_ROLE to adapter and mock
    const MINTER_ROLE = await bridgeToken.MINTER_ROLE();
    await bridgeToken
      .connect(admin)
      .grantRole(MINTER_ROLE, await nttAdapter.getAddress());
    await bridgeToken
      .connect(admin)
      .grantRole(MINTER_ROLE, await mockNttManager.getAddress());

    // Mint tokens to user1 for testing
    await bridgeToken
      .connect(admin)
      .mint(user1.address, ethers.parseEther("10000"));
  });

  describe("Chain ID Configuration", function () {
    it("should have pre-configured Optimism chain ID", async function () {
      expect(await nttAdapter.wormholeChainId(OPTIMISM_CHAIN_ID)).to.equal(
        WORMHOLE_OPTIMISM_ID
      );
    });

    it("should allow owner to configure chain ID", async function () {
      await nttAdapter.connect(admin).configureChainId(56, 4); // BSC
      expect(await nttAdapter.wormholeChainId(56)).to.equal(4);
    });

    it("should revert if non-owner configures chain ID", async function () {
      await expect(
        nttAdapter.connect(user1).configureChainId(56, 4)
      ).to.be.reverted;
    });
  });

  describe("Bridging", function () {
    it("should bridge tokens successfully", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");

      const balanceBefore = await bridgeToken.balanceOf(user1.address);

      await nttAdapter
        .connect(user1)
        .bridge(amount, OPTIMISM_CHAIN_ID, user2.address, { value: fee });

      const balanceAfter = await bridgeToken.balanceOf(user1.address);
      expect(balanceBefore - balanceAfter).to.equal(amount);

      // Check pending transfer in mock
      const pendingCount = await mockNttManager.getPendingTransferCount();
      expect(pendingCount).to.equal(1);
    });

    it("should revert with zero amount", async function () {
      const fee = ethers.parseEther("0.001");
      await expect(
        nttAdapter
          .connect(user1)
          .bridge(0, OPTIMISM_CHAIN_ID, user2.address, { value: fee })
      ).to.be.revertedWithCustomError(nttAdapter, "InvalidAmount");
    });

    it("should revert with zero recipient", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");
      await expect(
        nttAdapter
          .connect(user1)
          .bridge(amount, OPTIMISM_CHAIN_ID, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(nttAdapter, "InvalidRecipient");
    });

    it("should revert with unsupported chain", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");
      await expect(
        nttAdapter.connect(user1).bridge(amount, 999, user2.address, {
          value: fee,
        })
      ).to.be.revertedWithCustomError(nttAdapter, "UnsupportedChain");
    });
  });

  describe("Complete Bridge (Mock)", function () {
    it("should complete bridge and mint to recipient", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");

      // Bridge from user1
      await nttAdapter
        .connect(user1)
        .bridge(amount, OPTIMISM_CHAIN_ID, user2.address, { value: fee });

      // Check user2 balance before completion
      expect(await bridgeToken.balanceOf(user2.address)).to.equal(0);

      // Complete the bridge (simulate destination chain)
      await mockNttManager.completeBridge(0);

      // Check user2 received tokens
      expect(await bridgeToken.balanceOf(user2.address)).to.equal(amount);
    });
  });
});

describe("OFTBridgeAdapter", function () {
  let bridgeToken: BridgeToken;
  let mockOftAdapter: MockOFTAdapter;
  let oftAdapter: OFTBridgeAdapter;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const OPTIMISM_CHAIN_ID = 10;
  const LZ_OPTIMISM_EID = 30111;

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    // Deploy BridgeToken
    const BridgeTokenFactory = await ethers.getContractFactory("BridgeToken");
    bridgeToken = await BridgeTokenFactory.deploy(
      "BridgeTestToken",
      "BTT",
      admin.address
    );

    // Deploy MockOFTAdapter
    const MockOFTAdapterFactory = await ethers.getContractFactory(
      "MockOFTAdapter"
    );
    mockOftAdapter = await MockOFTAdapterFactory.deploy(
      await bridgeToken.getAddress()
    );

    // Deploy OFTBridgeAdapter
    const OFTBridgeAdapterFactory = await ethers.getContractFactory(
      "OFTBridgeAdapter"
    );
    oftAdapter = await OFTBridgeAdapterFactory.deploy(
      await mockOftAdapter.getAddress(),
      await bridgeToken.getAddress(),
      admin.address
    );

    // Grant MINTER_ROLE to adapter and mock
    const MINTER_ROLE = await bridgeToken.MINTER_ROLE();
    await bridgeToken
      .connect(admin)
      .grantRole(MINTER_ROLE, await oftAdapter.getAddress());
    await bridgeToken
      .connect(admin)
      .grantRole(MINTER_ROLE, await mockOftAdapter.getAddress());

    // Mint tokens to user1 for testing
    await bridgeToken
      .connect(admin)
      .mint(user1.address, ethers.parseEther("10000"));
  });

  describe("Endpoint ID Configuration", function () {
    it("should have pre-configured Optimism endpoint ID", async function () {
      expect(await oftAdapter.lzEndpointId(OPTIMISM_CHAIN_ID)).to.equal(
        LZ_OPTIMISM_EID
      );
    });

    it("should allow owner to configure endpoint ID", async function () {
      await oftAdapter.connect(admin).configureEndpointId(56, 30102); // BSC
      expect(await oftAdapter.lzEndpointId(56)).to.equal(30102);
    });

    it("should revert if non-owner configures endpoint ID", async function () {
      await expect(
        oftAdapter.connect(user1).configureEndpointId(56, 30102)
      ).to.be.reverted;
    });
  });

  describe("Quote Bridge", function () {
    it("should return fee quote", async function () {
      const amount = ethers.parseEther("100");
      const fee = await oftAdapter.quoteBridge(
        amount,
        OPTIMISM_CHAIN_ID,
        user2.address
      );
      expect(fee).to.equal(ethers.parseEther("0.001")); // Mock default fee
    });

    it("should revert for unsupported chain", async function () {
      const amount = ethers.parseEther("100");
      await expect(
        oftAdapter.quoteBridge(amount, 999, user2.address)
      ).to.be.revertedWithCustomError(oftAdapter, "UnsupportedChain");
    });
  });

  describe("Bridging", function () {
    it("should bridge tokens successfully", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");

      const balanceBefore = await bridgeToken.balanceOf(user1.address);

      await oftAdapter
        .connect(user1)
        .bridge(amount, OPTIMISM_CHAIN_ID, user2.address, { value: fee });

      const balanceAfter = await bridgeToken.balanceOf(user1.address);
      expect(balanceBefore - balanceAfter).to.equal(amount);

      // Check pending transfer in mock
      const pendingCount = await mockOftAdapter.getPendingTransferCount();
      expect(pendingCount).to.equal(1);
    });

    it("should revert with zero amount", async function () {
      const fee = ethers.parseEther("0.001");
      await expect(
        oftAdapter
          .connect(user1)
          .bridge(0, OPTIMISM_CHAIN_ID, user2.address, { value: fee })
      ).to.be.revertedWithCustomError(oftAdapter, "InvalidAmount");
    });

    it("should revert with zero recipient", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");
      await expect(
        oftAdapter
          .connect(user1)
          .bridge(amount, OPTIMISM_CHAIN_ID, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(oftAdapter, "InvalidRecipient");
    });

    it("should revert with unsupported chain", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");
      await expect(
        oftAdapter.connect(user1).bridge(amount, 999, user2.address, {
          value: fee,
        })
      ).to.be.revertedWithCustomError(oftAdapter, "UnsupportedChain");
    });
  });

  describe("Complete Bridge (Mock)", function () {
    it("should complete bridge and mint to recipient", async function () {
      const amount = ethers.parseEther("100");
      const fee = ethers.parseEther("0.001");

      // Bridge from user1
      await oftAdapter
        .connect(user1)
        .bridge(amount, OPTIMISM_CHAIN_ID, user2.address, { value: fee });

      // Check user2 balance before completion
      expect(await bridgeToken.balanceOf(user2.address)).to.equal(0);

      // Complete the bridge (simulate destination chain)
      await mockOftAdapter.completeBridge(0);

      // Check user2 received tokens
      expect(await bridgeToken.balanceOf(user2.address)).to.equal(amount);
    });
  });
});
