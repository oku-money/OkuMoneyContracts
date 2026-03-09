import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { OkuBridge, OkuNote, OkuBridge__factory, OkuNote__factory } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OkuBridge E2E", function () {
  let okuBridge: OkuBridge;
  let okuNote: OkuNote;

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
      { name: "recipient", type: "bytes32" },
      { name: "shares", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // Helper to convert an address to bytes32 (left-padded with zeros)
  function addressToBytes32(addr: string): string {
    return ethers.zeroPadValue(addr, 32);
  }

  // Helper to get a future deadline based on the EVM block timestamp (not wall clock)
  async function futureDeadline(seconds: number = 3600): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + seconds;
  }

  beforeEach(async function () {
    [admin, orchestratorSigner, feeRecipient, user1, user2] = await ethers.getSigners();

    // Deploy OkuNote with UUPS proxy
    okuNote = (await upgrades.deployProxy(
      new OkuNote__factory(admin),
      ["OkuNote", "OKUNOTE", admin.address, ethers.parseEther("1000000000")],
      { kind: "uups" }
    )) as unknown as OkuNote;
    await okuNote.waitForDeployment();

    // Deploy OkuBridge with UUPS proxy
    // OZ v5 ReentrancyGuard is @custom:stateless (ERC-7201 namespaced slot) — safe for proxies
    okuBridge = (await upgrades.deployProxy(
      new OkuBridge__factory(admin),
      [
        await okuNote.getAddress(),
        orchestratorSigner.address,
        feeRecipient.address,
        admin.address,
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuBridge;
    await okuBridge.waitForDeployment();

    // Setup roles
    const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"));
    const ALLOWANCE_MANAGER = ethers.keccak256(
      ethers.toUtf8Bytes("ALLOWANCE_MANAGER")
    );

    await okuNote.connect(admin).grantRole(MINTER, admin.address);
    await okuNote.connect(admin).grantRole(MINTER, await okuBridge.getAddress());
    await okuNote.connect(admin).grantRole(ALLOWANCE_MANAGER, admin.address);

    // Configure minter allowances
    const maxSupply = ethers.parseEther("1000000000");
    await okuNote.connect(admin).configureMinterAllowance(admin.address, maxSupply);
    await okuNote
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
      const netShares = shares - fee;

      // Mint OkuUSD to user1 (subtractive fee: user provides total shares, fee deducted)
      await okuNote.connect(admin).mint(user1.address, shares);

      // Approve bridge to pull tokens, then bridge
      const tokenAmount = await okuNote.sharesToTokens(shares);
      await okuNote.connect(user1).approve(await okuBridge.getAddress(), tokenAmount);
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, addressToBytes32(user2.address), shares);

      // Create BridgeRequest for destination (netShares after fee deduction)
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: netShares,
        nonce: 0,
        deadline: await futureDeadline(), // 1 hour from now
      };

      // Sign with EIP-712
      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // Submit to contract
      await okuBridge.bridgeMint(request, signature);

      // Verify net shares minted (fee already deducted on source)
      const recipientShares = await okuNote.sharesOf(user2.address);
      expect(recipientShares).to.equal(netShares);
    });

    it("should reject signatures from unauthorized signers", async function () {
      const shares = ethers.parseEther("100");

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(),
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
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(-3600), // 1 hour ago (expired)
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
          recipient: addressToBytes32(user2.address),
          shares: shares,
          nonce: i,
          deadline: await futureDeadline(),
        };

        const signature = await orchestratorSigner.signTypedData(domain, types, request);
        await okuBridge.bridgeMint(request, signature);
      }

      // Verify total shares minted
      const totalShares = await okuNote.sharesOf(user2.address);
      expect(totalShares).to.equal(shares * 10n);
    });

    it("should prevent replay attacks", async function () {
      const shares = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // First mint should succeed
      await okuBridge.bridgeMint(request, signature);

      await expect(okuBridge.bridgeMint(request, signature)).to.be.revertedWithCustomError(
        okuBridge,
        "AlreadyProcessed"
      );
    });
  });

  describe("Fee Mechanics", function () {
    it("should correctly calculate and collect fees", async function () {
      const totalShares = ethers.parseEther("1000");
      const fee = 10n; // 0.1%
      const expectedFee = (totalShares * fee) / 10000n;

      // Mint shares to user1 (subtractive: user provides totalShares, fee deducted from it)
      await okuNote.connect(admin).mint(user1.address, totalShares);

      const feeRecipientBalanceBefore = await okuNote.sharesOf(feeRecipient.address);

      // Approve and bridge
      const tokenAmount = await okuNote.sharesToTokens(totalShares);
      await okuNote.connect(user1).approve(await okuBridge.getAddress(), tokenAmount);
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), totalShares);

      const feeRecipientBalanceAfter = await okuNote.sharesOf(feeRecipient.address);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);
    });

    it("should handle zero fee correctly", async function () {
      const shares = ethers.parseEther("100");

      // Update fee to 0
      await okuBridge.connect(admin).updateFee(0);

      // Mint shares to user1
      await okuNote.connect(admin).mint(user1.address, shares);

      const feeRecipientBalanceBefore = await okuNote.sharesOf(feeRecipient.address);

      // Approve and bridge
      const tokenAmount = await okuNote.sharesToTokens(shares);
      await okuNote.connect(user1).approve(await okuBridge.getAddress(), tokenAmount);
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), shares);

      const feeRecipientBalanceAfter = await okuNote.sharesOf(feeRecipient.address);
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
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      const user1BalanceBefore = await okuNote.sharesOf(user1.address);

      // Advance time past the deadline so the mint window is closed
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Admin refunds (simulating destination failure)
      await okuBridge.connect(admin).refundFailedRequest(request, "0x");

      const user1BalanceAfter = await okuNote.sharesOf(user1.address);
      expect(user1BalanceAfter - user1BalanceBefore).to.equal(shares);
    });

    it("should prevent duplicate refunds (replay protection)", async function () {
      const shares = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      // Advance time past the deadline so the mint window is closed
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // First refund succeeds
      await okuBridge.connect(admin).refundFailedRequest(request, "0x");

      // Second refund should revert with AlreadyRefunded
      await expect(
        okuBridge.connect(admin).refundFailedRequest(request, "0x")
      ).to.be.revertedWithCustomError(okuBridge, "AlreadyRefunded");
    });
  });

  describe("Gas Measurement", function () {
    it("should measure gas costs for bridge operations", async function () {
      const shares = ethers.parseEther("100");

      // Mint to user1 (subtractive fee model)
      await okuNote.connect(admin).mint(user1.address, shares);

      // Approve and measure bridgeBurn gas
      const tokenAmount = await okuNote.sharesToTokens(shares);
      await okuNote.connect(user1).approve(await okuBridge.getAddress(), tokenAmount);
      const burnTx = await okuBridge
        .connect(user1)
        .bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), shares);
      const burnReceipt = await burnTx.wait();

      // Verify gas is reasonable (<200k target; safeTransferFrom + nonReentrant overhead)
      expect(burnReceipt?.gasUsed).to.be.lessThan(200000);

      // Create request for mint
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: shares,
        nonce: 0,
        deadline: await futureDeadline(),
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
      const netShares = shares - fee;

      // Mint to user1 (subtractive fee model)
      await okuNote.connect(admin).mint(user1.address, shares);

      // Approve and bridge burn
      const tokenAmount = await okuNote.sharesToTokens(shares);
      await okuNote.connect(user1).approve(await okuBridge.getAddress(), tokenAmount);
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, addressToBytes32(user2.address), shares);

      // Apply rebase (increase multiplier by 50%)
      const REBASER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_REBASER"));
      await okuNote.connect(admin).grantRole(REBASER, admin.address);

      const oldMultiplier = await okuNote.rewardMultiplier();
      const newMultiplier = (oldMultiplier * 150n) / 100n;
      await okuNote.connect(admin).updateRewardMultiplier(newMultiplier);

      // Mint on destination with netShares (fee already deducted on source)
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        shares: netShares,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);
      await okuBridge.bridgeMint(request, signature);

      // Verify net shares are preserved
      const recipientShares = await okuNote.sharesOf(user2.address);
      expect(recipientShares).to.equal(netShares);

      // Verify token balance reflects new multiplier
      const recipientTokens = await okuNote.balanceOf(user2.address);
      const expectedTokens = await okuNote.sharesToTokens(netShares);
      expect(recipientTokens).to.equal(expectedTokens);
    });
  });
});
