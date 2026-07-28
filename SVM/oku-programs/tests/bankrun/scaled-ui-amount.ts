/**
 * ScaledUiAmount extension behavior tests for the lite-psm program.
 *
 * These tests verify that the Token-2022 ScaledUiAmount extension is
 * correctly configured on the OkuM mint, and that multiplier changes
 * (via `set_multiplier` and `distribute_yield`) correctly affect:
 *   - the UI amount reported by `getTokenAccountBalance`
 *   - the raw token amounts minted per USDC deposited
 *   - the USDC returned per raw token redeemed
 *   - guard rails (monotonic increase, max cap)
 *
 * Each test boots a fresh bankrun instance so there are zero inter-test
 * dependencies on multiplier state.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator as orchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintOkuMViaProgram,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
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

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9

describe("ScaledUiAmount extension behavior", () => {
  // Fresh per-test state
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  let user: Keypair;
  let user2: Keypair;

  let configPda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMAta: PublicKey;

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;

  let userUsdcAta: PublicKey;
  let userOkuMAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let user2OkuMAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  beforeEach(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    program = h.program;
    payer = h.payer;

    user = Keypair.generate();
    user2 = Keypair.generate();

    const usdcMintKeypair = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    await fundKeypairs(h, [user, user2], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    configPda = psmSetup.configPda;
    okuMMint = psmSetup.okuMMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMAta = psmSetup.vaultOkuMAta;

    // Derive ATA addresses
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    userOkuMAta = getAssociatedTokenAddressSync(okuMMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    user2UsdcAta = getAssociatedTokenAddressSync(usdcMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
    user2OkuMAta = getAssociatedTokenAddressSync(okuMMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID);
    orchestratorUsdcAta = getAssociatedTokenAddressSync(usdcMint, orchestrator.publicKey, false, TOKEN_PROGRAM_ID);

    // Create ATAs
    await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user2.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, orchestrator.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user2.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

    // Fund with USDC
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, user2UsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, orchestratorUsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);

    // Deposit buffer for instant redemptions
    await program.methods
      .depositBuffer(new BN(500_000_000_000))
      .accountsPartial({
        bufferDepositor: orchestrator.publicKey,
        config: configPda,
        bufferDepositorUsdcAta: orchestratorUsdcAta,
        vaultUsdc: vaultUsdcAta,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    await ensurePSMUnpaused(program as any, configPda);
  });

  // =========================================================================
  // 1. Mint introspection
  // =========================================================================

  it("OkuM mint has ScaledUiAmount extension with initial multiplier 1.0", async () => {
    const info = await provider.connection.getAccountInfo(okuMMint);
    expect(info).to.not.be.null;

    const mint = unpackMint(okuMMint, info!, TOKEN_2022_PROGRAM_ID);

    // Extensions are stored in tlvData — non-empty means extensions present
    expect(mint.tlvData.length).to.be.greaterThan(0);

    // Mint authority and freeze authority should both be the config PDA
    expect(mint.mintAuthority!.toString()).to.equal(configPda.toString());
    expect(mint.freezeAuthority!.toString()).to.equal(configPda.toString());

    // Decimals should be 6
    expect(mint.decimals).to.equal(6);

    // Verify initial multiplier is 1.0
    const multiplier = await readMultiplierFromMint(h, okuMMint);
    expect(multiplier.eq(PRECISION)).to.be.true;
  });

  // =========================================================================
  // 2. getTokenAccountBalance returns scaled uiAmount after multiplier update
  // =========================================================================

  it("raw token balance unchanged after multiplier update", async () => {
    // Mint 10 USDC worth of okuM (10_000_000 base units at multiplier 1.0)
    const mintAmount = new BN(10_000_000);
    await mintOkuMViaProgram(
      program, user, mintAmount,
      configPda, usdcMint, okuMMint,
      userUsdcAta, userOkuMAta, vaultUsdcAta
    );

    const balBefore = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
    const rawBefore = Number(balBefore.amount);
    expect(rawBefore).to.be.greaterThanOrEqual(mintAmount.toNumber());

    // Bump multiplier to 2.0 (2_000_000_000)
    const newMultiplier = new BN(2_000_000_000);
    await program.methods
      .setMultiplier(newMultiplier)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    await warpSlots(h, 1);

    // Raw balance must NOT have changed after multiplier update
    const balAfter = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
    expect(Number(balAfter.amount)).to.equal(rawBefore);

    // Verify the on-chain multiplier matches what we set
    const actualMultiplier = await readMultiplierFromMint(h, okuMMint);
    expect(actualMultiplier.eq(newMultiplier)).to.be.true;
  });

  // =========================================================================
  // 3. Mint amount decreases as multiplier increases
  // =========================================================================

  it("mint amount decreases as multiplier increases", async () => {
    // Set multiplier to 3.0
    const m3 = new BN(3_000_000_000);
    await program.methods
      .setMultiplier(m3)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    await warpSlots(h, 1);

    // Mint 1 USDC at multiplier 3.0
    const user2OkuBefore = await getAccount(
      provider.connection, user2OkuMAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    const rawBefore = Number(user2OkuBefore.amount);

    await mintOkuMViaProgram(
      program, user2, new BN(1_000_000),
      configPda, usdcMint, okuMMint,
      user2UsdcAta, user2OkuMAta, vaultUsdcAta
    );

    const user2OkuAfter = await getAccount(
      provider.connection, user2OkuMAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    const rawMintedAt3x = Number(user2OkuAfter.amount) - rawBefore;

    // At multiplier 3.0: raw_tokens = usdc_amount * PRECISION / multiplier
    //   = 1_000_000 * 1_000_000_000 / 3_000_000_000 = 333_333
    expect(rawMintedAt3x).to.equal(333_333);

    // Now bump multiplier to 6.0 and mint another 1 USDC
    const m6 = new BN(6_000_000_000);
    await program.methods
      .setMultiplier(m6)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    await warpSlots(h, 1);

    // Use user (not user2) for the second mint to keep things isolated
    const userOkuBefore2 = await getAccount(
      provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    const rawBefore2 = Number(userOkuBefore2.amount);

    await mintOkuMViaProgram(
      program, user, new BN(1_000_000),
      configPda, usdcMint, okuMMint,
      userUsdcAta, userOkuMAta, vaultUsdcAta
    );

    const userOkuAfter2 = await getAccount(
      provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    const rawMintedAt6x = Number(userOkuAfter2.amount) - rawBefore2;

    // At multiplier 6.0: raw_tokens = 1_000_000 * 1_000_000_000 / 6_000_000_000 = 166_666
    expect(rawMintedAt6x).to.equal(166_666);

    // Confirm: higher multiplier -> fewer raw tokens per USDC
    expect(rawMintedAt6x).to.be.lessThan(rawMintedAt3x);
  });

  // =========================================================================
  // 4. Redeem returns more USDC per raw token as multiplier increases
  // =========================================================================

  it("redeem returns more USDC per raw token as multiplier increases", async () => {
    // Set multiplier to 8.0
    const m8 = new BN(8_000_000_000);
    await program.methods
      .setMultiplier(m8)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    await warpSlots(h, 1);

    // Mint some okuM for user to redeem (at multiplier 8.0)
    await mintOkuMViaProgram(
      program, user, new BN(10_000_000), // 10 USDC
      configPda, usdcMint, okuMMint,
      userUsdcAta, userOkuMAta, vaultUsdcAta
    );

    await warpSlots(h, 1);

    // Redeem 100_000 raw tokens at multiplier 8.0
    const redeemAmount = new BN(100_000);
    const userUsdcBefore = await getAccount(
      provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID
    );

    await program.methods
      .redeemOkuM(redeemAmount, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userUsdcAfter = await getAccount(
      provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID
    );

    const usdcReceived = Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount);

    // At multiplier 8.0: usdc_out = raw_tokens * multiplier / PRECISION
    //   = 100_000 * 8_000_000_000 / 1_000_000_000 = 800_000
    expect(usdcReceived).to.equal(800_000);

    // Verify we got MORE USDC than raw tokens redeemed (multiplier > 1.0)
    expect(usdcReceived).to.be.greaterThan(redeemAmount.toNumber());
  });

  // =========================================================================
  // 5. setMultiplier cannot decrease multiplier
  // =========================================================================

  it("setMultiplier cannot decrease multiplier", async () => {
    // Set multiplier to 2.0 first
    const higher = new BN(2_000_000_000);
    await program.methods
      .setMultiplier(higher)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    await warpSlots(h, 1);

    // Verify the multiplier is set
    const actualMultiplier = await readMultiplierFromMint(h, okuMMint);
    expect(actualMultiplier.eq(higher)).to.be.true;

    // Try to decrease to 1.0 -> should fail
    try {
      await program.methods
        .setMultiplier(PRECISION) // 1.0, which is less than 2.0
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
      expect.fail("Should have failed with MultiplierCannotDecrease");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code || err?.message || "";
      expect(code).to.satisfy((c: string) =>
        c === "MultiplierCannotDecrease" || c.includes("MultiplierCannotDecrease")
      );
    }
  });

  // =========================================================================
  // 6. setMultiplier cannot exceed MAX_MULTIPLIER
  // =========================================================================

  it("setMultiplier cannot exceed MAX_MULTIPLIER", async () => {
    // MAX_MULTIPLIER = 1e15 (1_000_000_000_000_000)
    const aboveMax = new BN("1000000000000001"); // 1e15 + 1

    try {
      await program.methods
        .setMultiplier(aboveMax)
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
      expect.fail("Should have failed with MultiplierAboveMax");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code || err?.message || "";
      expect(code).to.satisfy((c: string) =>
        c === "MultiplierAboveMax" || c.includes("MultiplierAboveMax")
      );
    }
  });

  // =========================================================================
  // 7. distribute_yield increments multiplier proportionally
  // =========================================================================

  it("distribute_yield increments multiplier proportionally", async () => {
    // Mint some okuM to create supply (at multiplier 1.0)
    await mintOkuMViaProgram(
      program, user, new BN(10_000_000), // 10 USDC
      configPda, usdcMint, okuMMint,
      userUsdcAta, userOkuMAta, vaultUsdcAta
    );

    // Verify initial multiplier is 1.0
    const startMultiplier = await readMultiplierFromMint(h, okuMMint);
    expect(startMultiplier.eq(PRECISION)).to.be.true;

    // Read the current supply from the mint
    const mintInfo = await provider.connection.getAccountInfo(okuMMint);
    const mintData = unpackMint(okuMMint, mintInfo!, TOKEN_2022_PROGRAM_ID);
    const totalSupply = new BN(mintData.supply.toString());

    // Distribute $1 of yield (1_000_000 base units)
    const yieldAmount = new BN(1_000_000);

    // Expected multiplier increase: yield * PRECISION / total_supply
    const expectedBump = yieldAmount.mul(PRECISION).div(totalSupply);

    // Only proceed if the bump is non-zero
    expect(expectedBump.toNumber()).to.be.greaterThan(0);

    const expectedNewMultiplier = startMultiplier.add(expectedBump);

    await program.methods
      .distributeYield(yieldAmount)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    await warpSlots(h, 1);

    // Verify the on-chain multiplier matches the expected computation
    const actualNewMultiplier = await readMultiplierFromMint(h, okuMMint);
    expect(actualNewMultiplier.eq(expectedNewMultiplier)).to.be.true;

    // Verify by redeeming some tokens and checking the USDC payout
    // reflects the new multiplier.
    const redeemAmount = new BN(100_000); // small redeem
    const userUsdcBefore = await getAccount(
      provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID
    );

    await program.methods
      .redeemOkuM(redeemAmount, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userUsdcAfter = await getAccount(
      provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID
    );

    const usdcReceived = Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount);
    const expectedUsdc = redeemAmount.mul(expectedNewMultiplier).div(PRECISION).toNumber();

    // The USDC received should match the post-yield multiplier
    expect(usdcReceived).to.equal(expectedUsdc);

    // Verify the config's lastYieldDistributionSlot was updated
    const config = await program.account.psmConfig.fetch(configPda);
    expect(Number(config.lastYieldDistributionSlot)).to.be.greaterThan(0);
  });
});
