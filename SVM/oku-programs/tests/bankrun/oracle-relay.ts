/**
 * Oracle Relay (USDC peg circuit-breaker) — bankrun tests.
 *
 * Replaces the previous `pyth-oracle.ts` PoR suite. Mirror of
 * `EVM/test/oracle/OracleRelay.t.sol`: builds a Pyth-V2 `SolanaPriceAccount`
 * fixture for the USDC/USD feed, injects it into the bankrun cluster via
 * `setAccount`, rotates the PSM's `oracle_relay_pyth_program_owner` to a
 * test keypair we control, and exercises every gated path.
 *
 * Why bankrun + fork:
 *
 * - This suite runs on every CI invocation (~300 ms) and protects against
 *   parser regressions without requiring an external process.
 * - `tests/fork/pyth-oracle.ts` hits the live mainnet Pyth USDC/USD feed
 *   via surfpool and is the integration-correctness anchor.
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
  psmOrchestrator,
  initializePsm,
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
} from "../shared/bankrun";
import {
  buildPythFixture,
  ONE_DOLLAR_AT_EXPO_M8,
  PythStatus,
} from "../shared/pythFixture";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("OracleRelay (bankrun)", () => {
  const pythProgramOwner = Keypair.generate();
  const pythFeedKey = Keypair.generate().publicKey;

  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  const user = Keypair.generate();
  const usdcMintKeypair = Keypair.generate();
  const okuMoneyMintKeypair = Keypair.generate();

  let configPda: PublicKey;
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let userUsdcAta: PublicKey;
  let userOkuMoneyAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  async function expectMintError(expectedCode: string): Promise<void> {
    let threw = false;
    try {
      await program.methods
        .mintOkuM(new BN(1_000_000))
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          usdcMint,
          okuMoneyMint,
          userUsdcAta,
          userOkuMoneyAta,
          vaultUsdc: vaultUsdcAta,
          oracleRelayFeed: pythFeedKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    } catch (err: any) {
      threw = true;
      const parts: string[] = [
        String(err?.message ?? ""),
        String(err?.transactionMessage ?? ""),
        String(err?.error?.errorCode?.code ?? ""),
        String(err?.error?.errorMessage ?? ""),
        ...(err?.logs ?? []),
      ];
      try {
        parts.push(JSON.stringify(err));
      } catch {
        /* circular */
      }
      const haystack = parts.join(" ");
      expect(haystack, `expected error matching "${expectedCode}"`).to.include(expectedCode);
    }
    expect(threw, `expected mint to fail with "${expectedCode}"`).to.equal(true);
  }

  function setPythAccount(data: Uint8Array): void {
    h.context.setAccount(pythFeedKey, {
      lamports: 1_000_000_000,
      data,
      owner: pythProgramOwner.publicKey,
      executable: false,
      rentEpoch: 0,
    });
  }

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    program = h.program;
    payer = h.payer;

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config_v3")],
      program.programId
    );

    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h,
      configPda,
      configPda,
      DECIMALS,
      psmOrchestrator.publicKey,
      0,
      okuMoneyMintKeypair
    );

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);

    await initializePsm(h, program, payer, usdcMint, okuMoneyMint);

    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, configPda, true, TOKEN_PROGRAM_ID);
    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    userOkuMoneyAta = await ensureAtaViaBankrun(
      h,
      user.publicKey,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID
    );
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);

    // Rotate the relay's accepted Pyth program owner to a test keypair we control.
    await program.methods
      .setOracleRelayPythProgramOwner(pythProgramOwner.publicKey)
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
        oracleAccount: null,
      })
      .signers([coldMultisig])
      .rpc();

    // Set a permissive staleness (300s) so the fixture isn't immediately stale.
    await program.methods
      .setOracleRelayStaleness(new BN(300))
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
        oracleAccount: null,
      })
      .signers([coldMultisig])
      .rpc();

    // Seed a valid fixture BEFORE set-feed so the pre-flight has data to read.
    const setupClock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: setupClock.unixTimestamp,
        priceRaw: ONE_DOLLAR_AT_EXPO_M8,
        status: PythStatus.Trading,
      })
    );

    // Wire the feed. Pre-flight validates magic/version/atype/owner.
    await program.methods
      .setOracleRelayFeed(pythFeedKey)
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
        oracleAccount: pythFeedKey,
      })
      .signers([coldMultisig])
      .rpc();
  });

  beforeEach(async () => {
    // Refresh fixture against the current bankrun clock each test.
    // Tests that need stale or out-of-band behavior override this.
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: ONE_DOLLAR_AT_EXPO_M8,
        status: PythStatus.Trading,
      })
    );
  });

  it("mint_oku_m succeeds when relay reports in-band price", async () => {
    const mintAmount = new BN(5_000_000);
    await program.methods
      .mintOkuM(mintAmount)
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        oracleRelayFeed: pythFeedKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  });

  it("mint_oku_m rejects when oracle is stale", async () => {
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp - 400n,
        priceRaw: ONE_DOLLAR_AT_EXPO_M8,
        status: PythStatus.Trading,
      })
    );
    await expectMintError("StaleOracle");
  });

  it("mint_oku_m rejects when oracle status is not Trading", async () => {
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: ONE_DOLLAR_AT_EXPO_M8,
        status: PythStatus.Halted,
      })
    );
    await expectMintError("InvalidOracleResponse");
  });

  it("mint_oku_m rejects when USDC depegs below the band (0.90)", async () => {
    const clock = await h.context.banksClient.getClock();
    // 0.90 USD at expo=-8 → 90_000_000
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: 90_000_000n,
        status: PythStatus.Trading,
      })
    );
    await expectMintError("PriceOutOfBand");
  });

  it("mint_oku_m rejects when USDC depegs above the band (1.10)", async () => {
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: 110_000_000n,
        status: PythStatus.Trading,
      })
    );
    await expectMintError("PriceOutOfBand");
  });

  it("mint_oku_m rejects when oracle returns a non-positive answer", async () => {
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: 0n,
        status: PythStatus.Trading,
      })
    );
    await expectMintError("NonPositiveAnswer");
  });

  it("kill switch: setting feed = default disables the peg-check", async () => {
    // Configure an out-of-band price (would normally revert with PriceOutOfBand)
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRaw: 90_000_000n, // $0.90 — below the 0.97 band
        status: PythStatus.Trading,
      })
    );

    // Disable the relay (kill switch)
    await program.methods
      .setOracleRelayFeed(PublicKey.default)
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
        oracleAccount: null,
      })
      .signers([coldMultisig])
      .rpc();

    // Mint now succeeds without supplying a feed account
    await program.methods
      .mintOkuM(new BN(1_000_000))
      .accountsPartial({
        user: user.publicKey,
        config: configPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        oracleRelayFeed: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Re-wire the feed for subsequent tests (this test runs last in the
    // suite but other suite-level tests may depend on the wired state).
    await program.methods
      .setOracleRelayFeed(pythFeedKey)
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
        oracleAccount: pythFeedKey,
      })
      .signers([coldMultisig])
      .rpc();
  });

  describe("setters: role gating + bounds", () => {
    it("set_oracle_relay_staleness rejects below ORACLE_MIN_STALENESS_SECS (60s)", async () => {
      let threw = false;
      try {
        await program.methods
          .setOracleRelayStaleness(new BN(30))
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
            oracleAccount: null,
          })
          .signers([coldMultisig])
          .rpc();
      } catch (e: any) {
        threw = true;
        expect(String(e?.error?.errorCode?.code ?? "")).to.include("InvalidStaleness");
      }
      expect(threw).to.equal(true);
    });

    it("set_oracle_relay_band rejects min outside the hard floor", async () => {
      let threw = false;
      try {
        await program.methods
          .setOracleRelayBand(new BN(900_000_000), new BN(1_030_000_000))
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
            oracleAccount: null,
          })
          .signers([coldMultisig])
          .rpc();
      } catch (e: any) {
        threw = true;
        expect(String(e?.error?.errorCode?.code ?? "")).to.include("InvalidPriceBand");
      }
      expect(threw).to.equal(true);
    });

    it("set_oracle_relay_band rejects min >= max", async () => {
      let threw = false;
      try {
        await program.methods
          .setOracleRelayBand(new BN(1_020_000_000), new BN(1_010_000_000))
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
            oracleAccount: null,
          })
          .signers([coldMultisig])
          .rpc();
      } catch (e: any) {
        threw = true;
        expect(String(e?.error?.errorCode?.code ?? "")).to.include("InvalidPriceBand");
      }
      expect(threw).to.equal(true);
    });

    it("set_oracle_relay_pyth_program_owner rejects zero pubkey", async () => {
      let threw = false;
      try {
        await program.methods
          .setOracleRelayPythProgramOwner(PublicKey.default)
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
            oracleAccount: null,
          })
          .signers([coldMultisig])
          .rpc();
      } catch (e: any) {
        threw = true;
        expect(String(e?.error?.errorCode?.code ?? "")).to.include("InvalidPythProgramOwner");
      }
      expect(threw).to.equal(true);
    });

    it("non-oracle_manager CANNOT call relay setters", async () => {
      let threw = false;
      try {
        await program.methods
          .setOracleRelayStaleness(new BN(600))
          .accountsPartial({
            oracleManager: user.publicKey, // wrong role
            config: configPda,
            oracleAccount: null,
          })
          .signers([user])
          .rpc();
      } catch {
        threw = true;
      }
      expect(threw, "expected unauthorized signer to be rejected").to.equal(true);
    });
  });
});
