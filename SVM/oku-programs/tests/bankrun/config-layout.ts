/**
 * Pins the raw byte layout of `PsmConfig`'s accrual fields.
 *
 * ## Why this is worth a test
 *
 * `EVM/scripts/utils/svmValue.ts` decodes these fields by hand, at fixed byte
 * offsets, rather than pulling the whole Anchor client stack into the EVM
 * package for one read. That decoder feeds SVM's contribution to the global
 * value V(t) — which is the DENOMINATOR of every derived yield rate. A silently
 * wrong offset would not throw; it would produce a plausible-looking number and
 * mis-size the rate on every chain.
 *
 * The offsets are easy to get wrong: 13 pubkeys precede the accrual block
 * (`pending_role_admin` and the two `direct_*` keys come after). This decodes a
 * REAL account with the exact offsets the EVM side uses and compares against
 * Anchor's own decoding.
 *
 * If this fails, `svmValue.ts` must be updated alongside the layout change.
 */

import * as anchor from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { initializePsm, DECIMALS } from "../shared/setup";
import { startBankrun, createMintViaBankrun } from "../shared/bankrun";

const { Keypair } = anchor.web3;

/** Must match `ACCRUAL_BASE` in `EVM/scripts/utils/svmValue.ts`. */
const ACCRUAL_BASE = 450;
/** Must match `PsmConfig::LEN`. Tail padding included. */
const EXPECTED_LEN = 754;

describe("PsmConfig byte layout (contract with EVM/scripts/utils/svmValue.ts)", () => {
  it("decodes the accrual block at the offsets the EVM tooling assumes", async () => {
    const h = await startBankrun();
    const psm = h.program;

    const usdcMint = await createMintViaBankrun(
      h,
      h.payer.publicKey,
      null,
      DECIMALS,
      Keypair.generate(),
      TOKEN_PROGRAM_ID,
    );
    const { configPda } = await initializePsm(h, psm, h.payer, usdcMint);

    const raw = await h.provider.connection.getAccountInfo(configPda);
    expect(raw, "config account not found").to.not.be.null;
    const data = raw!.data;

    expect(
      data.length,
      "PsmConfig size changed — update SVM_CONFIG_LEN in EVM/scripts/utils/svmValue.ts",
    ).to.equal(EXPECTED_LEN);

    // Manual decode, byte-for-byte identical to svmValue.ts's decoder.
    const u128 = (off: number): bigint => {
      let v = 0n;
      for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
      return v;
    };
    const manual = {
      baseMultiplier: u128(ACCRUAL_BASE),
      ratePerSecond: data.readBigUInt64LE(ACCRUAL_BASE + 16),
      lastAccrualTime: data.readBigInt64LE(ACCRUAL_BASE + 24),
      rateEnd: data.readBigInt64LE(ACCRUAL_BASE + 32),
      pendingRatePerSecond: data.readBigUInt64LE(ACCRUAL_BASE + 40),
      pendingRateEnd: data.readBigInt64LE(ACCRUAL_BASE + 48),
      lastDisplaySyncTs: data.readBigInt64LE(ACCRUAL_BASE + 56),
    };

    // Anchor's decode — the source of truth.
    const cfg: any = await psm.account.psmConfig.fetch(configPda);

    expect(manual.baseMultiplier.toString()).to.equal(
      cfg.okumBaseMultiplier.toString(),
      "okum_base_multiplier offset is wrong",
    );
    expect(manual.ratePerSecond.toString()).to.equal(
      cfg.okumRatePerSecond.toString(),
      "okum_rate_per_second offset is wrong",
    );
    expect(manual.lastAccrualTime.toString()).to.equal(
      cfg.okumLastAccrualTime.toString(),
      "okum_last_accrual_time offset is wrong",
    );
    expect(manual.rateEnd.toString()).to.equal(
      cfg.okumRateEnd.toString(),
      "okum_rate_end offset is wrong",
    );
    expect(manual.pendingRatePerSecond.toString()).to.equal(
      cfg.okumPendingRatePerSecond.toString(),
      "okum_pending_rate_per_second offset is wrong",
    );
    expect(manual.pendingRateEnd.toString()).to.equal(
      cfg.okumPendingRateEnd.toString(),
      "okum_pending_rate_end offset is wrong",
    );
    expect(manual.lastDisplaySyncTs.toString()).to.equal(
      cfg.lastDisplaySyncTs.toString(),
      "last_display_sync_ts offset is wrong",
    );
  });

  it("still decodes correctly after a schedule is published", async () => {
    // A freshly-initialised config is mostly zeroes, which would let a wrong
    // offset pass by accident. Write distinctive non-zero values first.
    const h = await startBankrun();
    const psm = h.program;
    const { psmOrchestrator } = await import("../shared/setup");
    const { ratePerSecondForApy } = await import("@okumoney/yield-tooling");
    const { BN } = anchor;

    const usdcMint = await createMintViaBankrun(
      h,
      h.payer.publicKey,
      null,
      DECIMALS,
      Keypair.generate(),
      TOKEN_PROGRAM_ID,
    );
    const { configPda } = await initializePsm(h, psm, h.payer, usdcMint);

    const clock = await h.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);
    const rate = ratePerSecondForApy(0.0537);
    const nextRate = ratePerSecondForApy(0.0831);

    await psm.methods
      .setOkumYieldRateWithSuccessor(
        new BN(rate.toString()),
        new BN(now + 13 * 86_400),
        new BN(nextRate.toString()),
        new BN(now + 41 * 86_400),
      )
      .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: configPda })
      .signers([psmOrchestrator])
      .rpc();

    const data = (await h.provider.connection.getAccountInfo(configPda))!.data;
    const cfg: any = await psm.account.psmConfig.fetch(configPda);

    expect(data.readBigUInt64LE(ACCRUAL_BASE + 16).toString()).to.equal(rate.toString());
    expect(data.readBigInt64LE(ACCRUAL_BASE + 32).toString()).to.equal(
      String(now + 13 * 86_400),
    );
    expect(data.readBigUInt64LE(ACCRUAL_BASE + 40).toString()).to.equal(nextRate.toString());
    expect(data.readBigInt64LE(ACCRUAL_BASE + 48).toString()).to.equal(
      String(now + 41 * 86_400),
    );
    // And the base multiplier, which is the field a wrong offset is most
    // likely to silently corrupt (it is the only u128).
    let v = 0n;
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[ACCRUAL_BASE + i]);
    expect(v.toString()).to.equal(cfg.okumBaseMultiplier.toString());
  });
});
