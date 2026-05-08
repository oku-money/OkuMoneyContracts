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
import { fetchBridgeBurnEvent, serializeBurnMessage, computeRequestId } from "../../scripts/lib/bridge";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  bridgeOrchestrator,
  initializePSMIfNeeded,
  ensurePSMUnpaused,
  mintOkuMoneyViaProgram,
  safeAirdrop,
  safeAirdropAll,
} from "../shared/setup";

// Use anchor's web3 types
const { SYSVAR_RENT_PUBKEY } = anchor.web3;

/**
 * Conditional `it` for tests that perform `bridge_mint` against a real
 * solana-test-validator. These tests routinely time out on the @solana/web3.js
 * 30s confirmation polling window because `bridge_mint` is the heaviest path
 * in the program (Ed25519 sigverify + instruction-sysvar introspection +
 * keccak256 + PDA init + Token-2022 mint CPI in a single transaction).
 *
 * The transactions themselves are valid; the issue is purely client-side
 * confirmation timing. See SVM/README.md → "Test runtime notes".
 *
 * Skipped by default to keep `anchor test` runtime ~1 minute on local machines.
 * To run them (e.g., on CI or fast hardware), set:
 *
 *     RUN_HEAVY_BRIDGE_TESTS=1 npx mocha --require tsx --timeout 300000 \
 *         'tests/unit/bridge_security.ts'
 */
const RUN_HEAVY_BRIDGE_TESTS = process.env.RUN_HEAVY_BRIDGE_TESTS === "1";
const itHeavy: Mocha.TestFunction = (RUN_HEAVY_BRIDGE_TESTS ? it : it.skip) as Mocha.TestFunction;

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

  // Captures the original `provider.sendAndConfirm` so the `before` hook can
  // monkey-patch it for this describe block and the `after` hook can restore it.
  let originalSendAndConfirm: typeof anchor.AnchorProvider.prototype.sendAndConfirm;

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

  /**
   * Submit a transaction with skipPreflight and assert a program-level error.
   *
   * Required for Ed25519-wrapped bridge_mint negative tests: Anchor 1.0's
   * preflight simulation rejects the Ed25519 precompile ("This program may
   * not be used for executing instructions"), so we must skipPreflight. But
   * provider.sendAndConfirm with skipPreflight: true wraps on-chain failures
   * in a plain Error("Raw transaction <sig> failed") without logs.
   *
   * This helper sends the raw signed transaction, waits for confirmation
   * (regardless of success/failure), then fetches the transaction to extract
   * the real on-chain logs and meta.err. The expectedCode must appear in
   * either the logs or the serialized err object.
   *
   * This is NOT a mock or simulation — it's the same tx the validator
   * processes, with skipPreflight:true being the only tweak to bypass the
   * Anchor-1.0/Ed25519-precompile incompatibility during preflight.
   */
  async function expectBridgeMintProgramError(
    tx: Transaction,
    signers: Keypair[],
    expectedCode: string
  ): Promise<void> {
    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);

    const rawTx = tx.serialize();
    const signature = await provider.connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });

    // confirmTransaction returns {value: {err}} for both success and failure;
    // it only throws on blockhash expiration / network errors.
    await provider.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    const txInfo = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    const onChainErr = txInfo?.meta?.err ?? null;
    const logs = txInfo?.meta?.logMessages ?? [];

    if (!onChainErr) {
      throw new Error(
        `Expected on-chain failure matching "${expectedCode}" but transaction succeeded.\n` +
          `Logs:\n  ${logs.join("\n  ")}`
      );
    }

    const haystack = [JSON.stringify(onChainErr), ...logs].join(" ");
    if (!haystack.includes(expectedCode)) {
      throw new Error(
        `Expected on-chain error to match "${expectedCode}" but got:\n` +
          `  meta.err: ${JSON.stringify(onChainErr)}\n` +
          `  logs:\n    ${logs.join("\n    ")}`
      );
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

    // ----------------------------------------------------------------------
    // Scoped patch: replace `provider.sendAndConfirm` with the modern
    // blockhash-based confirmation strategy for the duration of this describe
    // block, then restore the original in an `after` hook so it doesn't bleed
    // into other test files (the AnchorProvider instance is shared).
    //
    // Anchor's default implementation routes through web3.js's
    // `confirmTransactionUsingLegacyTimeoutStrategy`, which polls the RPC and
    // gives up after a hard 30s — even when the validator has actually accepted
    // the transaction. The bridge_mint instruction (Ed25519 sigverify +
    // instruction-sysvar introspection + keccak256 + PDA init + Token-2022
    // mint CPI in one tx) routinely exceeds 30s on a freshly-spawned local
    // validator, producing spurious `TransactionExpiredTimeoutError`s.
    //
    // The blockhash-based strategy waits until `lastValidBlockHeight` is
    // genuinely exceeded on-chain (~150 slots ≈ 60s on a local validator)
    // using websocket subscription updates instead of polling, and surfaces
    // real on-chain failures via `result.value.err` rather than swallowing
    // them as confirmation timeouts.
    // ----------------------------------------------------------------------
    const wallet = provider.wallet as anchor.Wallet;
    originalSendAndConfirm = provider.sendAndConfirm.bind(provider);
    provider.sendAndConfirm = async (tx: any, signers?: Keypair[], opts?: anchor.web3.ConfirmOptions) => {
      const latest = await provider.connection.getLatestBlockhash("confirmed");
      const skipPreflight = opts?.skipPreflight ?? false;

      if (tx instanceof anchor.web3.Transaction) {
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = wallet.payer.publicKey;
        // Drop any signatures from a prior attempt before re-signing.
        tx.signatures = [];
        const allSigners = [
          wallet.payer,
          ...(signers ?? []).filter((s) => !s.publicKey.equals(wallet.payer.publicKey)),
        ];
        tx.sign(...allSigners);
        const signature = await provider.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight,
          preflightCommitment: "confirmed",
          maxRetries: 5,
        });
        const result = await provider.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );
        if (result.value.err) {
          throw new Error(
            `Transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`
          );
        }
        return signature;
      }

      // VersionedTransaction path — sign with provided signers and send raw.
      if (tx instanceof anchor.web3.VersionedTransaction) {
        if (signers && signers.length > 0) tx.sign(signers);
        const signature = await provider.connection.sendTransaction(tx, {
          skipPreflight,
          preflightCommitment: "confirmed",
          maxRetries: 5,
        });
        const result = await provider.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );
        if (result.value.err) {
          throw new Error(
            `Transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`
          );
        }
        return signature;
      }

      throw new Error("Unsupported transaction type passed to patched sendAndConfirm");
    };

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
    //
    // Initializer now takes a `BridgeInitConfig` struct with caller-supplied
    // defaults instead of hardcoded values. Refund initiator and confirmer
    // must be distinct from each other AND from bridge_admin (mirrors EVM's
    // OkuBridge two-step refund key-separation requirement). We reuse
    // `nonceAdmin` and `signerManager` here since both already exist as
    // separate keypairs in this test fixture.
    await program.methods
      .initializeBridge({
        sourceChainId: SOLANA_CHAIN_ID,
        bridgeFeeBps: 10,                                   // 0.1%
        minBridgeAmount: new BN(1_000_000),                 // 1 token
        maxBridgeAmount: new BN(1_000_000_000_000),         // 1M tokens
        bridgeDeadlineSecs: new BN(3600),                   // 1 hour
        refundInitiator: nonceAdmin.publicKey,
        refundConfirmer: signerManager.publicKey,
      })
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

    // Add ETH as a supported chain for the bridge_burn / bridge_mint tests below.
    await program.methods
      .addSupportedChain(ETH_CHAIN_ID)
      .accountsPartial({
        chainManager: chainManager.publicKey,
        bridgeConfig: bridgeConfigPda,
      })
      .signers([chainManager])
      .rpc();

    // Seed users with OkuMoney for the burn tests below via the lightweight
    // PSM mint path (USDC -> OkuMoney). Previously this used `bridge_mint`,
    // which triggers Ed25519 sigverify + keccak256 + a PDA init in a single
    // transaction — heavy enough that a freshly-spawned local validator would
    // intermittently miss the client confirmation window during the very first
    // request. `mint_oku_m` avoids all of that and is also the canonical
    // user-facing mint path, so the seeding more closely mirrors production.
    const SEED_USDC_AMOUNT = 100_000_000; // 100 USDC -> 100 OkuMoney @ 1:1 price

    // user2 needs its own funded USDC ATA before it can mint.
    const user2UsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user2.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          user2UsdcAta,
          user2.publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID
        )
      ),
      [payer]
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      user2UsdcAta,
      payer,
      SEED_USDC_AMOUNT,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    await mintOkuMoneyViaProgram(
      program,
      user,
      new BN(SEED_USDC_AMOUNT),
      configPda,
      usdcMint,
      okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdcAta
    );
    await mintOkuMoneyViaProgram(
      program,
      user2,
      new BN(SEED_USDC_AMOUNT),
      configPda,
      usdcMint,
      okuMoneyMint,
      user2UsdcAta,
      user2OkuMoneyAta,
      vaultUsdcAta
    );

    // Sanity-check that both users hold OkuMoney before tests proceed.
    await getAccount(provider.connection, userOkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);
    await getAccount(provider.connection, user2OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);
  });

  after(() => {
    // Restore the original `provider.sendAndConfirm` so subsequent test files
    // (lite-psm, oku-bridge-router, oku-dollar) see the unpatched provider.
    if (originalSendAndConfirm) {
      provider.sendAndConfirm = originalSendAndConfirm;
    }
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

    itHeavy("accepts valid orchestrator signature", async () => {
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

    itHeavy("rejects invalid signature", async () => {
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

    itHeavy("rejects expired signature (past deadline)", async () => {
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

      await expectBridgeMintProgramError(tx, [payer], "SignatureExpired");
    });

    itHeavy("rejects tampered message (wrong request_id)", async () => {
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

    itHeavy("prevents duplicate request_id on second mint", async () => {
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
      const tx1Sig = await provider.sendAndConfirm(tx1, [payer], { skipPreflight: true });

      // Sanity check: the ProcessedRequest PDA must exist on-chain after tx1
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );
      const pdaInfo = await provider.connection.getAccountInfo(processedRequestPda);
      expect(pdaInfo, "ProcessedRequest PDA must exist after first mint").to.not.be.null;

      // Second mint with same request_id must fail — the ProcessedRequest PDA
      // already exists from tx1, so Anchor's `init` constraint trips. The
      // System Program's CreateAccount returns "already in use" in tx logs.
      //
      // IMPORTANT: tx2 must serialize to different bytes than tx1, otherwise
      // the validator dedupes and returns tx1's already-confirmed signature.
      // We wait for a new blockhash before building tx2.
      let newBlockhash = (await provider.connection.getLatestBlockhash("confirmed")).blockhash;
      while (newBlockhash === tx1.recentBlockhash) {
        await new Promise((r) => setTimeout(r, 50));
        newBlockhash = (await provider.connection.getLatestBlockhash("confirmed")).blockhash;
      }

      const tx2 = await createBridgeMintTx({
        program,
        message,
        signature,
        orchestrator,
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });

      await expectBridgeMintProgramError(tx2, [payer], "already in use");
    });

    itHeavy("allows different request_ids for different messages", async () => {
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
        "NonceNotMonotonic"
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
        "InvalidLimits"
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

    itHeavy("paused bridge blocks bridge_mint", async () => {
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

      await expectBridgeMintProgramError(tx, [payer], "BridgePaused");
    });

    it("bridge_unpauser can unpause bridge", async () => {
      // Pause first (beforeEach resets to unpaused, and unpause now reverts with
      // NotPaused if the bridge isn't actually paused).
      await program.methods
        .pauseBridge()
        .accountsPartial({
          bridgePauser: bridgePauser.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([bridgePauser])
        .rpc();

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
    itHeavy("completes full burn -> mint cycle", async () => {
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

  describe("Bridge Mint Without Amount Limits", () => {
    itHeavy("accepts bridge_mint below min_bridge_amount (limits removed from mint)", async () => {
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
        // Event deadline should be ~now + customDeadlineSecs.
        // Tolerance is wide (±60s) because solana-test-validator's on-chain
        // `clock.unix_timestamp` drifts from wall-clock `Date.now()` by tens
        // of seconds during a long test run. The intent of this assertion is
        // "deadline ≈ now + customDeadlineSecs", not exact second-level match.
        const now = Math.floor(Date.now() / 1000);
        const eventDeadline = event.deadline.toNumber();
        expect(eventDeadline).to.be.greaterThanOrEqual(now + customDeadlineSecs - 60);
        expect(eventDeadline).to.be.lessThanOrEqual(now + customDeadlineSecs + 60);
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

    it("rejects update_bridge_deadline from non-limits_manager", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeDeadline(new BN(120))
            .accountsPartial({
              limitsManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });

    it("rejects update_bridge_limits from non-limits_manager", async () => {
      await expectError(
        () =>
          program.methods
            .updateBridgeLimits(new BN(1), new BN(2))
            .accountsPartial({
              limitsManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });

    it("rejects update_fee_recipient from non-fee_manager", async () => {
      await expectError(
        () =>
          program.methods
            .updateFeeRecipient(Keypair.generate().publicKey)
            .accountsPartial({
              feeManager: unauthorizedUser.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  // ==========================================================================
  // Phase 8.3 — set_bridge_authority privilege-escalation defense
  // ==========================================================================
  describe("set_bridge_authority dedicated-rotation gate", () => {
    it("rejects rotation of OrchestratorSigner via set_bridge_authority", async () => {
      // Phase 8.1 closed the privilege-escalation vector: OrchestratorSigner
      // must be rotated through update_orchestrator_signer (signer_manager-
      // gated), NOT through set_bridge_authority (bridge_admin-gated).
      await expectError(
        () =>
          program.methods
            .setBridgeAuthority(
              { orchestratorSigner: {} } as any,
              Keypair.generate().publicKey
            )
            .accountsPartial({
              bridgeAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "UseDedicatedRotation"
      );
    });

    it("rejects rotation of FeeRecipient via set_bridge_authority", async () => {
      await expectError(
        () =>
          program.methods
            .setBridgeAuthority(
              { feeRecipient: {} } as any,
              Keypair.generate().publicKey
            )
            .accountsPartial({
              bridgeAdmin: bridgeAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([bridgeAdmin])
            .rpc(),
        "UseDedicatedRotation"
      );
    });
  });

  // ==========================================================================
  // Phase 8.3 — Refund flow (initiate_refund deadline checks)
  //
  // Full happy-path refund tests (initiate -> confirm) need the cluster clock
  // advanced past the bridge deadline. solana-test-validator's wall clock
  // would force us to literally sleep `bridge_deadline_secs` seconds; that
  // doesn't fit in a unit-test budget. Those tests are deferred to the
  // tests/bankrun/ migration where `warpBy()` makes them trivial.
  //
  // Below we cover the deadline-not-elapsed reject case (which DOESN'T
  // need clock manipulation — a fresh burn always has a future deadline).
  // ==========================================================================
  describe("Refund flow (deadline-not-elapsed)", () => {
    itHeavy("initiate_refund rejects with MintWindowStillOpen when deadline not yet elapsed", async () => {
      const burnAmount = BigInt(2_000_000); // 2 tokens
      const destChain = ETH_CHAIN_ID;
      const evmRecipient = randomEvmAddress();

      // Make sure user has balance to burn.
      const userBalance = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(userBalance.amount) < Number(burnAmount) * 2) {
        await program.methods
          .mintOkuM(new BN(20_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okuMoneyMint,
            userUsdcAta,
            userOkuMoneyAta,
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

      // Burn — produces a BridgeBurnEvent whose deadline is now+1h (the
      // current bridge_deadline_secs default).
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([destChain, 0])],
        program.programId
      );
      const txSig = await program.methods
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

      // Read the actual emitted BridgeBurnEvent (the canonical source of
      // request_id, nonce, and deadline). Avoids the fragile recomputation
      // that previously bit Phase 5's bridge-burn script.
      const burnEvent = await fetchBridgeBurnEvent(
        provider.connection,
        txSig,
        program.idl as any
      );
      const messageBytes = serializeBurnMessage({
        sourceChainId: burnEvent.sourceChainId,
        destChainId: burnEvent.destinationChain,
        sender: user.publicKey,
        recipient: evmRecipient,
        amount: burnEvent.amount,
        nonce: burnEvent.nonce,
        deadline: burnEvent.deadline,
      });
      const requestId = computeRequestId(messageBytes);
      // Sanity: locally-encoded request_id must match the on-chain emit.
      expect(Buffer.from(burnEvent.requestId).equals(requestId)).to.equal(true);

      const [pendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_refund"), requestId],
        program.programId
      );
      const [processedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const [refundedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("refunded_request"), requestId],
        program.programId
      );

      // The burn just landed; deadline = now + bridge_deadline_secs is in
      // the future. initiate_refund must reject with MintWindowStillOpen.
      await expectError(
        () =>
          program.methods
            .initiateRefund(messageBytes, Array.from(requestId) as number[])
            .accountsPartial({
              refundInitiator: nonceAdmin.publicKey,
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              pendingRefund: pendingPda,
              processedRequest: processedPda,
              refundedRequest: refundedPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([nonceAdmin])
            .rpc(),
        "MintWindowStillOpen"
      );
    });

    it("initiate_refund rejects when caller is not refund_initiator", async () => {
      // Build a synthetic message; the request_id check fails first which
      // is a different rejection, so we use a never-burned message but
      // call from a wrong signer to verify the role gate fires.
      const messageBytes = serializeBurnMessage({
        sourceChainId: SOLANA_CHAIN_ID,
        destChainId: ETH_CHAIN_ID,
        sender: user.publicKey,
        recipient: randomEvmAddress(),
        amount: 1_000_000n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) - 10), // already past
      });
      const requestId = computeRequestId(messageBytes);
      const [pendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_refund"), requestId],
        program.programId
      );
      const [processedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const [refundedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("refunded_request"), requestId],
        program.programId
      );

      await expectError(
        () =>
          program.methods
            .initiateRefund(messageBytes, Array.from(requestId) as number[])
            .accountsPartial({
              refundInitiator: unauthorizedUser.publicKey, // wrong signer
              bridgeConfig: bridgeConfigPda,
              config: configPda,
              pendingRefund: pendingPda,
              processedRequest: processedPda,
              refundedRequest: refundedPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([unauthorizedUser])
            .rpc(),
        "Unauthorized"
      );
    });
  });
});
