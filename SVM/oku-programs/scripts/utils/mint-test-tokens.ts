#!/usr/bin/env tsx
/**
 * Mint test USDC and then mint OkuMoney via PSM
 * Used to get OkuMoney for bridge testing
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { createProvider, detectNetwork } from './network';
import { loadDeployment } from './addressBook';
import { logger } from './logger';
import { LitePsm } from '../../target/types/lite_psm';

async function main() {
  const network = detectNetwork();
  logger.header(`Mint Test Tokens (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment) {
    throw new Error(`No deployment found for ${network}`);
  }

  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd);
  const programId = new PublicKey(deployment.programs.litePsm);

  logger.info(`USDC Mint: ${usdcMint.toBase58()}`);
  logger.info(`OkuMoney Mint: ${okuMoneyMint.toBase58()}`);

  // Step 1: Mint USDC to user
  logger.nextStep('Minting USDC');
  
  const usdcAmount = 100_000_000; // 100 USDC (6 decimals)
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);

  // Create ATA if needed
  try {
    await getAccount(provider.connection, userUsdcAta, 'confirmed', TOKEN_PROGRAM_ID);
    logger.info('USDC ATA exists');
  } catch {
    logger.info('Creating USDC ATA...');
    const createAtaIx = createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      userUsdcAta,
      wallet.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    const tx = new anchor.web3.Transaction().add(createAtaIx);
    await provider.sendAndConfirm(tx);
    logger.success('USDC ATA created');
  }

  // Mint USDC (deployer is mint authority)
  logger.info(`Minting ${usdcAmount / 1_000_000} USDC...`);
  await mintTo(
    provider.connection,
    wallet.payer,
    usdcMint,
    userUsdcAta,
    wallet.payer, // mint authority
    usdcAmount
  );
  logger.success(`Minted ${usdcAmount / 1_000_000} USDC`);

  // Step 2: Mint OkuMoney via PSM
  logger.nextStep('Minting OkuMoney via PSM');

  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('psm_config')],
    programId
  );

  // Get vault USDC ATA (PSM's vault)
  const vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  // Get user OkuMoney ATA
  const userOkuMoneyAta = getAssociatedTokenAddressSync(okuMoneyMint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const mintOkuMAmount = new BN(50_000_000); // 50 USDC -> 50 OkuMoney (6 decimals)

  logger.info(`Minting ${mintOkuMAmount.toNumber() / 1_000_000} OkuMoney from USDC...`);

  try {
    await program.methods
      .mintOkuM(mintOkuMAmount)
      .accountsPartial({
        user: wallet.publicKey,
        config: psmConfig,
        usdcMint: usdcMint,
        okuMoneyMint: okuMoneyMint,
        userUsdcAta: userUsdcAta,
        userOkuMoneyAta: userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null, // No oracle for fork testing
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.success(`Minted ${mintOkuMAmount.toNumber() / 1_000_000} OkuMoney`);

    // Check balance
    const okuMoneyAccount = await getAccount(provider.connection, userOkuMoneyAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    logger.info(`OkuMoney balance: ${Number(okuMoneyAccount.amount) / 1_000_000} OkuM`);
  } catch (error: any) {
    logger.error(`Failed to mint OkuMoney: ${error.message}`);
    if (error.logs) {
      console.log('Logs:', error.logs);
    }
    throw error;
  }

  logger.success('Test tokens minted successfully!');
}

main().catch(console.error);
