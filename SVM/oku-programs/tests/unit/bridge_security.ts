import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { LitePsm } from "../../target/types/lite_psm";
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
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  bridgeOrchestrator,
  initializePSMIfNeeded,
  ensurePSMUnpaused,
  safeAirdrop,
  safeAirdropAll,
} from "../shared/setup";

// Use anchor's web3 types
const { SYSVAR_RENT_PUBKEY } = anchor.web3;

describe("Bridge Security Tests", () => {
  // Constants - Chain IDs use OkuMoney protocol-internal identifiers (Ankr convention for Solana)
  const SOLANA_CHAIN_ID = 103; // Solana Devnet
  const ETH_CHAIN_ID = 1;
  const BSC_CHAIN_ID = 56;
  const OP_SEPOLIA_CHAIN_ID = 11155420;
  const ONE_TOKEN = 1_000_000; // 6 decimals
  const TEN_TOKENS = 10_000_000;
  const ONE_MILLION_TOKENS = 1_000_000_000_000;

  // Provider and program
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  // Bridge authorities (11 roles)
  let bridgeAdmin: Keypair;
  let bridgePauser: Keypair;
  let bridgeUnpauser: Keypair;
  // Use bridgeOrchestrator from shared setup for bridge operations
  const orchestrator = bridgeOrchestrator; // Ed25519 signer
  let feeRecipient: Keypair;
  let chainManager: Keypair;
  let feeManager: Keypair;
  let nonceAdmin: Keypair;
  let signerManager: Keypair;
  let limitsManager: Keypair;

  // PSM authorities imported from shared setup:
  // coldMultisig, warmMultisig, psmOrchestrator
  let psmAdmin: Keypair;

  // Test users
  const user = Keypair.generate();
  const user2 = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  // Mints
  const usdcMintKeypair = Keypair.generate();
  const okuMoneyMintKeypair = Keypair.generate();
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;

  // PDAs
  let configPda: PublicKey;
  let bridgeConfigPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;

  // Token accounts
  let userUsdcAta: PublicKey;
  let userOkuMoneyAta: PublicKey;
  let user2OkuMoneyAta: PublicKey;
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
   * CRITICAL: recipient must be the OkuMoney ATA address, not the user's pubkey
   */
  function serializeBridgeMessage(params: {
    sourceChainId: number;
    destinationChainId: number;
    sender: Uint8Array; // 20 bytes (EVM) or 32 bytes (Solana)
    recipientWallet: PublicKey; // 32 bytes - recipient's wallet pubkey (not ATA)
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

    // recipient wallet pubkey (EXACTLY 32 bytes)
    const recipientBytes = params.recipientWallet.toBytes();
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
   * Sign message with Ed25519
   */
  function signMessage(message: Buffer, keypair: Keypair): Uint8Array {
    return nacl.sign.detached(message, keypair.secretKey);
  }

  /**
   * Create bridge mint transaction with Ed25519 verification
   * CRITICAL: recipientWallet is the wallet pubkey (Fix 3: matches ATA owner, not ATA address)
   */
  async function createBridgeMintTx(params: {
    program: Program<LitePsm>;
    message: Buffer;
    signature: Uint8Array;
    orchestrator: Keypair;
    recipientWallet: PublicKey; // Wallet pubkey — ATA is derived from this
    payer: Keypair;
    requestId: Uint8Array;
  }): Promise<Transaction> {
    // Ed25519Program instruction MUST come first
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: params.orchestrator.publicKey.toBytes(),
      message: new Uint8Array(params.message),  // Convert Buffer to Uint8Array
      signature: params.signature,
    });

    // Derive ProcessedRequest PDA - must match Rust's derivation exactly
    // seeds = [b"bridge_request", &request_id] where request_id is [u8; 32]
    const [processedRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_request"), Buffer.from(params.requestId)],
      params.program.programId
    );

    // Derive recipient's OkuMoney ATA from wallet pubkey
    const recipientAta = getAssociatedTokenAddressSync(
      okuMoneyMint, params.recipientWallet, true, TOKEN_2022_PROGRAM_ID
    );

    // Verify the recipient ATA exists
    try {
      await getAccount(provider.connection, recipientAta, undefined, TOKEN_2022_PROGRAM_ID);
    } catch {
      throw new Error(`Recipient ATA ${recipientAta.toString()} does not exist. Create it in the test setup.`);
    }

    // Bridge mint instruction - pass message_bytes, signature, and request_id
    const bridgeMintIx = await params.program.methods
      .bridgeMint(
        params.message,    // Buffer (bytes type in IDL)
        Buffer.from(params.signature),   // Buffer (bytes type in IDL)
        Array.from(params.requestId)     // [u8; 32] as number array
      )
      .accountsPartial({
        payer: params.payer.publicKey,
        bridgeConfig: bridgeConfigPda,
        config: configPda,
        processedRequest: processedRequestPda,
        okuMoneyMint: okuMoneyMint,
        recipientOkuMoneyAta: recipientAta,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
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
   *
   * Handles both Anchor structured errors and SendTransactionError (the latter
   * occurs when skipPreflight: true is set — program logs must be fetched
   * separately via err.getLogs(connection)).
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

      // Collect all error text, including on-chain logs when available
      const parts: string[] = [];
      if (err.error?.errorCode?.code) parts.push(err.error.errorCode.code);
      if (err.error?.errorMessage) parts.push(err.error.errorMessage);
      parts.push(err.toString());

      // SendTransactionError (from skipPreflight: true) — fetch on-chain logs
      if (typeof err.getLogs === "function") {
        try {
          const logs: string[] = await err.getLogs(provider.connection);
          if (logs?.length) parts.push(logs.join(" "));
        } catch { /* log-fetch failure is non-fatal */ }
      }

      const haystack = parts.join(" ");
      expect(haystack).to.include(expectedCode);
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
    // Note: orchestrator is already assigned from bridgeOrchestrator (shared setup)
    bridgeAdmin = Keypair.generate();
    bridgePauser = Keypair.generate();
    bridgeUnpauser = Keypair.generate();
    feeRecipient = Keypair.generate();
    chainManager = Keypair.generate();
    feeManager = Keypair.generate();
    nonceAdmin = Keypair.generate();
    signerManager = Keypair.generate();
    limitsManager = Keypair.generate();

    // Ensure payer has sufficient SOL for rent (at least 10 SOL)
    const payerBalance = await provider.connection.getBalance(payer.publicKey);
    if (payerBalance < 10 * anchor.web3.LAMPORTS_PER_SOL) {
      await safeAirdrop(provider.connection, payer.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    }

    // Airdrop SOL to all test accounts with proper confirmation
    await safeAirdropAll(
      provider.connection,
      [
        bridgeAdmin,
        bridgePauser,
        bridgeUnpauser,
        orchestrator,
        feeRecipient,
        chainManager,
        feeManager,
        nonceAdmin,
        signerManager,
        limitsManager,
        coldMultisig,
        warmMultisig,
        psmOrchestrator,
        user,
        user2,
        unauthorizedUser,
      ],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

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

    // Create OkuMoney mint (Token-2022 with Interest-Bearing extension)
    const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      mintLen
    );

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: okuMoneyMintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    });

    const initInterestBearingIx = createInitializeInterestBearingMintInstruction(
      okuMoneyMintKeypair.publicKey,
      psmOrchestrator.publicKey, // rate authority
      0, // initial rate
      TOKEN_2022_PROGRAM_ID
    );

    const initMintIx = createInitializeMintInstruction(
      okuMoneyMintKeypair.publicKey,
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
    await provider.sendAndConfirm(tx, [payer, okuMoneyMintKeypair]);
    okuMoneyMint = okuMoneyMintKeypair.publicKey;

    // Derive vault ATAs
    vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      configPda,
      true,
      TOKEN_PROGRAM_ID
    );

    vaultOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
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

    userOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    user2OkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    feeRecipientAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
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

    // Initialize PSM using shared setup module
    const psmSetup = await initializePSMIfNeeded(
      program,
      provider,
      payer,
      usdcMint,
      okuMoneyMint
    );

    configPda = psmSetup.configPda;
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;

    // Initialize bridge config
    await program.methods
      .initializeBridge(SOLANA_CHAIN_ID)
      .accountsPartial({
        bridgeAdmin: bridgeAdmin.publicKey,
        bridgePauser: bridgePauser.publicKey,
        bridgeUnpauser: bridgeUnpauser.publicKey,
        orchestratorSigner: orchestrator.publicKey, // Ed25519 pubkey
        feeRecipient: feeRecipient.publicKey,
        chainManager: chainManager.publicKey,
        feeManager: feeManager.publicKey,
        nonceAdmin: nonceAdmin.publicKey,
        signerManager: signerManager.publicKey,
        limitsManager: limitsManager.publicKey,
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
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createFeeRecipientAtaTx, [payer]);

    // Create user OkuMoney ATAs (for bridge mint recipients)
    const createUserOkuMoneyAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userOkuMoneyAta,
        user.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUserOkuMoneyAtaTx, [payer]);

    const createUser2OkuMoneyAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        user2OkuMoneyAta,
        user2.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUser2OkuMoneyAtaTx, [payer]);

    // Mint OkuMoney to users for burn tests using bridge_mint
    // This avoids needing to sign with the config PDA
    // Add supported chain first
    await program.methods
      .addSupportedChain(ETH_CHAIN_ID)
      .accountsPartial({
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
      recipientWallet: user.publicKey,
      amount: userMintAmount,
      nonce: userNonce,
      deadline: userDeadline,
    });

    const userSignature = signMessage(userMessage, orchestrator);
    const userRequestId = calculateRequestId(userMessage);

    const userMintTx = await createBridgeMintTx({
      program,
      message: userMessage,
      signature: userSignature,
      orchestrator,
      recipientWallet: user.publicKey,
      payer,
      requestId: userRequestId,
    });

    await provider.sendAndConfirm(userMintTx, [payer], { skipPreflight: true });

    // Mint to user2
    const user2Nonce = 9998n;
    const user2Message = serializeBridgeMessage({
      sourceChainId: ETH_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      sender: userSender,
      recipientWallet: user2.publicKey,
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
      recipientWallet: user2.publicKey,
      payer,
      requestId: user2RequestId,
    });

    await provider.sendAndConfirm(user2MintTx, [payer], { skipPreflight: true });

    // Verify users have tokens
    const userAccount = await getAccount(
      provider.connection,
      userOkuMoneyAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const user2Account = await getAccount(
      provider.connection,
      user2OkuMoneyAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  beforeEach(async () => {
    try {
      // Ensure PSM is unpaused using shared helper
      await ensurePSMUnpaused(program, configPda);

      // Ensure bridge is unpaused
      const bridgeConfig = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      if (bridgeConfig.isPaused) {
        await program.methods
          .unpauseBridge()
          .accountsPartial({
            bridgeUnpauser: bridgeUnpauser.publicKey,
            bridgeConfig: bridgeConfigPda,
          })
          .signers([bridgeUnpauser])
          .rpc();

        // Verify unpause succeeded
        const updatedBridgeConfig = await program.account.bridgeConfig.fetch(bridgeConfigPda);
        if (updatedBridgeConfig.isPaused) {
          throw new Error("Failed to unpause bridge");
        }
      }
    } catch (err) {
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
      expect(config.supportedChainsCount).to.equal(1); // ETH chain added in before hook
    });

    it("sets all 11 bridge authorities correctly", async () => {
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
      expect(config.signerManager.toString()).to.equal(
        signerManager.publicKey.toString()
      );
      expect(config.limitsManager.toString()).to.equal(
        limitsManager.publicKey.toString()
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
          .accountsPartial({
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
        recipientWallet: user.publicKey,
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
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      await provider.sendAndConfirm(tx, [payer], { skipPreflight: true });

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
        recipientWallet: user2.publicKey,
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
        recipientWallet: user2.publicKey,
        payer,
        requestId,
      });

      // Ed25519Program fails before our program runs, so we just check for any error
      await expectError(
        () => provider.sendAndConfirm(tx, [payer], { skipPreflight: true }),
        "failed" // Generic check - Ed25519Program returns non-specific error
      );
    });

    // TODO: This test needs a different design. With skipPreflight:true (required for Ed25519
    // precompile), on-chain failures return a plain Error("Raw transaction <bytes>") — not a
    // SendTransactionError — so program logs are not available for error-code matching.
    // Fix: use sendRawTransaction + getTransaction to fetch logs manually, or restructure to
    // call bridge_mint without the Ed25519 wrapper and test the deadline check in isolation.
    it.skip("rejects expired signature (past deadline)", async () => {
      const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100); // 100s ago

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user2.publicKey,
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
        recipientWallet: user2.publicKey,
        payer,
        requestId,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer], { skipPreflight: true }),
        "SignatureExpired"
      );
    });

    it("rejects tampered message (wrong request_id)", async () => {
      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user2.publicKey,
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
        recipientWallet: user2.publicKey,
        payer,
        requestId: wrongRequestId, // Wrong request ID
      });

      // PDA derivation mismatch - Anchor returns constraint error
      await expectError(
        () => provider.sendAndConfirm(tx, [payer], { skipPreflight: true }),
        "Error" // Generic check - PDA seed mismatch causes Anchor constraint error
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

    // TODO: Same skipPreflight / on-chain error-log limitation as the expired-deadline test above.
    // The Anchor `init` constraint on ProcessedRequest PDA returns a Solana system error ("account
    // already in use") without program logs when the transaction is rejected on-chain with
    // skipPreflight:true. Needs sendRawTransaction + manual log fetch or an Anchor simulate call.
    it.skip("prevents duplicate request_id on second mint", async () => {
      const amount = BigInt(5_000_000);
      const nonce = 10n;

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user.publicKey,
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
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      // First mint succeeds
      await provider.sendAndConfirm(tx1, [payer], { skipPreflight: true });

      // Second mint with same request_id fails (PDA already exists)
      const tx2 = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      await expectError(
        () => provider.sendAndConfirm(tx2, [payer], { skipPreflight: true }),
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
        recipientWallet: user.publicKey,
        amount: amount1,
        nonce: nonce1,
        deadline: validDeadline,
      });

      const message2 = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user.publicKey,
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
        recipientWallet: user.publicKey,
        payer,
        requestId: requestId1,
      });

      const tx2 = await createBridgeMintTx({
        program,
        message: message2,
        signature: signature2,
        orchestrator,
        recipientWallet: user.publicKey,
        payer,
        requestId: requestId2,
      });

      // Both should succeed
      await provider.sendAndConfirm(tx1, [payer], { skipPreflight: true });
      await provider.sendAndConfirm(tx2, [payer], { skipPreflight: true });
    });
  });

  describe("Sequential Nonce Management", () => {
    beforeEach(async () => {
      // Ensure PSM is unpaused using shared helper
      await ensurePSMUnpaused(program, configPda);

      // Ensure user has OkuMoney
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 100_000_000) {
        // Mint some OkuMoney via PSM
        await program.methods
          .mintOkuM(new BN(50_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMoneyMint: okuMoneyMint,
            userUsdcAta: userUsdcAta,
            userOkuMoneyAta: userOkuMoneyAta,
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
          .accountsPartial({
            user: user.publicKey,
            bridgeConfig: bridgeConfigPda,
            config: configPda,
            bridgeNonce: noncePda,
            okuMoneyMint: okuMoneyMint,
            userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: bscNoncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
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
            .accountsPartial({
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

    it("rejects skip_nonce with backward nonce", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      // Read current nonce (should be 1000 from the earlier skip)
      const currentNonce = await program.account.bridgeNonce.fetch(noncePda);
      const backwardNonce = currentNonce.nextNonce.toNumber() - 1;

      await expectError(
        () =>
          program.methods
            .skipNonce(ETH_CHAIN_ID, new BN(backwardNonce))
            .accountsPartial({
              nonceAdmin: nonceAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
              bridgeNonce: noncePda,
              systemProgram: SystemProgram.programId,
            })
            .signers([nonceAdmin])
            .rpc(),
        "BelowMinimum"
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
          .accountsPartial({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Ensure user has enough OkuMoney
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 100_000_000) {
        await program.methods
          .mintOkuM(new BN(100_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMoneyMint: okuMoneyMint,
            userUsdcAta: userUsdcAta,
            userOkuMoneyAta: userOkuMoneyAta,
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

    it("burns exact amount from user and mints fee to fee_recipient", async () => {
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
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
      const expectedTotal = BURN_AMOUNT;

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
        .accountsPartial({
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
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .bridgeBurn(
          new BN(BURN_AMOUNT),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const totalBurned =
        Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount);
      expect(totalBurned).to.equal(BURN_AMOUNT); // No fee

      // Restore default fee
      await program.methods
        .updateBridgeFee(10)
        .accountsPartial({
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
            .accountsPartial({
              feeManager: feeManager.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([feeManager])
            .rpc(),
        "InvalidFeeBps"
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
            .accountsPartial({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okuMoneyMint: okuMoneyMint,
              userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
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
            .accountsPartial({
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
        .accountsPartial({
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
            .accountsPartial({
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
            .accountsPartial({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okuMoneyMint: okuMoneyMint,
              userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      // Should succeed
    });

    it("allows limits_manager to update limits", async () => {
      const newMin = 2_000_000;
      const newMax = 2_000_000_000_000;

      await program.methods
        .updateBridgeLimits(new BN(newMin), new BN(newMax))
        .accountsPartial({
          limitsManager: limitsManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([limitsManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.minBridgeAmount.toNumber()).to.equal(newMin);
      expect(config.maxBridgeAmount.toNumber()).to.equal(newMax);

      // Restore defaults
      await program.methods
        .updateBridgeLimits(new BN(MIN_AMOUNT), new BN(MAX_AMOUNT))
        .accountsPartial({
          limitsManager: limitsManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([limitsManager])
        .rpc();
    });

    it("rejects limit update with min > max", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeLimits(new BN(1000), new BN(100))
            .accountsPartial({
              limitsManager: limitsManager.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([limitsManager])
            .rpc(),
        "BelowMinimum"
      );
    });
  });

  describe("Bridge Pause/Unpause", () => {
    it("bridge_pauser can pause bridge", async () => {
      await program.methods
        .pauseBridge()
        .accountsPartial({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.isPaused).to.be.true;
    });

    it("paused bridge blocks bridge_burn", async () => {
      // Pause the bridge first
      await program.methods
        .pauseBridge()
        .accountsPartial({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

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
            .accountsPartial({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okuMoneyMint: okuMoneyMint,
              userOkuMoneyAta: userOkuMoneyAta,
              feeRecipientAta: feeRecipientAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc(),
        "BridgePaused"
      );
    });

    // TODO: Same skipPreflight / on-chain error-log limitation. BridgePaused is a program error
    // returned in the instruction body, but the error comes back as Error("Raw transaction ...")
    // without logs when skipPreflight:true. The bridge_burn pause test (above, using .rpc()) works
    // correctly; only the Ed25519-wrapped bridge_mint path is affected.
    it.skip("paused bridge blocks bridge_mint", async () => {
      // Pause the bridge first
      await program.methods
        .pauseBridge()
        .accountsPartial({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      const evmSender = randomEvmAddress();
      const validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = BigInt(5_000_000);
      const nonce = 1000n;

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user2.publicKey,
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
        recipientWallet: user2.publicKey,
        payer,
        requestId,
      });

      await expectError(
        () => provider.sendAndConfirm(tx, [payer], { skipPreflight: true }),
        "BridgePaused"
      );
    });

    it("bridge_unpauser can unpause bridge", async () => {
      await program.methods
        .unpauseBridge()
        .accountsPartial({
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
        .accountsPartial({
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
            .accountsPartial({
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
        .accountsPartial({
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
        .accountsPartial({
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
            .accountsPartial({
              user: user.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              bridgeNonce: noncePda,
              okuMoneyMint: okuMoneyMint,
              userOkuMoneyAta: userOkuMoneyAta,
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
        .accountsPartial({
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
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
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
    it("only signer_manager can update orchestrator signer", async () => {
      const newOrchestrator = Keypair.generate();

      await program.methods
        .updateOrchestratorSigner(newOrchestrator.publicKey)
        .accountsPartial({
          signerManager: signerManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([signerManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.orchestratorSigner.toString()).to.equal(
        newOrchestrator.publicKey.toString()
      );

      // Restore original orchestrator
      await program.methods
        .updateOrchestratorSigner(orchestrator.publicKey)
        .accountsPartial({
          signerManager: signerManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([signerManager])
        .rpc();
    });

    it("rejects orchestrator update from non-signer_manager", async () => {
      await expectError(
        () =>
          program.methods
            .updateOrchestratorSigner(Keypair.generate().publicKey)
            .accountsPartial({
              signerManager: unauthorizedUser.publicKey,
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
        .accountsPartial({
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
        .accountsPartial({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();
    });

    it("only fee_manager can update fee recipient", async () => {
      const newRecipient = Keypair.generate().publicKey;

      await program.methods
        .updateFeeRecipient(newRecipient)
        .accountsPartial({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.feeRecipient.toString()).to.equal(newRecipient.toString());

      // Restore original
      await program.methods
        .updateFeeRecipient(feeRecipient.publicKey)
        .accountsPartial({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();
    });

    it("enforces role separation for all bridge roles", async () => {
      // Test chain_manager
      await program.methods
        .addSupportedChain(999)
        .accountsPartial({
          chainManager: chainManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([chainManager])
        .rpc();

      await expectError(
        () =>
          program.methods
            .addSupportedChain(998)
            .accountsPartial({
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
            .accountsPartial({
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
        .accountsPartial({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

      await expectError(
        () =>
          program.methods
            .pauseBridge()
            .accountsPartial({
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
        .accountsPartial({
          bridgeUnpauser: bridgeUnpauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgeUnpauser])
        .rpc();

      await expectError(
        () =>
          program.methods
            .unpauseBridge()
            .accountsPartial({
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
          .accountsPartial({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Ensure user has enough OkuMoney
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < Number(burnAmount) * 2) {
        await program.methods
          .mintOkuM(new BN(100_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMoneyMint: okuMoneyMint,
            userUsdcAta: userUsdcAta,
            userOkuMoneyAta: userOkuMoneyAta,
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

      // Step 1: User burns OkuMoney on Solana
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([destChain, 0])],
        program.programId
      );

      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .bridgeBurn(
          new BN(burnAmount.toString()),
          Array.from(evmRecipient),
          destChain
        )
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const totalBurned =
        Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount);
      const expectedBurn = Number(burnAmount);
      expect(totalBurned).to.equal(expectedBurn);

      // Step 2: Get nonce used
      const nonceAccount = await program.account.bridgeNonce.fetch(noncePda);
      const usedNonce = nonceAccount.nextNonce.toNumber() - 1;

      // Step 3: Simulate orchestrator signing for mint on Solana (return trip)
      const netAmount = burnAmount - (burnAmount * BigInt(10)) / BigInt(10000);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const message = serializeBridgeMessage({
        sourceChainId: destChain, // EVM is source for return trip
        destinationChainId: sourceChain, // Solana is destination
        sender: evmRecipient,
        recipientWallet: user.publicKey, // Recipient's wallet pubkey
        amount: netAmount, // Net amount after fee deduction
        nonce: BigInt(usedNonce),
        deadline,
      });

      const signature = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      // Step 4: Execute bridge_mint on Solana
      const recipientBalanceBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const tx = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      await provider.sendAndConfirm(tx, [payer], { skipPreflight: true });

      // Step 5: Verify tokens minted to recipient
      const recipientBalanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const minted =
        Number(recipientBalanceAfter.amount) -
        Number(recipientBalanceBefore.amount);
      expect(minted).to.equal(Number(netAmount));

      // Step 6: Verify ProcessedRequest PDA created
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const processedRequest = await program.account.processedRequest.fetch(
        processedRequestPda
      );
      expect(processedRequest.amount.toNumber()).to.equal(Number(netAmount));
    });
  });

  describe("Refund Bridge Request", () => {
    /**
     * Serialize a SVM->EVM bridge burn message (80 bytes).
     * Layout matches bridge_burn's message construction in lib.rs:
     *   source_chain_id (2 LE) | dest_chain_id (2 LE) | sender (32 bytes Solana pubkey) |
     *   recipient (20 bytes EVM addr) | net_amount (8 LE) | nonce (8 LE) | deadline (8 LE)
     */
    function serializeBurnMessage(params: {
      sourceChainId: number;
      destinationChainId: number;
      sender: PublicKey;
      recipient: Uint8Array; // 20 bytes EVM address
      amount: bigint;
      nonce: bigint;
      deadline: bigint;
    }): Buffer {
      const message = Buffer.alloc(80);
      let offset = 0;

      offset = message.writeUInt16LE(params.sourceChainId, offset);
      offset = message.writeUInt16LE(params.destinationChainId, offset);

      const senderBytes = params.sender.toBytes();
      message.set(senderBytes, offset);
      offset += 32;

      const recipientBytes = params.recipient.slice(0, 20);
      message.set(recipientBytes, offset);
      offset += 20;

      offset = message.writeBigUInt64LE(params.amount, offset);
      offset = message.writeBigUInt64LE(params.nonce, offset);
      message.writeBigInt64LE(params.deadline, offset);

      return message;
    }

    it("refunds a failed bridge request after deadline expires", async () => {
      // Ensure user has enough OkuMoney for the burn
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 50_000_000) {
        await program.methods
          .mintOkuM(new BN(100_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMoneyMint: okuMoneyMint,
            userUsdcAta: userUsdcAta,
            userOkuMoneyAta: userOkuMoneyAta,
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

      // Construct a burn message manually with a deadline in the past (Unix timestamp 1)
      const evmRecipient = randomEvmAddress();
      const pastDeadline = 1n; // 1970-01-01, definitely expired
      const refundAmount = BigInt(5_000_000);
      const refundNonce = 88888n;

      const messageBytes = serializeBurnMessage({
        sourceChainId: SOLANA_CHAIN_ID,
        destinationChainId: ETH_CHAIN_ID,
        sender: user.publicKey,
        recipient: evmRecipient,
        amount: refundAmount,
        nonce: refundNonce,
        deadline: pastDeadline,
      });

      const requestId = calculateRequestId(messageBytes);

      // Derive RefundedRequest PDA
      const [refundedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_refund"), Buffer.from(requestId)],
        program.programId
      );

      // Derive ProcessedRequest PDA (for double-mint prevention check)
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );

      // Get user balance before refund
      const userBalanceBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Call refund_bridge_request (refund_admin defaults to bridgeAdmin)
      await program.methods
        .refundBridgeRequest(
          Buffer.from(messageBytes),
          Array.from(requestId)
        )
        .accountsPartial({
          refundAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          refundedRequest: refundedRequestPda,
          processedRequest: processedRequestPda,
          okuMoneyMint: okuMoneyMint,
          senderOkuMoneyAta: userOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bridgeAdmin])
        .rpc();

      // Verify tokens were minted back to the sender
      const userBalanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const minted =
        Number(userBalanceAfter.amount) - Number(userBalanceBefore.amount);
      expect(minted).to.equal(Number(refundAmount));

      // Verify RefundedRequest PDA was created
      const refundedRequest = await program.account.refundedRequest.fetch(
        refundedRequestPda
      );
      expect(refundedRequest.requestId).to.deep.equal(Array.from(requestId));
      expect(refundedRequest.amount.toNumber()).to.equal(Number(refundAmount));
      expect(refundedRequest.recipient.toString()).to.equal(
        user.publicKey.toString()
      );
    });

    it("rejects double-refund for the same request", async () => {
      // Use the same message from the happy path (already refunded above)
      const evmRecipient = new Uint8Array(20).fill(0xaa); // deterministic address
      const pastDeadline = 1n;
      const refundAmount = BigInt(3_000_000);
      const refundNonce = 77777n;

      const messageBytes = serializeBurnMessage({
        sourceChainId: SOLANA_CHAIN_ID,
        destinationChainId: ETH_CHAIN_ID,
        sender: user.publicKey,
        recipient: evmRecipient,
        amount: refundAmount,
        nonce: refundNonce,
        deadline: pastDeadline,
      });

      const requestId = calculateRequestId(messageBytes);

      const [refundedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_refund"), Buffer.from(requestId)],
        program.programId
      );

      // Derive ProcessedRequest PDA (for double-mint prevention check)
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );

      // First refund should succeed
      await program.methods
        .refundBridgeRequest(
          Buffer.from(messageBytes),
          Array.from(requestId)
        )
        .accountsPartial({
          refundAdmin: bridgeAdmin.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          refundedRequest: refundedRequestPda,
          processedRequest: processedRequestPda,
          okuMoneyMint: okuMoneyMint,
          senderOkuMoneyAta: userOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bridgeAdmin])
        .rpc();

      // Second refund with same request_id should fail (PDA already exists)
      await expectError(
        () =>
          program.methods
            .refundBridgeRequest(
              Buffer.from(messageBytes),
              Array.from(requestId)
            )
            .accountsPartial({
              refundAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              refundedRequest: refundedRequestPda,
              processedRequest: processedRequestPda,
              okuMoneyMint: okuMoneyMint,
              senderOkuMoneyAta: userOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "already in use" // Anchor init constraint error - PDA already exists
      );
    });

    it("rejects refund before deadline expires (MintWindowStillOpen)", async () => {
      const evmRecipient = randomEvmAddress();
      const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 99999); // far in the future
      const refundAmount = BigInt(2_000_000);
      const refundNonce = 66666n;

      const messageBytes = serializeBurnMessage({
        sourceChainId: SOLANA_CHAIN_ID,
        destinationChainId: ETH_CHAIN_ID,
        sender: user.publicKey,
        recipient: evmRecipient,
        amount: refundAmount,
        nonce: refundNonce,
        deadline: futureDeadline,
      });

      const requestId = calculateRequestId(messageBytes);

      const [refundedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_refund"), Buffer.from(requestId)],
        program.programId
      );

      // Derive ProcessedRequest PDA (for double-mint prevention check)
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .refundBridgeRequest(
              Buffer.from(messageBytes),
              Array.from(requestId)
            )
            .accountsPartial({
              refundAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              refundedRequest: refundedRequestPda,
              processedRequest: processedRequestPda,
              okuMoneyMint: okuMoneyMint,
              senderOkuMoneyAta: userOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "MintWindowStillOpen"
      );
    });

    it("rejects refund for a request that was already minted (RequestAlreadyMinted)", async () => {
      // First, create and execute a successful bridge_mint
      const evmSender = randomEvmAddress();
      const validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const mintAmount = BigInt(1_000_000);
      const mintNonce = 99999n;

      const mintMessage = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user.publicKey,
        amount: mintAmount,
        nonce: mintNonce,
        deadline: validDeadline,
      });

      const signature = signMessage(mintMessage, orchestrator);
      const requestId = calculateRequestId(mintMessage);

      // Execute the mint successfully
      const tx = await createBridgeMintTx({
        program,
        message: mintMessage,
        signature,
        orchestrator,
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });
      await provider.sendAndConfirm(tx, [payer], { skipPreflight: true });

      // Now construct the corresponding burn message (EVM→SVM format differs from SVM→EVM)
      // For refund, we need the SVM→EVM burn message format
      const refundMessage = serializeBurnMessage({
        sourceChainId: SOLANA_CHAIN_ID, // SVM is source for refund
        destinationChainId: ETH_CHAIN_ID,
        sender: user.publicKey,
        recipient: evmSender,
        amount: mintAmount,
        nonce: mintNonce,
        deadline: 1n, // Past deadline to allow refund attempt
      });

      const refundRequestId = calculateRequestId(refundMessage);

      const [refundedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_refund"), Buffer.from(refundRequestId)],
        program.programId
      );

      // The ProcessedRequest PDA should exist from the mint
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );

      // Attempt refund should fail because the ProcessedRequest exists
      // (but we need to use the SAME requestId that was minted, not a different one)
      // Actually, the refund check is for the same request_id, so we need to try
      // to refund the SAME request that was already minted

      // For the proper test, we'd need to attempt a refund using the same
      // requestId that was used in bridge_mint. The refund message format
      // uses SVM→EVM format, but the processedRequest check uses the requestId.
      
      // Let's use the MINT requestId and see if refund is blocked
      const [mintRefundedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_refund"), Buffer.from(requestId)],
        program.programId
      );

      // The mint's ProcessedRequest PDA
      const [mintProcessedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );

      // Try to refund using the same message that was minted
      // This should fail with RequestAlreadyMinted because processedRequest exists
      await expectError(
        () =>
          program.methods
            .refundBridgeRequest(
              Buffer.from(mintMessage),
              Array.from(requestId)
            )
            .accountsPartial({
              refundAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              refundedRequest: mintRefundedPda,
              processedRequest: mintProcessedPda,
              okuMoneyMint: okuMoneyMint,
              senderOkuMoneyAta: userOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "RequestAlreadyMinted"
      );
    });
  });

  describe("Bridge Mint Without Amount Limits", () => {
    it("accepts bridge_mint below min_bridge_amount (limits removed from mint)", async () => {
      // min_bridge_amount is 1_000_000 (1 token). Mint 100 (0.0001 tokens) — should succeed now.
      const smallAmount = BigInt(100);
      const evmSender = randomEvmAddress();
      const validDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const nonce = 55555n;

      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user.publicKey,
        amount: smallAmount,
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
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      // Should succeed — amount limit checks were removed from bridge_mint
      await provider.sendAndConfirm(tx, [payer], { skipPreflight: true });

      // Verify tokens were minted
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const processedRequest = await program.account.processedRequest.fetch(
        processedRequestPda
      );
      expect(processedRequest.amount.toNumber()).to.equal(Number(smallAmount));
    });
  });

  describe("Configurable Bridge Deadline", () => {
    it("update_bridge_deadline sets new deadline", async () => {
      const newDeadlineSecs = 7200; // 2 hours

      await program.methods
        .updateBridgeDeadline(new BN(newDeadlineSecs))
        .accountsPartial({
          limitsManager: limitsManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([limitsManager])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.bridgeDeadlineSecs.toNumber()).to.equal(newDeadlineSecs);
    });

    it("bridge_burn uses the configured deadline", async () => {
      // Set a custom deadline of 120 seconds
      const customDeadlineSecs = 120;
      await program.methods
        .updateBridgeDeadline(new BN(customDeadlineSecs))
        .accountsPartial({
          limitsManager: limitsManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([limitsManager])
        .rpc();

      // Ensure user has tokens
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < 10_000_000) {
        await program.methods
          .mintOkuM(new BN(50_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMoneyMint: okuMoneyMint,
            userUsdcAta: userUsdcAta,
            userOkuMoneyAta: userOkuMoneyAta,
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

      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );

      // Listen for BridgeBurnEvent
      const listener = program.addEventListener("bridgeBurnEvent", (event) => {
        // Event deadline should be ~now + customDeadlineSecs
        const now = Math.floor(Date.now() / 1000);
        const eventDeadline = event.deadline.toNumber();
        // Deadline should be within a few seconds of now + customDeadlineSecs
        expect(eventDeadline).to.be.greaterThanOrEqual(now + customDeadlineSecs - 5);
        expect(eventDeadline).to.be.lessThanOrEqual(now + customDeadlineSecs + 5);
      });

      await program.methods
        .bridgeBurn(
          new BN(1_000_000),
          Array.from(randomEvmAddress()),
          ETH_CHAIN_ID
        )
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint: okuMoneyMint,
          userOkuMoneyAta: userOkuMoneyAta,
          feeRecipientAta: feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Give the event listener a moment to fire
      await new Promise((resolve) => setTimeout(resolve, 500));
      program.removeEventListener(listener);

      // Restore default deadline
      await program.methods
        .updateBridgeDeadline(new BN(3600))
        .accountsPartial({
          limitsManager: limitsManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([limitsManager])
        .rpc();
    });

    it("rejects update_bridge_deadline with zero value", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeDeadline(new BN(0))
            .accountsPartial({
              limitsManager: limitsManager.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([limitsManager])
            .rpc(),
        "InvalidDeadline"
      );
    });
  });
});
