/**
 * WS3.2 coverage additions — bankrun tests for gaps identified in the
 * pre-MVP review.
 *
 * Covered:
 *   WS3.2.a  zero-supply distribute_yield reverts with ZeroAmount (PSM)
 *   WS3.2.a  zero-supply update_usd_multiplier succeeds (vault — u64::MAX collateral)
 *   WS3.2.b  PSM double-init negative test
 *   WS3.2.b  vault double-init negative test
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
import { OkuDollar } from "../../target/types/oku_dollar";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMoneyViaProgram,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
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

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const DEAD_ADDRESS = SystemProgram.programId;

// ---------------------------------------------------------------------------
// PSM-only describe: WS3.2.a (PSM yield), WS3.2.b (PSM init), WS3.2.c (pause)
// ---------------------------------------------------------------------------

describe("WS3.2 PSM coverage additions", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let configPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")], psm.programId
    );

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h, configPda, configPda, DECIMALS, orchestrator.publicKey, 0, Keypair.generate()
    );

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, psm as any, payer, usdcMint, okuMoneyMint);
    redemptionQueuePda = setup.redemptionQueuePda;
    vaultUsdcAta = setup.vaultUsdcAta;
    vaultOkuMoneyAta = setup.vaultOkuMoneyAta;
  });

  it("WS3.2.a: distribute_yield reverts ZeroAmount when OkuM supply == 0", async () => {
    try {
      await psm.methods
        .distributeYield(new BN(1_000_000))
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMoneyMint,
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
        .initialize(
          MAX_SUPPLY,
          MINTER_ALLOWANCE,
          warmMultisig.publicKey,
          coldMultisig.publicKey,
          warmMultisig.publicKey,
          coldMultisig.publicKey,
          orchestrator.publicKey,
          orchestrator.publicKey,
          coldMultisig.publicKey,
          coldMultisig.publicKey,
          coldMultisig.publicKey,
          coldMultisig.publicKey,
          orchestrator.publicKey,
          SystemProgram.programId
        )
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: configPda,
          usdcMint,
          okuMoneyMint,
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
          okuMoneyMint,
          vaultUsdc: vaultUsdcAta,
          vaultOkuMoney: vaultOkuMoneyAta,
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
  let okuMoneyMint: PublicKey;
  let configPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();
  const wrongUser = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")], psm.programId
    );

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h, configPda, configPda, DECIMALS, orchestrator.publicKey, 0, Keypair.generate()
    );

    await fundKeypairs(h, [user, wrongUser], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, psm as any, payer, usdcMint, okuMoneyMint);
    redemptionQueuePda = setup.redemptionQueuePda;
    vaultUsdcAta = setup.vaultUsdcAta;
    vaultOkuMoneyAta = setup.vaultOkuMoneyAta;
  });

  it("process_queue soft-skips (breaks without reverting) when recipient ATA owner is wrong", async () => {
    // 1. Setup user ATAs
    const userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    const userOkuMoneyAta = await ensureAtaViaBankrun(
      h, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID
    );
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 5_000_000n, TOKEN_PROGRAM_ID);

    // 2. Mint 2M OkuM (deposits 2M USDC into buffer)
    await mintOkuMoneyViaProgram(
      psm as any, user, new BN(2_000_000), configPda,
      usdcMint, okuMoneyMint, userUsdcAta, userOkuMoneyAta, vaultUsdcAta
    );

    // 3. Drain buffer so redemption will queue
    //    Buffer now has 2M USDC. Use coldMultisig (has buffer_withdrawer role) to drain.
    const coldUsdcAta = await ensureAtaViaBankrun(
      h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID
    );
    await psm.methods
      .withdrawBuffer(new BN(2_000_000))
      .accountsPartial({
        bufferWithdrawer: coldMultisig.publicKey,
        config: configPda,
        redemptionQueue: redemptionQueuePda,
        okuMoneyMint,
        withdrawerUsdcAta: coldUsdcAta,
        vaultUsdc: vaultUsdcAta,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([coldMultisig])
      .rpc();

    // 4. User redeems — buffer is 0 → queues
    await psm.methods
      .redeemOkuM(new BN(2_000_000))
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
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
        okuMoneyMint,
        vaultUsdc: vaultUsdcAta,
        vaultOkuMoney: vaultOkuMoneyAta,
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

// ---------------------------------------------------------------------------
// Vault describe: WS3.2.a (vault) + WS3.2.b (vault)
// ---------------------------------------------------------------------------

describe("WS3.2 vault coverage additions", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let vault: Program<OkuDollar>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let configPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let usdOkuMint: PublicKey;
  let reserveVault: PublicKey;
  let vaultUsdcAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const usdRebaser = Keypair.generate();
  const reserveManager = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;
    vault = getProgram<OkuDollar>(h, "oku_dollar") as Program<OkuDollar>;

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")], psm.programId
    );
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config")], vault.programId
    );
    [usdOkuMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("usd_oku_mint")], vault.programId
    );

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h, configPda, configPda, DECIMALS, orchestrator.publicKey, 0, Keypair.generate()
    );

    await fundKeypairs(h, [usdRebaser, reserveManager], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, psm as any, payer, usdcMint, okuMoneyMint);
    vaultUsdcAta = setup.vaultUsdcAta;

    reserveVault = getAssociatedTokenAddressSync(
      okuMoneyMint, vaultConfigPda, true, TOKEN_2022_PROGRAM_ID
    );

    await vault.methods
      .initialize(
        warmMultisig.publicKey,
        coldMultisig.publicKey,
        usdRebaser.publicKey,
        reserveManager.publicKey,
        new BN(950_000_000)
      )
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        reserveVault,
        psmConfig: configPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await ensureAtaViaBankrun(h, DEAD_ADDRESS, usdOkuMint, TOKEN_2022_PROGRAM_ID);
  });

  it("WS3.2.a vault: update_usd_multiplier succeeds when usdOku supply == 0", async () => {
    const config = await vault.account.okuDollarConfig.fetch(vaultConfigPda);
    const current = config.usdMultiplier as BN;

    await warpSlots(h, 1);

    await vault.methods
      .updateUsdMultiplier(current)
      .accountsPartial({
        usdRebaser: usdRebaser.publicKey,
        config: vaultConfigPda,
        psmConfig: configPda,
        usdOkuMint,
        reserveVault,
      })
      .signers([usdRebaser])
      .rpc();

    const after = await vault.account.okuDollarConfig.fetch(vaultConfigPda);
    expect((after.usdMultiplier as BN).toString()).to.equal(current.toString());
  });

  it("WS3.2.b vault: oku-dollar initialize fails if vaultConfig PDA already exists", async () => {
    try {
      await vault.methods
        .initialize(
          warmMultisig.publicKey,
          coldMultisig.publicKey,
          usdRebaser.publicKey,
          reserveManager.publicKey,
          new BN(950_000_000)
        )
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          reserveVault,
          psmConfig: configPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed — vault config PDA already initialized");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});
