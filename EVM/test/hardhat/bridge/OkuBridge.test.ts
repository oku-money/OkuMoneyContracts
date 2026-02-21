import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { OkuBridge, OkuUSD, OkuBridge__factory, OkuUSD__factory } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OkuBridge E2E", function () {
  let okuBridge: OkuBridge;
  let okuUSD: OkuUSD;

  let admin: SignerWithAddress;
  let orchestratorSigner: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const OPTIMISM_CHAIN_ID = 10;
  const ARBITRUM_CHAIN_ID = 42161;
  const BASE_CHAIN_ID = 8453;

  // EIP-712 Domain
  let domain: any;

  // EIP-712 Types
  const types = {
    BridgeRequest: [
      { name: "sourceChainId", type: "uint256" },
      { name: "destChainId", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  beforeEach(async function () {
    [admin, orchestratorSigner, feeRecipient, user1, user2] = await ethers.getSigners();

    // Deploy OkuUSD with transparent proxy
    okuUSD = (await upgrades.deployProxy(
      new OkuUSD__factory(admin),
      ["OkuUSD", "OKUSD", admin.address, ethers.parseEther("1000000000")],
      { kind: "uups" }
    )) as unknown as OkuUSD;
    await okuUSD.waitForDeployment();

    // Deploy OkuBridge with transparent proxy
    okuBridge = (await upgrades.deployProxy(
      new OkuBridge__factory(admin),
      [
        await okuUSD.getAddress(),
        orchestratorSigner.address,
        feeRecipient.address,
        admin.address,
      ],
      { kind: "uups" }
    )) as unknown as OkuBridge;
    await okuBridge.waitForDeployment();

    // Setup roles
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    const ALLOWANCE_MANAGER_ROLE = ethers.keccak256(
      ethers.toUtf8Bytes("ALLOWANCE_MANAGER_ROLE")
    );

    await okuUSD.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await okuUSD.connect(admin).grantRole(MINTER_ROLE, await okuBridge.getAddress());
    await okuUSD.connect(admin).grantRole(ALLOWANCE_MANAGER_ROLE, admin.address);

    // Configure minter allowances
    const maxSupply = ethers.parseEther("1000000000");
    await okuUSD.connect(admin).configureMinterAllowance(admin.address, maxSupply);
    await okuUSD
      .connect(admin)
      .configureMinterAllowance(await okuBridge.getAddress(), maxSupply);

    // Setup EIP-712 domain
    const chainId = (await ethers.provider.getNetwork()).chainId;
    domain = {
      name: "OkuBridge",
      version: "1",
      chainId: chainId,
      verifyingContract: await okuBridge.getAddress(),
    };
  });

  describe("EIP-712 Signature Generation", function () {
    it("should create and validate EIP-712 signatures", async function () {
      const shares = ethers.parseEther("100");
      const fee = (shares * 10n) / 10000n;

      // Mint OkuUSD to user1
      await okuUSD.connect(admin).mint(user1.address, shares + fee);

      // User1 bridges
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, user2.address, shares);

      // Create BridgeRequest for destination
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      };

      // Sign with EIP-712
      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // Submit to contract
      await okuBridge.bridgeMint(request, signature);

      // Verify shares minted
      const recipientShares = await okuUSD.sharesOf(user2.address);
      expect(recipientShares).to.equal(shares);
    });

    it("should reject signatures from unauthorized signers", async function () {
      const shares = ethers.parseEther("100");

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      // Sign with wrong signer (user1 instead of orchestrator)
      const wrongSignature = await user1.signTypedData(domain, types, request);

      // Should revert with InvalidSignature
      await expect(okuBridge.bridgeMint(request, wrongSignature)).to.be.revertedWithCustomError(
        okuBridge,
        "InvalidSignature"
      );
    });

    it("should reject expired signatures", async function () {
      const shares = ethers.parseEther("100");

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (expired)
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      await expect(okuBridge.bridgeMint(request, signature)).to.be.revertedWithCustomError(
        okuBridge,
        "SignatureExpired"
      );
    });
  });

  describe("Multi-Chain Simulation", function () {
    it("should handle sequential bridges from multiple chains", async function () {
      const shares = ethers.parseEther("50");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Simulate 10 bridges with various source/dest combinations
      for (let i = 0; i < 10; i++) {
        // Vary source chains
        const sourceChainId = i % 2 === 0 ? OPTIMISM_CHAIN_ID : ARBITRUM_CHAIN_ID;

        const request = {
          sourceChainId: sourceChainId,
          destChainId: chainId,
          sender: user1.address,
          recipient: user2.address,
          shares: shares,
          nonce: i,
          deadline: Math.floor(Date.now() / 1000) + 3600,
        };

        const signature = await orchestratorSigner.signTypedData(domain, types, request);
        await okuBridge.bridgeMint(request, signature);
      }

      // Verify total shares minted
      const totalShares = await okuUSD.sharesOf(user2.address);
      expect(totalShares).to.equal(shares * 10n);
    });

    it("should prevent replay attacks", async function () {
      const shares = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // First mint should succeed
      await okuBridge.bridgeMint(request, signature);

      // Second mint with same request should fail
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "address", "address", "uint256", "uint256", "uint256"],
          [
            request.sourceChainId,
            request.destChainId,
            request.sender,
            request.recipient,
            request.shares,
            request.nonce,
            request.deadline,
          ]
        )
      );

      await expect(okuBridge.bridgeMint(request, signature)).to.be.revertedWithCustomError(
        okuBridge,
        "AlreadyProcessed"
      );
    });
  });

  describe("Fee Mechanics", function () {
    it("should correctly calculate and collect fees", async function () {
      const shares = ethers.parseEther("1000");
      const fee = 10n; // 0.1%
      const expectedFee = (shares * fee) / 10000n;

      // Mint shares to user1 (with fee included)
      await okuUSD.connect(admin).mint(user1.address, shares + expectedFee);

      const feeRecipientBalanceBefore = await okuUSD.sharesOf(feeRecipient.address);

      // Bridge
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, user2.address, shares);

      const feeRecipientBalanceAfter = await okuUSD.sharesOf(feeRecipient.address);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);
    });

    it("should handle zero fee correctly", async function () {
      const shares = ethers.parseEther("100");

      // Update fee to 0
      await okuBridge.connect(admin).updateFee(0);

      // Mint shares to user1 (no fee needed)
      await okuUSD.connect(admin).mint(user1.address, shares);

      const feeRecipientBalanceBefore = await okuUSD.sharesOf(feeRecipient.address);

      // Bridge
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, user2.address, shares);

      const feeRecipientBalanceAfter = await okuUSD.sharesOf(feeRecipient.address);
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore);
    });
  });

  describe("Error Recovery", function () {
    it("should allow admin to skip stuck nonces", async function () {
      const nonceBefore = await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID);

      await okuBridge.connect(admin).skipNonce(ARBITRUM_CHAIN_ID);

      const nonceAfter = await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID);
      expect(nonceAfter).to.equal(nonceBefore + 1n);
    });

    it("should allow admin to refund failed requests", async function () {
      const shares = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Create bridge request
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const user1BalanceBefore = await okuUSD.sharesOf(user1.address);

      // Admin refunds (simulating destination failure)
      await okuBridge.connect(admin).refundFailedRequest(request, "0x");

      const user1BalanceAfter = await okuUSD.sharesOf(user1.address);
      expect(user1BalanceAfter - user1BalanceBefore).to.equal(shares);
    });
  });

  describe("Gas Measurement", function () {
    it("should measure gas costs for bridge operations", async function () {
      const shares = ethers.parseEther("100");
      const fee = (shares * 10n) / 10000n;

      // Mint to user1
      await okuUSD.connect(admin).mint(user1.address, shares + fee);

      // Measure bridgeBurn gas
      const burnTx = await okuBridge
        .connect(user1)
        .bridgeBurn(ARBITRUM_CHAIN_ID, user2.address, shares);
      const burnReceipt = await burnTx.wait();

      // Verify gas is reasonable (<150k target)
      expect(burnReceipt?.gasUsed).to.be.lessThan(150000);

      // Create request for mint
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // Measure bridgeMint gas
      const mintTx = await okuBridge.bridgeMint(request, signature);
      const mintReceipt = await mintTx.wait();

      // Verify gas is reasonable (<140k target, slightly higher than Forge due to proxy overhead)
      expect(mintReceipt?.gasUsed).to.be.lessThan(140000);
    });
  });

  describe("Rebase Scenarios", function () {
    it("should preserve shares across rebase events", async function () {
      const shares = ethers.parseEther("100");
      const fee = (shares * 10n) / 10000n;

      // Mint to user1
      await okuUSD.connect(admin).mint(user1.address, shares + fee);

      // Bridge burn
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, user2.address, shares);

      // Apply rebase (increase multiplier by 50%)
      const REBASER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REBASER_ROLE"));
      await okuUSD.connect(admin).grantRole(REBASER_ROLE, admin.address);

      const oldMultiplier = await okuUSD.rewardMultiplier();
      const newMultiplier = (oldMultiplier * 150n) / 100n;
      await okuUSD.connect(admin).updateRewardMultiplier(newMultiplier);

      // Mint on destination with same shares
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: user2.address,
        shares: shares,
        nonce: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);
      await okuBridge.bridgeMint(request, signature);

      // Verify shares are preserved
      const recipientShares = await okuUSD.sharesOf(user2.address);
      expect(recipientShares).to.equal(shares);

      // Verify token balance reflects new multiplier
      const recipientTokens = await okuUSD.balanceOf(user2.address);
      const expectedTokens = await okuUSD.sharesToTokens(shares);
      expect(recipientTokens).to.equal(expectedTokens);
    });
  });
});
