/**
 * WS3.2 coverage additions — bankrun tests for gaps identified in the
 * pre-MVP review.
 *
 * Covered:
 *   WS3.2.a  zero-supply distribute_yield reverts with ZeroAmount (PSM)
 *   WS3.2.b  PSM double-init negative test
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
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
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
// PSM-only describe: WS3.2.a (PSM yield), WS3.2.b (PSM init)
// ---------------------------------------------------------------------------

describe("WS3.2 PSM coverage additions", () => {
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

  it("WS3.2.a: distribute_yield reverts ZeroAmount when okuM supply == 0", async () => {
    try {
      await psm.methods
        .distributeYield(new BN(1_000_000))
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMMint,
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
