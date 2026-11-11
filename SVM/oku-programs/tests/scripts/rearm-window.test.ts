import { expect } from 'chai';
import { PRECISION, type Schedule } from '@okumoney/yield-tooling';
import { assertRearmWindow } from '../../scripts/admin/_lib/rearm-window';

// Cyfrin audit #13 follow-up: on Solana the Clock trails wall clock, so an artifact that
// repeats the armed successor can reach a chain whose Clock is still inside the active window.

const R1 = PRECISION + 1_547_126_016n;
const R2 = PRECISION + 2_440_418_608n;
const S: Schedule = {
  baseMultiplier: PRECISION,
  ratePerSecond: R1,
  lastAccrualTime: 1_000n,
  rateEnd: 2_000n,
  pendingRatePerSecond: R2,
  pendingRateEnd: 3_000n,
};

describe('assertRearmWindow (Cyfrin #13 follow-up)', () => {
  it('refuses the successor re-arm while the Clock is still inside the active window', () => {
    for (const now of [1_500, 1_999, 2_000]) {
      expect(() => assertRearmWindow(S, now, R2, 3_000)).to.throw(/has not reached the segment this write re-arms/);
    }
    expect(() => assertRearmWindow(S, 2_001, R2, 3_000)).not.to.throw();
  });

  it('refuses a stale re-arm of a segment that has ended on this chain', () => {
    expect(() => assertRearmWindow(S, 2_000, R1, 2_000)).to.throw(/already ended on this chain/);
    expect(() => assertRearmWindow(S, 3_000, R2, 3_000)).to.throw(/already ended on this chain/);
    expect(() => assertRearmWindow(S, 1_999, R1, 2_000)).not.to.throw();
  });

  it('leaves new rates, new ends and halts alone, at any Clock', () => {
    for (const now of [0, 1_500, 2_500, 9_000]) {
      expect(() => assertRearmWindow(S, now, R1 + 1n, 2_000)).not.to.throw();
      expect(() => assertRearmWindow(S, now, R2, 3_001)).not.to.throw();
      expect(() => assertRearmWindow(S, now, PRECISION, 0)).not.to.throw();
    }
  });
});
