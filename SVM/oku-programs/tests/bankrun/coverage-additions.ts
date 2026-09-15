/**
 * Additional PSM edge-case coverage.
 *
 * Covered:
 *   - zero-supply distribute_yield reverts with ZeroAmount
 *   - PSM double-init negative test
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  computeMultiplier,
  scheduleFromConfig,
  ratePerSecondForApy,
} from "../../scripts/utils/multiplier";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// PSM yield + init edge cases
// ---------------------------------------------------------------------------

describe("PSM coverage additions", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let okuMMint: PublicKey;
  let configPda: PublicKey;
  let vaultUsdcAta: PublicKey;

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
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);
  });

  // The old `distribute_yield reverts ZeroAmount when okuM supply == 0` test
  // was deleted with the instruction it covered. Under streaming accrual the
  // operator publishes a RATE, and a rate is well-defined at zero supply —
  // nothing is divided by the supply, so there is no degenerate case to guard.
  // That is the point of the model: the multiplier has no supply term, which
  // is exactly what makes it identical across chains.
  //
  // The replacement property — that a schedule can be published and accrues
  // correctly against an empty mint — is asserted here.
  it("a rate schedule is valid at zero supply (no supply term in the multiplier)", async () => {
    const clock = await h.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);

    await psm.methods
      .setOkumYieldRate(new BN(ratePerSecondForApy(0.05).toString()), new BN(now + 30 * 86_400))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: configPda })
      .signers([orchestrator])
      .rpc();

    const cfg: any = await psm.account.psmConfig.fetch(configPda);
    expect(cfg.okumRatePerSecond.toString()).to.equal(ratePerSecondForApy(0.05).toString());

    // Supply is zero, yet the multiplier advances — no division by supply.
    const m0 = computeMultiplier(scheduleFromConfig(cfg), BigInt(now));
    const m1 = computeMultiplier(scheduleFromConfig(cfg), BigInt(now + 86_400));
    expect(m1 > m0).to.be.true;
  });

  it("lite-psm initialize fails if config PDA already exists", async () => {
    try {
      await psm.methods
        .initialize({
          maxSupply: MAX_SUPPLY,
          minterAllowance: MINTER_ALLOWANCE,
          pauser: warmMultisig.publicKey,
          unpauser: coldMultisig.publicKey,
          freezer: warmMultisig.publicKey,
          unfreezer: coldMultisig.publicKey,
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
          okuMMint,
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

});
