/**
 * Program-identity binding for upgrades (audit U-02 / U-03).
 *
 * Five places name the program, and an upgrade is only safe when they agree:
 *
 *   deployments/<network>.json   the program the operator means to upgrade
 *   declare_id!  (lib.rs)        compiled into the ELF; Anchor's entrypoint
 *                                rejects every instruction if it differs from
 *                                the runtime program id (DeclaredProgramIdMismatch)
 *   the .so itself               must contain those 32 bytes (proves the ELF was
 *                                built from that declare_id!, not a stale build)
 *   target/idl/<prog>.json       `address` — clients build instructions from it
 *   Anchor.toml [programs.<c>]   what `anchor` tooling and `anchor keys sync` use
 *   target/deploy/<p>-keypair    if present, its public key (a mismatch means the
 *                                local workspace is set up for another program)
 *
 * `checkProgramIdentity` is pure so it can be unit-tested; `gatherIdentity`
 * reads the workspace.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';

export interface IdentitySources {
  expected: PublicKey;
  /** `declare_id!` literal from the program source, if found. */
  declareId?: string;
  /** `address` field of the IDL that will ship with this build. */
  idlAddress?: string;
  /** `Anchor.toml [programs.<section>]` entry, if the section exists. */
  anchorToml?: string;
  /** Whether Anchor.toml must have the entry (true for every non-localnet cluster). */
  anchorTomlRequired: boolean;
  /** Public key of target/deploy/<prog>-keypair.json, if the file exists. */
  keypairPubkey?: string;
  /** The ELF that will be uploaded. */
  elf: Buffer;
}

/** Every disagreement, as human-readable lines. Empty = bound. */
export function checkProgramIdentity(s: IdentitySources): string[] {
  const want = s.expected.toBase58();
  const out: string[] = [];
  if (!s.declareId) out.push(`declare_id! not found in program source`);
  else if (s.declareId !== want) out.push(`declare_id! is ${s.declareId}, expected ${want}`);
  if (!s.idlAddress) out.push(`IDL has no address`);
  else if (s.idlAddress !== want) out.push(`IDL address is ${s.idlAddress}, expected ${want}`);
  if (s.anchorToml === undefined) {
    if (s.anchorTomlRequired) out.push(`Anchor.toml has no entry for this program on this cluster`);
  } else if (s.anchorToml !== want) {
    out.push(`Anchor.toml lists ${s.anchorToml}, expected ${want}`);
  }
  if (s.keypairPubkey !== undefined && s.keypairPubkey !== want) {
    out.push(`target/deploy keypair is ${s.keypairPubkey}, expected ${want}`);
  }
  if (!s.elf.includes(s.expected.toBuffer())) {
    out.push(`the ELF does not contain ${want}'s bytes: it was compiled for a different declare_id!`);
  }
  return out;
}

export function readDeclareId(libRsPath: string): string | undefined {
  if (!fs.existsSync(libRsPath)) return undefined;
  const m = fs.readFileSync(libRsPath, 'utf-8').match(/declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)/);
  return m?.[1];
}

export function readAnchorTomlProgram(
  tomlPath: string,
  section: string,
  programKey: string
): string | undefined {
  if (!fs.existsSync(tomlPath)) return undefined;
  const content = fs.readFileSync(tomlPath, 'utf-8');
  const block = content.match(new RegExp(`\\[programs\\.${section}\\][^\\[]*`, 'm'));
  if (!block) return undefined;
  const row = block[0].match(new RegExp(`^\\s*${programKey}\\s*=\\s*"([^"]+)"`, 'm'));
  return row?.[1];
}

export function readKeypairPubkey(keypairPath: string): string | undefined {
  if (!fs.existsSync(keypairPath)) return undefined;
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secret)).publicKey.toBase58();
}

/** Anchor.toml section for a network name (forks rehearse their parent's program). */
export function anchorSection(network: string): string {
  if (network === 'devnet' || network === 'devnet-fork') return 'devnet';
  if (network === 'mainnet-beta' || network === 'mainnet-fork') return 'mainnet';
  return 'localnet';
}

export function gatherIdentity(args: {
  root: string;
  network: string;
  programKey: string;
  crateDir: string;
  expected: PublicKey;
  idl: { address?: string };
  elf: Buffer;
}): IdentitySources {
  const section = anchorSection(args.network);
  return {
    expected: args.expected,
    declareId: readDeclareId(path.join(args.root, 'programs', args.crateDir, 'src', 'lib.rs')),
    idlAddress: args.idl.address,
    anchorToml: readAnchorTomlProgram(path.join(args.root, 'Anchor.toml'), section, args.programKey),
    anchorTomlRequired: section !== 'localnet',
    keypairPubkey: readKeypairPubkey(
      path.join(args.root, 'target', 'deploy', `${args.programKey}-keypair.json`)
    ),
    elf: args.elf,
  };
}
