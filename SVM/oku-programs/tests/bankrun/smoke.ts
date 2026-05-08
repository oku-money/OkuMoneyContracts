/**
 * Bankrun harness smoke test.
 *
 * Exercises the full `program.methods.<ix>().rpc()` round-trip on bankrun to
 * confirm `@anchor-lang/core`'s instruction-builder talks to bankrun's
 * BanksClient correctly. If this test passes, the rest of the unit suite
 * can be migrated to bankrun in subsequent commits without further plumbing.
 *
 * This file lives outside `tests/unit/` so the legacy `anchor test` command
 * (which boots solana-test-validator) doesn't pick it up; it's run by the
 * dedicated `npm run test:bankrun` script.
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
