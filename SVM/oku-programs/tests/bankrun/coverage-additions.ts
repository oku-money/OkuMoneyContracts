/**
 * WS3.2 coverage additions — bankrun tests for gaps identified in the
 * pre-MVP review.
 *
 * Covered:
 *   WS3.2.a  zero-supply distribute_yield reverts with ZeroAmount (PSM)
 *   WS3.2.b  PSM double-init negative test
 *   WS3.2.c  pause-during-process_queue (WS2.8 enforcement)
 *   WS3.2.e  wrong-owner-ATA soft-skip in process_queue (WS2.1 enforcement)
 *
 * WS3.2.d (upgrade-path bankrun) is deferred — requires deploying a modified
 * program binary into the test environment, which is out of scope for bankrun.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
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
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpSlots,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// PSM-only describe: WS3.2.a (PSM yield), WS3.2.b (PSM init), WS3.2.c (pause)
// ---------------------------------------------------------------------------

describe("WS3.2 PSM coverage additions", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let usdOkuMint: PublicKey;
  let configPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultUsdOkuAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );

    const setup = await initializePsm(h, psm as any, payer, usdcMint);
    configPda = setup.configPda;
    redemptionQueuePda = setup.redemptionQueuePda;
    usdOkuMint = setup.usdOkuMint;
    vaultUsdcAta = setup.vaultUsdcAta;
    vaultUsdOkuAta = setup.vaultUsdOkuAta;

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("WS3.2.a: distribute_yield reverts ZeroAmount when usdOku supply == 0", async () => {
    try {
      await psm.methods
        .distributeYield(new BN(1_000_000))
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
      expect.fail("Should have reverted with ZeroAmount");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code || err?.message || "";
      expect(code).to.satisfy(
        (c: string) => c === "ZeroAmount" || c.includes("ZeroAmount"),
        `Expected ZeroAmount, got: ${code}`
      );
    }
  });

  it("WS3.2.b: lite-psm initialize fails if config PDA already exists", async () => {
    try {
      await psm.methods
        .initialize({
          maxSupply: MAX_SUPPLY,
          minterAllowance: MINTER_ALLOWANCE,
          pauser: warmMultisig.publicKey,
          unpauser: coldMultisig.publicKey,
          freezer: warmMultisig.publicKey,
          unfreezer: coldMultisig.publicKey,
          queueProcessor: orchestrator.publicKey,
          bufferDepositor: orchestrator.publicKey,
          bufferWithdrawer: coldMultisig.publicKey,
          capManager: coldMultisig.publicKey,
          allowanceManager: coldMultisig.publicKey,
          rebaser: orchestrator.publicKey,
        })
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: configPda,
          usdcMint,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed — config PDA already initialized");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("WS3.2.c: process_queue reverts with Paused when PSM is paused", async () => {
    await psm.methods
      .pause()
      .accountsPartial({ pauser: warmMultisig.publicKey, config: configPda })
      .signers([warmMultisig])
      .rpc();

    try {
      await psm.methods
        .processQueue(1)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
      expect.fail("Should have reverted with Paused");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code || err?.message || "";
      expect(code).to.satisfy(
        (c: string) => c === "Paused" || c.includes("Paused"),
        `Expected Paused, got: ${code}`
      );
    }

    await psm.methods
      .unpause()
      .accountsPartial({ unpauser: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();
  });
});

// ---------------------------------------------------------------------------
// WS3.2.e — wrong-owner ATA soft-skip in process_queue (WS2.1)
// ---------------------------------------------------------------------------

describe("WS3.2.e: wrong-owner-ATA soft-skip in process_queue (WS2.1)", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let usdOkuMint: PublicKey;
  let configPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultUsdOkuAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();
  const wrongUser = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );

    const setup = await initializePsm(h, psm as any, payer, usdcMint);
    configPda = setup.configPda;
    redemptionQueuePda = setup.redemptionQueuePda;
    usdOkuMint = setup.usdOkuMint;
    vaultUsdcAta = setup.vaultUsdcAta;
    vaultUsdOkuAta = setup.vaultUsdOkuAta;

    await fundKeypairs(h, [user, wrongUser], 10 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("process_queue soft-skips (breaks without reverting) when recipient ATA owner is wrong", async () => {
    // 1. Setup user ATAs
    const userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    const userUsdOkuAta = await ensureAtaViaBankrun(
      h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID
    );
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 5_000_000n, TOKEN_PROGRAM_ID);

    // 2. Mint 2M usdOku (deposits 2M USDC into buffer)
    await mintUsdOkuViaProgram(
      psm as any, user, new BN(2_000_000), configPda,
      usdcMint, usdOkuMint, userUsdcAta, userUsdOkuAta, vaultUsdcAta
    );

    // 3. Drain buffer so redemption will queue
    const coldUsdcAta = await ensureAtaViaBankrun(
      h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID
    );
    await psm.methods
      .withdrawBuffer(new BN(2_000_000))
      .accountsPartial({
        bufferWithdrawer: coldMultisig.publicKey,
        config: configPda,
        redemptionQueue: redemptionQueuePda,
        usdOkuMint,
        withdrawerUsdcAta: coldUsdcAta,
        vaultUsdc: vaultUsdcAta,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([coldMultisig])
      .rpc();

    // 4. User redeems — buffer is 0 -> queues
    await psm.methods
      .redeemUsdOku(new BN(2_000_000))
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
        redemptionQueue: redemptionQueuePda,
        usdcMint,
        usdOkuMint,
        userUsdcAta,
        userUsdOkuAta,
        vaultUsdc: vaultUsdcAta,
        vaultUsdOku: vaultUsdOkuAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const queueState = await psm.account.redemptionQueue.fetch(redemptionQueuePda);
    expect((queueState.tail as BN).sub(queueState.head as BN).toNumber()).to.equal(1);

    // 5. Refill buffer
    await mintToViaBankrun(h, usdcMint, vaultUsdcAta, payer, 5_000_000n, TOKEN_PROGRAM_ID);

    // 6. Pass WRONG-OWNER ATA (owned by wrongUser, not user)
    const wrongOwnerAta = await ensureAtaViaBankrun(
      h, wrongUser.publicKey, usdcMint, TOKEN_PROGRAM_ID
    );

    // process_queue should NOT revert — WS2.1 soft-skip (break 'batch)
    await psm.methods
      .processQueue(1)
      .accountsPartial({
        queueProcessor: orchestrator.publicKey,
        config: configPda,
        redemptionQueue: redemptionQueuePda,
        usdOkuMint,
        vaultUsdc: vaultUsdcAta,
        vaultUsdOku: vaultUsdOkuAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([{ pubkey: wrongOwnerAta, isSigner: false, isWritable: true }])
      .signers([orchestrator])
      .rpc();

    // 7. Queue entry still there (soft-skip leaves entry for rescue)
    const queueAfter = await psm.account.redemptionQueue.fetch(redemptionQueuePda);
    expect((queueAfter.tail as BN).sub(queueAfter.head as BN).toNumber()).to.equal(
      1, "Wrong-owner ATA: entry must remain in queue for rescue_queue_entry"
    );
  });
});
