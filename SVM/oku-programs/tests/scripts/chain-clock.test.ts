import { expect } from 'chai';
import { SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { compoundFor, catchUpRate } from '@okumoney/yield-tooling';
import { chainNowSec, parseClockUnixTimestamp } from '../../scripts/utils/chainClock';

// Cyfrin audit finding #19: the catch-up window was sized from Date.now() while the program
// anchors at Clock::unix_timestamp, which can lag wall clock. When the lag exceeds the
// landing delay the on-chain window is longer than the one the rate was derived for and the
// laggard ends ABOVE the leader, permanently (the multiplier never decreases).

function clockData(unixTimestamp: bigint): Buffer {
  const b = Buffer.alloc(40);
  b.writeBigUInt64LE(123_456n, 0); // slot
  b.writeBigInt64LE(1_000n, 8); // epoch_start_timestamp
  b.writeBigUInt64LE(7n, 16); // epoch
  b.writeBigUInt64LE(8n, 24); // leader_schedule_epoch
  b.writeBigInt64LE(unixTimestamp, 32);
  return b;
}

function fakeConnection(info: { data: Buffer } | null) {
  const asked: string[] = [];
  const connection: any = {
    getAccountInfo: async (k: any, commitment: string) => {
      asked.push(`${k.toBase58()}@${commitment}`);
      return info;
    },
    // anything that would be a wall-clock or block-time shortcut must not be used
    getBlockTime: async () => {
      throw new Error('getBlockTime must not be used');
    },
  };
  return { connection, asked };
}

describe('chain clock (Cyfrin #19)', () => {
  describe('parseClockUnixTimestamp', () => {
    it('reads unix_timestamp at offset 32', () => {
      expect(parseClockUnixTimestamp(clockData(1_800_000_123n))).to.equal(1_800_000_123);
    });

    it('rejects truncated data', () => {
      expect(() => parseClockUnixTimestamp(Buffer.alloc(39))).to.throw(/expected 40/);
    });
  });

  describe('chainNowSec', () => {
    it('reads the Clock sysvar, not wall clock', async () => {
      const lagging = BigInt(Math.floor(Date.now() / 1000) - 30);
      const { connection, asked } = fakeConnection({ data: clockData(lagging) });
      expect(await chainNowSec(connection)).to.equal(Number(lagging));
      expect(asked).to.deep.equal([`${SYSVAR_CLOCK_PUBKEY.toBase58()}@confirmed`]);
    });

    it('refuses rather than falling back to wall clock', async () => {
      for (const info of [null, { data: clockData(0n) }, { data: clockData(-5n) }]) {
        let err: Error | undefined;
        try {
          await chainNowSec(fakeConnection(info as any).connection);
        } catch (e: any) {
          err = e;
        }
        expect(err?.message, JSON.stringify(info)).to.match(/retry instead of using wall clock/);
      }
    });

    it('is not fooled by an unrelated account', async () => {
      const { connection } = fakeConnection({ data: Buffer.alloc(10) });
      let err: Error | undefined;
      try {
        await chainNowSec(connection);
      } catch (e: any) {
        err = e;
      }
      expect(err?.message).to.match(/expected 40/);
      
    });
  });

  // The report's scenario: SVM halted at 1.02, leader at 1.020418210751004070, window ~5,760 s,
  // the chain Clock 30 s behind wall clock, the transaction landing 1 s after the read.
  describe('catch-up window sized from the chain clock', () => {
    const BASE = 1_020_000_000_000_000_000n;
    const TARGET = 1_020_418_210_751_004_070n;
    const WALL = 1_900_000_000; // wall-clock seconds at the read
    const LAG = 30;
    const LANDING_DELAY = 1;
    const END = WALL + 5_760;
    // the program anchors at the Clock when the transaction lands
    const anchor = WALL - LAG + LANDING_DELAY;
    const onChainWindow = BigInt(END - anchor);

    it('sized from wall clock, the laggard ends above the leader (the report)', () => {
      const rate = catchUpRate({
        currentMultiplier: BASE,
        targetMultiplier: TARGET,
        windowSeconds: BigInt(END - WALL),
      });
      const atEnd = compoundFor(BASE, rate, onChainWindow);
      expect(atEnd > TARGET, 'the old behaviour overshoots').to.equal(true);
      expect(atEnd - TARGET).to.equal(2_106_008_734_406n);
    });

    it('sized from the chain clock, it ends at or below the leader', () => {
      const chainNow = WALL - LAG;
      const rate = catchUpRate({
        currentMultiplier: BASE,
        targetMultiplier: TARGET,
        windowSeconds: BigInt(END - chainNow),
      });
      const atEnd = compoundFor(BASE, rate, onChainWindow);
      expect(atEnd <= TARGET, `ends ${atEnd - TARGET} above target`).to.equal(true);
      // ... and by no more than the landing delay's worth of accrual
      expect(TARGET - atEnd < 10n ** 13n).to.equal(true);
    });

    it('stays at or below target for any lag once the write lands a second after the read', () => {
      for (const lag of [0, 1, 5, 30, 90]) {
        for (const delay of [1, 2, 10]) {
          const chainNow = WALL - lag;
          const rate = catchUpRate({
            currentMultiplier: BASE,
            targetMultiplier: TARGET,
            windowSeconds: BigInt(END - chainNow),
          });
          const landed = chainNow + delay;
          const atEnd = compoundFor(BASE, rate, BigInt(END - landed));
          expect(atEnd <= TARGET, `lag ${lag}s delay ${delay}s`).to.equal(true);
        }
      }
    });

    it('a write landing in the same chain second as the read overshoots by rate granularity only', () => {
      // `catchUpRate` returns the minimal rate that REACHES the target, so with zero delay the
      // chain ends a few thousand wei above it (one rate unit, 1e-18 per second, compounded
      // over the window), unlike the ~2e12 of the wall-clock bug.
      const rate = catchUpRate({
        currentMultiplier: BASE,
        targetMultiplier: TARGET,
        windowSeconds: BigInt(END - (WALL - LAG)),
      });
      const atEnd = compoundFor(BASE, rate, BigInt(END - (WALL - LAG)));
      expect(atEnd >= TARGET).to.equal(true);
      expect(atEnd - TARGET < 100_000n).to.equal(true);
    });
  });
});
