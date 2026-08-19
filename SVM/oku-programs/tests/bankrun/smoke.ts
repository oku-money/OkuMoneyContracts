/**
 * Bankrun harness smoke test.
 *
 * Bare-minimum integration check that the bankrun cluster boots, the
 * `BankrunProvider` registers correctly with `@anchor-lang/core`, the
 * lite-psm `Program` instance is loadable from the local IDL, and the
 * `BankrunConnectionProxy` answers the few `Connection` methods Anchor
 * actually calls (`getAccountInfo`, `getMinimumBalanceForRentExemption`).
 *
 * This is the simplest smoke test to flag a busted harness build (e.g. a
 * stale `target/idl/*.json`).
 */

import { startBankrun } from '../shared/bankrun';
import { expect } from 'chai';

describe('bankrun smoke', () => {
  it('boots bankrun and resolves the lite-psm program from the workspace', async () => {
    const h = await startBankrun();
    expect(h.program.idl.metadata.name).to.equal('litePsm');
    expect(h.program.idl.address).to.match(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(h.payer.publicKey.toBase58()).to.equal(h.provider.publicKey.toBase58());
  });

  it('reads cluster state via the BankrunConnectionProxy', async () => {
    const h = await startBankrun();
    // banksClient.getSlot returns the current slot; on a fresh bankrun
    // boot this is a small positive number.
    const slot = await h.context.banksClient.getSlot();
    expect(Number(slot)).to.be.greaterThan(0);
    // The connection proxy must answer rent queries (Anchor uses this
    // when sizing init accounts).
    const rent = await h.provider.connection.getMinimumBalanceForRentExemption(
      8 + 32
    );
    expect(rent).to.be.greaterThan(0);
  });
});
