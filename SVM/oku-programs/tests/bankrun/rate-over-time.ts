/**
 * Rate-changes-over-time tests (PSM + vault).
 *
 * These tests exercise the discrete rate-update model under explicit slot
 * and wall-clock progression, validating that:
 *
 *   1. `set_oku_m_price` bumps the PSM `oku_m_price` and a subsequent
 *      `redeem_oku_m` returns the corresponding higher USDC payout.
 *   2. `distribute_yield(yield_amount)` bumps the price proportional to
 *      `yield_amount / total_supply` and `redeem_oku_m` reflects the bump
 *      across multiple ticks.
 *   3. `update_usd_multiplier` bumps the vault multiplier and a subsequent
 *      `unwrap` returns the corresponding higher OkuMoney amount per share.
 *   4. The yield-distribution sandwich lock fires on a same-slot
 *      mint/redeem and releases on the next slot — verified with a
 *      dedicated `autoBumpSlot: false` harness so the assertion is
 *      reproducible.
 *   5. Wall-clock progression alone is a no-op (SVM uses the discrete
 *      stored-price model — no time-based `_rpow` streaming).
 *   6. Multi-tick yield accrual composes: 3 × 0.1% bumps across separate
 *      slots produce a strictly-higher redeem payout than the starting
 *      price, with exact arithmetic at each tick.
 *
 * Time / slot progression is driven by `warpSlots` and `warpBy` from
 * `tests/shared/bankrun.ts` — bankrun's clock is sticky until something
 * explicitly warps it.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { OkuDollar } from "../../target/types/oku_dollar";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
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
  warpBy,
  getClock,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9, matches oku-shared::PRECISION
const DEAD_ADDRESS = SystemProgram.programId;

describe("rate changes over time (slot + wall-clock progression)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let vault: Program<OkuDollar>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

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

  let userUsdcAta: PublicKey;
  let userOkuMoneyAta: PublicKey;
  let userUsdOkuAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  // Vault-specific authorities
  const usdRebaser = Keypair.generate();
  const reserveManager = Keypair.generate();
  let reserveManagerOkuMoneyAta: PublicKey;

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;
    vault = getProgram<OkuDollar>(h, "oku_dollar");

    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config_v4")],
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
      [user, usdRebaser, reserveManager],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    const psmSetup = await initializePsm(h, psm, payer, usdcMint, okuMoneyMint);
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;

    // Initialize the oku-dollar vault.
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config_v2")],
      vault.programId
    );
    [usdOkuMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("usd_oku_mint_v2")],
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

    // User / orchestrator / reserveManager ATAs.
    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    userOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
    userUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    const rmUsdcAta = await ensureAtaViaBankrun(
      h,
      reserveManager.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    reserveManagerOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      reserveManager.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(
      h,
      reserveManager.publicKey,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID
    );

    // Fund users with USDC.
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID); // 100k
    await mintToViaBankrun(h, usdcMint, orchestratorUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, rmUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID);

    // Mint OkuM to user (50k) and to reserveManager (50k, used to bump
    // vault reserves before update_usd_multiplier).
    await mintOkuMoneyViaProgram(
      psm as any,
      user,
      new BN(50_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdcAta
    );
    await mintOkuMoneyViaProgram(
      psm as any,
      reserveManager,
      new BN(50_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      rmUsdcAta,
      reserveManagerOkuMoneyAta,
      vaultUsdcAta
    );

    // Pre-load PSM buffer so redeems land instant throughout the suite.
    await psm.methods
      .depositBuffer(new BN(50_000_000_000))
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

  beforeEach(async () => {
    await ensurePSMUnpaused(psm as any, psmConfigPda);
  });

  // -------------------------------------------------------------------
  // 1. PSM price tick under explicit slot progression
  // -------------------------------------------------------------------

  it("redeem_oku_m payout tracks set_oku_m_price across explicit slot ticks", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const p0 = new BN(cfg0.okuMPrice.toString());

    // Redeem at p0 → expected: oku_m * p0 / PRECISION.
    const redeemAmt = new BN(1_000_000_000); // 1000 OkuM
    const expectedUsdc0 = redeemAmt.mul(p0).div(PRECISION);
    const usdcBefore0 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt)
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter0 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter0.amount) - Number(usdcBefore0.amount)).to.equal(
      expectedUsdc0.toNumber()
    );

    // ===== Tick: bump price by 1%, then redeem again =====
    const p1 = p0.mul(new BN(101)).div(new BN(100));
    await psm.methods
      .setOkuMPrice(p1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // Auto-bumped harness already advanced one slot for the set call,
    // and will advance another for the redeem. Confirm the price stuck.
    const cfg1 = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(new BN(cfg1.okuMPrice.toString()).toString()).to.equal(p1.toString());

    // Explicit additional slot warp — defensive, ensures the
    // `last_yield_distribution_slot` stamp lands before the next ix.
    await warpSlots(h, 1);

    const expectedUsdc1 = redeemAmt.mul(p1).div(PRECISION);
    const usdcBefore1 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt)
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter1 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter1.amount) - Number(usdcBefore1.amount)).to.equal(
      expectedUsdc1.toNumber()
    );

    // The tick payout must be strictly larger than the pre-tick payout
    // (same OkuM input, higher multiplier).
    expect(expectedUsdc1.gt(expectedUsdc0)).to.be.true;
  });

  // -------------------------------------------------------------------
  // 2. distribute_yield composes correctly across consecutive slots
  // -------------------------------------------------------------------

  it("distribute_yield bumps oku_m_price by yield/supply across consecutive slot ticks", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const p0 = new BN(cfg0.okuMPrice.toString());

    // Read live OkuMoney supply — distribute_yield uses this as the
    // denominator (`new_price = old + yield * PRECISION / supply`).
    const { unpackMint } = await import("@solana/spl-token");
    const mintAcct0 = await provider.connection.getAccountInfo(okuMoneyMint);
    const supply0 = new BN(
      unpackMint(okuMoneyMint, mintAcct0!, TOKEN_2022_PROGRAM_ID).supply.toString()
    );

    // === Tick A: distribute_yield($10) ===
    const yieldA = new BN(10_000_000); // $10 in 6-decimal terms
    const expectedDeltaA = yieldA.mul(PRECISION).div(supply0);
    const pAExpected = p0.add(expectedDeltaA);

    await psm.methods
      .distributeYield(yieldA)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    const cfgA = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(new BN(cfgA.okuMPrice.toString()).toString()).to.equal(
      pAExpected.toString()
    );

    // Warp to release the yield lock + bankrun's auto-bump still runs.
    await warpSlots(h, 1);

    // === Tick B: distribute_yield($20) at the (unchanged) supply ===
    const mintAcctB = await provider.connection.getAccountInfo(okuMoneyMint);
    const supplyB = new BN(
      unpackMint(okuMoneyMint, mintAcctB!, TOKEN_2022_PROGRAM_ID).supply.toString()
    );
    const yieldB = new BN(20_000_000);
    const expectedDeltaB = yieldB.mul(PRECISION).div(supplyB);
    const pBExpected = pAExpected.add(expectedDeltaB);

    await psm.methods
      .distributeYield(yieldB)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    const cfgB = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(new BN(cfgB.okuMPrice.toString()).toString()).to.equal(
      pBExpected.toString()
    );

    // === Downstream redeem at the cumulative price ===
    await warpSlots(h, 1);

    const redeemAmt = new BN(500_000_000); // 500 OkuM
    const expectedUsdc = redeemAmt.mul(pBExpected).div(PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt)
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );
  });

  // -------------------------------------------------------------------
  // 3. Vault rate tick: update_usd_multiplier bumps unwrap payout
  // -------------------------------------------------------------------

  it("update_usd_multiplier bumps unwrap payout per share across slot ticks", async () => {
    // Wrap 5000 OkuM → usdOku shares.
    const wrapAmt = new BN(5_000_000_000);
    const usdOkuMintAcct0 = await provider.connection.getAccountInfo(usdOkuMint);
    const { unpackMint } = await import("@solana/spl-token");
    const initialSupply = unpackMint(
      usdOkuMint,
      usdOkuMintAcct0!,
      TOKEN_2022_PROGRAM_ID
    ).supply;
    const usesDeadShares = initialSupply === BigInt(0);

    await vault.methods
      .wrap(wrapAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        userOkuMoneyAta,
        userUsdOkuAta,
        reserveVault,
        psmConfig: psmConfigPda,
        deadSharesAta: usesDeadShares ? deadSharesAta : null,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const cfg0 = await vault.account.okuDollarConfig.fetch(vaultConfigPda);
    const m0 = new BN(cfg0.usdMultiplier.toString());
    const sharesBefore = await getAccount(
      provider.connection,
      userUsdOkuAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(sharesBefore.amount)).to.be.greaterThan(0);

    // Top up vault reserves so the post-bump collateral check passes.
    // The reserve_manager already has 50k OkuM funded in `before()`.
    const reserveDeposit = wrapAmt; // 100% headroom
    await vault.methods
      .depositReserves(reserveDeposit)
      .accountsPartial({
        reserveManager: reserveManager.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        sourceAta: reserveManagerOkuMoneyAta,
        reserveVault,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([reserveManager])
      .rpc();

    // === Tick: bump the vault multiplier by 2% ===
    const m1 = m0.mul(new BN(102)).div(new BN(100));
    await vault.methods
      .updateUsdMultiplier(m1)
      .accountsPartial({
        usdRebaser: usdRebaser.publicKey,
        config: vaultConfigPda,
        reserveVault,
        usdOkuMint,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([usdRebaser])
      .rpc();

    // Confirm the stored multiplier.
    const cfg1 = await vault.account.okuDollarConfig.fetch(vaultConfigPda);
    expect(new BN(cfg1.usdMultiplier.toString()).toString()).to.equal(m1.toString());

    // Warp a slot, then unwrap.
    await warpSlots(h, 1);

    // Expected (oku-dollar::unwrap):
    //   oku_m_returned = shares * usd_multiplier / oku_m_price
    const sharesToUnwrap = new BN(Math.floor(Number(sharesBefore.amount) / 4)); // 25%
    const psmCfg = await psm.account.psmConfig.fetch(psmConfigPda);
    const okuMPrice = new BN(psmCfg.okuMPrice.toString());
    const expectedOkuM = sharesToUnwrap.mul(m1).div(okuMPrice);

    const okuMBefore = await getAccount(
      provider.connection,
      userOkuMoneyAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    await vault.methods
      .unwrap(sharesToUnwrap)
      .accountsPartial({
        user: user.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        userOkuMoneyAta,
        userUsdOkuAta,
        reserveVault,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const okuMAfter = await getAccount(
      provider.connection,
      userOkuMoneyAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const okuMReceived = Number(okuMAfter.amount) - Number(okuMBefore.amount);
    expect(okuMReceived).to.equal(expectedOkuM.toNumber());

    // Sanity: the bumped multiplier yields strictly more OkuM than the
    // m0 baseline would have produced for the same share input.
    const baselineOkuM = sharesToUnwrap.mul(m0).div(okuMPrice);
    expect(okuMReceived).to.be.greaterThan(baselineOkuM.toNumber());
  });

  // -------------------------------------------------------------------
  // 4. Wall-clock progression alone is a no-op (discrete model)
  // -------------------------------------------------------------------

  it("wall-clock progression alone does NOT change oku_m_price (discrete model)", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const p0 = new BN(cfg0.okuMPrice.toString());
    const clock0 = await getClock(h);

    // Jump the wall clock forward by 1 hour without any rebase call.
    await warpBy(h, 3600);
    await warpSlots(h, 1);

    const clock1 = await getClock(h);
    expect(Number(clock1.unixTimestamp) - Number(clock0.unixTimestamp)).to.be.greaterThan(
      3500
    );

    const cfg1 = await psm.account.psmConfig.fetch(psmConfigPda);
    const p1 = new BN(cfg1.okuMPrice.toString());

    // SVM PSM price is a stored value — wall-clock alone is a no-op.
    // This is the deliberate divergence from EVM OkuDollar's continuous
    // _rpow streaming.
    expect(p1.toString()).to.equal(p0.toString());
  });

  // -------------------------------------------------------------------
  // 5. Multi-tick composition under exact arithmetic
  // -------------------------------------------------------------------

  it("3 × small set_oku_m_price ticks compose to a strictly higher redeem payout", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const pStart = new BN(cfg0.okuMPrice.toString());

    let pCurrent = pStart;
    for (let i = 0; i < 3; i++) {
      const next = pCurrent.add(pCurrent.div(new BN(1000))); // +0.1%
      await psm.methods
        .setOkuMPrice(next)
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
      pCurrent = next;
      await warpSlots(h, 1);
    }
    const pAfter3Ticks = pCurrent;

    const cfgFinal = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(new BN(cfgFinal.okuMPrice.toString()).toString()).to.equal(
      pAfter3Ticks.toString()
    );

    // Redeem 100 OkuM at the final composed price.
    const redeemAmt = new BN(100_000_000);
    const expectedUsdc = redeemAmt.mul(pAfter3Ticks).div(PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt)
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);

    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );

    // The composed payout must be strictly greater than the starting-price
    // payout would have been (sanity that rate actually appreciated).
    const baselineUsdc = redeemAmt.mul(pStart).div(PRECISION);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.be.greaterThan(
      baselineUsdc.toNumber()
    );
  });
});

// =============================================================================
// Dedicated sandwich-lock test — disables autoBumpSlot so the rebase and
// the follow-up redeem land in the SAME slot, exercising the on-chain
// YieldDistributionInProgress guard.
// =============================================================================
describe("sandwich lock under manual slot control (autoBumpSlot=false)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  const usdcMintKp = Keypair.generate();
  const okuMoneyMintKp = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let psmConfigPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;
  let userUsdcAta: PublicKey;
  let userOkuMoneyAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  before(async () => {
    // Manual slot control — no auto-bump per send. This lets us land a
    // rebase and a redeem in the same slot to verify the lock fires.
    h = await startBankrun({ autoBumpSlot: false });
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;

    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config_v4")],
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
    // Advance manually between setup steps (no auto-bump means bankrun
    // will reject identical-byte txs by hash; warp a slot to refresh the
    // blockhash window between operations).
    await warpSlots(h, 1);

    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h,
      psmConfigPda,
      psmConfigPda,
      DECIMALS,
      orchestrator.publicKey,
      0,
      okuMoneyMintKp
    );
    await warpSlots(h, 1);

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);
    await warpSlots(h, 1);

    const psmSetup = await initializePsm(h, psm, payer, usdcMint, okuMoneyMint);
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;
    await warpSlots(h, 1);

    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await warpSlots(h, 1);
    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    await warpSlots(h, 1);
    userOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
    await warpSlots(h, 1);

    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 5_000_000_000, TOKEN_PROGRAM_ID);
    await warpSlots(h, 1);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      5_000_000_000,
      TOKEN_PROGRAM_ID
    );
    await warpSlots(h, 1);

    await mintOkuMoneyViaProgram(
      psm as any,
      user,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdcAta
    );
    await warpSlots(h, 1);

    await psm.methods
      .depositBuffer(new BN(2_000_000_000))
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
    await warpSlots(h, 1);
  });

  it("same-slot redeem after set_oku_m_price reverts with YieldDistributionInProgress; next slot succeeds", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const p0 = new BN(cfg0.okuMPrice.toString());
    const p1 = p0.add(p0.div(new BN(100))); // +1%

    // Stamp the yield-lock slot.
    await psm.methods
      .setOkuMPrice(p1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // SAME SLOT redeem → must revert.
    await expectBankrunError(
      () =>
        psm.methods
          .redeemOkuM(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: psmConfigPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            okuMoneyMint,
            userUsdcAta,
            userOkuMoneyAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuMoney: vaultOkuMoneyAta,
          tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc(),
      "YieldDistributionInProgress"
    );

    // Advance one slot — lock releases — redeem succeeds at the new price.
    await warpSlots(h, 1);

    const redeemAmt = new BN(1_000_000);
    const expectedUsdc = redeemAmt.mul(p1).div(PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt)
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );
  });
});
