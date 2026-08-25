/**
 * Cross-Chain Bridging via Orchestrator + PSM (SVM side).
 *
 * Mirrors `EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts`.
 *
 * Design under test:
 *   - There is no on-chain bridge program on SVM.
 *   - The orchestrator holds the `direct_minter` and `direct_burner`
 *     roles on the lite-psm. Bridging uses `mint_oku_m_direct` /
 *     `burn_oku_m_direct` (raw OkuM tokens).
 *
 *   - To "bridge" okuM from chain A to chain B, the orchestrator:
 *       1. Pulls the user's okuM on A (SPL `transfer` from
 *          user -> orchestrator's okuM ATA — the user signs).
 *       2. Calls `burn_oku_m_direct` on chain A -> okuM is burned.
 *       3. Off-chain notification (no USDC hand-off needed).
 *       4. Calls `mint_oku_m_direct` on chain B -> okuM is minted
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
  mintOkuMViaProgram,
  DECIMALS,
} from "../shared/setup";
import { clearSyncWindow } from "../shared/multiplier";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpSlots,
  readMultiplierFromMint,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9

describe("cross-chain bridging via orchestrator + PSM (SVM)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;

  let psmConfigPda: PublicKey;
  let vaultUsdcAta: PublicKey;

  // Alice = sender on "chain A"
  let aliceUsdcAta: PublicKey;
  let aliceOkuMAta: PublicKey;
  // Bob = recipient on "chain B"
  let bobOkuMAta: PublicKey;
  // Orchestrator ATAs
  let orchestratorUsdcAta: PublicKey;
  let orchestratorOkuMAta: PublicKey;

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
    okuMMint = psmSetup.okuMMint;
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
    aliceOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      alice.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, alice.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

    bobOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      bob.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, bob.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    orchestratorOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      orchestrator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      okuMMint,
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
  // Test 1 — okuM bridging via direct burn/mint
  // ---------------------------------------------------------------------

  it("orchestrator-mediated bridge: Alice okuM on A -> Bob okuM on B (direct burn/mint)", async () => {
    // Step 0: Alice mints okuM via public PSM on chain A (1000 USDC -> ~1000 okuM).
    const mintUsdc = new BN(1_000_000_000); // 1000 USDC
    await mintOkuMViaProgram(
      psm as any,
      alice,
      mintUsdc,
      psmConfigPda,
      usdcMint,
      okuMMint,
      aliceUsdcAta,
      aliceOkuMAta,
      vaultUsdcAta
    );
    const aliceOkuMBefore = await ataAmount(aliceOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceOkuMBefore)).to.be.greaterThan(0);

    // Snapshot pre-bridge state.
    const bobOkuMStart = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);

    // ===== Step 1: Alice transfers her OkuM to the orchestrator's ATA =====
    const bridgeAmount = new BN(Number(aliceOkuMBefore));

    const transferIx = createTransferCheckedInstruction(
      aliceOkuMAta,
      okuMMint,
      orchestratorOkuMAta,
      alice.publicKey,
      BigInt(bridgeAmount.toString()),
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await provider.sendAndConfirm!(new Transaction().add(transferIx), [alice]);

    const aliceOkuMAfterTransfer = await ataAmount(aliceOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceOkuMAfterTransfer)).to.equal(0);

    // ===== Step 2: Orchestrator burns okuM on chain A =====
    await psm.methods
      .burnOkuMDirect(bridgeAmount)
      .accountsPartial({
        directBurner: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        burnerOkuMAta: orchestratorOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // Orchestrator's okuM balance should be 0 after burn
    const orchOkuMAfterBurn = await ataAmount(orchestratorOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchOkuMAfterBurn)).to.equal(0);

    // ===== Step 3: Off-chain notification (no USDC hand-off needed) =====
    // With direct burn/mint, no USDC flows through the bridge.

    // ===== Step 4: Orchestrator mints okuM to Bob on chain B =====
    await psm.methods
      .mintOkuMDirect(bridgeAmount)
      .accountsPartial({
        directMinter: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        recipient: bob.publicKey,
        recipientOkuMAta: bobOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const bobOkuMEnd = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = bobOkuMEnd - bobOkuMStart;

    // ===== Invariants =====
    // I1: Raw amount burned == raw amount minted (1:1 conservation).
    expect(bobReceived.toString()).to.equal(bridgeAmount.toString());

    // I2: Orchestrator holds no leftover okuM.
    const orchOkuMFinal = await ataAmount(orchestratorOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchOkuMFinal)).to.equal(0);

    // I3: Alice's tokens are fully consumed.
    expect(Number(aliceOkuMAfterTransfer)).to.equal(0);
  });

  // ---------------------------------------------------------------------
  // Test 2 — okuM bridging across a multiplier tick
  // ---------------------------------------------------------------------

  it("bridge legs are BLOCKED mid-tick, and conserve raw 1:1 once the window lifts", async () => {
    // This test previously asserted only that raw is conserved across a tick.
    // That is still true, but it is no longer the interesting property: the
    // legs are now refused outright while a tick is propagating.
    //
    // WHY. Neither leg prices through the multiplier on its own — each moves a
    // caller-supplied raw amount, and the multiplier read inside feeds only the
    // event. But the PAIR does price, across chains: burning 100 raw where
    // M=1.04 destroys $104 of claim while minting 100 raw where M=1.05 creates
    // $105, conjuring a dollar out of a mid-tick divergence. "Raw-conserving"
    // is a per-instruction property that does not survive the round trip, so
    // the gating rule is "can this move value across a multiplier boundary".
    // Fund Alice with fresh okuM.
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintOkuMViaProgram(
      psm as any,
      alice,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMMint,
      aliceUsdcAta,
      aliceOkuMAta,
      vaultUsdcAta
    );

    const aliceOkuM = await ataAmount(aliceOkuMAta, TOKEN_2022_PROGRAM_ID);
    const bobStart = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);

    // Snapshot starting multiplier from the mint extension.
    const multiplier0 = await readMultiplierFromMint(h, okuMMint);

    // Alice -> orchestrator (pull).
    const bridgeAmount = new BN(Number(aliceOkuM));
    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          aliceOkuMAta,
          okuMMint,
          orchestratorOkuMAta,
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
      .burnOkuMDirect(bridgeAmount)
      .accountsPartial({
        directBurner: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        burnerOkuMAta: orchestratorOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // ===== Multiplier tick BETWEEN the legs =====
    // A rebase lands while the orchestrator is in flight. Step by 0.99%, just
    // inside what the configured `tout` covers.
    const multiplier1 = multiplier0.add(multiplier0.muln(99).divn(10_000));
    await psm.methods
      .setMultiplier(multiplier1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    await warpSlots(h, 1);

    // The write auto-armed the sync window. The destination leg must now be
    // REFUSED — completing it here is exactly the value-conjuring round trip.
    await expectBankrunError(
      () =>
        psm.methods
          .mintOkuMDirect(bridgeAmount)
          .accountsPartial({
            directMinter: orchestrator.publicKey,
            config: psmConfigPda,
            okuMMint,
            recipient: bob.publicKey,
            recipientOkuMAta: bobOkuMAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([orchestrator])
          .rpc(),
      "SyncWindowActive"
    );

    // Once the tick has propagated and the window lifts, the leg completes and
    // raw is conserved 1:1 as before.
    await clearSyncWindow(h, psm as any, psmConfigPda);

    // Mint on "chain B" — same raw amount, regardless of multiplier.
    await psm.methods
      .mintOkuMDirect(bridgeAmount)
      .accountsPartial({
        directMinter: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        recipient: bob.publicKey,
        recipientOkuMAta: bobOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const bobEnd = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = new BN((bobEnd - bobStart).toString());

    // Raw amounts are conserved 1:1 regardless of multiplier changes.
    // The ScaledUiAmount extension adjusts the display value automatically.
    expect(bobReceived.toString()).to.equal(bridgeAmount.toString());

    // Orchestrator holds no leftover.
    const orchFinal = await ataAmount(orchestratorOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchFinal)).to.equal(0);
  });

  // ---------------------------------------------------------------------
  // Test 3 — Authority boundary: random key cannot mint okuM directly
  // ---------------------------------------------------------------------

  it("a non-orchestrator key cannot mint okuM directly (PSM public mint is permissionless)", async () => {
    // Bob — random key with USDC — tries to call mint_oku_m directly
    // against his own ATA. mint_oku_m is permissionless, so this should
    // SUCCEED for him, but the result must not differ from any other
    // user's mint. The point of this test is to assert that the
    // orchestrator's privileges are bounded: it has no special public
    // mint authority; any other USDC-holding key can mint identically.
    const bobUsdcAta = await ensureAtaViaBankrun(h, bob.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, bobUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);

    const bobOkuMBefore = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);
    await psm.methods
      .mintOkuM(new BN(100_000_000))
      .accountsPartial({
        user: bob.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta: bobUsdcAta,
        userOkuMAta: bobOkuMAta,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();
    const bobOkuMAfter = await ataAmount(bobOkuMAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(bobOkuMAfter) - Number(bobOkuMBefore)).to.be.greaterThan(0);

    // The orchestrator role-set (buffer_depositor /
    // rebaser / direct_minter / direct_burner) does NOT grant a public
    // mint privilege — confirm by inspecting PsmConfig. Bob can mint
    // because `mint_oku_m` is permissionless; the PSM PDA signs the
    // inner CPI to Token-2022's `mint_to`.
    const cfg = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(cfg.bufferDepositor.toString()).to.equal(orchestrator.publicKey.toString());
    expect(cfg.rebaser.toString()).to.equal(orchestrator.publicKey.toString());
  });
});
