#!/usr/bin/env tsx
/**
 * 004-initialize-vault.ts
 *
 * Initialize wOkuUSD vault:
 * - Create wOkuUSD mint (SPL Token)
 * - Initialize vault config with 3 authorities
 * - Create vault's OkuUSD ATA
 */

import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program } from '@coral-xyz/anchor';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { deriveVaultConfigPDA } from '../utils/pdaHelpers';
import wokusdVaultIDL from '../../target/idl/wokusd_vault.json';

async function main() {
  logger.header('Initialize Vault (004)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.wokusdVault || !deployment?.tokens?.okusd) {
    logger.error('Missing deployment data. Run scripts 001-003 first.', false);
    process.exit(1);
  }

  const vaultProgramId = new PublicKey(deployment.programs.wokusdVault);
  const okusdMint = new PublicKey(deployment.tokens.okusd);

  logger.section('Deriving Vault PDAs');

  const [vaultConfig, vaultBump] = deriveVaultConfigPDA(vaultProgramId);

  logger.success(`Vault Config: ${vaultConfig.toBase58()}`);

  // Derive vault's OkuUSD token account
  const vaultOkusd = getAssociatedTokenAddressSync(
    okusdMint,
    vaultConfig,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.success(`Vault OkuUSD ATA: ${vaultOkusd.toBase58()}`);

  logger.log('');
  logger.section('Vault Authorities (3 roles)');
  logger.table({
    'Role Admin': authorities.vault.roleAdmin.toBase58(),
    'Pauser': authorities.vault.pauser.toBase58(),
    'Unpauser': authorities.vault.unpauser.toBase58(),
  });

  // Initialize vault program
  logger.log('');
  logger.section('Initializing Vault Program');

  const vaultProgram = new Program(wokusdVaultIDL as any, vaultProgramId, provider);

  let wokusdMint: PublicKey;

  if (deployment.tokens.wokusd) {
    logger.info(`Using existing wOkuUSD mint: ${deployment.tokens.wokusd}`);
    wokusdMint = new PublicKey(deployment.tokens.wokusd);
  } else {
    try {
      // Generate new keypair for wOkuUSD mint (vault's initialize() will create it)
      const wokusdMintKeypair = Keypair.generate();
      wokusdMint = wokusdMintKeypair.publicKey;

      logger.info('Calling initialize() on vault...');
      logger.info(`Creating wOkuUSD mint: ${wokusdMint.toBase58()}`);

      const tx = await vaultProgram.methods
        .initialize()
        .accounts({
          roleAdmin: authorities.vault.roleAdmin,
          pauser: authorities.vault.pauser,
          unpauser: authorities.vault.unpauser,
          config: vaultConfig,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          vaultOkusd: vaultOkusd,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([wokusdMintKeypair])
        .rpc();

      logger.success(`Vault initialized: ${tx}`);
      logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
      logger.success(`wOkuUSD Mint created: ${wokusdMint.toBase58()}`);

      // Save wOkuUSD mint address
      updateDeployment(network, 'tokens', { wokusd: wokusdMint.toBase58() });
    } catch (error: any) {
      if (error.message?.includes('already in use')) {
        logger.warning('Vault already initialized (idempotent)');
        // If vault exists, wOkuUSD mint should be in deployment - check again
        const reloadedDeployment = loadDeployment(network);
        if (reloadedDeployment.tokens.wokusd) {
          wokusdMint = new PublicKey(reloadedDeployment.tokens.wokusd);
        } else {
          throw new Error('Vault initialized but wOkuUSD mint not found in deployment');
        }
      } else {
        logger.error(`Vault initialization failed: ${error.message}`);
        throw error;
      }
    }
  }

  // Save PDAs
  updateDeployment(network, 'pdas', {
    vaultConfig: vaultConfig.toBase58(),
    vaultOkusd: vaultOkusd.toBase58(),
  });

  logger.log('');
  logger.section('Vault Summary');
  logger.table({
    'OkuUSD Mint (Token-2022)': okusdMint.toBase58(),
    'wOkuUSD Mint (SPL Token)': wokusdMint.toBase58(),
    'Vault Config PDA': vaultConfig.toBase58(),
    'Vault OkuUSD ATA': vaultOkusd.toBase58(),
    'Mint Authority': vaultConfig.toBase58() + ' (Vault PDA)',
  });

  logger.log('');
  logger.success('Vault initialization complete!', false);
  logger.info('Next: Run script 005 to initialize bridge', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
