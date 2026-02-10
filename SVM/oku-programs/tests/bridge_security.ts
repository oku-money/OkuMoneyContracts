import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { LitePsm } from "../target/types/lite_psm";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  createMint,
  getMintLen,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeInterestBearingMintInstruction,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import * as nacl from "tweetnacl";

// Use anchor's web3 types
const { SYSVAR_RENT_PUBKEY } = anchor.web3;

describe("Bridge Security Tests", () => {
  // Constants
  const SOLANA_CHAIN_ID = 1151;
  const ETH_CHAIN_ID = 1;
  const BSC_CHAIN_ID = 56;
  const ONE_TOKEN = 1_000_000; // 6 decimals
  const TEN_TOKENS = 10_000_000;
  const ONE_MILLION_TOKENS = 1_000_000_000_000;

  // Provider and program
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  // Bridge authorities (8 roles)
  let bridgeAdmin: Keypair;
  let bridgePauser: Keypair;
  let bridgeUnpauser: Keypair;
  let orchestrator: Keypair; // Ed25519 signer
  let feeRecipient: Keypair;
  let chainManager: Keypair;
  let feeManager: Keypair;
  let nonceAdmin: Keypair;

  // PSM authorities (for initialization)
  let psmAdmin: Keypair;
  const coldMultisig = Keypair.generate();
  const warmMultisig = Keypair.generate();
  const psmOrchestrator = Keypair.generate();

  // Test users
  const user = Keypair.generate();
  const user2 = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  // Mints
  const usdcMintKeypair = Keypair.generate();
  const okusdMintKeypair = Keypair.generate();
  let usdcMint: PublicKey;
  let okusdMint: PublicKey;

  // PDAs
  let configPda: PublicKey;
  let bridgeConfigPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkusdAta: PublicKey;

  // Token accounts
  let userUsdcAta: PublicKey;
  let userOkusdAta: PublicKey;
  let user2OkusdAta: PublicKey;
  let feeRecipientAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  const MAX_SUPPLY = new BN(1_000_000_000_000_000); // 1B tokens
  const MINTER_ALLOWANCE = new BN(100_000_000_000_000); // 100M tokens
  const DECIMALS = 6;

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Serialize bridge message (must match Rust exactly)
   * CRITICAL: recipient must be the OkuUSD ATA address, not the user's pubkey
   */
  function serializeBridgeMessage(params: {
    sourceChainId: number;
    destinationChainId: number;
    sender: Uint8Array; // 20 bytes (EVM) or 32 bytes (Solana)
    recipientAta: PublicKey; // 32 bytes - recipient's OkuUSD ATA address
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
  }): Buffer {
    const message = Buffer.alloc(80);
    let offset = 0;

    // u16 little-endian (2 bytes each)
    offset = message.writeUInt16LE(params.sourceChainId, offset);
    offset = message.writeUInt16LE(params.destinationChainId, offset);

    // sender (EXACTLY 20 bytes for EVM)
    const sender = params.sender.slice(0, 20);
    if (sender.length !== 20) {
      throw new Error(`Sender must be 20 bytes, got ${sender.length}`);
    }
    message.set(sender, offset);
    offset += 20;

    // recipient ATA (EXACTLY 32 bytes)
    const recipientBytes = params.recipientAta.toBytes();
    if (recipientBytes.length !== 32) {
      throw new Error(`Recipient must be 32 bytes, got ${recipientBytes.length}`);
    }
    message.set(recipientBytes, offset);
    offset += 32;

    // u64/i64 little-endian (8 bytes each)
    offset = message.writeBigUInt64LE(params.amount, offset);
    offset = message.writeBigUInt64LE(params.nonce, offset);
    message.writeBigInt64LE(params.deadline, offset);

    // Final validation
    if (message.length !== 80) {
      throw new Error(`Message should be 80 bytes, got ${message.length}`);
    }

    return message;
  }

  /**
   * Calculate request ID (keccak256 hash)
   */
  function calculateRequestId(message: Buffer): Uint8Array {
    return keccak_256(message);
  }

  /**
   * Debug utility to inspect message structure
   */
  function debugMessage(message: Buffer): void {
    console.log("Message breakdown:");
    console.log("  sourceChainId:", message.readUInt16LE(0));
    console.log("  destChainId:", message.readUInt16LE(2));
    console.log("  sender:", message.slice(4, 24).toString('hex'));
    console.log("  recipient:", message.slice(24, 56).toString('hex'));
    console.log("  amount:", message.readBigUInt64LE(56));
    console.log("  nonce:", message.readBigUInt64LE(64));
    console.log("  deadline:", message.readBigInt64LE(72));
    console.log("  total length:", message.length);
    console.log("  keccak256:", Buffer.from(keccak_256(message)).toString('hex'));
  }

  /**
   * Sign message with Ed25519
   */
  function signMessage(message: Buffer, keypair: Keypair): Uint8Array {
    return nacl.sign.detached(message, keypair.secretKey);
  }

  /**
   * Create bridge mint transaction with Ed25519 verification
   * CRITICAL: recipientAta parameter must match what was used in message signing
   */
  async function createBridgeMintTx(params: {
    program: Program<LitePsm>;
    message: Buffer;
    signature: Uint8Array;
    orchestrator: Keypair;
    recipientAta: PublicKey; // The EXACT ATA used in message signing
    payer: Keypair;
    requestId: Uint8Array;
    sourceChainId: number;
    destinationChainId: number;
    sender: Uint8Array;
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
  }): Promise<Transaction> {
    // Ed25519Program instruction MUST come first
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: params.orchestrator.publicKey.toBytes(),
      message: params.message,
      signature: params.signature,
    });

    // Derive ProcessedRequest PDA - must match Rust's derivation exactly
    // seeds = [b"bridge_request", &request_id] where request_id is [u8; 32]
    const [processedRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_request"), Buffer.from(params.requestId)],
      params.program.programId
    );

    // Create recipient ATA if needed
    // The ATA should already exist from the before hook, but check to be safe
    try {
      await getAccount(provider.connection, params.recipientAta, undefined, TOKEN_2022_PROGRAM_ID);
    } catch {
      // ATA doesn't exist - this shouldn't happen in tests but handle it gracefully
      throw new Error(`Recipient ATA ${params.recipientAta.toString()} does not exist. Create it in the test setup.`);
    }

    // Bridge mint instruction
    const bridgeMintIx = await params.program.methods
      .bridgeMint(
        params.sourceChainId,
        params.destinationChainId,
        Array.from(params.sender),
        params.recipientAta, // Add recipient parameter
        new BN(params.amount.toString()),
        new BN(params.nonce.toString()),
        new BN(params.deadline.toString()),
        Array.from(params.requestId)
      )
      .accounts({
        payer: params.payer.publicKey,
        bridgeConfig: bridgeConfigPda,
        config: configPda,
        processedRequest: processedRequestPda,
        okusdMint: okusdMint,
        recipientOkusdAta: params.recipientAta, // Use the exact ATA from params
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ed25519Program: Ed25519Program.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction();
    tx.add(ed25519Ix); // MUST come first
    tx.add(bridgeMintIx); // MUST come second
    return tx;
  }

  /**
   * Random EVM address generator
   */
  function randomEvmAddress(): Uint8Array {
    const addr = new Uint8Array(20);
    crypto.getRandomValues(addr);
    return addr;
  }

  /**
   * Helper to expect error
   */
  async function expectError(
    fn: () => Promise<any>,
    expectedCode: string
  ): Promise<void> {
    try {
      await fn();
      throw new Error("Expected error but transaction succeeded");
    } catch (err: any) {
      if (err.message === "Expected error but transaction succeeded") {
        throw err;
      }
      expect(err.error?.errorCode?.code || err.toString()).to.include(expectedCode);
    }
  }

  // ============================================================================
  // Setup & Initialization
  // ============================================================================

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    psmAdmin = payer;

    // Generate bridge authorities
    bridgeAdmin = Keypair.generate();
    bridgePauser = Keypair.generate();
    bridgeUnpauser = Keypair.generate();
    orchestrator = Keypair.generate(); // Ed25519 signer for bridge_mint
    feeRecipient = Keypair.generate();
    chainManager = Keypair.generate();
    feeManager = Keypair.generate();
    nonceAdmin = Keypair.generate();

    // Ensure payer has sufficient SOL for rent (at least 10 SOL)
    const payerBalance = await provider.connection.getBalance(payer.publicKey);
    if (payerBalance < 10 * anchor.web3.LAMPORTS_PER_SOL) {
      await provider.connection.requestAirdrop(
        payer.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for airdrop
    }

    // Airdrop SOL to all test accounts
    const airdropPromises = [
      bridgeAdmin,
      bridgePauser,
      bridgeUnpauser,
      orchestrator,
      feeRecipient,
      chainManager,
      feeManager,
      nonceAdmin,
      coldMultisig,
      warmMultisig,
      psmOrchestrator,
      user,
      user2,
      unauthorizedUser,
    ].map((kp) =>
      provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    await Promise.all(airdropPromises);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for confirmations

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      program.programId
    );

    [bridgeConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_config")],
      program.programId
    );

    [redemptionQueuePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("redemption_queue")],
      program.programId
    );

    // Create USDC mint (standard SPL)
    usdcMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Create OkuUSD mint (Token-2022 with Interest-Bearing extension)
    const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      mintLen
    );

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: okusdMintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    });

    const initInterestBearingIx = createInitializeInterestBearingMintInstruction(
      okusdMintKeypair.publicKey,
      psmOrchestrator.publicKey, // rate authority
      0, // initial rate
      TOKEN_2022_PROGRAM_ID
    );

    const initMintIx = createInitializeMintInstruction(
      okusdMintKeypair.publicKey,
      DECIMALS,
      configPda, // mint authority = PSM config PDA
      configPda, // freeze authority = PSM config PDA
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(
      createAccountIx,
      initInterestBearingIx,
      initMintIx
    );
    await provider.sendAndConfirm(tx, [payer, okusdMintKeypair]);
    okusdMint = okusdMintKeypair.publicKey;

    // Derive vault ATAs
    vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      configPda,
      true,
      TOKEN_PROGRAM_ID
    );

    vaultOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      configPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Create user token accounts
    userUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    userOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    user2OkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    feeRecipientAta = getAssociatedTokenAddressSync(
      okusdMint,
      feeRecipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    orchestratorUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      psmOrchestrator.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Create USDC accounts and mint USDC
    const createUserUsdcTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userUsdcAta,
        user.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUserUsdcTx, [payer]);

    const createOrchestratorUsdcTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        orchestratorUsdcAta,
        psmOrchestrator.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createOrchestratorUsdcTx, [payer]);

    // Mint USDC to users
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      userUsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM
    await program.methods
      .initialize(MAX_SUPPLY, MINTER_ALLOWANCE)
      .accounts({
        roleAdmin: psmAdmin.publicKey,
        pauser: warmMultisig.publicKey,
        unpauser: coldMultisig.publicKey,
        freezer: warmMultisig.publicKey,
        unfreezer: coldMultisig.publicKey,
        queueProcessor: psmOrchestrator.publicKey,
        bufferDepositor: psmOrchestrator.publicKey,
        bufferWithdrawer: coldMultisig.publicKey,
        oracleManager: coldMultisig.publicKey,
        capManager: coldMultisig.publicKey,
        allowanceManager: coldMultisig.publicKey,
        rebaser: psmOrchestrator.publicKey,
        config: configPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint: usdcMint,
        okusdMint: okusdMint,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Setup OkuUSD escrow
    await program.methods
      .setupOkusdEscrow()
      .accounts({
        roleAdmin: psmAdmin.publicKey,
        config: configPda,
        okusdMint: okusdMint,
        vaultOkusd: vaultOkusdAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Initialize bridge config
    await program.methods
      .initializeBridge()
      .accounts({
        bridgeAdmin: bridgeAdmin.publicKey,
        bridgePauser: bridgePauser.publicKey,
        bridgeUnpauser: bridgeUnpauser.publicKey,
        orchestratorSigner: orchestrator.publicKey, // Ed25519 pubkey
        feeRecipient: feeRecipient.publicKey,
        chainManager: chainManager.publicKey,
        feeManager: feeManager.publicKey,
        nonceAdmin: nonceAdmin.publicKey,
        bridgeConfig: bridgeConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([bridgeAdmin])
      .rpc();

    // Create fee recipient ATA
    const createFeeRecipientAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        feeRecipientAta,
        feeRecipient.publicKey,
        okusdMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createFeeRecipientAtaTx, [payer]);

    // Create user OkuUSD ATAs (for bridge mint recipients)
    const createUserOkusdAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userOkusdAta,
        user.publicKey,
        okusdMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUserOkusdAtaTx, [payer]);

    const createUser2OkusdAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        user2OkusdAta,
        user2.publicKey,
        okusdMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUser2OkusdAtaTx, [payer]);

    // Mint OkuUSD to users for burn tests using bridge_mint
    // This avoids needing to sign with the config PDA
    console.log("Minting OkuUSD to test users for burn tests using bridge_mint...");

    // Add supported chain first
    await program.methods
      .addSupportedChain(ETH_CHAIN_ID)
      .accounts({
        chainManager: chainManager.publicKey,
        bridgeConfig: bridgeConfigPda,
      })
      .signers([chainManager])
      .rpc();

    // Mint to user
    const userMintAmount = BigInt(100_000_000); // 100 tokens
    const userNonce = 9999n;
    const userDeadline = BigInt(2000000000); // Fixed timestamp far in the future
    const userSender = new Uint8Array(20).fill(1); // Dummy EVM address

    const userMessage = serializeBridgeMessage({
      sourceChainId: ETH_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      sender: userSender,
      recipientAta: userOkusdAta,
      amount: userMintAmount,
      nonce: userNonce,
      deadline: userDeadline,
    });

    const userSignature = signMessage(userMessage, orchestrator);
    const userRequestId = calculateRequestId(userMessage);

    console.log("User request ID:", Buffer.from(userRequestId).toString('hex'));
    console.log("User message length:", userMessage.length);
    console.log("User recipientAta:", userOkusdAta.toString());
    debugMessage(userMessage);

    const userMintTx = await createBridgeMintTx({
      program,
      message: userMessage,
      signature: userSignature,
      orchestrator,
      recipientAta: userOkusdAta,
      payer,
      requestId: userRequestId,
      sourceChainId: ETH_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      sender: userSender,
      amount: userMintAmount,
      nonce: userNonce,
      deadline: userDeadline,
    });

    await provider.sendAndConfirm(userMintTx, [payer]);

    // Mint to user2
    const user2Nonce = 9998n;
    const user2Message = serializeBridgeMessage({
      sourceChainId: ETH_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      sender: userSender,
      recipientAta: user2OkusdAta,
      amount: userMintAmount,
      nonce: user2Nonce,
      deadline: userDeadline,
    });

    const user2Signature = signMessage(user2Message, orchestrator);
    const user2RequestId = calculateRequestId(user2Message);

    const user2MintTx = await createBridgeMintTx({
      program,
      message: user2Message,
      signature: user2Signature,
      orchestrator,
      recipientAta: user2OkusdAta,
      payer,
      requestId: user2RequestId,
      sourceChainId: ETH_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      sender: userSender,
      amount: userMintAmount,
      nonce: user2Nonce,
      deadline: userDeadline,
    });

    await provider.sendAndConfirm(user2MintTx, [payer]);

    // Verify users have tokens
    const userAccount = await getAccount(
      provider.connection,
      userOkusdAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const user2Account = await getAccount(
      provider.connection,
      user2OkusdAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    console.log("User OkuUSD balance:", userAccount.amount.toString());
    console.log("User2 OkuUSD balance:", user2Account.amount.toString());
  });

  beforeEach(async () => {
    try {
      // Ensure PSM is unpaused before each test
      const config = await program.account.psmConfig.fetch(configPda);
      if (config.isPaused) {
        console.log("Unpausing PSM before test...");
        await program.methods
          .unpause()
          .accounts({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();

        // WAIT for unpause to confirm
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify unpause succeeded
        const updatedConfig = await program.account.psmConfig.fetch(configPda);
        if (updatedConfig.isPaused) {
          throw new Error("Failed to unpause PSM");
        }
      }

      // Ensure bridge is unpaused before each test
      const bridgeConfig = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      if (bridgeConfig.isPaused) {
        console.log("Unpausing bridge before test...");
        await program.methods
          .unpauseBridge()
          .accounts({
            bridgeUnpauser: bridgeUnpauser.publicKey,
            bridgeConfig: bridgeConfigPda,
          })
          .signers([bridgeUnpauser])
          .rpc();

        // WAIT for unpause to confirm
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify unpause succeeded
        const updatedBridgeConfig = await program.account.bridgeConfig.fetch(bridgeConfigPda);
        if (updatedBridgeConfig.isPaused) {
          throw new Error("Failed to unpause bridge");
        }
      }
    } catch (err) {
      console.error("beforeEach hook error:", err);
      // Don't throw - let test fail naturally with better error message
    }
  });

  // ============================================================================
  // Test Suites
  // ============================================================================

  describe("Bridge Initialization", () => {
    it("initializes bridge config with correct defaults", async () => {
      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);

      expect(config.bridgeFeeBps).to.equal(10); // 0.1%
      expect(config.minBridgeAmount.toNumber()).to.equal(1_000_000); // 1 token
      expect(config.maxBridgeAmount.toNumber()).to.equal(1_000_000_000_000); // 1M tokens
      expect(config.isPaused).to.be.false;
      expect(config.supportedChainsCount).to.equal(0);
    });

    it("sets all 8 bridge authorities correctly", async () => {
      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);

      expect(config.bridgeAdmin.toString()).to.equal(
        bridgeAdmin.publicKey.toString()
      );
      expect(config.bridgePauser.toString()).to.equal(
        bridgePauser.publicKey.toString()
      );
      expect(config.bridgeUnpauser.toString()).to.equal(
        bridgeUnpauser.publicKey.toString()
      );
      expect(config.orchestratorSigner.toString()).to.equal(
        orchestrator.publicKey.toString()
      );
      expect(config.feeRecipient.toString()).to.equal(
        feeRecipient.publicKey.toString()
      );
      expect(config.chainManager.toString()).to.equal(
        chainManager.publicKey.toString()
      );
      expect(config.feeManager.toString()).to.equal(
        feeManager.publicKey.toString()
      );
      expect(config.nonceAdmin.toString()).to.equal(
        nonceAdmin.publicKey.toString()
      );
    });
  });

  describe("Ed25519 Signature Verification", () => {
    const amount = BigInt(10_000_000); // 10 tokens
    const nonce = 0n;
    let validDeadline: bigint;
    let evmSender: Uint8Array;

    beforeEach(async () => {
      // Add Ethereum to supported chains
      try {
        await program.methods
          .addSupportedChain(ETH_CHAIN_ID)
          .accounts({
            chainManager: chainManager.publicKey,
            bridgeConfig: bridgeConfigPda,
          })
          .signers([chainManager])
          .rpc();
      } catch {
        // Already added
      }

      validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      evmSender = randomEvmAddress();
    });

    it("accepts valid orchestrator signature", async () => {
      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: userOkusdAta,
        amount,
        nonce,
        deadline: validDeadline,
      });

      // Debug message
      console.log("\n=== Message Debug ===");
      console.log("userOkusdAta:", userOkusdAta.toString());
      debugMessage(message);

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);
      console.log("Request ID (hex):", Buffer.from(requestId).toString('hex'));

      // Reconstruct message exactly as Rust does to verify
      const rustStyleMessage = Buffer.alloc(80);
      let off = 0;
      off = rustStyleMessage.writeUInt16LE(ETH_CHAIN_ID, off);
      off = rustStyleMessage.writeUInt16LE(SOLANA_CHAIN_ID, off);
      rustStyleMessage.set(evmSender.slice(0, 20), off);
      off += 20;
      rustStyleMessage.set(userOkusdAta.toBytes(), off);
      off += 32;
      off = rustStyleMessage.writeBigUInt64LE(amount, off);
      off = rustStyleMessage.writeBigUInt64LE(nonce, off);
      rustStyleMessage.writeBigInt64LE(validDeadline, off);

      const rustStyleRequestId = keccak_256(rustStyleMessage);
      console.log("\nRust-style message hash:", Buffer.from(rustStyleRequestId).toString('hex'));
      console.log("Our message hash:       ", Buffer.from(requestId).toString('hex'));
      console.log("Messages match:", Buffer.from(rustStyleMessage).toString('hex') === message.toString('hex'));

      console.log("\nAbout to call bridge_mint with recipientOkusdAta:", userOkusdAta.toString());

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce,
        deadline: validDeadline,
      });

      try {
        await provider.sendAndConfirm(tx, [payer]);
      } catch (err) {
        console.log("\nTransaction failed!");
        console.log("Expected recipient:", userOkusdAta.toString());
        console.log("Expected recipient (hex):", Buffer.from(userOkusdAta.toBytes()).toString('hex'));
        throw err;
      }

      // Verify ProcessedRequest PDA created
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const processedRequest = await program.account.processedRequest.fetch(
        processedRequestPda
      );
      expect(processedRequest.requestId).to.deep.equal(Array.from(requestId));
      expect(processedRequest.amount.toNumber()).to.equal(Number(amount));
    });

    it("rejects invalid signature", async () => {
      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: user2OkusdAta,
        amount,
        nonce: 1n,
        deadline: validDeadline,
      });

      const wrongKeypair = Keypair.generate();
      const signature = signMessage(message, wrongKeypair); // Wrong signer
      const requestId = calculateRequestId(message);

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator, // Correct orchestrator in accounts, but wrong signature
        recipientAta: user2OkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce: 1n,
        deadline: validDeadline,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer]),
        "InvalidSignature"
      );
    });

    it("rejects expired signature (past deadline)", async () => {
      const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100); // 100s ago

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: user2OkusdAta,
        amount,
        nonce: 2n,
        deadline: expiredDeadline,
      });

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: user2OkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce: 2n,
        deadline: expiredDeadline,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer]),
        "SignatureExpired"
      );
    });

    it("rejects tampered message (wrong request_id)", async () => {
      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: user2OkusdAta,
        amount,
        nonce: 3n,
        deadline: validDeadline,
      });

      const signature = signMessage(message, orchestrator);
      const wrongRequestId = new Uint8Array(32).fill(0xff);

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: user2OkusdAta,
        payer,
        requestId: wrongRequestId, // Wrong request ID
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce: 3n,
        deadline: validDeadline,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer]),
        "InvalidRequestId"
      );
    });
  });

  describe("Replay Attack Prevention", () => {
    let evmSender: Uint8Array;
    let validDeadline: bigint;

    before(async () => {
      evmSender = randomEvmAddress();
      validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    });

    it("prevents duplicate request_id on second mint", async () => {
      const amount = BigInt(5_000_000);
      const nonce = 10n;

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: userOkusdAta,
        amount,
        nonce,
        deadline: validDeadline,
      });

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      const tx1 = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce,
        deadline: validDeadline,
      });

      // First mint succeeds
      await provider.sendAndConfirm(tx1, [payer]);

      // Second mint with same request_id fails (PDA already exists)
      const tx2 = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce,
        deadline: validDeadline,
      });

      await expectError(
        () => provider.sendAndConfirm(tx2, [payer]),
        "already in use" // Anchor init constraint error
      );
    });

    it("allows different request_ids for different messages", async () => {
      const amount1 = BigInt(3_000_000);
      const amount2 = BigInt(4_000_000);
      const nonce1 = 20n;
      const nonce2 = 21n;

      const message1 = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: userOkusdAta,
        amount: amount1,
        nonce: nonce1,
        deadline: validDeadline,
      });

      const message2 = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: userOkusdAta,
        amount: amount2,
        nonce: nonce2,
        deadline: validDeadline,
      });

      const requestId1 = calculateRequestId(message1);
      const requestId2 = calculateRequestId(message2);

      // Request IDs must be different
      expect(Buffer.from(requestId1).toString("hex")).to.not.equal(
        Buffer.from(requestId2).toString("hex")
      );

      const signature1 = signMessage(message1, orchestrator);
      const signature2 = signMessage(message2, orchestrator);

      const tx1 = await createBridgeMintTx({
        program,
        message: message1,
        signature: signature1,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId: requestId1,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount: amount1,
        nonce: nonce1,
        deadline: validDeadline,
      });

      const tx2 = await createBridgeMintTx({
        program,
        message: message2,
        signature: signature2,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId: requestId2,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount: amount2,
        nonce: nonce2,
        deadline: validDeadline,
      });

      // Both should succeed
      await provider.sendAndConfirm(tx1, [payer]);
      await provider.sendAndConfirm(tx2, [payer]);
    });
  });

  describe("Sequential Nonce Management", () => {
    beforeEach(async () => {
      // Ensure PSM is unpaused
      const config = await program.account.psmConfig.fetch(configPda);
      if (config.isPaused) {
        await program.methods
          .unpause()
          .accounts({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Ensure user has OkuUSD
      const userBalance = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 100_000_000) {
        // Mint some OkuUSD via PSM
        await program.methods
          .mint(new BN(50_000_000))
          .accounts({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okusdMint: okusdMint,
            userUsdcAta: userUsdcAta,
            userOkusdAta: userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
      }
    });

    it("initializes nonce PDA on first burn to destination", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      // Check if nonce account exists
      let nonceExists = true;
      try {
        await program.account.bridgeNonce.fetch(noncePda);
      } catch {
        nonceExists = false;
      }

      if (!nonceExists) {
        // First burn to Ethereum
        await program.methods
          .bridgeBurn(
            new BN(1_000_000),
            Array.from(randomEvmAddress()),
            ETH_CHAIN_ID
          )
          .accounts({
            user: user.publicKey,
            bridgeConfig: bridgeConfigPda,
            config: configPda,
            bridgeNonce: noncePda,
            okusdMint: okusdMint,
            userOkusdAta: userOkusdAta,
            feeRecipientAta: feeRecipientAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
      }

      const nonceAccount = await program.account.bridgeNonce.fetch(noncePda);
      expect(nonceAccount.destinationChain).to.equal(ETH_CHAIN_ID);
      expect(nonceAccount.nextNonce.toNumber()).to.be.greaterThan(0);
    });

    it("increments nonce sequentially on each burn", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      const nonceBefore = await program.account.bridgeNonce.fetch(noncePda);
      const initialNonce = nonceBefore.nextNonce.toNumber();

      // Burn 1
      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      let nonce = await program.account.bridgeNonce.fetch(noncePda);
      expect(nonce.nextNonce.toNumber()).to.equal(initialNonce + 1);

      // Burn 2
      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      nonce = await program.account.bridgeNonce.fetch(noncePda);
      expect(nonce.nextNonce.toNumber()).to.equal(initialNonce + 2);
    });

    it("tracks nonces independently per destination chain", async () => {
      // Add BSC to supported chains
      await program.methods
        .addSupportedChain(BSC_CHAIN_ID)
        .accounts({
          chainManager: chainManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([chainManager])
        .rpc();

      const [ethNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      const [bscNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([BSC_CHAIN_ID, 0])],
        program.programId
      );

      const ethNonceBefore = await program.account.bridgeNonce.fetch(ethNoncePda);

      // Burn to BSC (first time)
      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          BSC_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: bscNoncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const bscNonce = await program.account.bridgeNonce.fetch(bscNoncePda);
      const ethNonceAfter = await program.account.bridgeNonce.fetch(ethNoncePda);

      // BSC nonce should be 1
      expect(bscNonce.nextNonce.toNumber()).to.equal(1);
      expect(bscNonce.destinationChain).to.equal(BSC_CHAIN_ID);

      // ETH nonce should be unchanged
      expect(ethNonceAfter.nextNonce.toNumber()).to.equal(
        ethNonceBefore.nextNonce.toNumber()
      );
    });

    it("allows nonce_admin to skip stuck nonce", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await program.methods
        .skipNonce(ETH_CHAIN_ID, new BN(1000))
        .accounts({
          nonceAdmin: nonceAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
          bridgeNonce: noncePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonceAdmin])
        .rpc();

      const nonce = await program.account.bridgeNonce.fetch(noncePda);
      expect(nonce.nextNonce.toNumber()).to.equal(1000);
    });

    it("rejects skip_nonce from unauthorized account", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .skipNonce(ETH_CHAIN_ID, new BN(2000))
            .accounts({
              nonceAdmin: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
              bridgeNonce: noncePda,
              systemProgram: SystemProgram.programId,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  describe("Bridge Fee Collection", () => {
    const FEE_BPS = 10; // 0.1%
    const BURN_AMOUNT = 10_000_000; // 10 tokens

    before(async () => {
      // Ensure PSM is unpaused
      const config = await program.account.psmConfig.fetch(configPda);
      if (config.isPaused) {
        await program.methods
          .unpause()
          .accounts({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Ensure user has enough OkuUSD
      const userBalance = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 100_000_000) {
        await program.methods
          .mint(new BN(100_000_000))
          .accounts({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okusdMint: okusdMint,
            userUsdcAta: userUsdcAta,
            userOkusdAta: userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
      }
    });

    it("calculates fee correctly (basis points)", () => {
      const expectedFee = (BURN_AMOUNT * FEE_BPS) / 10000;
      expect(expectedFee).to.equal(10_000); // 0.01 tokens
    });

    it("burns amount + fee from user and mints fee to fee_recipient", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const feeRecipientBalanceBefore = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .bridgeBurn(
          new BN(BURN_AMOUNT),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const feeRecipientBalanceAfter = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const totalBurned =
        Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount);
      const expectedTotal = BURN_AMOUNT + (BURN_AMOUNT * FEE_BPS) / 10000;

      expect(totalBurned).to.equal(expectedTotal);

      const feeReceived =
        Number(feeRecipientBalanceAfter.amount) -
        Number(feeRecipientBalanceBefore.amount);
      const expectedFee = (BURN_AMOUNT * FEE_BPS) / 10000;

      expect(feeReceived).to.equal(expectedFee);
    });

    it("handles zero fee correctly (0 bps)", async () => {
      // Update fee to 0
      await program.methods
        .updateBridgeFee(0)
        .accounts({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();

      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .bridgeBurn(
          new BN(BURN_AMOUNT),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const totalBurned =
        Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount);
      expect(totalBurned).to.equal(BURN_AMOUNT); // No fee

      // Restore default fee
      await program.methods
        .updateBridgeFee(10)
        .accounts({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();
    });

    it("rejects fee update above 10000 bps", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeFee(10001)
            .accounts({
              feeManager: feeManager.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([feeManager])
            .rpc(),
        "Overflow"
      );
    });
  });

  describe("Chain Whitelist Validation", () => {
    const POLYGON_CHAIN_ID = 137;

    it("rejects burn to unsupported chain", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([POLYGON_CHAIN_ID, 0])],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .bridgeBurn(
              new BN(1_000_000),
              Array.from(randomEvmAddress()),
              POLYGON_CHAIN_ID
            )
            .accounts({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okusdMint: okusdMint,
              userOkusdAta: userOkusdAta,
              feeRecipientAta: feeRecipientAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc(),
        "UnsupportedChain"
      );
    });

    it("allows chain_manager to add supported chain", async () => {
      await program.methods
        .addSupportedChain(POLYGON_CHAIN_ID)
        .accounts({
          chainManager: chainManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([chainManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(
        config.supportedChains
          .slice(0, config.supportedChainsCount)
          .includes(POLYGON_CHAIN_ID)
      ).to.be.true;
    });

    it("allows burn to supported chain after whitelisting", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([POLYGON_CHAIN_ID, 0])],
        program.programId
      );

      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          POLYGON_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Should succeed
    });

    it("prevents duplicate chain addition", async () => {
      await expectError(
        () =>
          program.methods
            .addSupportedChain(POLYGON_CHAIN_ID)
            .accounts({
              chainManager: chainManager.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([chainManager])
            .rpc(),
        "ChainAlreadySupported"
      );
    });

    it("allows chain_manager to remove supported chain", async () => {
      await program.methods
        .removeSupportedChain(POLYGON_CHAIN_ID)
        .accounts({
          chainManager: chainManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([chainManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(
        config.supportedChains
          .slice(0, config.supportedChainsCount)
          .includes(POLYGON_CHAIN_ID)
      ).to.be.false;
    });

    it("rejects add_chain from unauthorized account", async () => {
      await expectError(
        () =>
          program.methods
            .addSupportedChain(42)
            .accounts({
              chainManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  describe("Bridge Amount Limits", () => {
    const MIN_AMOUNT = 1_000_000; // 1 token
    const MAX_AMOUNT = 1_000_000_000_000; // 1M tokens

    it("rejects burn below minimum amount", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .bridgeBurn(
              new BN(MIN_AMOUNT - 1),
              Array.from(randomEvmAddress()),
              ETH_CHAIN_ID
            )
            .accounts({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okusdMint: okusdMint,
              userOkusdAta: userOkusdAta,
              feeRecipientAta: feeRecipientAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc(),
        "BelowMinimum"
      );
    });

    it("allows burn exactly at minimum", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await program.methods
        .bridgeBurn(
          new BN(MIN_AMOUNT),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      // Should succeed
    });

    it("allows bridge_admin to update limits", async () => {
      const newMin = 2_000_000;
      const newMax = 2_000_000_000_000;

      await program.methods
        .updateBridgeLimits(new BN(newMin), new BN(newMax))
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.minBridgeAmount.toNumber()).to.equal(newMin);
      expect(config.maxBridgeAmount.toNumber()).to.equal(newMax);

      // Restore defaults
      await program.methods
        .updateBridgeLimits(new BN(MIN_AMOUNT), new BN(MAX_AMOUNT))
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();
    });

    it("rejects limit update with min > max", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeLimits(new BN(1000), new BN(100))
            .accounts({
              bridgeAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "BelowMinimum"
      );
    });
  });

  describe("Bridge Pause/Unpause", () => {
    it("bridge_pauser can pause bridge", async () => {
      await program.methods
        .pauseBridge()
        .accounts({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.isPaused).to.be.true;
    });

    it("paused bridge blocks bridge_burn", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .bridgeBurn(
              new BN(1_000_000),
              Array.from(randomEvmAddress()),
              ETH_CHAIN_ID
            )
            .accounts({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okusdMint: okusdMint,
              userOkusdAta: userOkusdAta,
              feeRecipientAta: feeRecipientAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc(),
        "BridgePaused"
      );
    });

    it("paused bridge blocks bridge_mint", async () => {
      const evmSender = randomEvmAddress();
      const validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = BigInt(5_000_000);
      const nonce = 1000n;

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientAta: user2OkusdAta,
        amount,
        nonce,
        deadline: validDeadline,
      });

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: user2OkusdAta,
        payer,
        requestId,
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        amount,
        nonce,
        deadline: validDeadline,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer]),
        "BridgePaused"
      );
    });

    it("bridge_unpauser can unpause bridge", async () => {
      await program.methods
        .unpauseBridge()
        .accounts({
          bridgeUnpauser: bridgeUnpauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeUnpauser])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.isPaused).to.be.false;
    });

    it("bridge_pauser CANNOT unpause", async () => {
      // Pause first
      await program.methods
        .pauseBridge()
        .accounts({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      // Try to unpause with wrong authority
      await expectError(
        () =>
          program.methods
            .unpauseBridge()
            .accounts({
              bridgeUnpauser: bridgePauser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([bridgePauser])
            .rpc(),
        "Unauthorized"
      );

      // Cleanup: unpause with correct authority
      await program.methods
        .unpauseBridge()
        .accounts({
          bridgeUnpauser: bridgeUnpauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeUnpauser])
        .rpc();
    });

    it("bridge pause is independent from PSM pause", async () => {
      // Pause PSM (not bridge)
      await program.methods
        .pause()
        .accounts({
          pauser: warmMultisig.publicKey,
          config: configPda,
        })
        .signers([warmMultisig])
        .rpc();

      // Bridge burn should still work (if bridge not paused)
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .bridgeBurn(
              new BN(1_000_000),
              Array.from(randomEvmAddress()),
              ETH_CHAIN_ID
            )
            .accounts({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okusdMint: okusdMint,
              userOkusdAta: userOkusdAta,
              feeRecipientAta: feeRecipientAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc(),
        "Paused" // PSM is paused, bridge checks PSM pause too
      );

      // Unpause PSM
      await program.methods
        .unpause()
        .accounts({
          unpauser: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();

      // Now bridge burn should work
      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      // Should succeed
    });
  });

  describe("Bridge RBAC Enforcement", () => {
    it("only bridge_admin can update orchestrator signer", async () => {
      const newOrchestrator = Keypair.generate();

      await program.methods
        .updateOrchestratorSigner(newOrchestrator.publicKey)
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.orchestratorSigner.toString()).to.equal(
        newOrchestrator.publicKey.toString()
      );

      // Restore original orchestrator
      await program.methods
        .updateOrchestratorSigner(orchestrator.publicKey)
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();
    });

    it("rejects orchestrator update from non-admin", async () => {
      await expectError(
        () =>
          program.methods
            .updateOrchestratorSigner(Keypair.generate().publicKey)
            .accounts({
              bridgeAdmin: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });

    it("only fee_manager can update bridge fee", async () => {
      await program.methods
        .updateBridgeFee(20)
        .accounts({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.bridgeFeeBps).to.equal(20);

      // Restore default
      await program.methods
        .updateBridgeFee(10)
        .accounts({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();
    });

    it("only bridge_admin can update fee recipient", async () => {
      const newRecipient = Keypair.generate().publicKey;

      await program.methods
        .updateFeeRecipient(newRecipient)
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.feeRecipient.toString()).to.equal(newRecipient.toString());

      // Restore original
      await program.methods
        .updateFeeRecipient(feeRecipient.publicKey)
        .accounts({
          bridgeAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeAdmin])
        .rpc();
    });

    it("enforces role separation for all bridge roles", async () => {
      // Test chain_manager
      await program.methods
        .addSupportedChain(999)
        .accounts({
          chainManager: chainManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([chainManager])
        .rpc();

      await expectError(
        () =>
          program.methods
            .addSupportedChain(998)
            .accounts({
              chainManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );

      // Test fee_manager
      await expectError(
        () =>
          program.methods
            .updateBridgeFee(50)
            .accounts({
              feeManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );

      // Test bridge_pauser
      await program.methods
        .pauseBridge()
        .accounts({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      await expectError(
        () =>
          program.methods
            .pauseBridge()
            .accounts({
              bridgePauser: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );

      // Test bridge_unpauser
      await program.methods
        .unpauseBridge()
        .accounts({
          bridgeUnpauser: bridgeUnpauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeUnpauser])
        .rpc();

      await expectError(
        () =>
          program.methods
            .unpauseBridge()
            .accounts({
              bridgeUnpauser: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  describe("End-to-End Bridge Flow", () => {
    it("completes full burn -> mint cycle", async () => {
      const burnAmount = BigInt(20_000_000); // 20 tokens
      const sourceChain = SOLANA_CHAIN_ID;
      const destChain = ETH_CHAIN_ID;
      const evmRecipient = randomEvmAddress();

      // Ensure PSM is unpaused
      const config = await program.account.psmConfig.fetch(configPda);
      if (config.isPaused) {
        await program.methods
          .unpause()
          .accounts({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Ensure user has enough OkuUSD
      const userBalance = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < Number(burnAmount) * 2) {
        await program.methods
          .mint(new BN(100_000_000))
          .accounts({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okusdMint: okusdMint,
            userUsdcAta: userUsdcAta,
            userOkusdAta: userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
      }

      // Step 1: User burns OkuUSD on Solana
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([destChain, 0])],
        program.programId
      );

      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .bridgeBurn(
          new BN(burnAmount.toString()),
          Array.from(evmRecipient),
          destChain
        )
        .accounts({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const totalBurned =
        Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount);
      const expectedBurn =
        Number(burnAmount) + (Number(burnAmount) * 10) / 10000; // amount + fee
      expect(totalBurned).to.equal(expectedBurn);

      // Step 2: Get nonce used
      const nonceAccount = await program.account.bridgeNonce.fetch(noncePda);
      const usedNonce = nonceAccount.nextNonce.toNumber() - 1;

      // Step 3: Simulate orchestrator signing for mint on Solana (return trip)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const message = serializeBridgeMessage({
        sourceChainId: destChain, // EVM is source for return trip
        destinationChainId: sourceChain, // Solana is destination
        sender: evmRecipient,
        recipientAta: userOkusdAta, // Use recipient's OkuUSD ATA
        amount: burnAmount, // Amount excluding fee
        nonce: BigInt(usedNonce),
        deadline,
      });

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      // Step 4: Execute bridge_mint on Solana
      const recipientBalanceBefore = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientAta: userOkusdAta,
        payer,
        requestId,
        sourceChainId: destChain,
        destinationChainId: sourceChain,
        sender: evmRecipient,
        amount: burnAmount,
        nonce: BigInt(usedNonce),
        deadline,
      });

      await provider.sendAndConfirm(tx, [payer]);

      // Step 5: Verify tokens minted to recipient
      const recipientBalanceAfter = await getAccount(
        provider.connection,
        userOkusdAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const minted =
        Number(recipientBalanceAfter.amount) -
        Number(recipientBalanceBefore.amount);
      expect(minted).to.equal(Number(burnAmount));

      // Step 6: Verify ProcessedRequest PDA created
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const processedRequest = await program.account.processedRequest.fetch(
        processedRequestPda
      );
      expect(processedRequest.amount.toNumber()).to.equal(Number(burnAmount));
    });
  });
});
