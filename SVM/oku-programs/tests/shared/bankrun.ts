/**
 * Bankrun harness for the SVM unit tests.
 *
 * Why bankrun? `solana-test-validator` (used by `anchor test`) has a 30s
 * confirmation polling window in `@solana/web3.js@1.x` that times out on
 * heavyweight transactions (Ed25519 sigverify + sysvar introspection +
 * keccak256 + PDA init + Token-2022 mint CPI in one tx). Bankrun runs the
 * BPF programs in-process via `solana-bankrun` (which itself wraps
 * `litesvm`), eliminating the validator's confirmation loop entirely.
 *
 * `anchor-bankrun`'s `BankrunProvider` is structurally compatible with
 * `@anchor-lang/core`'s `Provider` interface — both sides have the same
 * `connection`, `wallet`, `publicKey`, `sendAndConfirm`, etc. shape. The
 * only nominal-vs-structural mismatch is the package name; we cast through
 * `unknown` once at provider-registration time and the rest of the codebase
 * uses `@anchor-lang/core` normally.
 *
 * Phase 8.2 goal: ship the harness + a small proof-of-concept migration of
 * the heavy bridge-security tests. Future passes migrate the rest of the
 * unit suite. Tests in `tests/bankrun/` use this harness; tests in
 * `tests/unit/` continue to use the validator until they're migrated.
 */

import { startAnchor, BankrunProvider } from 'anchor-bankrun';
import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { ProgramTestContext } from 'solana-bankrun';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';

export interface BankrunHarness {
  context: ProgramTestContext;
  provider: BankrunProvider;
  payer: Keypair;
  program: Program<LitePsm>;
}

/**
 * Boot an in-process bankrun cluster, register a BankrunProvider, and
 * return a typed harness. Callers should `await` this in a `before` hook.
 */
export async function startBankrun(): Promise<BankrunHarness> {
  const context = await startAnchor('.', [], []);
  const provider = new BankrunProvider(context);
  // BankrunProvider implements `Provider` from @coral-xyz/anchor; that
  // interface is structurally identical to @anchor-lang/core's `Provider`.
  // The cast is the only place where the package-name divergence surfaces.
  anchor.setProvider(provider as unknown as anchor.Provider);

  // ProgramTestContext.payer is already a @solana/web3.js Keypair on
  // solana-bankrun >=0.4.
  const payer = context.payer;
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  return { context, provider, payer, program };
}

/**
 * Advance the bankrun clock by `secs` seconds. Replaces the
 * `await new Promise(r => setTimeout(r, 500))` patterns scattered across
 * the unit tests — those waits assumed solana-test-validator's wall-clock
 * advance, which bankrun does NOT do automatically.
 */
export async function warpBy(harness: BankrunHarness, secs: number): Promise<void> {
  const clock = await harness.context.banksClient.getClock();
  const newClock = {
    ...clock,
    unixTimestamp: clock.unixTimestamp + BigInt(secs),
  } as any;
  // solana-bankrun exposes `setClock` on the context to set future time.
  // The exact API is `context.setClock(new Clock(...))` but we lean on
  // ProgramTestContext's setClock helper for type-friendliness.
  (harness.context as any).setClock(newClock);
}

/**
 * Advance the bankrun slot clock by `slots`. Cheap — useful for the
 * yield-distribution-slot fence tests that need a slot increment.
 */
export async function warpSlots(harness: BankrunHarness, slots: bigint): Promise<void> {
  const cur = await harness.context.banksClient.getSlot();
  (harness.context as any).warpToSlot(cur + slots);
}

/**
 * Shorthand for fetching an account's lamports.
 */
export async function getLamports(
  harness: BankrunHarness,
  address: PublicKey
): Promise<bigint> {
  const info = await harness.context.banksClient.getAccount(address);
  if (!info) return 0n;
  return info.lamports;
}
