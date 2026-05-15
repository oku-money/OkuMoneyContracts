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
} from "@solana/spl-token";
import {
  findBridgeBurnEventInLogs,
  serializeBurnMessage,
  computeRequestId,
} from "../../scripts/lib/bridge";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  bridgeOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintOkuMoneyViaProgram,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  createOkuMoneyMintViaBankrun,
  mintToViaBankrun,
  warpBy,
} from "../shared/bankrun";
import {
  BridgeTestContext,
  bridgeBurnAndGetLogs as bridgeBurnAndGetLogsFn,
  calculateRequestId,
  createBridgeMintTx as createBridgeMintTxFn,
  expectBridgeMintProgramError as expectBridgeMintProgramErrorFn,
  expectError,
  randomEvmAddress,
  serializeBridgeMintMessage as serializeBridgeMessage,
  signMessage,
} from "../shared/bridge-helpers";

// Use anchor's web3 types
const { SYSVAR_RENT_PUBKEY } = anchor.web3;

/**
 * Phase 9: this file used to be `tests/unit/bridge_security.ts` and ran
 * against `solana-test-validator` via `anchor test`. The 9 bridge_mint
 * tests were gated behind `RUN_HEAVY_BRIDGE_TESTS=1` because they
 * routinely exceeded `@solana/web3.js`'s 30 s confirmation polling
 * window. Bankrun runs them in-process with no confirmation loop, so
 * the gate is gone and every test runs on every CI invocation.
 *
 * The previous file also monkey-patched `provider.sendAndConfirm` for
 * blockhash-based confirmation (lines 407–468 in the old file). That
 * patch is gone too; bankrun's `BankrunProvider.sendAndConfirm` is
 * already synchronous and returns the real on-chain error.
 */

describe("Bridge Security Tests", () => {
  // Chain IDs are OkuMoney protocol-internal u16 identifiers (NOT EIP-155
  // values). The values appear in `BridgeRequest.{source,destination}_chain_id`
  // and `BridgeConfig.supported_chains`. See SVM/EVM_VS_SVM.md for the
  // mapping and the look-alike-EIP-155 caveat noted in TRACKER.md.
  const SOLANA_CHAIN_ID = 103; // Solana Devnet protocol ID
  const ETH_CHAIN_ID = 1;
  const BSC_CHAIN_ID = 56;
  const ONE_TOKEN = 1_000_000; // 6 decimals
  const TEN_TOKENS = 10_000_000;
  const ONE_MILLION_TOKENS = 1_000_000_000_000;

  // Bankrun harness, provider and program
  let h: BankrunHarness;
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
  // Local wrappers around tests/shared/bridge-helpers.ts
  // ============================================================================
  //
  // The pure helpers (`signMessage`, `calculateRequestId`, `randomEvmAddress`,
  // `serializeBridgeMessage`) and the assertion helpers (`expectError`,
  // `expectBridgeMintProgramError`) are imported directly above.
  //
  // The context-bearing helpers below bind `bridgeCtx` so call sites
  // stay terse. `bridgeCtx` is populated inside `before()` once the
  // PSM/bridge PDAs are known.
  let bridgeCtx: BridgeTestContext;

  async function createBridgeMintTx(params: {
    program: Program<LitePsm>;
    message: Buffer;
    signature: Uint8Array;
    orchestrator: Keypair;
    recipientWallet: PublicKey;
    payer: Keypair;
    requestId: Uint8Array;
  }): Promise<Transaction> {
    return createBridgeMintTxFn(bridgeCtx, params);
  }

  async function bridgeBurnAndGetLogs(
    burnAmount: BN,
    evmRecipient: Uint8Array,
    destChain: number
  ): Promise<string[]> {
    return bridgeBurnAndGetLogsFn(bridgeCtx, {
      user,
      payer,
      userOkuMoneyAta,
      feeRecipientAta,
      burnAmount,
      evmRecipient,
      destChain,
    });
  }

  async function expectBridgeMintProgramError(
    tx: Transaction,
    signers: Keypair[],
    expectedCode: string
  ): Promise<void> {
    return expectBridgeMintProgramErrorFn(bridgeCtx, tx, signers, expectedCode);
  }

  // ============================================================================
  // Setup & Initialization
  // ============================================================================

  before(async () => {
    // Boot bankrun and pull the typed harness pieces we need. The harness's
    // `program` is loaded directly from the IDL and bound to bankrun's provider.
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    program = h.program;
    payer = h.payer;
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

    // Bankrun's payer is pre-funded; everything else gets force-credited
    // via `setAccount` in `fundKeypairs`.
    await fundKeypairs(
      h,
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

    // Create USDC mint (standard SPL) via the bankrun-aware helper.
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    // Create OkuMoney mint (Token-2022 with Interest-Bearing extension)
    // with mint/freeze authority set to the PSM config PDA.
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h,
      configPda, // mint authority = PSM config PDA
      configPda, // freeze authority = PSM config PDA
      DECIMALS,
      psmOrchestrator.publicKey, // rate authority
      0, // initial rate
      okuMoneyMintKeypair
    );

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
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          userUsdcAta,
          user.publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID
        )
      )
    );

    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          orchestratorUsdcAta,
          psmOrchestrator.publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID
        )
      )
    );

    // Mint USDC to users via the bankrun-aware helper.
    await mintToViaBankrun(
      h,
      usdcMint,
      userUsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      TOKEN_PROGRAM_ID
    );
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM.
    const psmSetup = await initializePsm(h, program, payer, usdcMint, okuMoneyMint);
    configPda = psmSetup.configPda;
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;

    // Bind the shared bridge-helpers context now that the PDA pubkeys
    // are known. All the in-file `createBridgeMintTx` / `bridgeBurn...`
    // wrappers below resolve through this context.
    bridgeCtx = {
      h,
      program,
      configPda,
      bridgeConfigPda,
      okuMoneyMint,
    };

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
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          feeRecipientAta,
          feeRecipient.publicKey,
          okuMoneyMint,
          TOKEN_2022_PROGRAM_ID
        )
      )
    );

    // Create user OkuMoney ATAs (for bridge mint recipients)
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          userOkuMoneyAta,
          user.publicKey,
          okuMoneyMint,
          TOKEN_2022_PROGRAM_ID
        )
      )
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          user2OkuMoneyAta,
          user2.publicKey,
          okuMoneyMint,
          TOKEN_2022_PROGRAM_ID
        )
      )
    );

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
      )
    );
    await mintToViaBankrun(
      h,
      usdcMint,
      user2UsdcAta,
      payer,
      SEED_USDC_AMOUNT,
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

    // NOTE: this test cannot run in any in-process Solana SVM available to us
    // today. Bankrun, Surfpool, and direct litesvm 1.x all share the same
    // backend, and litesvm's `LiteSVM::with_precompiles` toggle (added in
    // 0.4.0) is OFF by default and not exposed by `solana-bankrun@0.4.0`
    // or surfpool 1.1.2. The precompile is therefore a no-op, the curve25519
    // sig math is never checked, and our program's `verify_ed25519_signature`
    // — which only byte-compares the precompile ix data against the bytes
    // we built — accepts the (bad-but-consistent) bytes and proceeds to
    // mint.
    //
    // This is the canonical Solana pattern: programs trust the precompile
    // to have validated the math (re-implementing curve25519 in BPF would
    // burn ~200K CU per call). On a real validator the precompile rejects
    // before our program runs.
    //
    // Coverage: `scripts/test/test-devnet.ts` has the
    // `bridgeMintInvalidSig` step which runs against real devnet (or
    // localnet's `solana-test-validator`) where the precompile DOES
    // execute. See `SVM/TRACKER.md` § "Bankrun coverage gaps".
    it.skip("rejects invalid signature (in-process SVM lacks precompile enforcement)", async () => {
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

      await expectError(
        () => provider.sendAndConfirm(tx, [payer], { skipPreflight: true }),
        "failed"
      );
    });

    it("rejects expired signature (past deadline)", async () => {
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

    it("prevents duplicate request_id on second mint", async () => {
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

      // Sanity check: the ProcessedRequest PDA must exist on-chain after tx1
      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), Buffer.from(requestId)],
        program.programId
      );
      const pdaInfo = await h.context.banksClient.getAccount(processedRequestPda);
      expect(pdaInfo, "ProcessedRequest PDA must exist after first mint").to.not.be.null;

      // Second mint with same request_id must fail — the ProcessedRequest PDA
      // already exists from tx1, so Anchor's `init` constraint trips. The
      // System Program's CreateAccount returns "already in use" in tx logs.
      // Auto-bump-slot in the harness guarantees the next tx gets a fresh
      // blockhash, so no manual `warpSlots` dance is required.

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

    it("paused bridge blocks bridge_mint", async () => {
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

      // bankrun doesn't expose WebSocket-based `addEventListener`. Instead,
      // we fetch the BridgeBurnEvent synchronously from the tx logs.
      const logs = await bridgeBurnAndGetLogs(
        new BN(1_000_000),
        randomEvmAddress(),
        ETH_CHAIN_ID
      );
      const event = findBridgeBurnEventInLogs(logs, program.idl as any);
      // Event deadline should be ~bankrun_clock_now + customDeadlineSecs.
      // Read the clock from bankrun rather than wall clock — bankrun's clock
      // doesn't track Date.now().
      const clock = await h.context.banksClient.getClock();
      const now = Number(clock.unixTimestamp);
      const eventDeadline = Number(event.deadline);
      expect(eventDeadline).to.be.greaterThanOrEqual(now + customDeadlineSecs - 5);
      expect(eventDeadline).to.be.lessThanOrEqual(now + customDeadlineSecs + 5);

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
  // Phase 10 — Bridge fee edge cases (fee=0 vs fee>0)
  // ==========================================================================
  describe("bridge_burn fee edge cases", () => {
    it("fee=0: burns exactly the input amount and skips fee-recipient mint", async () => {
      // Rotate the bridge fee to 0 bps.
      await program.methods
        .updateBridgeFee(0)
        .accountsPartial({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();

      // Capture balances before.
      const userBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const feeBefore = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const burnAmount = new BN(3_000_000);
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );
      await program.methods
        .bridgeBurn(burnAmount, Array.from(randomEvmAddress()), ETH_CHAIN_ID)
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint,
          userOkuMoneyAta,
          feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // User must have decreased by exactly burnAmount; fee recipient unchanged.
      const userAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const feeAfter = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect((BigInt(userBefore.amount) - BigInt(userAfter.amount)).toString()).to.equal(
        burnAmount.toString()
      );
      expect(BigInt(feeAfter.amount)).to.equal(BigInt(feeBefore.amount));

      // Restore the default 10 bps so subsequent tests behave normally.
      await program.methods
        .updateBridgeFee(10)
        .accountsPartial({
          feeManager: feeManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([feeManager])
        .rpc();
    });

    it("fee>0: burns full input, mints fee=amount*bps/10000 to fee_recipient", async () => {
      // The bridge_fee_bps was restored to 10 above; verify and capture.
      const cfg = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      const feeBps = cfg.bridgeFeeBps as number;
      expect(feeBps).to.equal(10);

      const userBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const feeBefore = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const burnAmount = new BN(5_000_000);
      const expectedFee = burnAmount.muln(feeBps).divn(10_000);
      const [noncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID, 0])],
        program.programId
      );
      await program.methods
        .bridgeBurn(burnAmount, Array.from(randomEvmAddress()), ETH_CHAIN_ID)
        .accountsPartial({
          user: user.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          bridgeNonce: noncePda,
          okuMoneyMint,
          userOkuMoneyAta,
          feeRecipientAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const feeAfter = await getAccount(
        provider.connection,
        feeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect((BigInt(userBefore.amount) - BigInt(userAfter.amount)).toString()).to.equal(
        burnAmount.toString()
      );
      expect((BigInt(feeAfter.amount) - BigInt(feeBefore.amount)).toString()).to.equal(
        expectedFee.toString()
      );
    });
  });

  // ==========================================================================
  // Phase 10 — Wrong-direction bridge format rejects
  //
  // The 80-byte bridge message has different sender/recipient widths per
  // direction:
  //   EVM-burn -> SVM-mint:   sender = 20 bytes (EVM), recipient = 32 bytes (Solana)
  //   SVM-burn -> EVM-mint:   sender = 32 bytes (Solana), recipient = 20 bytes (EVM)
  //
  // `bridge_mint` parses the EVM-burn shape. If a caller submits an SVM-burn-
  // formatted message (sender 32 bytes, recipient 20 bytes), the program's
  // keccak hash of the message bytes still matches the supplied request_id
  // (since we hash whatever bytes are given), so the request_id check passes,
  // but the *decoded* sender pubkey collides with what was supposed to be
  // sender+recipient_prefix bytes — the resulting recipient ATA derivation
  // points at a different account, which fails the constraint.
  // ==========================================================================
  describe("wrong-direction bridge format rejects", () => {
    it("bridge_mint rejects an SVM-burn-formatted message", async () => {
      // Build a message in the SVM-burn shape: source=SOL, dest=ETH,
      // sender = 32-byte Solana pubkey, recipient = 20-byte EVM address.
      const wrongDirectionMessage = Buffer.alloc(80);
      wrongDirectionMessage.writeUInt16LE(SOLANA_CHAIN_ID, 0);
      wrongDirectionMessage.writeUInt16LE(ETH_CHAIN_ID, 2);
      user.publicKey.toBuffer().copy(wrongDirectionMessage, 4); // 32-byte sender
      const evmRecipient = randomEvmAddress();
      Buffer.from(evmRecipient).copy(wrongDirectionMessage, 36); // 20-byte recipient
      wrongDirectionMessage.writeBigUInt64LE(1_000_000n, 56);
      wrongDirectionMessage.writeBigUInt64LE(999n, 64);
      wrongDirectionMessage.writeBigInt64LE(
        BigInt(Math.floor(Date.now() / 1000) + 3600),
        72
      );

      // Sign with the real orchestrator.
      const signature = signMessage(wrongDirectionMessage, orchestrator);
      const requestId = calculateRequestId(wrongDirectionMessage);

      // The decoded recipient_wallet (bytes 24..56 of the EVM-burn layout) is
      // garbage from the test's perspective — it's the last 12 bytes of the
      // Solana sender pubkey + the first 20 bytes of the EVM recipient. Derive
      // the ATA the program WILL try to use:
      const decodedRecipientBytes = wrongDirectionMessage.subarray(24, 56);
      const decodedRecipient = new PublicKey(decodedRecipientBytes);
      const decodedAta = getAssociatedTokenAddressSync(
        okuMoneyMint,
        decodedRecipient,
        true,
        TOKEN_2022_PROGRAM_ID
      );

      const [processedRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_request"), requestId],
        program.programId
      );
      const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: orchestrator.publicKey.toBytes(),
        message: new Uint8Array(wrongDirectionMessage),
        signature,
      });
      const bridgeMintIx = await program.methods
        .bridgeMint(
          wrongDirectionMessage,
          Buffer.from(signature),
          Array.from(requestId)
        )
        .accountsPartial({
          payer: payer.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          processedRequest: processedRequestPda,
          okuMoneyMint,
          // Pass the user's ATA — the program will derive its own from the
          // decoded recipient and the mismatch will trip the seeds check.
          recipientOkuMoneyAta: userOkuMoneyAta,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ed25519Ix).add(bridgeMintIx);

      // The program's `bridge_mint` first decodes the message and checks
      // `dest_chain_id == bridge_config.source_chain_id`. In an SVM-burn-
      // shaped message, the first u16 is SOLANA_CHAIN_ID — which IS the
      // destination of an EVM-burn — so it matches; but the program then
      // checks that `source_chain_id` (second u16) is a supported chain
      // OTHER than the destination, which rejects with
      // `WrongDestinationChain` / `SameChainBridge`. Either error is
      // acceptable evidence that the wrong-direction payload was caught
      // before any mint took effect.
      await expectBridgeMintProgramError(tx, [payer], "WrongDestinationChain");
      // Mark the unused-variable lint happy.
      expect(decodedAta.toBase58().length).to.be.greaterThan(0);
    });
  });

  // ==========================================================================
  // Phase 10 — Orchestrator-rotation invalidates in-flight signed messages
  // ==========================================================================
  describe("orchestrator rotation invalidates in-flight messages", () => {
    it("a message signed by the old orchestrator is rejected after rotation", async () => {
      // 1. Build & sign a fresh bridge-mint message with the CURRENT orchestrator.
      const amount = 1_000_000n;
      const nonce = 9_999n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const evmSender = randomEvmAddress();
      const message = serializeBridgeMessage({
        sourceChainId: ETH_CHAIN_ID,
        destinationChainId: SOLANA_CHAIN_ID,
        sender: evmSender,
        recipientWallet: user.publicKey,
        amount,
        nonce,
        deadline,
      });
      const oldOrchestratorSig = signMessage(message, orchestrator);
      const requestId = calculateRequestId(message);

      // 2. Rotate orchestrator_signer to a NEW keypair via update_orchestrator_signer.
      const newOrchestrator = Keypair.generate();
      await program.methods
        .updateOrchestratorSigner(newOrchestrator.publicKey)
        .accountsPartial({
          signerManager: signerManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([signerManager])
        .rpc();

      // 3. Attempt to redeem the old-signed message — must reject. The
      // program's `verify_ed25519_signature` introspects the Ed25519
      // precompile instruction (now declaring the OLD pubkey) and compares
      // the recovered pubkey against `bridge_config.orchestrator_signer`
      // (the NEW pubkey). The check fails.
      const tx = await createBridgeMintTx({
        program,
        message,
        signature: oldOrchestratorSig,
        orchestrator, // OLD orchestrator — declared in the Ed25519 precompile ix
        recipientWallet: user.publicKey,
        payer,
        requestId,
      });
      await expectBridgeMintProgramError(tx, [payer], "InvalidSignature");

      // 4. Restore the original orchestrator so subsequent tests proceed.
      await program.methods
        .updateOrchestratorSigner(orchestrator.publicKey)
        .accountsPartial({
          signerManager: signerManager.publicKey,
          bridgeConfig: bridgeConfigPda,
        })
        .signers([signerManager])
        .rpc();
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
    it("initiate_refund rejects with MintWindowStillOpen when deadline not yet elapsed", async () => {
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
      // current bridge_deadline_secs default). Capture the meta directly
      // since BankrunProvider.rpc() discards it.
      const burnLogs = await bridgeBurnAndGetLogs(
        new BN(burnAmount.toString()),
        evmRecipient,
        destChain
      );

      // Read the actual emitted BridgeBurnEvent (the canonical source of
      // request_id, nonce, and deadline). Avoids the fragile recomputation
      // that previously bit Phase 5's bridge-burn script.
      const burnEvent = findBridgeBurnEventInLogs(burnLogs, program.idl as any);
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
        [Buffer.from("bridge_refund"), requestId],
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
        [Buffer.from("bridge_refund"), requestId],
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

  // ==========================================================================
  // Phase 9 — Happy-path refund flow (burn -> warpBy -> initiate -> confirm)
  //
  // Previously impossible on solana-test-validator because advancing the
  // cluster clock past `bridge_deadline_secs` would have required literally
  // sleeping for an hour. Trivial on bankrun via `warpBy`.
  // ==========================================================================
  describe("Refund flow (happy path, time-travelled)", () => {
    it("initiate_refund -> confirm_refund mints OkuMoney back to the user", async () => {
      const burnAmount = BigInt(3_000_000); // 3 tokens
      const destChain = ETH_CHAIN_ID;
      const evmRecipient = randomEvmAddress();

      // Top up user's OkuMoney balance via the lightweight PSM mint path.
      // (auto-bump-slot handles the `check_yield_lock` sandwich check.)
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

      // Burn — produces a BridgeBurnEvent whose deadline is now + 1h.
      const burnLogs = await bridgeBurnAndGetLogs(
        new BN(burnAmount.toString()),
        evmRecipient,
        destChain
      );
      const burnEvent = findBridgeBurnEventInLogs(burnLogs, program.idl as any);
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
        [Buffer.from("bridge_refund"), requestId],
        program.programId
      );

      // Record the user's OkuMoney balance after burn (should be lower).
      const balanceAfterBurn = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Now time-travel past the deadline. `bridge_deadline_secs` is 3600,
      // so warpBy(3601) puts us just past the deadline.
      await warpBy(h, 3601);

      // initiate_refund — must be called by the refund_initiator
      // (nonceAdmin per the bridge init in `before()`).
      await program.methods
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
        .rpc();

      // PendingRefund PDA must now exist.
      const pendingInfo = await h.context.banksClient.getAccount(pendingPda);
      expect(pendingInfo, "PendingRefund PDA must exist after initiate").to.not.be.null;

      // confirm_refund — must be called by refund_confirmer
      // (signerManager per the bridge init), and MUST be a different key
      // from the initiator (two-step refund safety check).
      await program.methods
        .confirmRefund(Array.from(requestId) as number[])
        .accountsPartial({
          refundConfirmer: signerManager.publicKey,
          bridgeConfig: bridgeConfigPda,
          config: configPda,
          pendingRefund: pendingPda,
          refundedRequest: refundedPda,
          okuMoneyMint,
          senderOkuMoneyAta: userOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([signerManager])
        .rpc();

      // PendingRefund PDA must now be closed.
      const pendingClosed = await h.context.banksClient.getAccount(pendingPda);
      expect(pendingClosed, "PendingRefund PDA must be closed after confirm").to.be.null;

      // RefundedRequest PDA must now exist.
      const refundedInfo = await h.context.banksClient.getAccount(refundedPda);
      expect(refundedInfo, "RefundedRequest PDA must exist after confirm").to.not.be.null;

      // User's OkuMoney balance must have increased by exactly `burnEvent.amount`
      // (net-of-fee burn amount; what the program re-mints on refund).
      const balanceAfterRefund = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const delta = BigInt(balanceAfterRefund.amount) - BigInt(balanceAfterBurn.amount);
      expect(delta).to.equal(burnEvent.amount);
    });
  });
});
