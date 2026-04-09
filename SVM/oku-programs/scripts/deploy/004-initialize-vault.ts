#!/usr/bin/env tsx
/**
 * 004-initialize-vault.ts
 *
 * Initialize OkuDollar (usdOku) vault:
 * - Create usdOku mint (PDA, Token-2022)
 * - Initialize vault config
 * - Create vault's OkuMoney reserve account (ATA)
 */

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program, BN } from '@anchor-lang/core';
import { detectNetwork, createProvider, getWalletKeypair } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { deriveVaultConfigPDA, deriveUsdOkuMintPDA, derivePsmConfigPDA } from '../utils/pdaHelpers';
import { PROGRAM_IDS } from '../config/constants';
import okuDollarIDLRaw from '../../target/idl/oku_dollar.json';

// Constants from the Rust program
const PRECISION = new BN('1000000000'); // 1e9
const DEFAULT_MIN_COLLATERAL_RATIO = PRECISION; // 100% collateralization

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
  logger.header('Initialize Vault (004)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const wallet = getWalletKeypair();
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment from current network
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.wokusdVault || !deployment?.programs?.litePsm || !deployment?.tokens?.okusd) {
    logger.error('Missing deployment data. Run scripts 001-003 first.', false);
    process.exit(1);
  }

  const vaultProgramId = new PublicKey(deployment.programs.wokusdVault);
  const psmProgramId = new PublicKey(deployment.programs.litePsm);
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd); // OkuMoney is okusd (Token-2022)

  logger.section('Deriving Vault PDAs');

  // Vault config PDA - seeds: ["oku_dollar_config"]
  const [vaultConfig] = deriveVaultConfigPDA(vaultProgramId);
  logger.success(`Vault Config: ${vaultConfig.toBase58()}`);

  // usdOku mint PDA - seeds: ["usd_oku_mint"]
  const [usdOkuMint] = deriveUsdOkuMintPDA(vaultProgramId);
  logger.success(`usdOku Mint (PDA): ${usdOkuMint.toBase58()}`);

  // PSM config PDA (needed for reading oku_m_price)
  const [psmConfig] = derivePsmConfigPDA(psmProgramId);
  logger.success(`PSM Config: ${psmConfig.toBase58()}`);

  // Reserve vault is the ATA of vaultConfig for okuMoneyMint
  const reserveVault = getAssociatedTokenAddressSync(
    okuMoneyMint,
    vaultConfig,
    true, // allowOwnerOffCurve - PDA owner
    TOKEN_2022_PROGRAM_ID
  );
  logger.success(`Reserve Vault (ATA): ${reserveVault.toBase58()}`);

  logger.log('');
  logger.section('Vault Authorities (5 roles)');
  logger.table({
    'Role Admin': authorities.vault.roleAdmin.toBase58(),
    'Pauser': authorities.vault.pauser.toBase58(),
    'Unpauser': authorities.vault.unpauser.toBase58(),
    'USD Rebaser': authorities.vault.usdRebaser.toBase58(),
    'Reserve Manager': authorities.vault.reserveManager.toBase58(),
  });

  // Initialize vault program
  logger.log('');
  logger.section('Initializing Vault Program');

  // Load program
  const okuDollarIDL = loadIdlForNetwork(okuDollarIDLRaw, network, 'wokusdVault');
  const vaultProgram = new Program(okuDollarIDL as any, provider);

  // Check if already initialized
  try {
    const existingConfig = await vaultProgram.account.okuDollarConfig.fetch(vaultConfig);
    logger.warning('Vault already initialized (idempotent)');
    logger.info(`Existing usdOku mint: ${(existingConfig as any).usdOkuMint.toBase58()}`);
    
    // Save to deployment file
    updateDeployment(network, 'tokens', { 
      usdOku: (existingConfig as any).usdOkuMint.toBase58() 
    });
    updateDeployment(network, 'pdas', {
      vaultConfig: vaultConfig.toBase58(),
      usdOkuMint: (existingConfig as any).usdOkuMint.toBase58(),
      reserveVault: (existingConfig as any).reserveVault.toBase58(),
    });
  } catch (error: any) {
    // Account doesn't exist, proceed with initialization
    if (!error.message?.includes('Account does not exist')) {
      throw error;
    }

    logger.info('Calling initialize() on vault...');

    // Initialize args:
    // - pauser: Pubkey
    // - unpauser: Pubkey  
    // - usd_rebaser: Pubkey
    // - reserve_manager: Pubkey
    // - min_collateral_ratio: u64 (100% = 1e9)
    const initArgs = {
      pauser: authorities.vault.pauser,
      unpauser: authorities.vault.unpauser,
      usdRebaser: authorities.vault.usdRebaser,
      reserveManager: authorities.vault.reserveManager,
      minCollateralRatio: DEFAULT_MIN_COLLATERAL_RATIO,
    };

    logger.info(`Min Collateral Ratio: ${initArgs.minCollateralRatio.toString()} (100%)`);

    // Build the accounts array in exact order from IDL
    const keys = [
      { pubkey: authorities.vault.roleAdmin, isSigner: true, isWritable: true },   // role_admin
      { pubkey: vaultConfig, isSigner: false, isWritable: true },                   // config
      { pubkey: okuMoneyMint, isSigner: false, isWritable: false },                 // oku_money_mint
      { pubkey: usdOkuMint, isSigner: false, isWritable: true },                    // usd_oku_mint
      { pubkey: reserveVault, isSigner: false, isWritable: true },                  // reserve_vault
      { pubkey: psmConfig, isSigner: false, isWritable: false },                    // psm_config
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },        // token_2022_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },      // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },           // rent
    ];

    // Use Anchor's instruction coder to encode the instruction data
    const instructionData = vaultProgram.coder.instruction.encode('initialize', initArgs);

    const ix: TransactionInstruction = {
      programId: vaultProgramId,
      keys,
      data: Buffer.from(instructionData),
    };

    try {
      const { blockhash } = await provider.connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [ix],
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);

      const sig = await provider.connection.sendTransaction(tx);
      await provider.connection.confirmTransaction(sig, 'confirmed');

      logger.success(`Vault initialized: ${sig}`);
      logger.info(`Transaction: https://explorer.solana.com/tx/${sig}?cluster=${network}`);

      // Save to deployment file
      updateDeployment(network, 'tokens', { usdOku: usdOkuMint.toBase58() });
      updateDeployment(network, 'pdas', {
        vaultConfig: vaultConfig.toBase58(),
        usdOkuMint: usdOkuMint.toBase58(),
        reserveVault: reserveVault.toBase58(),
      });
    } catch (err: any) {
      logger.error(`Vault initialization failed: ${err.message}`);
      if (err.logs || err.transactionLogs) {
        logger.log('Transaction logs:');
        (err.logs || err.transactionLogs).forEach((log: string) => logger.log(`  ${log}`));
      }
      throw err;
    }
  }

  logger.log('');
  logger.section('Vault Summary');
  logger.table({
    'OkuMoney Mint (Token-2022)': okuMoneyMint.toBase58(),
    'usdOku Mint (Token-2022)': usdOkuMint.toBase58(),
    'Vault Config PDA': vaultConfig.toBase58(),
    'Reserve Vault (ATA)': reserveVault.toBase58(),
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
