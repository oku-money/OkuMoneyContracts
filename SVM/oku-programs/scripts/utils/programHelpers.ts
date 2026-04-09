/**
 * Program loading helpers for Anchor 1.0
 * 
 * Handles IDL loading and Program instantiation for deployment scripts.
 */

import { Program, AnchorProvider, Idl } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Load an IDL file from the target/idl directory
 */
export function loadIdl(programName: string): Idl {
  const idlPath = path.join(process.cwd(), 'target/idl', `${programName}.json`);
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL file not found: ${idlPath}. Run 'anchor build' first.`);
  }
  return JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
}

/**
 * Create a Program instance from IDL
 * 
 * In Anchor 1.0, the Program constructor expects:
 * - idl: The IDL object (must have 'address' field with program ID)
 * - provider: The AnchorProvider
 * 
 * The program ID is read from idl.address, not passed separately.
 */
export function createProgram<T extends Idl>(
  idl: T,
  programId: PublicKey,  // Kept for backwards compatibility but not used
  provider: AnchorProvider
): Program<T> {
  // Anchor 1.0 uses 2-arg constructor - programId comes from idl.address
  return new Program(idl, provider);
}

/**
 * Load and create a Program instance in one step
 */
export function loadProgram<T extends Idl>(
  programName: string,
  programId: PublicKey,
  provider: AnchorProvider
): Program<T> {
  const idl = loadIdl(programName);
  return createProgram(idl as T, programId, provider);
}
