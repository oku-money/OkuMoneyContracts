/**
 * Regression for Cyfrin audit finding #2. No program change: the mitigation is
 * the deployment ceremony and the laggard runbook (README § Opening PSM minting
 * on a chain, § Chain lagging the fleet). These tests pin the program
 * properties that ceremony relies on:
 *   - `initialize` with `minter_allowance = 0` (the mainnet deploy) closes
 *     `mint_oku_m`;
 *   - while closed and unpaused, `set_okum_multiplier` and yielding rate writes
 *     work, so the chain can be brought to the fleet's multiplier before any mint;
 *   - `set_minter_allowance` works while paused, so a lagging chain can be
 *     paused (warm), closed, and unpaused for redemptions while it catches up;
 *   - redemptions never reopen a configured zero.
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
import { PRECISION, catchUpRate, ratePerSecondForApy } from "@okumoney/yield-tooling";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  computeCanonicalMultiplier,
  expectBankrunError,
  getClock,
  warpBy,
  warpSlots,
} from "../shared/bankrun";

const { Keypair, SystemProgram } = anchor.web3;

describe("psm minting closed until seeded (audit #2)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  const user = Keypair.generate();
  const usdcMintKeypair = Keypair.generate();

  let configPda: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let okuMMint: anchor.web3.PublicKey;
  let vaultUsdcAta: anchor.web3.PublicKey;
  let userUsdcAta: anchor.web3.PublicKey;
  let userOkuMAta: anchor.web3.PublicKey;

  const POLICY_ALLOWANCE = 10_000_000_000_000n;
  const DAY = 86_400;

  before(async () => {
    h = await startBankrun();
    program = h.program;

    usdcMint = await createMintViaBankrun(
      h,
      h.payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );
    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);

    // The mainnet deploy: initialize with PSM minting closed.
    const setup = await initializePsm(h, program, h.payer, usdcMint, new BN(0));
    configPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    userOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, userUsdcAta, h.payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
  });

  const accts = () => ({
    user: user.publicKey,
    config: configPda,
    usdcMint,
    okuMMint,
    userUsdcAta,
    userOkuMAta,
    vaultUsdc: vaultUsdcAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const mint = (usdc: bigint) =>
    program.methods
      .mintOkuM(new BN(usdc.toString()))
      .accountsPartial(accts())
      .signers([user])
      .rpc();
  const redeem = (raw: bigint) =>
    program.methods
      .redeemOkuM(new BN(raw.toString()), new BN(0))
      .accountsPartial(accts())
      .signers([user])
      .rpc();
  const setAllowance = (amount: bigint) =>
    program.methods
      .setMinterAllowance(new BN(amount.toString()))
      .accountsPartial({ allowanceManager: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();
  const setRate = (rate: bigint, end: number) =>
    program.methods
      .setOkumYieldRate(new BN(rate.toString()), new BN(end))
      .accountsPartial({ rateManager: psmOrchestrator.publicKey, config: configPda })
      .signers([psmOrchestrator])
      .rpc();
  const pause = () =>
    program.methods
      .pause()
      .accountsPartial({ pauser: warmMultisig.publicKey, config: configPda })
      .signers([warmMultisig])
      .rpc();
  const unpause = () =>
    program.methods
      .unpause()
      .accountsPartial({ unpauser: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();
  const fetchConfig = () => program.account.psmConfig.fetch(configPda);
  const now = async () => Number((await getClock(h)).unixTimestamp);
  const multiplier = () => computeCanonicalMultiplier(h, program, configPda);
  const okuMBalance = async () =>
    (await getAccount(h.provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID)).amount;

  it("initialize leaves the PSM unpaused with minting closed at a 1.00 multiplier", async () => {
    const cfg = await fetchConfig();
    expect(cfg.isPaused).to.equal(false);
    expect(cfg.minterAllowance.toString()).to.equal("0");
    expect(cfg.minterAllowanceLimit.toString()).to.equal("0");
    expect(await multiplier()).to.equal(PRECISION);
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    await expectBankrunError(() => mint(10_000_000n), "AllowanceExceeded");
  });

  it("the multiplier can be seeded to the fleet's while closed, then minting opened", async () => {
    // Override to the leader's 1.05, then a yielding rate, all with minting closed.
    const fleet = 1_050_000_000_000_000_000n;
    await program.methods
      .setOkumMultiplier(new BN(fleet.toString()))
      .accountsPartial({
        rateManager: psmOrchestrator.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([psmOrchestrator])
      .rpc();
    await warpSlots(h, 1);
    await setRate(ratePerSecondForApy(0.05), (await now()) + DAY);
    await expectBankrunError(() => mint(10_000_000n), "AllowanceExceeded");

    await setAllowance(POLICY_ALLOWANCE);
    const m = await multiplier();
    expect(m >= fleet).to.equal(true);
    await mint(10_000_000n);
    // Bought at (at least) the fleet's multiplier, never at 1.00.
    expect(await okuMBalance()).to.equal((10_000_000n * PRECISION) / m);
  });

  it("a lagging chain is closed (pause, zero while paused, unpause) and redeems stay open", async () => {
    await pause();
    await setAllowance(0n); // set_minter_allowance is not pause-gated
    await unpause();
    expect((await fetchConfig()).minterAllowance.toString()).to.equal("0");

    await expectBankrunError(() => mint(10_000_000n), "AllowanceExceeded");

    const half = (await okuMBalance()) / 2n;
    await redeem(half);
    expect((await fetchConfig()).minterAllowance.toString()).to.equal(
      "0",
      "redeem does not reopen minting"
    );
  });

  it("the catch-up rate lands with minting closed; minting reopens once caught up", async () => {
    const cur = await multiplier();
    const target = (cur * 1_001n) / 1_000n;
    const end = (await now()) + DAY;
    const rate = catchUpRate({
      currentMultiplier: cur,
      targetMultiplier: target,
      windowSeconds: BigInt(DAY),
    });
    await setRate(rate, end);
    await expectBankrunError(() => mint(10_000_000n), "AllowanceExceeded");

    await warpBy(h, DAY);
    expect((await multiplier()) >= target).to.equal(true);
    await setAllowance(POLICY_ALLOWANCE);
    await mint(10_000_000n);
  });
});
