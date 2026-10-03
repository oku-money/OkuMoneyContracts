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
import { ratePerSecondForApy } from "@okumoney/yield-tooling";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMViaProgram,
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
  computeCanonicalMultiplier,
  warpBy,
  getClock,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;


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
      psm,
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

  it("raw amount conserved across an orchestrator multiplier tick between burn and mint", async () => {
    // Fund Alice with fresh okuM.
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintOkuMViaProgram(
      psm,
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

    // Snapshot the starting CANONICAL multiplier (computed from the rate
    // schedule, not read from the display mirror).
    const multiplier0 = await computeCanonicalMultiplier(h, psm, psmConfigPda);

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

    // ===== Multiplier ACCRUES between the legs =====
    // Under streaming accrual there is no "tick" to simulate: the multiplier
    // moves because time passes, with no transaction at all. That is what
    // makes this test stronger than its predecessor -- the bridge now has to
    // be correct across a continuously-moving multiplier rather than across a
    // single discrete jump the orchestrator controls.
    //
    // Publish a fast rate, then simply warp. Nothing is submitted in between.
    const nowTs = Number((await getClock(h)).unixTimestamp);
    await psm.methods
      .setOkumYieldRate(new BN(ratePerSecondForApy(2.0).toString()), new BN(nowTs + 30 * 86_400))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .signers([orchestrator])
      .rpc();
    await warpBy(h, 2 * 86_400);

    const multiplier1 = await computeCanonicalMultiplier(h, psm, psmConfigPda);
    expect(multiplier1 > multiplier0, "multiplier should have streamed upward").to.be.true;

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

  it("the public PSM mint is permissionless — a random key mints identically to the orchestrator", async () => {
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
    // Exact: 100 USDC at the live multiplier. `> 0` passed on a single unit.
    const mult = await computeCanonicalMultiplier(h, psm, psmConfigPda);
    const expected = (100_000_000n * 10n ** 18n) / mult;
    expect(
      (BigInt(bobOkuMAfter) - BigInt(bobOkuMBefore)).toString(),
      "an unprivileged key mints the same amount anyone else would",
    ).to.equal(expected.toString());

    // The DIRECT mint, by contrast, IS gated -- Bob holds no `direct_minter`
    // role. Previously this was "proven" by reading back config fields the
    // fixture had written, which demonstrates nothing about an authority
    // boundary. Exercise the boundary instead.
    await expectBankrunError(
      () =>
        psm.methods
          .mintOkuMDirect(new BN(1_000_000))
          .accountsPartial({
            directMinter: bob.publicKey,
            config: psmConfigPda,
            okuMMint,
            recipient: bob.publicKey,
            recipientOkuMAta: bobOkuMAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bob])
          .rpc(),
      "Unauthorized",
    );
  });
});
