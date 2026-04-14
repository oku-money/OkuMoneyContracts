import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { OkuBridge, OkuMoney, OkuBridge__factory, OkuMoney__factory } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OkuBridge E2E", function () {
  let okuBridge: OkuBridge;
  let okuMoney: OkuMoney;

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
      { name: "amount", type: "uint256" },
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

    // Deploy OkuMoney with UUPS proxy
    okuMoney = (await upgrades.deployProxy(
      new OkuMoney__factory(admin),
      ["OkuMoney", "OkuM", admin.address, ethers.parseEther("1000000000")],
      { kind: "uups" }
    )) as unknown as OkuMoney;
    await okuMoney.waitForDeployment();

    // Deploy OkuBridge with UUPS proxy
    // OZ v5 ReentrancyGuard is @custom:stateless (ERC-7201 namespaced slot) — safe for proxies
    okuBridge = (await upgrades.deployProxy(
      new OkuBridge__factory(admin),
      [
        await okuMoney.getAddress(),
        orchestratorSigner.address,
        feeRecipient.address,
        admin.address,
        [OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID, BASE_CHAIN_ID], // initialChains
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuBridge;
    await okuBridge.waitForDeployment();

    // Setup roles
    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"));
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(
      ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER")
    );

    await okuMoney.connect(admin).grantRole(OKUM_MINTER, admin.address);
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await okuBridge.getAddress());
    await okuMoney.connect(admin).grantRole(OKUM_ALLOWANCE_MANAGER, admin.address);

    // Configure minter allowances
    const maxSupply = ethers.parseEther("1000000000");
    await okuMoney.connect(admin).configureMinterAllowance(admin.address, maxSupply);
    await okuMoney
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
      const amount = ethers.parseEther("100");
      const fee = (amount * 10n) / 10000n;
      const netAmount = amount - fee;

      // Mint OkuMoney to user1 (subtractive fee: user provides total amount, fee deducted)
      await okuMoney.connect(admin).mint(user1.address, amount);

      // Approve bridge to pull tokens, then bridge
      await okuMoney.connect(user1).approve(await okuBridge.getAddress(), amount);
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, addressToBytes32(user2.address), amount);

      // Create BridgeRequest for destination (netAmount after fee deduction)
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: netAmount,
        nonce: 0,
        deadline: await futureDeadline(), // 1 hour from now
      };

      // Sign with EIP-712
      const signature = await orchestratorSigner.signTypedData(domain, types, request);

      // Submit to contract
      await okuBridge.bridgeMint(request, signature);

      // Verify net amount minted (fee already deducted on source)
      const recipientBalance = await okuMoney.balanceOf(user2.address);
      expect(recipientBalance).to.equal(netAmount);
    });

    it("should reject signatures from unauthorized signers", async function () {
      const amount = ethers.parseEther("100");

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: amount,
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
      const amount = ethers.parseEther("100");

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: amount,
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
      const amount = ethers.parseEther("50");
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
          amount: amount,
          nonce: i,
          deadline: await futureDeadline(),
        };

        const signature = await orchestratorSigner.signTypedData(domain, types, request);
        await okuBridge.bridgeMint(request, signature);
      }

      // Verify total amount minted
      const totalBalance = await okuMoney.balanceOf(user2.address);
      expect(totalBalance).to.equal(amount * 10n);
    });

    it("should prevent replay attacks", async function () {
      const amount = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: amount,
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
      const totalAmount = ethers.parseEther("1000");
      const fee = 10n; // 0.1%
      const expectedFee = (totalAmount * fee) / 10000n;

      // Mint tokens to user1 (subtractive: user provides totalAmount, fee deducted from it)
      await okuMoney.connect(admin).mint(user1.address, totalAmount);

      const feeRecipientBalanceBefore = await okuMoney.balanceOf(feeRecipient.address);

      // Approve and bridge
      await okuMoney.connect(user1).approve(await okuBridge.getAddress(), totalAmount);
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), totalAmount);

      const feeRecipientBalanceAfter = await okuMoney.balanceOf(feeRecipient.address);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);
    });

    it("should handle zero fee correctly", async function () {
      const amount = ethers.parseEther("100");

      // Update fee to 0
      await okuBridge.connect(admin).updateFee(0);

      // Mint tokens to user1
      await okuMoney.connect(admin).mint(user1.address, amount);

      const feeRecipientBalanceBefore = await okuMoney.balanceOf(feeRecipient.address);

      // Approve and bridge
      await okuMoney.connect(user1).approve(await okuBridge.getAddress(), amount);
      await okuBridge.connect(user1).bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), amount);

      const feeRecipientBalanceAfter = await okuMoney.balanceOf(feeRecipient.address);
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
      const amount = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Create bridge request - sourceChainId must match current chain for refund
      // (refund is initiated on the chain where tokens were burned, i.e., the source chain)
      const request = {
        sourceChainId: chainId,
        destChainId: OPTIMISM_CHAIN_ID,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: amount,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      const user1BalanceBefore = await okuMoney.balanceOf(user1.address);

      // Advance time past the deadline so the mint window is closed
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Two-step refund: admin initiates, user2 (granted confirmer role) confirms.
      // The confirmer must be a different address than the initiator.
      const BRIDGE_REFUND_CONFIRMER = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_REFUND_CONFIRMER"));
      await okuBridge.connect(admin).grantRole(BRIDGE_REFUND_CONFIRMER, user2.address);

      await okuBridge.connect(admin).initiateRefund(request);
      await okuBridge.connect(user2).confirmRefund(request);

      const user1BalanceAfter = await okuMoney.balanceOf(user1.address);
      expect(user1BalanceAfter - user1BalanceBefore).to.equal(amount);
    });

    it("should prevent duplicate refunds (replay protection)", async function () {
      const amount = ethers.parseEther("100");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // sourceChainId must match current chain for refund
      const request = {
        sourceChainId: chainId,
        destChainId: OPTIMISM_CHAIN_ID,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: amount,
        nonce: 1, // different nonce to avoid collision with prior test
        deadline: await futureDeadline(),
      };

      // Advance time past the deadline so the mint window is closed
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Grant confirmer role to a separate address
      const BRIDGE_REFUND_CONFIRMER = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_REFUND_CONFIRMER"));
      await okuBridge.connect(admin).grantRole(BRIDGE_REFUND_CONFIRMER, user2.address);

      // First refund succeeds
      await okuBridge.connect(admin).initiateRefund(request);
      await okuBridge.connect(user2).confirmRefund(request);

      // Second initiation should revert with AlreadyRefunded
      await expect(
        okuBridge.connect(admin).initiateRefund(request)
      ).to.be.revertedWithCustomError(okuBridge, "AlreadyRefunded");
    });
  });

  describe("Gas Measurement", function () {
    it("should measure gas costs for bridge operations", async function () {
      const amount = ethers.parseEther("100");

      // Mint to user1 (subtractive fee model)
      await okuMoney.connect(admin).mint(user1.address, amount);

      // Approve and measure bridgeBurn gas
      await okuMoney.connect(user1).approve(await okuBridge.getAddress(), amount);
      const burnTx = await okuBridge
        .connect(user1)
        .bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), amount);
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
        amount: amount,
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

  describe("NotePrice Scenarios", function () {
    it("should preserve token amounts across notePrice updates", async function () {
      const amount = ethers.parseEther("100");
      const fee = (amount * 10n) / 10000n;
      const netAmount = amount - fee;

      // Mint to user1 (subtractive fee model)
      await okuMoney.connect(admin).mint(user1.address, amount);

      // Approve and bridge burn
      await okuMoney.connect(user1).approve(await okuBridge.getAddress(), amount);
      await okuBridge.connect(user1).bridgeBurn(OPTIMISM_CHAIN_ID, addressToBytes32(user2.address), amount);

      // Update notePrice (increase by 50%) — does NOT change balances
      const REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"));
      await okuMoney.connect(admin).grantRole(REBASER, admin.address);

      const oldPrice = await okuMoney.okuMMultiplier();
      const newPrice = (oldPrice * 150n) / 100n;
      await okuMoney.connect(admin).setOkuMMultiplier(newPrice);

      // Mint on destination with netAmount (fee already deducted on source)
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const request = {
        sourceChainId: OPTIMISM_CHAIN_ID,
        destChainId: chainId,
        sender: user1.address,
        recipient: addressToBytes32(user2.address),
        amount: netAmount,
        nonce: 0,
        deadline: await futureDeadline(),
      };

      const signature = await orchestratorSigner.signTypedData(domain, types, request);
      await okuBridge.bridgeMint(request, signature);

      // Verify net amount minted — balanceOf returns raw token count (non-rebasing)
      const recipientBalance = await okuMoney.balanceOf(user2.address);
      expect(recipientBalance).to.equal(netAmount);
    });
  });
});
