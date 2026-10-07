/**
 * PSM init-time mint-extension validation tests.
 *
 * `initialize` creates the OkuM mint with Token-2022 extensions:
 *   - ScaledUiAmount (multiplier for yield accrual)
 *   - MetadataPointer (points to the mint itself)
 *   - TokenMetadata (name, symbol, URI)
 *
 * This test verifies the mint is created with the correct extensions
 * and an initial multiplier of 1.0.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  MINT_SIZE,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  startBankrun,
  BankrunHarness,
  createMintViaBankrun,
  seedProgramData,
  programDataAddress,
  fundKeypairs,
  readDisplayMultiplier,
} from "../shared/bankrun";
import { initializePsm, DECIMALS, MAX_SUPPLY, MINTER_ALLOWANCE } from "../shared/setup";


describe("init invariants (OkuM mint extensions)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  let payer: Keypair;

  before(async () => {
    h = await startBankrun();
    program = h.program;
    payer = h.payer;
  });

  it("initialize creates the OkuM mint with ScaledUiAmount, MetadataPointer, and TokenMetadata extensions and initial multiplier of 1.0", async () => {
    // Standard USDC mint
    const usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM — creates PsmConfig + USDC vault + OkuM mint
    // (the program creates the Token-2022 mint with extensions via CPI)
    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    const { okuMMint, configPda } = psmSetup;

    // Verify the OkuM mint was created as a Token-2022 mint
    const mintAcctInfo = await h.provider.connection.getAccountInfo(okuMMint);
    expect(mintAcctInfo, "OkuM mint account should exist").to.not.be.null;
    expect(mintAcctInfo!.owner.equals(TOKEN_2022_PROGRAM_ID)).to.be.true;

    // The test name promises THREE SPECIFIC extensions. `data.length >
    // MINT_SIZE` is satisfied by any one of them, so assert each by its TLV
    // discriminator instead.
    expect(mintAcctInfo!.data.length).to.be.greaterThan(MINT_SIZE);
    const tlvTypes = new Set<number>();
    {
      const d = mintAcctInfo!.data;
      let i = 166; // 82 mint + 83 padding + 1 account type
      while (i + 4 <= d.length) {
        const t = d[i] | (d[i + 1] << 8);
        const len = d[i + 2] | (d[i + 3] << 8);
        if (t === 0 && len === 0) break;
        tlvTypes.add(t);
        i += 4 + len;
      }
    }
    expect(tlvTypes.has(25), "ScaledUiAmount extension missing").to.be.true;
    expect(tlvTypes.has(18), "MetadataPointer extension missing").to.be.true;
    expect(tlvTypes.has(19), "TokenMetadata extension missing").to.be.true;

    // Parse the mint and verify basic properties
    const mintData = unpackMint(okuMMint, mintAcctInfo!, TOKEN_2022_PROGRAM_ID);
    expect(mintData.mintAuthority?.equals(configPda)).to.be.true;
    expect(Number(mintData.decimals)).to.equal(DECIMALS);

    // The initial multiplier the test name promises.
    const display = await readDisplayMultiplier(h, okuMMint);
    expect(display.effective, "mint must start at a 1.0 display multiplier").to.equal(1.0);

    // Verify PsmConfig references the correct OkuM mint
    const config = await program.account.psmConfig.fetch(configPda);
    expect(config.okuMMint.equals(okuMMint)).to.be.true;
  });

  // Base set of valid granular-authority params, matching `initializePsm`
  // in shared/setup.ts. The `authority validation` tests below override
  // exactly one field with an invalid value and expect `initialize` to
  // revert with `InvalidAuthority` before any state is written; the
  // `deploy-authority gate` tests use it unmodified.
  //
  // Declared at THIS level, not inside `authority validation`: scoped there,
  // the deploy-authority tests would throw a ReferenceError with no
  // `error.errorCode`, and their negative assertions would pass vacuously.
  function baseParams(warm: PublicKey, cold: PublicKey, orchestrator: PublicKey) {
    return {
      maxSupply: MAX_SUPPLY,
      minterAllowance: MINTER_ALLOWANCE,
      pauser: warm,
      unpauser: cold,
      freezer: warm,
      unfreezer: cold,
      bufferDepositor: orchestrator,
      bufferWithdrawer: cold,
      capManager: cold,
      allowanceManager: cold,
      rebaser: orchestrator,
      okuMUri: "",
    };
  }

  describe("authority validation", () => {
    async function attemptInitialize(
      params: ReturnType<typeof baseParams>
    ): Promise<void> {
      const usdcMint = await createMintViaBankrun(
        h,
        payer.publicKey,
        null,
        6,
        Keypair.generate(),
        TOKEN_PROGRAM_ID
      );
      const okuMMintKeypair = Keypair.generate();
      const okuMMint = okuMMintKeypair.publicKey;
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("psm_config")],
        program.programId
      );
      const vaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        configPda,
        true,
        TOKEN_PROGRAM_ID
      );

      // `initialize` requires its signer to be the program's upgrade
      // authority; bankrun creates no ProgramData account, so seed one.
      await seedProgramData(h, program.programId, payer.publicKey);

      await program.methods
        .initialize(params)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          programData: programDataAddress(program.programId),
          config: configPda,
          usdcMint,
          okuMMint,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([okuMMintKeypair])
        .rpc();
    }

    it("rejects a zero-pubkey granular authority (pauser)", async () => {
      // Fresh cluster per test — PsmConfig is a singleton PDA and
      // initialize() can only run once per program deployment.
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      params.pauser = PublicKey.default;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected zero-pubkey pauser");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("rejects a zero-pubkey granular authority (rebaser)", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      params.rebaser = PublicKey.default;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected zero-pubkey rebaser");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("rejects a granular authority collapsed into role_admin", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      // roleAdmin in attemptInitialize is `payer.publicKey` — collapse
      // `bufferWithdrawer` into it to exercise the separation-of-duties
      // guard (mirrors `set_authority`'s equivalent check).
      params.bufferWithdrawer = payer.publicKey;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected authority collapsed into role_admin");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("accepts fully valid, distinct granular authorities (control case)", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);

      // Should not throw.
      await attemptInitialize(params);
    });
  });

  // ── Deploy-authority gate ────────────────────────────────────────────────
  //
  // `initialize` is otherwise a land-grab: `PsmConfig` is a singleton PDA at
  // ["psm_config"], deploy and initialize are necessarily separate
  // transactions, and there is no `close_config` or re-init path. Whoever
  // landed it first would own `role_admin` permanently AND choose
  // `usdc_mint` — for which only the decimal count is checked, so an
  // attacker-controlled fake mint passes. The program now requires the
  // signer to be its own BPF upgrade authority.

  describe("deploy-authority gate", () => {
    async function attemptInitializeAs(
      roleAdmin: Keypair,
      upgradeAuthority: PublicKey,
      programDataOverride?: PublicKey
    ): Promise<void> {
      const usdcMint = await createMintViaBankrun(
        h,
        payer.publicKey,
        null,
        6,
        Keypair.generate(),
        TOKEN_PROGRAM_ID
      );
      const okuMMintKeypair = Keypair.generate();
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("psm_config")],
        program.programId
      );
      const vaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        configPda,
        true,
        TOKEN_PROGRAM_ID
      );

      await seedProgramData(h, program.programId, upgradeAuthority);

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;

      await program.methods
        .initialize(baseParams(warm, cold, orchestrator))
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          programData: programDataOverride ?? programDataAddress(program.programId),
          config: configPda,
          usdcMint,
          okuMMint: okuMMintKeypair.publicKey,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([okuMMintKeypair, roleAdmin])
        .rpc();
    }

    it("rejects a signer who is NOT the program's upgrade authority", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const attacker = Keypair.generate();
      await fundKeypairs(h, [attacker], 10 * LAMPORTS_PER_SOL);

      // ProgramData names the legitimate deployer; the attacker signs.
      try {
        await attemptInitializeAs(attacker, payer.publicKey);
        expect.fail("Should have rejected a non-upgrade-authority initializer");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("Unauthorized");
      }
    });

    it("rejects a ProgramData account belonging to a DIFFERENT program", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      // Attacker controls some other program and is its upgrade authority.
      // Substituting its ProgramData must not satisfy the check — the
      // address is pinned to THIS program's PDA on-chain.
      const attacker = Keypair.generate();
      await fundKeypairs(h, [attacker], 10 * LAMPORTS_PER_SOL);
      const foreignProgramId = Keypair.generate().publicKey;
      await seedProgramData(h, foreignProgramId, attacker.publicKey);

      try {
        await attemptInitializeAs(
          attacker,
          attacker.publicKey,
          programDataAddress(foreignProgramId)
        );
        expect.fail("Should have rejected a foreign program's ProgramData");
      } catch (err: any) {
        // Anchor's `address =` constraint surfaces as ConstraintAddress.
        expect(["Unauthorized", "ConstraintAddress"]).to.include(
          err?.error?.errorCode?.code
        );
      }
    });

    it("accepts the program's actual upgrade authority (control case)", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      // Should not throw: signer IS the named upgrade authority.
      await attemptInitializeAs(payer, payer.publicKey);
    });
  });
});
