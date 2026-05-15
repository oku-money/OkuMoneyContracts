/**
 * Pyth Oracle Tests — bankrun variant.
 *
 * Mirror of `tests/fork/pyth-oracle.ts` but runs entirely in-process: we
 * inject a hand-built Pyth V2 PriceAccount fixture into the bankrun
 * cluster via `setAccount`, rotate the PSM's accepted `pyth_program_owner`
 * to a test pubkey we control, and exercise the same `mint_oku_m` paths
 * the validator-mode fork test does.
 *
 * Why both runners?
 *
 * - The surfpool fork test (`tests/fork/pyth-oracle.ts`) hits the live
 *   mainnet Pyth feed and is the integration-correctness anchor — it
 *   catches Pyth layout drift before it can hit production.
 * - This bankrun variant runs on every CI invocation (~300 ms) and
 *   protects against parser regressions without requiring an external
 *   process.
 *
 * If the hand-built fixture here diverges from what mainnet actually
 * publishes, the fork test will catch it (when run on demand).
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

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// Pyth V2 PriceAccount fixture builder
// ---------------------------------------------------------------------------
//
// Byte layout (annotated in programs/lite-psm/src/helpers/oracle.rs):
//
//   offset 0..4    magic = 0xa1b2c3d4
//   offset 4..8    ver   = 2
//   offset 8..12   atype = 3 (Price)
//   offset 12..16  size
//   offset 20..24  expo  = 0 (raw base units)
//   offset 96..104 timestamp (i64 unix seconds; aggregate publish time)
//   offset 208..216 agg.price (i64; scaled by 10^expo, so raw token count
//                   when expo == 0)
//   offset 224     agg.status (u8; 1 = Trading)
//   offset 232..240 agg.pub_slot (read but unused by our parser)
//
// Anything outside these fields can be zero-padded.

const PYTH_PRICE_ACCOUNT_LEN = 3312; // canonical SolanaPriceAccount size
const PYTH_MAGIC = 0xa1b2c3d4;

/**
 * Pyth V2 status values — only `Trading` (1) is accepted by the parser.
 * Match the canonical `PriceStatus` enum.
 */
const enum PythStatus {
  Unknown = 0,
  Trading = 1,
  Halted = 2,
  Auction = 3,
}

function buildPythFixture(opts: {
  unixTimestamp: bigint;
  priceRawBaseUnits: bigint;
  status?: PythStatus;
  pubSlot?: bigint;
}): Uint8Array {
  const buf = Buffer.alloc(PYTH_PRICE_ACCOUNT_LEN);
  // header
  buf.writeUInt32LE(PYTH_MAGIC, 0);
  buf.writeUInt32LE(2, 4); // ver
  buf.writeUInt32LE(3, 8); // atype = Price
  buf.writeUInt32LE(PYTH_PRICE_ACCOUNT_LEN, 12); // size (not validated, but real Pyth fills it)
  // expo = 0 — required by parser
  buf.writeInt32LE(0, 20);
  // aggregate publish timestamp (i64)
  buf.writeBigInt64LE(opts.unixTimestamp, 96);
  // agg.price (i64)
  buf.writeBigInt64LE(opts.priceRawBaseUnits, 208);
  // agg.conf (u64) — required for size but unused
  buf.writeBigUInt64LE(0n, 216);
  // agg.status (u8)
  buf.writeUInt8(opts.status ?? PythStatus.Trading, 224);
  // agg.corp_act (u8) — unused but kept zero
  buf.writeUInt8(0, 225);
  // agg.pub_slot (u64)
  buf.writeBigUInt64LE(opts.pubSlot ?? 1n, 232);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Pyth oracle (bankrun)", () => {
  // We pick a dedicated keypair as the "pyth program" — the program just
  // requires the price account's owner field to match the configured
  // `pyth_program_owner`, so any keypair will do.
  const pythProgramOwner = Keypair.generate();
  const pythPriceAccountKey = Keypair.generate().publicKey;

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

  /**
   * Run `mint_oku_m` against the current fixture and assert that the
   * program rejects with `expectedCode`. Searches the full surface of
   * Anchor/bankrun error shapes (message, transactionMessage, logs,
   * errorCode.code, and the serialised object) since pre-existing
   * mocha test ordering can change which of those fields is populated.
   */
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
          priceUpdate: pythPriceAccountKey,
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

  /** Helper to write/refresh the Pyth fixture at the configured price-account address. */
  function setPythAccount(data: Uint8Array): void {
    h.context.setAccount(pythPriceAccountKey, {
      lamports: 1_000_000_000, // ample rent-exempt buffer
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
      [Buffer.from("psm_config")],
      program.programId
    );

    // Create mints + initialize PSM (same pattern as lite-psm bankrun tests).
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

    vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      configPda,
      true,
      TOKEN_PROGRAM_ID
    );

    // User ATAs + USDC funding.
    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    userOkuMoneyAta = await ensureAtaViaBankrun(
      h,
      user.publicKey,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID
    );
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);

    // Rotate the PSM's accepted pyth_program_owner to the test keypair.
    await program.methods
      .setPythProgramOwner(pythProgramOwner.publicKey)
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
      })
      .signers([coldMultisig])
      .rpc();

    // Configure the PSM's `oracle` pubkey + a permissive staleness threshold
    // (300 s — well within `ORACLE_MIN_STALENESS_SECS..ORACLE_MAX_STALENESS_SECS`).
    await program.methods
      .setOracle(pythPriceAccountKey, new BN(300))
      .accountsPartial({
        oracleManager: coldMultisig.publicKey,
        config: configPda,
      })
      .signers([coldMultisig])
      .rpc();
  });

  beforeEach(async () => {
    // Refresh the Pyth fixture against the *current* bankrun clock each test.
    // Tests that need staleness behavior override this fixture themselves.
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        // 10^14 base units of OkuMoney supply backing — way larger than
        // anything the test mints.
        priceRawBaseUnits: 100_000_000_000_000n,
        status: PythStatus.Trading,
      })
    );
  });

  it("mint_oku_m succeeds when oracle reports sufficient reserves", async () => {
    const mintAmount = new BN(5_000_000); // 5 OkuMoney
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
        priceUpdate: pythPriceAccountKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // No explicit assertion beyond "the rpc succeeded" — the program-level
    // checks (status == Trading, reserves >= supply, age <= staleness) all
    // ran inside the BPF call.
  });

  it("mint_oku_m rejects when oracle is stale", async () => {
    // Set the fixture's publish_time *into the past* by 400 s — exceeds the
    // 300 s staleness threshold configured in `before()`.
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp - 400n,
        priceRawBaseUnits: 100_000_000_000_000n,
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
        priceRawBaseUnits: 100_000_000_000_000n,
        status: PythStatus.Halted,
      })
    );

    await expectMintError("InvalidOracleResponse");
  });

  it("mint_oku_m rejects when reserves are below supply + mint", async () => {
    // Squeeze reserves down to something tiny.
    const clock = await h.context.banksClient.getClock();
    setPythAccount(
      buildPythFixture({
        unixTimestamp: clock.unixTimestamp,
        priceRawBaseUnits: 1n,
        status: PythStatus.Trading,
      })
    );

    await expectMintError("InsufficientReserves");
  });
});
