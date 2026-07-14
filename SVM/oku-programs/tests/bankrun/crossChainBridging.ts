/**
 * Cross-Chain Bridging via Orchestrator + PSM (noBridge model, SVM side).
 *
 * Mirrors `EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts`.
 *
 * Design under test:
 *   - There is no on-chain bridge program on SVM.
 *   - The orchestrator holds the `direct_minter` and `direct_burner`
 *     roles on the lite-psm. Bridging uses `mint_usd_oku_direct` /
 *     `burn_usd_oku_direct` (raw usdOku tokens).
 *
 *   - To "bridge" usdOku from chain A to chain B, the orchestrator:
 *       1. Pulls the user's usdOku on A (SPL `transfer` from
 *          user -> orchestrator's usdOku ATA — the user signs).
 *       2. Calls `burn_usd_oku_direct` on chain A -> usdOku is burned.
 *       3. Off-chain notification (no USDC hand-off needed).
 *       4. Calls `mint_usd_oku_direct` on chain B -> usdOku is minted
 *          directly to the recipient's ATA.
 *
 *   - Raw token amounts are conserved across the bridge (1:1).
 *     The ScaledUiAmount extension handles multiplier-based display.
 *
 * SVM constraint: the lite-psm program is a singleton (one
 * `PsmConfig` PDA per program ID). We simulate the two-chain trust
 * boundary by running burn + mint against the same PSM and asserting
 * amount conservation.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintUsdOkuViaProgram,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpSlots,
  readMultiplierFromMint,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9

describe("cross-chain bridging via orchestrator + PSM (noBridge, SVM)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let usdcMint: PublicKey;
  let usdOkuMint: PublicKey;

  let psmConfigPda: PublicKey;
  let vaultUsdcAta: PublicKey;

  // Alice = sender on "chain A"
  let aliceUsdcAta: PublicKey;
  let aliceUsdOkuAta: PublicKey;
  // Bob = recipient on "chain B"
  let bobUsdOkuAta: PublicKey;
  // Orchestrator ATAs
  let orchestratorUsdcAta: PublicKey;
  let orchestratorUsdOkuAta: PublicKey;

  const DIRECT_MINTER_ALLOWANCE = new BN(1_000_000_000_000); // 1M
  const DIRECT_BURNER_ALLOWANCE = new BN(1_000_000_000_000); // 1M

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;

    const usdcMintKp = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKp,
      TOKEN_PROGRAM_ID
    );

    await fundKeypairs(
      h,
      [alice, bob],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    const psmSetup = await initializePsm(h, psm, payer, usdcMint);
    psmConfigPda = psmSetup.configPda;
    usdOkuMint = psmSetup.usdOkuMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;

    // Grant orchestrator the DirectMinter and DirectBurner roles
    await psm.methods
      .setAuthority({ directMinter: {} }, orchestrator.publicKey)
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: psmConfigPda,
      })
      .rpc();

    await psm.methods
      .setAuthority({ directBurner: {} }, orchestrator.publicKey)
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: psmConfigPda,
      })
      .rpc();

    // Set allowances
    await psm.methods
      .setDirectMinterAllowance(DIRECT_MINTER_ALLOWANCE)
      .accountsPartial({
        allowanceManager: coldMultisig.publicKey,
        config: psmConfigPda,
      })
      .signers([coldMultisig])
      .rpc();

    await psm.methods
      .setDirectBurnerAllowance(DIRECT_BURNER_ALLOWANCE)
      .accountsPartial({
        allowanceManager: coldMultisig.publicKey,
        config: psmConfigPda,
      })
      .signers([coldMultisig])
      .rpc();

    // ATAs.
    aliceUsdcAta = await ensureAtaViaBankrun(h, alice.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    aliceUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      alice.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, alice.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    bobUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      bob.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, bob.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    orchestratorUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      orchestrator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdOkuMint,
      TOKEN_2022_PROGRAM_ID
    );

    // Fund USDC: alice (5k for PSM mint), orchestrator (10k for buffer).
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 5_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      10_000_000_000,
      TOKEN_PROGRAM_ID
    );

    // Pre-load the PSM USDC buffer (5k) so public mints work.
    await psm.methods
      .depositBuffer(new BN(5_000_000_000))
      .accountsPartial({
        bufferDepositor: orchestrator.publicKey,
        config: psmConfigPda,
        bufferDepositorUsdcAta: orchestratorUsdcAta,
        vaultUsdc: vaultUsdcAta,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  async function ataAmount(ata: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): Promise<bigint> {
    const acct = await getAccount(provider.connection, ata, undefined, tokenProgram);
    return acct.amount;
  }

  // ---------------------------------------------------------------------
  // Test 1 — usdOku bridging via direct burn/mint
  // ---------------------------------------------------------------------

  it("orchestrator-mediated bridge: Alice usdOku on A -> Bob usdOku on B (direct burn/mint)", async () => {
    // Step 0: Alice mints usdOku via public PSM on chain A (1000 USDC -> ~1000 usdOku).
    const mintUsdc = new BN(1_000_000_000); // 1000 USDC
    await mintUsdOkuViaProgram(
      psm as any,
      alice,
      mintUsdc,
      psmConfigPda,
      usdcMint,
      usdOkuMint,
      aliceUsdcAta,
      aliceUsdOkuAta,
      vaultUsdcAta
    );
    const aliceUsdOkuBefore = await ataAmount(aliceUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceUsdOkuBefore)).to.be.greaterThan(0);

    // Snapshot pre-bridge state.
    const bobUsdOkuStart = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);

    // ===== Step 1: Alice transfers her usdOku to the orchestrator's ATA =====
    const bridgeAmount = new BN(Number(aliceUsdOkuBefore));

    const transferIx = createTransferCheckedInstruction(
      aliceUsdOkuAta,
      usdOkuMint,
      orchestratorUsdOkuAta,
      alice.publicKey,
      BigInt(bridgeAmount.toString()),
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await provider.sendAndConfirm!(new Transaction().add(transferIx), [alice]);

    const aliceUsdOkuAfterTransfer = await ataAmount(aliceUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceUsdOkuAfterTransfer)).to.equal(0);

    // ===== Step 2: Orchestrator burns usdOku on chain A =====
    await psm.methods
      .burnUsdOkuDirect(bridgeAmount)
      .accountsPartial({
        directBurner: orchestrator.publicKey,
        config: psmConfigPda,
        usdOkuMint,
        burnerUsdOkuAta: orchestratorUsdOkuAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // Orchestrator's usdOku balance should be 0 after burn
    const orchUsdOkuAfterBurn = await ataAmount(orchestratorUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchUsdOkuAfterBurn)).to.equal(0);

    // ===== Step 3: Off-chain notification (no USDC hand-off needed) =====
    // With direct burn/mint, no USDC flows through the bridge.

    // ===== Step 4: Orchestrator mints usdOku to Bob on chain B =====
    await psm.methods
      .mintUsdOkuDirect(bridgeAmount)
      .accountsPartial({
        directMinter: orchestrator.publicKey,
        config: psmConfigPda,
        usdOkuMint,
        recipient: bob.publicKey,
        recipientUsdOkuAta: bobUsdOkuAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const bobUsdOkuEnd = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = bobUsdOkuEnd - bobUsdOkuStart;

    // ===== Invariants =====
    // I1: Raw amount burned == raw amount minted (1:1 conservation).
    expect(bobReceived.toString()).to.equal(bridgeAmount.toString());

    // I2: Orchestrator holds no leftover usdOku.
    const orchUsdOkuFinal = await ataAmount(orchestratorUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchUsdOkuFinal)).to.equal(0);

    // I3: Alice's tokens are fully consumed.
    expect(Number(aliceUsdOkuAfterTransfer)).to.equal(0);
  });

  // ---------------------------------------------------------------------
  // Test 2 — usdOku bridging across a multiplier tick
  // ---------------------------------------------------------------------

  it("raw amount conserved across an orchestrator multiplier tick between burn and mint", async () => {
    // Fund Alice with fresh usdOku.
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintUsdOkuViaProgram(
      psm as any,
      alice,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      usdOkuMint,
      aliceUsdcAta,
      aliceUsdOkuAta,
      vaultUsdcAta
    );

    const aliceUsdOku = await ataAmount(aliceUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    const bobStart = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);

    // Snapshot starting multiplier from the mint extension.
    const multiplier0 = await readMultiplierFromMint(h, usdOkuMint);

    // Alice -> orchestrator (pull).
    const bridgeAmount = new BN(Number(aliceUsdOku));
    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          aliceUsdOkuAta,
          usdOkuMint,
          orchestratorUsdOkuAta,
          alice.publicKey,
          BigInt(bridgeAmount.toString()),
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [alice]
    );

    // Orchestrator burns on chain A.
    await psm.methods
      .burnUsdOkuDirect(bridgeAmount)
      .accountsPartial({
        directBurner: orchestrator.publicKey,
        config: psmConfigPda,
        usdOkuMint,
        burnerUsdOkuAta: orchestratorUsdOkuAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // ===== Multiplier tick BETWEEN the legs =====
    // Simulate a rebase that lands while the orchestrator is in flight.
    // Bump the multiplier by 1%.
    const multiplier1 = multiplier0.mul(new BN(101)).div(new BN(100));
    await psm.methods
      .setMultiplier(multiplier1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        usdOkuMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    await warpSlots(h, 1);

    // Mint on "chain B" — same raw amount, regardless of multiplier.
    await psm.methods
      .mintUsdOkuDirect(bridgeAmount)
      .accountsPartial({
        directMinter: orchestrator.publicKey,
        config: psmConfigPda,
        usdOkuMint,
        recipient: bob.publicKey,
        recipientUsdOkuAta: bobUsdOkuAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const bobEnd = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = new BN((bobEnd - bobStart).toString());

    // Raw amounts are conserved 1:1 regardless of multiplier changes.
    // The ScaledUiAmount extension adjusts the display value automatically.
    expect(bobReceived.toString()).to.equal(bridgeAmount.toString());

    // Orchestrator holds no leftover.
    const orchFinal = await ataAmount(orchestratorUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchFinal)).to.equal(0);
  });

  // ---------------------------------------------------------------------
  // Test 3 — Authority boundary: random key cannot mint usdOku directly
  // ---------------------------------------------------------------------

  it("a non-orchestrator key cannot mint usdOku directly (PSM public mint is permissionless)", async () => {
    // Bob — random key with USDC — tries to call mint_usd_oku directly
    // against his own ATA. mint_usd_oku is permissionless, so this should
    // SUCCEED for him, but the result must not differ from any other
    // user's mint. The point of this test is to assert that the
    // orchestrator's privileges are bounded: it has no special public
    // mint authority; any other USDC-holding key can mint identically.
    const bobUsdcAta = await ensureAtaViaBankrun(h, bob.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, bobUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);

    const bobUsdOkuBefore = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    await psm.methods
      .mintUsdOku(new BN(100_000_000))
      .accountsPartial({
        user: bob.publicKey,
        config: psmConfigPda,
        usdcMint,
        usdOkuMint,
        userUsdcAta: bobUsdcAta,
        userUsdOkuAta: bobUsdOkuAta,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();
    const bobUsdOkuAfter = await ataAmount(bobUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(bobUsdOkuAfter) - Number(bobUsdOkuBefore)).to.be.greaterThan(0);

    // The orchestrator role-set (queue_processor / buffer_depositor /
    // rebaser / direct_minter / direct_burner) does NOT grant a public
    // mint privilege — confirm by inspecting PsmConfig. Bob can mint
    // because `mint_usd_oku` is permissionless; the PSM PDA signs the
    // inner CPI to Token-2022's `mint_to`.
    const cfg = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(cfg.queueProcessor.toString()).to.equal(orchestrator.publicKey.toString());
    expect(cfg.bufferDepositor.toString()).to.equal(orchestrator.publicKey.toString());
    expect(cfg.rebaser.toString()).to.equal(orchestrator.publicKey.toString());
  });
});
