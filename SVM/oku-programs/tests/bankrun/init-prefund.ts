/**
 * Regression for Cyfrin audit findings #8 and #22: `initialize` cannot be blocked
 * by funding addresses it will use before it runs.
 *
 *  #8  the config PDA's USDC vault is an ATA that anyone can create first. A plain
 *      `init` failed on it and bricked the program ID until an upgrade; it is now
 *      `init_if_needed` (validated against mint, owner and canonical address).
 *  #22 the OkuM mint keypair's public key is visible in the pending transaction,
 *      so anyone can send it lamports first, which made `create_account` fail with
 *      `AccountAlreadyInUse`. The handler now tops up only the shortfall, then
 *      allocates and assigns.
 */
import * as anchor from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import { expect } from "chai";
import { DECIMALS, initializePsm } from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  getLamports,
} from "../shared/bankrun";

const { Keypair, PublicKey, SystemProgram, Transaction } = anchor.web3;

describe("initialize cannot be blocked by pre-funding (audit #8, #22)", () => {
  let h: BankrunHarness;
  let usdcMint: anchor.web3.PublicKey;
  let configPda: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  const attacker = Keypair.generate();

  beforeEach(async () => {
    h = await startBankrun();
    await fundKeypairs(h, [attacker], 10 * anchor.web3.LAMPORTS_PER_SOL);
    usdcMint = await createMintViaBankrun(
      h,
      h.payer.publicKey,
      h.payer.publicKey,
      DECIMALS,
      Keypair.generate(),
      TOKEN_PROGRAM_ID
    );
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("psm_config")], h.program.programId);
    vault = getAssociatedTokenAddressSync(usdcMint, configPda, true, TOKEN_PROGRAM_ID);
  });

  const preCreateVault = async () => {
    await h.provider.sendAndConfirm!(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(attacker.publicKey, vault, configPda, usdcMint, TOKEN_PROGRAM_ID)
      ),
      [attacker]
    );
  };
  const prefund = async (to: anchor.web3.PublicKey, lamports: number) => {
    await h.provider.sendAndConfirm!(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: to, lamports })
      ),
      [attacker]
    );
  };

  /** The mint is a correct Token-2022 mint with both extensions, rent-exempt, owned by the config. */
  const expectCorrectMint = async (okuMMint: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(okuMMint);
    expect(info, "mint exists").to.not.equal(null);
    expect(new PublicKey(info!.owner).toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    const mint = await getMint(h.provider.connection, okuMMint, undefined, TOKEN_2022_PROGRAM_ID);
    expect(mint.decimals).to.equal(6);
    expect(mint.mintAuthority!.toBase58()).to.equal(configPda.toBase58());
    expect(mint.freezeAuthority!.toBase58()).to.equal(configPda.toBase58());
    const ext = getExtensionTypes(mint.tlvData);
    expect(ext).to.include(ExtensionType.ScaledUiAmountConfig);
    expect(ext).to.include(ExtensionType.MetadataPointer);
    const rent = await h.context.banksClient.getRent();
    expect(BigInt(info!.lamports) >= rent.minimumBalance(BigInt(info!.data.length))).to.equal(true);
  };

  it("#8: a vault created beforehand by anyone does not block initialize", async () => {
    await preCreateVault();
    const { okuMMint, vaultUsdcAta } = await initializePsm(h, h.program, h.payer, usdcMint);

    const cfg = await h.program.account.psmConfig.fetch(configPda);
    expect(cfg.vaultUsdc.toBase58()).to.equal(vault.toBase58());
    expect(vaultUsdcAta.toBase58()).to.equal(vault.toBase58());
    expect(cfg.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
    const acct = await getAccount(h.provider.connection, vault, undefined, TOKEN_PROGRAM_ID);
    expect(acct.owner.toBase58()).to.equal(configPda.toBase58());
    expect(acct.delegate).to.equal(null);
    expect(acct.closeAuthority).to.equal(null);
    await expectCorrectMint(okuMMint);
  });

  it("#8: USDC an attacker deposits into the vault first is just buffer", async () => {
    await preCreateVault();
    await mintToViaBankrun(h, usdcMint, vault, h.payer, 1_234_567, TOKEN_PROGRAM_ID);
    await initializePsm(h, h.program, h.payer, usdcMint);

    const acct = await getAccount(h.provider.connection, vault, undefined, TOKEN_PROGRAM_ID);
    expect(acct.amount).to.equal(1_234_567n);
    const cfg = await h.program.account.psmConfig.fetch(configPda);
    expect(cfg.vaultUsdc.toBase58()).to.equal(vault.toBase58());
  });

  // A transfer to an empty system account must leave it rent-exempt for 0 bytes, so the
  // smallest pre-fund an attacker can make is 890,880 lamports (~0.00089 SOL).
  const MIN_PREFUND = 890_880;
  for (const [label, lamports] of [
    ["the minimum an attacker can send", MIN_PREFUND],
    ["less than the mint's rent", 1_000_000],
    ["more than the full rent", 5 * anchor.web3.LAMPORTS_PER_SOL],
  ] as Array<[string, number]>) {
    it(`#22: an OkuM mint address pre-funded with ${label} does not block initialize`, async () => {
      expect(
        (await h.context.banksClient.getRent()).minimumBalance(0n) <= BigInt(MIN_PREFUND),
        "MIN_PREFUND is the real minimum"
      ).to.equal(true);
      const mintKp = Keypair.generate();
      await prefund(mintKp.publicKey, lamports);
      expect(await getLamports(h, mintKp.publicKey)).to.equal(BigInt(lamports));

      const { okuMMint } = await initializePsm(h, h.program, h.payer, usdcMint, undefined, mintKp);
      expect(okuMMint.toBase58()).to.equal(mintKp.publicKey.toBase58());
      await expectCorrectMint(okuMMint);
      const cfg = await h.program.account.psmConfig.fetch(configPda);
      expect(cfg.okuMMint.toBase58()).to.equal(mintKp.publicKey.toBase58());
      // Nothing is lost: an over-funded address keeps its extra lamports.
      if (lamports > 1_000_000_000) {
        expect((await getLamports(h, okuMMint)) >= BigInt(lamports)).to.equal(true);
      }
    });
  }

  it("#8 + #22 together", async () => {
    const mintKp = Keypair.generate();
    await preCreateVault();
    await prefund(mintKp.publicKey, MIN_PREFUND);
    const { okuMMint } = await initializePsm(h, h.program, h.payer, usdcMint, undefined, mintKp);
    await expectCorrectMint(okuMMint);
  });

  it("#22: a mint address that already holds an account of another program is still refused", async () => {
    // Pre-funding is tolerated; an address that is already an initialized account is not.
    const mintKp = Keypair.generate();
    h.context.setAccount(mintKp.publicKey, {
      lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
      data: new Uint8Array(82),
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      rentEpoch: 0,
    });
    let failed = false;
    try {
      await initializePsm(h, h.program, h.payer, usdcMint, undefined, mintKp);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(await h.context.banksClient.getAccount(configPda), "atomic: no config left behind").to.equal(null);
  });
});
