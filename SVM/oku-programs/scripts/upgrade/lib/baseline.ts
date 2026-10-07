/**
 * Deploy-time upgrade baseline: record the IDL of the ELF now on-chain, bound
 * by the ELF's hash, as an `upgrades[]` entry with `mode: "deploy"`. The
 * upgrade script diffs the next build against this record (not against
 * whatever IDL is in the tree at upgrade time) and refuses to run without it.
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { NetworkName } from '../../config/networks';
import { appendUpgradeRecord, saveIdlSnapshot } from '../../utils/addressBook';
import { readOnChainElf } from './elfCompare';

export async function recordDeployBaseline(args: {
  network: NetworkName;
  connection: Connection;
  programId: PublicKey;
  deployer: PublicKey;
  soPath: string;
  idlPath: string;
}): Promise<{ recorded: boolean; file?: string }> {
  const elf = fs.readFileSync(args.soPath);
  const elfSha = createHash('sha256').update(elf).digest('hex');
  const onChain = await readOnChainElf(args.connection, args.programId, elf.length);
  if (onChain.sha256 !== elfSha) return { recorded: false };
  const snap = saveIdlSnapshot(args.network, 'lite_psm', fs.readFileSync(args.idlPath, 'utf-8'));
  let gitCommit: string | undefined;
  try {
    gitCommit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  appendUpgradeRecord(args.network, {
    program: 'LitePsm',
    programId: args.programId.toBase58(),
    oldElfSize: 0,
    newElfSize: elf.length,
    oldElfSha256: '<none>',
    newElfSha256: elfSha,
    txSignature: '<initial-deploy>',
    timestamp: new Date().toISOString(),
    deployer: args.deployer.toBase58(),
    mode: 'deploy',
    genesisHash: await args.connection.getGenesisHash(),
    gitCommit,
    idlSnapshotFile: snap.file,
    idlSha256: snap.sha256,
  });
  return { recorded: true, file: snap.file };
}
