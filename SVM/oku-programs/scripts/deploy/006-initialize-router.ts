#!/usr/bin/env tsx
/**
 * 006-initialize-router.ts
 *
 * Initialize bridge router:
 * - Initialize router config PDA
 * - Set admin authority
 * - Store OkuMoney and usdOku mint references for validation
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Program } from '@anchor-lang/core';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { deriveRouterConfigPDA } from '../utils/pdaHelpers';
import { PROGRAM_IDS } from '../config/constants';
import okuBridgeRouterIDLRaw from '../../target/idl/oku_bridge_router.json';

/**
 * Load IDL with correct program ID for the current network.
 */
function loadIdlForNetwork(idl: any, network: string, programKey: keyof typeof PROGRAM_IDS['localnet']): any {
  const programId = PROGRAM_IDS[network as keyof typeof PROGRAM_IDS]?.[programKey];
  if (!programId) {
    throw new Error(`No program ID found for ${programKey} on ${network}`);
  }
  return {
    ...idl,
    address: programId.toBase58(),
  };
}

async function main() {
  logger.header('Initialize Router (006)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment from current network
  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.okuBridgeRouter ||
    !deployment?.tokens?.okusd ||
    !deployment?.tokens?.usdOku
  ) {
    logger.error('Missing deployment data. Run scripts 001-005 first.', false);
    process.exit(1);
  }

  const routerProgramId = new PublicKey(deployment.programs.okuBridgeRouter);
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);

  logger.section('Deriving Router PDA');

  const [routerConfig, routerBump] = deriveRouterConfigPDA(routerProgramId);

  logger.success(`Router Config: ${routerConfig.toBase58()}`);

  logger.log('');
  logger.section('Router Configuration');
  logger.table({
    'Router Config PDA': routerConfig.toBase58(),
    'Role Admin': authorities.psm.roleAdmin.toBase58(),
    'Pauser': authorities.psm.pauser.toBase58(),
    'Unpauser': authorities.psm.unpauser.toBase58(),
    'OkuMoney Mint': okuMoneyMint.toBase58(),
    'usdOku Mint': usdOkuMint.toBase58(),
  });

  // Initialize router program
  logger.log('');
  logger.section('Initializing Router Program');

  // Anchor 1.0: Program(idl, provider) - program ID from idl.address
  // For fork networks, override IDL address with fork program ID
  const okuBridgeRouterIDL = loadIdlForNetwork(okuBridgeRouterIDLRaw, network, 'okuBridgeRouter');
  const routerProgram = new Program(okuBridgeRouterIDL as any, provider);

  try {
    logger.info('Calling initialize() on router...');

    // Build instruction manually to avoid Anchor 1.0 account resolution issues
    const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
    
    // Encode args: pauser (pubkey), unpauser (pubkey)
    const argsBuffer = Buffer.concat([
      authorities.psm.pauser.toBuffer(),
      authorities.psm.unpauser.toBuffer(),
    ]);
    
    const data = Buffer.concat([discriminator, argsBuffer]);
    
    // Build accounts array matching IDL order:
    // role_admin, config, oku_money_mint, usd_oku_mint, token_2022_program, system_program
    const keys = [
      { pubkey: authorities.psm.roleAdmin, isSigner: true, isWritable: true },
      { pubkey: routerConfig, isSigner: false, isWritable: true },
      { pubkey: okuMoneyMint, isSigner: false, isWritable: false },
      { pubkey: usdOkuMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    const ix = new TransactionInstruction({
      programId: routerProgramId,
      keys,
      data,
    });
    
    const tx = await provider.sendAndConfirm(
      new (await import('@solana/web3.js')).Transaction().add(ix),
      [],
      { commitment: 'confirmed' }
    );

    logger.success(`Router initialized: ${tx}`);
    logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Router already initialized (idempotent)');
    } else {
      logger.error(`Router initialization failed: ${error.message}`);
      throw error;
    }
  }

  updateDeployment(network, 'pdas', {
    routerConfig: routerConfig.toBase58(),
  });

  logger.log('');
  logger.success('Router initialization complete!', false);
  logger.info('Next: Run script 007 to verify deployment', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
