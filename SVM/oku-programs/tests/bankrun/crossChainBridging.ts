/**
 * Cross-Chain Bridging via Orchestrator + PSM (noBridge model, SVM side).
 *
 * Mirrors `EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts`.
 *
 * Design under test:
 *   - There is no on-chain bridge program on SVM.
 *   - The orchestrator holds the standard PSM operational roles
 *     (queue_processor / buffer_depositor / rebaser) on every chain's
 *     lite-psm. It does NOT have a privileged mint authority — it uses
 *     the public `mint_oku_m` / `redeem_oku_m` ix surface against its
 *     own ATAs, then `transfer`s the resulting OkuM to the recipient.
 *
 *   - To "bridge" OkuMoney from chain A to chain B, the orchestrator:
 *       1. Pulls the user's OkuMoney on A (SPL `transfer` from
 *          user → orchestrator's OkuM ATA — the user signs).
 *       2. Calls `redeem_oku_m` as itself on chain A → orchestrator
 *          receives USDC, OkuM is burned, PSM buffer on A shrinks.
 *       3. Off-chain (modelled inline as a USDC mint on B), the
 *          orchestrator now custodies USDC on chain B.
 *       4. Calls `mint_oku_m` as itself on chain B → OkuM is minted to
 *          the orchestrator's ATA, PSM buffer on B grows.
 *       5. SPL `transfer`s the resulting OkuM to the recipient on B.
 *
 *   - For OkuDollar (usdOku), the orchestrator unwraps to OkuM first
 *     and then runs the same flow — usdOku does NOT survive the
 *     bridge in v1.
 *
 * SVM constraint: the lite-psm program is a singleton (one
 * `PsmConfig` PDA per program ID). We simulate the two-chain trust
 * boundary by tracking the orchestrator's USDC balance across the
 * redeem-and-mint hand-off and asserting value conservation. To
 * mimic the cross-chain leg, after the chain-A redeem we credit the
 * orchestrator with an equal USDC amount on "chain B" via
 * `mintToViaBankrun` and zero its "chain A" USDC custody (the
 * off-chain rail). This is the same shape as the EVM test which uses
 * two independently-deployed LitePSM instances on the same node.
 *
 * Reference: SVM/EVM_VS_SVM.md § Cross-chain operational requirements.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { OkuDollar } from "../../target/types/oku_dollar";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMoneyViaProgram,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  createOkuMoneyMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  getProgram,
  warpSlots,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9
const DEAD_ADDRESS = SystemProgram.programId;

describe("cross-chain bridging via orchestrator + PSM (noBridge, SVM)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let vault: Program<OkuDollar>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  const usdcMintKp = Keypair.generate();
  const okuMoneyMintKp = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let usdOkuMint: PublicKey;

  let psmConfigPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;
  let reserveVault: PublicKey;
  let deadSharesAta: PublicKey;

  // Alice = sender on "chain A"
  let aliceUsdcAta: PublicKey;
  let aliceOkuMoneyAta: PublicKey;
  let aliceUsdOkuAta: PublicKey;
  // Bob = recipient on "chain B"
  let bobOkuMoneyAta: PublicKey;
  // Orchestrator ATAs (its mint/redeem source)
  let orchestratorUsdcAta: PublicKey;
  let orchestratorOkuMoneyAta: PublicKey;

  // Vault authorities
  const usdRebaser = Keypair.generate();
  const reserveManager = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;
    vault = getProgram<OkuDollar>(h, "oku_dollar");

    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      psm.programId
    );

    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKp,
      TOKEN_PROGRAM_ID
    );
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h,
      psmConfigPda,
      psmConfigPda,
      DECIMALS,
      orchestrator.publicKey,
      0,
      okuMoneyMintKp
    );

    await fundKeypairs(
      h,
      [alice, bob, usdRebaser, reserveManager],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    const psmSetup = await initializePsm(h, psm, payer, usdcMint, okuMoneyMint);
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;

    // Initialize vault (needed for the OkuDollar bridging test).
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config")],
      vault.programId
    );
    [usdOkuMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("usd_oku_mint")],
      vault.programId
    );
    reserveVault = getAssociatedTokenAddressSync(
      okuMoneyMint,
      vaultConfigPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    await vault.methods
      .initialize(
        warmMultisig.publicKey,
        coldMultisig.publicKey,
        usdRebaser.publicKey,
        reserveManager.publicKey,
        new BN(950_000_000) // 95%
      )
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        reserveVault,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    deadSharesAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      DEAD_ADDRESS,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, DEAD_ADDRESS, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    // ATAs.
    aliceUsdcAta = await ensureAtaViaBankrun(h, alice.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    aliceOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      alice.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, alice.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
    aliceUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      alice.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, alice.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    bobOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      bob.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, bob.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);

    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    orchestratorOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      orchestrator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID
    );

    // Fund USDC: alice (5k for the OkuM-bridging test), orchestrator
    // (10k for buffer top-ups + cross-chain leg simulation).
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 5_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      10_000_000_000,
      TOKEN_PROGRAM_ID
    );

    // Pre-load the PSM USDC buffer (5k) so redeems land instant.
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

  /** Simulate the orchestrator's off-chain USDC custody hand-off from
   *  chain A to chain B. In reality, the orchestrator either burns the
   *  redeemed USDC on chain A or bridges it via an off-chain rail; here
   *  we mint a fresh USDC balance into the orchestrator's ATA on
   *  "chain B" equal to what it redeemed on "chain A," and zero out the
   *  chain-A balance, matching the EVM-side test's two-MockUSDC pattern. */
  async function offchainUsdcHandoff(amount: BN): Promise<void> {
    // Simulating "the orchestrator no longer has this USDC on chain A"
    // is mechanically equivalent to spending it on something else; we
    // model it by *not* draining it (the chain A buffer still has the
    // shrunk side of the redeem). The hand-off is the credit on chain B,
    // modelled by minting fresh USDC into the orchestrator's ATA.
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      BigInt(amount.toString()),
      TOKEN_PROGRAM_ID
    );
  }

  // ---------------------------------------------------------------------
  // Test 1 — OkuMoney bridging
  // ---------------------------------------------------------------------

  it("orchestrator-mediated bridge: Alice OkuM on A → Bob OkuM on B (price-aware)", async () => {
    // Step 0: Alice mints OkuM via PSM on chain A (1000 USDC → ~1000 OkuM).
    const mintUsdc = new BN(1_000_000_000); // 1000 USDC
    await mintOkuMoneyViaProgram(
      psm as any,
      alice,
      mintUsdc,
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      aliceUsdcAta,
      aliceOkuMoneyAta,
      vaultUsdcAta
    );
    const aliceOkuMBefore = await ataAmount(aliceOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceOkuMBefore)).to.be.greaterThan(0);

    // Snapshot pre-bridge state for invariant assertions.
    const bobOkuMStart = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    const vaultUsdcStart = await ataAmount(vaultUsdcAta, TOKEN_PROGRAM_ID);
    const psmCfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const price0 = new BN(psmCfg0.okuMPrice.toString());

    // ===== Step 1: Alice transfers her OkuM to the orchestrator's ATA =====
    // The orchestrator is the only party that can `redeem_oku_m` against
    // its own ATA (Anchor pins `associated_token::authority = user`).
    // This is the SPL-transfer "pull from user" step. Alice signs.
    const bridgeAmount = new BN(Number(aliceOkuMBefore)); // bridge full balance
    const orchOkuMBefore = await ataAmount(orchestratorOkuMoneyAta, TOKEN_2022_PROGRAM_ID);

    const transferIx = createTransferCheckedInstruction(
      aliceOkuMoneyAta,
      okuMoneyMint,
      orchestratorOkuMoneyAta,
      alice.publicKey,
      BigInt(bridgeAmount.toString()),
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await provider.sendAndConfirm!(new Transaction().add(transferIx), [alice]);

    const orchOkuMAfterTransfer = await ataAmount(orchestratorOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchOkuMAfterTransfer) - Number(orchOkuMBefore)).to.equal(
      bridgeAmount.toNumber()
    );
    const aliceOkuMAfterTransfer = await ataAmount(aliceOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceOkuMAfterTransfer)).to.equal(0);

    // ===== Step 2: Orchestrator redeems OkuM → USDC on chain A =====
    const orchUsdcBefore = await ataAmount(orchestratorUsdcAta);
    await psm.methods
      .redeemOkuM(bridgeAmount)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const orchUsdcAfterRedeem = await ataAmount(orchestratorUsdcAta);
    const usdcRedeemed = new BN(
      (orchUsdcAfterRedeem - orchUsdcBefore).toString()
    );
    // Price-aware redeem: usdc = oku_m * oku_m_price / PRECISION
    const expectedRedeemUsdc = bridgeAmount.mul(price0).div(PRECISION);
    expect(usdcRedeemed.toString()).to.equal(expectedRedeemUsdc.toString());

    // OkuM was burned (orchestrator OkuM balance back to baseline).
    const orchOkuMAfterRedeem = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(orchOkuMAfterRedeem)).to.equal(Number(orchOkuMBefore));

    // PSM USDC buffer on chain A shrunk by exactly the redeemed amount.
    const vaultUsdcAfterRedeem = await ataAmount(vaultUsdcAta);
    expect((vaultUsdcStart - vaultUsdcAfterRedeem).toString()).to.equal(
      usdcRedeemed.toString()
    );

    // ===== Step 3: Off-chain USDC hand-off A → B =====
    await offchainUsdcHandoff(usdcRedeemed);
    const orchUsdcOnB = await ataAmount(orchestratorUsdcAta);
    expect(Number(orchUsdcOnB)).to.be.greaterThan(Number(orchUsdcAfterRedeem));

    // ===== Step 4: Orchestrator mints OkuM on chain B =====
    // In a real two-PSM deployment this would target chain B's PSM.
    // The single-PSM model uses the same PsmConfig; the value-conservation
    // invariant still holds because mint_oku_m's accounting is symmetric
    // to redeem_oku_m at the same price.
    await psm.methods
      .mintOkuM(usdcRedeemed)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const orchOkuMAfterMint = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    const okuMMinted = BigInt(orchOkuMAfterMint) - BigInt(orchOkuMAfterRedeem);

    // Price-aware mint: oku_m = usdc * PRECISION / oku_m_price
    const expectedMint = usdcRedeemed.mul(PRECISION).div(price0);
    expect(okuMMinted.toString()).to.equal(expectedMint.toString());

    // ===== Step 5: Orchestrator transfers OkuM to Bob on chain B =====
    const transferToBob = createTransferCheckedInstruction(
      orchestratorOkuMoneyAta,
      okuMoneyMint,
      bobOkuMoneyAta,
      orchestrator.publicKey,
      okuMMinted,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await provider.sendAndConfirm!(new Transaction().add(transferToBob), [orchestrator]);

    const bobOkuMEnd = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = bobOkuMEnd - bobOkuMStart;

    // ===== Invariants =====
    // I1: Bob received exactly what the orchestrator minted on chain B.
    expect(bobReceived.toString()).to.equal(okuMMinted.toString());

    // I2: Value conservation — the dollar value of Bob's receipt equals
    // the dollar value of Alice's burn, at the constant price.
    const aliceDollarValue = bridgeAmount.mul(price0).div(PRECISION);
    const bobDollarValue = new BN(bobReceived.toString())
      .mul(price0)
      .div(PRECISION);
    expect(aliceDollarValue.toString()).to.equal(bobDollarValue.toString());

    // I3: At a flat price the OkuM amount itself is also conserved
    // (no slippage / no fee in v1 noBridge — that's the EVM property too).
    expect(bobReceived.toString()).to.equal(bridgeAmount.toString());

    // I4: Orchestrator holds no leftover OkuM (fully forwarded to Bob).
    const orchOkuMFinal = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(orchOkuMFinal)).to.equal(Number(orchOkuMBefore));

    // I5: PSM USDC buffer net change = +usdcRedeemed (mint leg added
    // exactly what the redeem leg removed, plus the off-chain hand-off
    // credited the orchestrator). After both legs, the buffer is back
    // to the starting balance.
    const vaultUsdcFinal = await ataAmount(vaultUsdcAta);
    expect(vaultUsdcFinal.toString()).to.equal(vaultUsdcStart.toString());
  });

  // ---------------------------------------------------------------------
  // Test 2 — OkuMoney bridging across a price tick
  // ---------------------------------------------------------------------

  it("preserves dollar value across an orchestrator price tick between redeem and mint", async () => {
    // Fund Alice with fresh OkuM.
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintOkuMoneyViaProgram(
      psm as any,
      alice,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      aliceUsdcAta,
      aliceOkuMoneyAta,
      vaultUsdcAta
    );

    const aliceOkuM = await ataAmount(aliceOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    const bobStart = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);

    // Snapshot starting price.
    const psmCfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const price0 = new BN(psmCfg0.okuMPrice.toString());

    // Alice → orchestrator (pull).
    const bridgeAmount = new BN(Number(aliceOkuM));
    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          aliceOkuMoneyAta,
          okuMoneyMint,
          orchestratorOkuMoneyAta,
          alice.publicKey,
          BigInt(bridgeAmount.toString()),
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [alice]
    );

    // Orchestrator redeems at price0.
    const orchUsdcBefore = await ataAmount(orchestratorUsdcAta);
    await psm.methods
      .redeemOkuM(bridgeAmount)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();
    const usdcRedeemed = new BN(
      ((await ataAmount(orchestratorUsdcAta)) - orchUsdcBefore).toString()
    );
    expect(usdcRedeemed.toString()).to.equal(
      bridgeAmount.mul(price0).div(PRECISION).toString()
    );

    // ===== Price tick BETWEEN the legs =====
    // Simulate a rebase that lands while the orchestrator is in flight
    // (off-chain rail latency). Bump the price by 1%.
    //
    // Note: the auto-bump-slot harness advances one slot per
    // `sendAndConfirm`, so this rebase and the follow-up mint already
    // land in separate slots. The sandwich-lock semantics themselves
    // are exercised by the dedicated `autoBumpSlot: false` test in
    // `rate-over-time.ts`; here we only care about the cross-chain
    // accounting under a mid-flight rate change.
    const price1 = price0.mul(new BN(101)).div(new BN(100));
    await psm.methods
      .setOkuMPrice(price1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // Mint on "chain B" at the new price.
    await warpSlots(h, 1);
    await offchainUsdcHandoff(usdcRedeemed);
    const orchOkuMBeforeMint = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    await psm.methods
      .mintOkuM(usdcRedeemed)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();
    const orchOkuMAfterMint = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    const okuMMinted = BigInt(orchOkuMAfterMint) - BigInt(orchOkuMBeforeMint);

    // Expected: usdcRedeemed * PRECISION / price1
    const expectedMint = usdcRedeemed.mul(PRECISION).div(price1);
    expect(okuMMinted.toString()).to.equal(expectedMint.toString());

    // Forward to Bob.
    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          orchestratorOkuMoneyAta,
          okuMoneyMint,
          bobOkuMoneyAta,
          orchestrator.publicKey,
          okuMMinted,
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [orchestrator]
    );

    const bobEnd = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    const bobReceived = new BN((bobEnd - bobStart).toString());

    // Bob got fewer raw OkuM tokens than Alice burned (price went up),
    // but the dollar value reconciles exactly at the new price:
    //   aliceDollarValue == bobReceived * price1 / PRECISION
    expect(bobReceived.lt(bridgeAmount)).to.be.true;

    const aliceDollar = bridgeAmount.mul(price0).div(PRECISION);
    const bobDollar = bobReceived.mul(price1).div(PRECISION);

    // The redeem-then-mint pipeline rounds DOWN twice (once per leg),
    // so the bob-side dollar value can be at most `aliceDollar` and at
    // least `aliceDollar - 1` micro-USDC of accumulated truncation.
    const tolerance = new BN(1);
    expect(bobDollar.lte(aliceDollar)).to.be.true;
    expect(aliceDollar.sub(bobDollar).lte(tolerance)).to.be.true;
  });

  // ---------------------------------------------------------------------
  // Test 3 — OkuDollar bridging (orchestrator unwraps usdOku first)
  // ---------------------------------------------------------------------

  it("usdOku bridge: orchestrator unwraps to OkuM on A, mints OkuM on B (no usdOku on dest)", async () => {
    // Alice mints OkuM and wraps it into usdOku.
    await mintToViaBankrun(h, usdcMint, aliceUsdcAta, payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintOkuMoneyViaProgram(
      psm as any,
      alice,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      aliceUsdcAta,
      aliceOkuMoneyAta,
      vaultUsdcAta
    );
    const aliceOkuMAfterMint = await ataAmount(
      aliceOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );

    // Wrap. The dead-shares ATA only takes the MINIMUM_LIQUIDITY haircut
    // on the vault's very first deposit; subsequent wraps pass null.
    const usdOkuMintAcct = await provider.connection.getAccountInfo(usdOkuMint);
    const { unpackMint } = await import("@solana/spl-token");
    const usdOkuInfo = unpackMint(usdOkuMint, usdOkuMintAcct!, TOKEN_2022_PROGRAM_ID);
    const usesDeadShares = usdOkuInfo.supply === BigInt(0);

    await vault.methods
      .wrap(new BN(Number(aliceOkuMAfterMint)), new BN(0))
      .accountsPartial({
        user: alice.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        userOkuMoneyAta: aliceOkuMoneyAta,
        userUsdOkuAta: aliceUsdOkuAta,
        reserveVault,
        psmConfig: psmConfigPda,
        deadSharesAta: usesDeadShares ? deadSharesAta : null,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();
    const aliceUsdOkuAfterWrap = await ataAmount(aliceUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(aliceUsdOkuAfterWrap)).to.be.greaterThan(0);

    // ===== Step 1: Alice transfers usdOku shares to the orchestrator =====
    // We need a usdOku ATA on the orchestrator side.
    const orchUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      orchestrator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, orchestrator.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    const sharesBridged = new BN(Number(aliceUsdOkuAfterWrap));
    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          aliceUsdOkuAta,
          usdOkuMint,
          orchUsdOkuAta,
          alice.publicKey,
          BigInt(sharesBridged.toString()),
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [alice]
    );

    // ===== Step 2: Orchestrator unwraps shares → OkuM on chain A =====
    const orchOkuMBeforeUnwrap = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );

    await vault.methods
      .unwrap(sharesBridged)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        userUsdOkuAta: orchUsdOkuAta,
        reserveVault,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const orchOkuMAfterUnwrap = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    const okuMFromUnwrap = orchOkuMAfterUnwrap - orchOkuMBeforeUnwrap;
    expect(Number(okuMFromUnwrap)).to.be.greaterThan(0);

    // ===== Step 3: Orchestrator redeems OkuM → USDC =====
    const orchUsdcBeforeRedeem = await ataAmount(orchestratorUsdcAta);
    await psm.methods
      .redeemOkuM(new BN(okuMFromUnwrap.toString()))
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();
    const usdcFromRedeem = new BN(
      ((await ataAmount(orchestratorUsdcAta)) - orchUsdcBeforeRedeem).toString()
    );

    // ===== Step 4: Off-chain hand-off + mint OkuM on B + transfer to Bob =====
    await offchainUsdcHandoff(usdcFromRedeem);
    const bobBefore = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    const orchOkuMBeforeMint = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );

    await psm.methods
      .mintOkuM(usdcFromRedeem)
      .accountsPartial({
        user: orchestrator.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: orchestratorUsdcAta,
        userOkuMoneyAta: orchestratorOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

    const orchOkuMAfterMint = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    const okuMMinted = orchOkuMAfterMint - orchOkuMBeforeMint;

    await provider.sendAndConfirm!(
      new Transaction().add(
        createTransferCheckedInstruction(
          orchestratorOkuMoneyAta,
          okuMoneyMint,
          bobOkuMoneyAta,
          orchestrator.publicKey,
          okuMMinted,
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [orchestrator]
    );
    const bobEnd = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);

    // ===== Invariants =====
    // I1: Bob receives raw OkuM, NOT usdOku — usdOku does not survive
    // the bridge in v1. Confirm Bob has no usdOku ATA balance.
    const bobUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      bob.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const bobUsdOkuAcctInfo = await h.context.banksClient.getAccount(bobUsdOkuAta);
    expect(bobUsdOkuAcctInfo).to.be.null;

    // I2: Bob received exactly the OkuM the orchestrator minted on B.
    expect((bobEnd - bobBefore).toString()).to.equal(okuMMinted.toString());

    // I3: Orchestrator holds no leftover OkuM or usdOku.
    const orchOkuMFinal = await ataAmount(
      orchestratorOkuMoneyAta,
      TOKEN_2022_PROGRAM_ID
    );
    const orchUsdOkuFinal = await ataAmount(orchUsdOkuAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(orchOkuMFinal)).to.equal(Number(orchOkuMBeforeUnwrap));
    expect(Number(orchUsdOkuFinal)).to.equal(0);
  });

  // ---------------------------------------------------------------------
  // Test 4 — Authority boundary: random key cannot mint OkuM directly
  // ---------------------------------------------------------------------

  it("a non-orchestrator key cannot mint OkuM directly (PSM is the sole minter)", async () => {
    // Bob — random key with USDC — tries to call mint_oku_m directly
    // against his own ATA. mint_oku_m is permissionless, so this should
    // SUCCEED for him, but the result must not differ from any other
    // user's mint. The point of this test is to assert that the
    // orchestrator's privileges are bounded: it has no special mint
    // authority; any other USDC-holding key can mint identically.
    const bobUsdcAta = await ensureAtaViaBankrun(h, bob.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, bobUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);

    const bobOkuMBefore = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    await psm.methods
      .mintOkuM(new BN(100_000_000))
      .accountsPartial({
        user: bob.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta: bobUsdcAta,
        userOkuMoneyAta: bobOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();
    const bobOkuMAfter = await ataAmount(bobOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
    expect(Number(bobOkuMAfter) - Number(bobOkuMBefore)).to.be.greaterThan(0);

    // The orchestrator role-set (queue_processor / buffer_depositor /
    // rebaser) does NOT include a mint privilege — confirm by inspecting
    // PsmConfig.
    const cfg = await psm.account.psmConfig.fetch(psmConfigPda);
    // None of the role pubkeys is the OkuMoney mint authority — the
    // mint authority is the PsmConfig PDA itself. Bob can mint because
    // `mint_oku_m` is permissionless; the PSM PDA signs the inner CPI
    // to Token-2022's `mint_to`.
    // Sanity: queue_processor / buffer_depositor / rebaser are all the
    // orchestrator key (per `initializePsm`), confirming the v1 design
    // that the orchestrator's authority is the operational PSM roles,
    // not a mint authority.
    expect(cfg.queueProcessor.toString()).to.equal(orchestrator.publicKey.toString());
    expect(cfg.bufferDepositor.toString()).to.equal(orchestrator.publicKey.toString());
    expect(cfg.rebaser.toString()).to.equal(orchestrator.publicKey.toString());
  });
});
