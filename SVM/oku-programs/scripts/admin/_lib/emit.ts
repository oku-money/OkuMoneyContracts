/**
 * Print an instruction in the form a Squads vault transaction needs (Squads
 * app -> Transaction builder -> add instruction): program id, each account
 * with its signer / writable flags, and the instruction data. Nothing is sent.
 */

import { TransactionInstruction } from '@solana/web3.js';
import { utils } from '@anchor-lang/core';

const bs58 = utils.bytes.bs58;

export function printInstructionForMultisig(ix: TransactionInstruction, title: string): void {
  console.log('');
  console.log(`=== ${title} ===`);
  console.log(`program: ${ix.programId.toBase58()}`);
  console.log('accounts:');
  for (const k of ix.keys) {
    console.log(`  ${k.pubkey.toBase58()}  signer=${k.isSigner}  writable=${k.isWritable}`);
  }
  console.log(`data (base58): ${bs58.encode(ix.data)}`);
  console.log(`data (hex):    ${Buffer.from(ix.data).toString('hex')}`);
  console.log('');
}
