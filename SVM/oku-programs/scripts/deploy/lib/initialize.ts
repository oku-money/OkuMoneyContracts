/**
 * Program initialization utilities
 */

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider } from '@anchor-lang/core';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { logger } from '../../utils/logger';
import { loadAuthorities } from '../../config/authorities';
import { SOLANA_CHAIN_ID } from '../../config/constants';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
  deriveBridgeConfigPDA,
  deriveVaultConfigPDA,
  deriveUsdOkuMintPDA,
  deriveRouterConfigPDA,
} from '../../utils/pdaHelpers';
import { loadIdlWithAddress } from './programs';
import { DeploymentConfig } from './config';

// Import IDLs
import litePsmIdl from '../../../target/idl/lite_psm.json';
import okuDollarIdl from '../../../target/idl/oku_dollar.json';
import okuBridgeRouterIdl from '../../../target/idl/oku_bridge_router.json';

export interface PsmInitResult {
  psmConfig: PublicKey;
  redemptionQueue: PublicKey;
  bridgeConfig: PublicKey;
  vaultOkuMoney: PublicKey;
}

/**
 * Initialize the PSM program
 */
export async function initializePsm(
  provider: AnchorProvider,
  programId: PublicKey,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig
): Promise<PsmInitResult> {
  logger.nextStep('Initializing PSM');

  const idl = loadIdlWithAddress(litePsmIdl, programId);
  const program = new Program(idl as any, provider);

  const [psmConfig] = derivePsmConfigPDA(programId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(programId);
  const [bridgeConfig] = deriveBridgeConfigPDA(programId);

  // PSM vault accounts
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  logger.info(`PSM Config PDA: ${psmConfig.toBase58()}`);

  // Initialize PSM
  logger.info('Calling initialize()...');
  try {
    await program.methods
      .initialize(
        config.maxSupply,
        config.minterAllowance,
        authorities.psm.pauser,
        authorities.psm.unpauser,
        authorities.psm.freezer,
        authorities.psm.unfreezer,
        authorities.psm.queueProcessor,
        authorities.psm.bufferDepositor,
        authorities.psm.bufferWithdrawer,
        authorities.psm.oracleManager,
        authorities.psm.capManager,
        authorities.psm.allowanceManager,
        authorities.psm.rebaser
      )
      .accountsPartial({
        roleAdmin: provider.wallet.publicKey,
        config: psmConfig,
        usdcMint: usdcMint,
        okuMoneyMint: okuMoneyMint,
        vaultUsdc: vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('PSM initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('PSM already initialized');
    } else {
      throw error;
    }
  }

  // Setup redemption queue
  logger.info('Setting up redemption queue...');
  try {
    await program.methods
      .setupRedemptionQueue()
      .accountsPartial({
        deployer: provider.wallet.publicKey,
        config: psmConfig,
        redemptionQueue: redemptionQueue,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('Redemption queue initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Redemption queue already exists');
    } else {
      throw error;
    }
  }

  // Initialize bridge config
  logger.info('Initializing bridge config...');
  try {
    await program.methods
      .initializeBridge(SOLANA_CHAIN_ID)
      .accountsPartial({
        bridgeAdmin: authorities.bridge.bridgeAdmin,
        bridgePauser: authorities.bridge.bridgePauser,
        bridgeUnpauser: authorities.bridge.bridgeUnpauser,
        orchestratorSigner: authorities.bridge.orchestratorSigner,
        feeRecipient: authorities.bridge.feeRecipient,
        chainManager: authorities.bridge.chainManager,
        feeManager: authorities.bridge.feeManager,
        nonceAdmin: authorities.bridge.nonceAdmin,
        signerManager: authorities.bridge.signerManager,
        limitsManager: authorities.bridge.limitsManager,
        bridgeConfig: bridgeConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('Bridge config initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Bridge config already initialized');
    } else {
      throw error;
    }
  }

  // Create the fee-recipient ATA (owned by the configured fee_recipient, which
  // may be a PDA on testnet). bridgeBurn references this ATA via a regular
  // (non-init_if_needed) constraint, so it must exist ahead of time.
  const feeRecipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    authorities.bridge.feeRecipient,
    true /* allowOwnerOffCurve — fee_recipient can be a PDA on testnet */,
    TOKEN_2022_PROGRAM_ID
  );
  logger.info(`Fee recipient ATA: ${feeRecipientAta.toBase58()}`);
  try {
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      provider.wallet.publicKey,
      feeRecipientAta,
      authorities.bridge.feeRecipient,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx);
    logger.success('Fee recipient ATA ready');
  } catch (error: any) {
    logger.warning(`Fee recipient ATA setup: ${error.message}`);
  }

  // Add supported chains
  for (const chainId of config.supportedChains) {
    logger.info(`Adding supported chain ${chainId}...`);
    try {
      await program.methods
        .addSupportedChain(chainId)
        .accountsPartial({
          chainManager: provider.wallet.publicKey,
          bridgeConfig: bridgeConfig,
        })
        .rpc();
      logger.success(`Chain ${chainId} added`);
    } catch (error: any) {
      if (error.message?.includes('already supported') || error.message?.includes('AlreadySupported')) {
        logger.warning(`Chain ${chainId} already supported`);
      } else {
        throw error;
      }
    }
  }

  // Setup OkuMoney escrow vault (for queued redemptions)
  const vaultOkuMoney = getAssociatedTokenAddressSync(okuMoneyMint, psmConfig, true, TOKEN_2022_PROGRAM_ID);
  logger.info('Setting up OkuMoney escrow vault...');
  try {
    await program.methods
      .setupOkuMoneyEscrow()
      .accountsPartial({
        roleAdmin: provider.wallet.publicKey,
        config: psmConfig,
        okuMoneyMint: okuMoneyMint,
        vaultOkuMoney: vaultOkuMoney,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('OkuMoney escrow vault initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use') || error.message?.includes('EscrowAlreadyInitialized')) {
      logger.warning('OkuMoney escrow vault already initialized');
    } else {
      throw error;
    }
  }

  return { psmConfig, redemptionQueue, bridgeConfig, vaultOkuMoney };
}

export interface VaultInitResult {
  vaultConfig: PublicKey;
  usdOkuMint: PublicKey;
  reserveVault: PublicKey;
}

/**
 * Initialize the Vault (OkuDollar) program
 */
export async function initializeVault(
  provider: AnchorProvider,
  programId: PublicKey,
  psmProgramId: PublicKey,
  okuMoneyMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig
): Promise<VaultInitResult> {
  logger.nextStep('Initializing Vault');

  const idl = loadIdlWithAddress(okuDollarIdl, programId);
  const program = new Program(idl as any, provider);

  const [vaultConfig] = deriveVaultConfigPDA(programId);
  const [usdOkuMint] = deriveUsdOkuMintPDA(programId);
  const [psmConfig] = derivePsmConfigPDA(psmProgramId);
  const reserveVault = getAssociatedTokenAddressSync(okuMoneyMint, vaultConfig, true, TOKEN_2022_PROGRAM_ID);

  logger.info(`Vault Config PDA: ${vaultConfig.toBase58()}`);
  logger.info(`usdOku Mint PDA: ${usdOkuMint.toBase58()}`);

  // Initialize vault
  logger.info('Calling initialize()...');
  try {
    await program.methods
      .initialize(
        authorities.vault.pauser,
        authorities.vault.unpauser,
        authorities.vault.usdRebaser,
        authorities.vault.reserveManager,
        config.minCollateralRatio
      )
      .accountsPartial({
        roleAdmin: provider.wallet.publicKey,
        config: vaultConfig,
        okuMoneyMint: okuMoneyMint,
        usdOkuMint: usdOkuMint,
        reserveVault: reserveVault,
        psmConfig: psmConfig,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('Vault initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Vault already initialized');
    } else {
      throw error;
    }
  }

  return { vaultConfig, usdOkuMint, reserveVault };
}

export interface RouterInitResult {
  routerConfig: PublicKey;
}

/**
 * Initialize the Bridge Router program
 */
export async function initializeRouter(
  provider: AnchorProvider,
  programId: PublicKey,
  okuMoneyMint: PublicKey,
  usdOkuMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>
): Promise<RouterInitResult> {
  logger.nextStep('Initializing Router');

  const idl = loadIdlWithAddress(okuBridgeRouterIdl, programId);
  const program = new Program(idl as any, provider);

  const [routerConfig] = deriveRouterConfigPDA(programId);

  logger.info(`Router Config PDA: ${routerConfig.toBase58()}`);

  // Initialize router
  logger.info('Calling initialize()...');
  try {
    await program.methods
      .initialize(authorities.psm.pauser, authorities.psm.unpauser)
      .accountsPartial({
        roleAdmin: provider.wallet.publicKey,
        config: routerConfig,
        okuMoneyMint: okuMoneyMint,
        usdOkuMint: usdOkuMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('Router initialized');
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Router already initialized');
    } else {
      throw error;
    }
  }

  return { routerConfig };
}
