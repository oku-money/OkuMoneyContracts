/**
 * Post-upgrade liveness: prove the program at `programId` actually EXECUTES.
 *
 * An ELF compiled for a different `declare_id!` uploads and hashes fine, and
 * account reads still decode (they never run the program), yet every Anchor
 * instruction fails with DeclaredProgramIdMismatch (audit U-03). Simulating
 * one real instruction is the only check that catches it.
 *
 * `sync_display_multiplier` is permissionless, has no pause gate and only
 * refreshes a value fully determined on-chain, so simulating it (never sent)
 * is harmless on any cluster.
 */

import { AnchorProvider, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { derivePsmConfigPDA } from '../../utils/pdaHelpers';

/** Anchor framework errors that mean "the program does not run as this program". */
const DEAD = [/DeclaredProgramIdMismatch/, /Error Number: 4100/, /InstructionFallbackNotFound/, /Error Number: 101\b/];

/**
 * Retries while the cluster still reports "Program is not deployed": a program
 * upgraded in slot N only becomes executable from slot N+1 (loader delay
 * visibility), so a simulation right after the upgrade sees no program.
 */
export async function assertProgramLive(
  provider: AnchorProvider,
  idl: any,
  programId: PublicKey,
  okuMMint: PublicKey,
  attempts = 20
): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      return await simulateOnce(provider, idl, programId, okuMMint);
    } catch (e: any) {
      if (i >= attempts || !/Program is not deployed/.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function simulateOnce(
  provider: AnchorProvider,
  idl: any,
  programId: PublicKey,
  okuMMint: PublicKey
): Promise<string> {
  if (idl.address !== programId.toBase58()) throw new Error('IDL address must equal the program id');
  const program = new Program(idl, provider);
  const [config] = derivePsmConfigPDA(programId);
  try {
    await (program.methods as any)
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: provider.wallet.publicKey,
        config,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .simulate();
    return 'simulated sync_display_multiplier: ok';
  } catch (err: any) {
    const logs: string[] = err?.simulationResponse?.logs ?? err?.logs ?? [];
    const text = `${err?.message ?? err}\n${logs.join('\n')}`;
    if (DEAD.some((re) => re.test(text))) {
      throw new Error(`Program ${programId.toBase58()} does not execute as itself:\n${text}`);
    }
    // A program-defined error (code >= 6000) still proves the code ran.
    const code = text.match(/Error Number: (\d+)/)?.[1];
    if (code && Number(code) >= 6000) return `simulated sync_display_multiplier: program error ${code} (program executes)`;
    throw new Error(`Liveness simulation failed:\n${text}`);
  }
}
