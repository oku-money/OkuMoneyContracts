#!/usr/bin/env tsx
/**
 * Phase 2: Initialize Programs
 * 
 * Creates tokens and initializes all program PDAs.
 * Run this AFTER deploy-programs.ts has succeeded.
 * 
 * Prerequisites:
 *   - Programs must be deployed (run deploy:programs first)
 *   - deployments/{network}.json must have program IDs
 * 
 * Usage:
 *   pnpm run deploy:init
 */

import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { detectNetwork, createProvider, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, saveDeployment, DeploymentAddresses } from '../utils/addressBook';
import { NETWORK_CONFIGS } from '../config/networks';
import { loadAuthorities } from '../config/authorities';
import { createSPLTokenMint, createToken2022Mint } from '../utils/tokenHelpers';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
  deriveBridgeConfigPDA,
  deriveVaultConfigPDA,
  deriveUsdOkuMintPDA,
  deriveRouterConfigPDA,
} from '../utils/pdaHelpers';
import {
  USDC_DECIMALS,
  OKUSD_DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  BRIDGE_FEE_BPS,
  MIN_BRIDGE_AMOUNT,
  MAX_BRIDGE_AMOUNT,
  SOLANA_CHAIN_ID,
  SUPPORTED_CHAINS,
} from '../config/constants';

// Import IDLs
import litePsmIdl from '../../target/idl/lite_psm.json';
import okuDollarIdl from '../../target/idl/oku_dollar.json';
import okuBridgeRouterIdl from '../../target/idl/oku_bridge_router.json';

// ============================================================================
// Configuration
// ============================================================================

interface DeploymentConfig {
  maxSupply: BN;
  minterAllowance: BN;
  bridgeFeeBps: number;
  minBridgeAmount: BN;
  maxBridgeAmount: BN;
  bridgeDeadlineSecs: BN;
  supportedChains: number[];
  oracleEnabled: boolean;
  minCollateralRatio: BN;
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(MINTER_ALLOWANCE),
    bridgeFeeBps: BRIDGE_FEE_BPS,
    minBridgeAmount: new BN(MIN_BRIDGE_AMOUNT),
    maxBridgeAmount: new BN(MAX_BRIDGE_AMOUNT),
    bridgeDeadlineSecs: new BN(3600),
    supportedChains: SUPPORTED_CHAINS,
    oracleEnabled: false,
    minCollateralRatio: new BN('1000000000'),
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

function loadIdlWithAddress(idl: any, programId: PublicKey): any {
  return { ...idl, address: programId.toBase58() };
}

// ============================================================================
// Deploy Tokens
// ============================================================================

async function deployTokens(
  provider: AnchorProvider,
  psmConfigPDA: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>
): Promise<{ usdcMint: PublicKey; okuMoneyMint: PublicKey }> {
  logger.nextStep('Deploying Tokens');

  // Create Mock USDC
  logger.info('Creating Mock USDC...');
  const usdcMint = await createSPLTokenMint(
    provider.connection,
    provider.wallet.payer,
    USDC_DECIMALS,
    provider.wallet.publicKey,
    null
  );

  // Create OkuMoney (Token-2022)
  logger.info('Creating OkuMoney (Token-2022)...');
  const okuMoneyMint = await createToken2022Mint({
    connection: provider.connection,
    payer: provider.wallet.payer,
    decimals: OKUSD_DECIMALS,
    mintAuthority: psmConfigPDA,
    freezeAuthority: psmConfigPDA,
    rateAuthority: authorities.psm.rebaser,
    initialRate: 0,
  });

  return { usdcMint, okuMoneyMint };
}

// ============================================================================
// Initialize PSM
// ============================================================================

async function initializePsm(
  provider: AnchorProvider,
  programId: PublicKey,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig
): Promise<{ psmConfig: PublicKey; redemptionQueue: PublicKey; bridgeConfig: PublicKey; vaultOkuMoney: PublicKey }> {
  logger.nextStep('Initializing PSM');

  const idl = loadIdlWithAddress(litePsmIdl, programId);
  const program = new Program(idl as any, provider);

  const [psmConfig] = derivePsmConfigPDA(programId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(programId);
  const [bridgeConfig] = deriveBridgeConfigPDA(programId);
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

// ============================================================================
// Initialize Vault
// ============================================================================

async function initializeVault(
  provider: AnchorProvider,
  programId: PublicKey,
  psmProgramId: PublicKey,
  okuMoneyMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig
): Promise<{ vaultConfig: PublicKey; usdOkuMint: PublicKey; reserveVault: PublicKey }> {
  logger.nextStep('Initializing Vault');

  const idl = loadIdlWithAddress(okuDollarIdl, programId);
  const program = new Program(idl as any, provider);

  const [vaultConfig] = deriveVaultConfigPDA(programId);
  const [usdOkuMint] = deriveUsdOkuMintPDA(programId);
  const [psmConfig] = derivePsmConfigPDA(psmProgramId);
  const reserveVault = getAssociatedTokenAddressSync(okuMoneyMint, vaultConfig, true, TOKEN_2022_PROGRAM_ID);

  logger.info(`Vault Config PDA: ${vaultConfig.toBase58()}`);
  logger.info(`usdOku Mint PDA: ${usdOkuMint.toBase58()}`);

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

// ============================================================================
// Initialize Router
// ============================================================================

async function initializeRouter(
  provider: AnchorProvider,
  programId: PublicKey,
  okuMoneyMint: PublicKey,
  usdOkuMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>
): Promise<{ routerConfig: PublicKey }> {
  logger.nextStep('Initializing Router');

  const idl = loadIdlWithAddress(okuBridgeRouterIdl, programId);
  const program = new Program(idl as any, provider);

  const [routerConfig] = deriveRouterConfigPDA(programId);

  logger.info(`Router Config PDA: ${routerConfig.toBase58()}`);

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

// ============================================================================
// Verify Deployment
// ============================================================================

async function verifyDeployment(
  provider: AnchorProvider,
  addresses: DeploymentAddresses
): Promise<void> {
  logger.nextStep('Verifying Deployment');

  const accountsToCheck = [
    { name: 'USDC Mint', address: addresses.tokens?.usdc },
    { name: 'OkuMoney Mint', address: addresses.tokens?.okusd },
    { name: 'PSM Config', address: addresses.pdas?.psmConfig },
    { name: 'Redemption Queue', address: addresses.pdas?.redemptionQueue },
    { name: 'Bridge Config', address: addresses.pdas?.bridgeConfig },
    { name: 'Vault Config', address: addresses.pdas?.vaultConfig },
    { name: 'usdOku Mint', address: addresses.tokens?.usdOku },
    { name: 'Router Config', address: addresses.pdas?.routerConfig },
  ];

  let allPassed = true;
  for (const { name, address } of accountsToCheck) {
    if (!address) {
      logger.error(`${name}: NOT FOUND`);
      allPassed = false;
      continue;
    }
    const accountInfo = await provider.connection.getAccountInfo(new PublicKey(address));
    if (accountInfo) {
      logger.success(`${name}: ${address.slice(0, 8)}...`);
    } else {
      logger.error(`${name}: NOT FOUND`);
      allPassed = false;
    }
  }

  if (allPassed) {
    logger.success('All verification checks passed!');
  } else {
    logger.warning('Some checks failed - review deployment');
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Initialize Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);
  const config = getDeploymentConfig();

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.log('');

  // Load existing deployment (must have program IDs from deploy-programs)
  const existingDeployment = loadDeployment(network);
  if (!existingDeployment?.programs?.litePsm) {
    throw new Error(
      `No program deployment found for ${network}. Run 'pnpm run deploy:programs' first.`
    );
  }

  const programIds = {
    litePsm: new PublicKey(existingDeployment.programs.litePsm),
    okuDollar: new PublicKey(existingDeployment.programs.wokusdVault),
    okuBridgeRouter: new PublicKey(existingDeployment.programs.okuBridgeRouter),
  };

  logger.info('Found deployed programs:');
  logger.info(`  lite_psm: ${programIds.litePsm.toBase58()}`);
  logger.info(`  oku_dollar: ${programIds.okuDollar.toBase58()}`);
  logger.info(`  oku_bridge_router: ${programIds.okuBridgeRouter.toBase58()}`);
  logger.log('');

  // Create provider
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  logger.log('');

  // Derive PSM config PDA (needed for mint authority)
  const [psmConfigPDA] = derivePsmConfigPDA(programIds.litePsm);

  // Deploy tokens
  const { usdcMint, okuMoneyMint } = await deployTokens(provider, psmConfigPDA, authorities);
  logger.log('');

  // Initialize PSM
  const { psmConfig, redemptionQueue, bridgeConfig, vaultOkuMoney } = await initializePsm(
    provider,
    programIds.litePsm,
    usdcMint,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Initialize Vault
  const { vaultConfig, usdOkuMint } = await initializeVault(
    provider,
    programIds.okuDollar,
    programIds.litePsm,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Initialize Router
  const { routerConfig } = await initializeRouter(
    provider,
    programIds.okuBridgeRouter,
    okuMoneyMint,
    usdOkuMint,
    authorities
  );
  logger.log('');

  // Save complete deployment
  const deployment: DeploymentAddresses = {
    network,
    timestamp: new Date().toISOString(),
    tokens: {
      usdc: usdcMint.toBase58(),
      okusd: okuMoneyMint.toBase58(),
      usdOku: usdOkuMint.toBase58(),
    },
    programs: existingDeployment.programs,
    pdas: {
      psmConfig: psmConfig.toBase58(),
      redemptionQueue: redemptionQueue.toBase58(),
      bridgeConfig: bridgeConfig.toBase58(),
      vaultConfig: vaultConfig.toBase58(),
      routerConfig: routerConfig.toBase58(),
      vaultOkuMoney: vaultOkuMoney.toBase58(),
    },
    authorities: {
      coldMultisig: authorities.psm.roleAdmin.toBase58(),
      warmMultisig: authorities.psm.pauser.toBase58(),
      orchestrator: authorities.bridge.orchestratorSigner.toBase58(),
      feeRecipient: authorities.bridge.feeRecipient.toBase58(),
    },
  };

  saveDeployment(network, deployment);

  // Verify
  await verifyDeployment(provider, deployment);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Initialization Complete');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Deployment saved to: deployments/' + network + '.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Initialization failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
