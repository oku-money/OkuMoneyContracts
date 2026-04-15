#!/usr/bin/env tsx
/**
 * Unified Deployment Script for OkuMoney SVM Contracts
 *
 * Deploys all programs and configures them in a single execution.
 * Designed for fresh ephemeral deployments on Surfpool fork of devnet.
 *
 * Usage:
 *   # Local Surfpool fork (recommended for testing)
 *   surfpool start --rpc-url https://api.devnet.solana.com
 *   NETWORK=devnet-fork npm run deploy
 *
 *   # Live devnet (when ready)
 *   NETWORK=devnet npm run deploy
 *
 * Each run creates fresh tokens and programs - no state reuse.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { detectNetwork, createProvider, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { clearDeployment, saveDeployment, hasDeployment, DeploymentAddresses } from '../utils/addressBook';
import { LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import * as readline from 'readline';
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
    bridgeDeadlineSecs: new BN(3600), // 1 hour
    supportedChains: SUPPORTED_CHAINS,
    oracleEnabled: false, // Disabled for fork testing (1:1 ratio)
    minCollateralRatio: new BN('1000000000'), // 100% in 9-decimal precision (1e9)
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function getProgramIdFromKeypair(keypairPath: string): PublicKey {
  const keypairData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  return keypair.publicKey;
}

function loadIdlWithAddress(idl: any, programId: PublicKey): any {
  return { ...idl, address: programId.toBase58() };
}

/**
 * Format SOL balance for display
 */
function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

/**
 * Check if this is a live network (not a fork or localnet)
 */
function isLiveNetwork(network: string): boolean {
  return network === 'devnet' || network === 'mainnet-beta';
}

/**
 * Prompt user for confirmation before overwriting live deployment
 */
async function confirmLiveDeployment(network: string): Promise<boolean> {
  // Check if --yes flag was passed to skip confirmation
  if (process.argv.includes('--yes') || process.argv.includes('-y')) {
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    logger.warning(`\nExisting deployment found for ${network}.`);
    logger.warning('This will OVERWRITE the existing deployment addresses.');
    rl.question('\nProceed with deployment? (y/N): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// ============================================================================
// Step 1: Build Programs
// ============================================================================

async function buildPrograms(isFork: boolean): Promise<{ originalKeypairs: Record<string, Buffer> }> {
  logger.nextStep('Building Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const programs = ['lite_psm', 'oku_dollar', 'oku_bridge_router'];
  const originalKeypairs: Record<string, Buffer> = {};

  if (isFork) {
    // For fork: swap keypairs, sync, build
    // We keep the fork keypairs in place for deployment, restore later
    logger.info('Preparing fork build...');

    // Backup original keypairs and copy fork keypairs
    for (const prog of programs) {
      const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
      const forkPath = join(process.cwd(), keypairDir, `${prog}-keypair.json`);

      if (!existsSync(forkPath)) {
        throw new Error(`Fork keypair not found: ${forkPath}. Run: solana-keygen new -o ${forkPath}`);
      }

      if (existsSync(originalPath)) {
        originalKeypairs[prog] = readFileSync(originalPath);
      }

      execSync(`cp ${forkPath} ${originalPath}`);
    }

    // Sync declare_id! macros to match fork keypairs
    logger.info('Syncing program IDs...');
    execSync('anchor keys sync', { stdio: 'pipe' });

    // Build
    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
    
    // Note: We do NOT restore keypairs here - they stay as fork keypairs for deployment
  } else {
    // Standard build
    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
  }

  return { originalKeypairs };
}

function restoreOriginalKeypairs(originalKeypairs: Record<string, Buffer>): void {
  if (Object.keys(originalKeypairs).length === 0) return;
  
  logger.info('Restoring original keypairs...');
  for (const [prog, data] of Object.entries(originalKeypairs)) {
    const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
    writeFileSync(originalPath, data);
  }
  execSync('anchor keys sync', { stdio: 'pipe' });
}

// ============================================================================
// Step 2: Deploy Tokens (Fresh)
// ============================================================================

async function deployTokens(
  provider: AnchorProvider,
  psmConfigPDA: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>
): Promise<{ usdcMint: PublicKey; okuMoneyMint: PublicKey }> {
  logger.nextStep('Deploying Tokens (Fresh)');

  // Create Mock USDC (standard SPL token)
  logger.info('Creating Mock USDC...');
  const usdcMint = await createSPLTokenMint(
    provider.connection,
    provider.wallet.payer,
    USDC_DECIMALS,
    provider.wallet.publicKey, // mint authority = deployer (for testing)
    null
  );

  // Create OkuMoney (Token-2022 with interest-bearing extension)
  logger.info('Creating OkuMoney (Token-2022)...');
  const okuMoneyMint = await createToken2022Mint({
    connection: provider.connection,
    payer: provider.wallet.payer,
    decimals: OKUSD_DECIMALS,
    mintAuthority: psmConfigPDA, // PSM controls minting
    freezeAuthority: psmConfigPDA,
    rateAuthority: authorities.psm.rebaser,
    initialRate: 0, // 0% initial rate
  });

  return { usdcMint, okuMoneyMint };
}

// ============================================================================
// Step 3: Deploy Programs
// ============================================================================

async function deployPrograms(
  provider: AnchorProvider,
  isFork: boolean
): Promise<{ litePsm: PublicKey; okuDollar: PublicKey; okuBridgeRouter: PublicKey }> {
  logger.nextStep('Deploying Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const cluster = provider.connection.rpcEndpoint;

  // Deploy programs one at a time using solana CLI with priority fees
  // Order: smallest to largest to fail fast if there's an issue
  const programs = ['oku_bridge_router', 'oku_dollar', 'lite_psm'];
  const maxRetries = 3;
  const delayBetweenPrograms = 10000; // 10 seconds between programs
  const delayBetweenRetries = 60000; // 60 seconds before retry (let blockhash refresh)
  const priorityFee = 50000; // micro-lamports per compute unit (helps with congestion)
  
  for (const program of programs) {
    let deployed = false;
    const programSoPath = join(process.cwd(), 'target/deploy', `${program}.so`);
    const keypairPath = join(process.cwd(), keypairDir, `${program}-keypair.json`);
    
    for (let attempt = 1; attempt <= maxRetries && !deployed; attempt++) {
      if (attempt > 1) {
        logger.warning(`Retry ${attempt}/${maxRetries} for ${program} in ${delayBetweenRetries / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenRetries));
      }
      
      logger.info(`Deploying ${program} to ${cluster}... (attempt ${attempt}/${maxRetries})`);
      
      try {
        // Use solana program deploy with priority fees for better landing rate
        execSync(
          `solana program deploy ${programSoPath} \
            --program-id ${keypairPath} \
            --url "${cluster}" \
            --with-compute-unit-price ${priorityFee} \
            --max-sign-attempts 100 \
            --use-rpc`,
          {
            stdio: 'inherit',
            timeout: 900000, // 15 minute timeout per program
          }
        );
        logger.success(`${program} deployed successfully`);
        deployed = true;
      } catch (error: any) {
        if (attempt === maxRetries) {
          if (error.killed) {
            throw new Error(`Deployment of ${program} timed out after ${maxRetries} attempts.`);
          }
          throw new Error(`Failed to deploy ${program} after ${maxRetries} attempts: ${error.message || error}`);
        }
        logger.warning(`Attempt ${attempt} failed for ${program}`);
      }
    }
    
    // Delay between programs to let the network settle
    if (program !== programs[programs.length - 1]) {
      logger.info(`Waiting ${delayBetweenPrograms / 1000}s before next program...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenPrograms));
    }
  }

  // Read deployed program IDs from keypair files
  const programIds = {
    litePsm: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'lite_psm-keypair.json')),
    okuDollar: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'oku_dollar-keypair.json')),
    okuBridgeRouter: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'oku_bridge_router-keypair.json')),
  };

  logger.success(`lite_psm: ${programIds.litePsm.toBase58()}`);
  logger.success(`oku_dollar: ${programIds.okuDollar.toBase58()}`);
  logger.success(`oku_bridge_router: ${programIds.okuBridgeRouter.toBase58()}`);

  return programIds;
}

// ============================================================================
// Step 4: Initialize PSM
// ============================================================================

async function initializePsm(
  provider: AnchorProvider,
  programId: PublicKey,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig
): Promise<{ psmConfig: PublicKey; redemptionQueue: PublicKey; bridgeConfig: PublicKey }> {
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
  // Args order: max_supply, minter_allowance, then 11 authority pubkeys
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
  // Note: Authorities are passed as ACCOUNTS, only sourceChainId is an ARG
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

  return { psmConfig, redemptionQueue, bridgeConfig };
}

// ============================================================================
// Step 5: Initialize Vault
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

  // Initialize vault
  // Args: pauser, unpauser, usd_rebaser, reserve_manager, min_collateral_ratio
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
// Step 6: Initialize Router
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

// ============================================================================
// Step 7: Verify Deployment
// ============================================================================

async function verifyDeployment(
  provider: AnchorProvider,
  addresses: DeploymentAddresses
): Promise<void> {
  logger.nextStep('Verifying Deployment');

  const checks: { name: string; address: string; exists: boolean }[] = [];

  // Check all key accounts exist
  const accountsToCheck = [
    { name: 'USDC Mint', address: addresses.tokens.usdc },
    { name: 'OkuMoney Mint', address: addresses.tokens.okusd },
    { name: 'PSM Config', address: addresses.pdas.psmConfig },
    { name: 'Redemption Queue', address: addresses.pdas.redemptionQueue },
    { name: 'Bridge Config', address: addresses.pdas.bridgeConfig },
    { name: 'Vault Config', address: addresses.pdas.vaultConfig },
    { name: 'usdOku Mint', address: addresses.tokens.usdOku },
    { name: 'Router Config', address: addresses.pdas.routerConfig },
  ];

  for (const { name, address } of accountsToCheck) {
    if (!address) {
      checks.push({ name, address: 'N/A', exists: false });
      continue;
    }
    const accountInfo = await provider.connection.getAccountInfo(new PublicKey(address));
    checks.push({ name, address, exists: accountInfo !== null });
  }

  // Print results
  let allPassed = true;
  for (const check of checks) {
    if (check.exists) {
      logger.success(`${check.name}: ${check.address.slice(0, 8)}...`);
    } else {
      logger.error(`${check.name}: NOT FOUND`);
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

  logger.header('OkuMoney SVM Deployment');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);
  const config = getDeploymentConfig();

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.info(`Mode: ${isFork ? 'Fork (fresh deploy)' : 'Live'}`);
  logger.log('');

  // Create provider first to get wallet info
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  // Display deployer info and balance
  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  
  // For fork networks, also show the real balance on the parent network
  if (isFork) {
    const parentNetwork = getParentNetwork(network);
    const parentConfig = NETWORK_CONFIGS[parentNetwork];
    const parentConnection = new Connection(parentConfig.cluster, 'confirmed');
    try {
      const realBalance = await parentConnection.getBalance(deployerPubkey);
      logger.info(`Balance on ${parentNetwork}: ${formatSol(realBalance)} SOL (real)`);
    } catch (e) {
      logger.warning(`Could not fetch ${parentNetwork} balance`);
    }
  }
  logger.log('');

  // For live networks, check for existing deployment and confirm overwrite
  if (isLiveNetwork(network) && hasDeployment(network)) {
    const confirmed = await confirmLiveDeployment(network);
    if (!confirmed) {
      logger.info('Deployment cancelled.');
      process.exit(0);
    }
    logger.log('');
  }

  // For fork networks, always clear previous deployment (no confirmation needed)
  if (isFork) {
    logger.info('Clearing previous fork deployment...');
    clearDeployment(network);
  }

  // Step 1: Build programs (keeps fork keypairs in place for deployment)
  const { originalKeypairs } = await buildPrograms(isFork);
  logger.log('');

  // Step 2: Deploy programs
  let programIds: { litePsm: PublicKey; okuDollar: PublicKey; okuBridgeRouter: PublicKey };
  try {
    programIds = await deployPrograms(provider, isFork);
  } finally {
    // Always restore original keypairs after deployment attempt
    if (isFork) {
      restoreOriginalKeypairs(originalKeypairs);
    }
  }
  logger.log('');

  // Derive PSM config PDA (needed for mint authority)
  const [psmConfigPDA] = derivePsmConfigPDA(programIds.litePsm);

  // Step 2: Deploy tokens
  const { usdcMint, okuMoneyMint } = await deployTokens(provider, psmConfigPDA, authorities);
  logger.log('');

  // Step 4: Initialize PSM
  const { psmConfig, redemptionQueue, bridgeConfig } = await initializePsm(
    provider,
    programIds.litePsm,
    usdcMint,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Step 5: Initialize Vault
  const { vaultConfig, usdOkuMint, reserveVault } = await initializeVault(
    provider,
    programIds.okuDollar,
    programIds.litePsm,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Step 6: Initialize Router
  const { routerConfig } = await initializeRouter(
    provider,
    programIds.okuBridgeRouter,
    okuMoneyMint,
    usdOkuMint,
    authorities
  );
  logger.log('');

  // Save deployment
  const deployment: DeploymentAddresses = {
    network,
    timestamp: new Date().toISOString(),
    tokens: {
      usdc: usdcMint.toBase58(),
      okusd: okuMoneyMint.toBase58(),
      usdOku: usdOkuMint.toBase58(),
    },
    programs: {
      litePsm: programIds.litePsm.toBase58(),
      wokusdVault: programIds.okuDollar.toBase58(),
      okuBridgeRouter: programIds.okuBridgeRouter.toBase58(),
    },
    pdas: {
      psmConfig: psmConfig.toBase58(),
      redemptionQueue: redemptionQueue.toBase58(),
      bridgeConfig: bridgeConfig.toBase58(),
      vaultConfig: vaultConfig.toBase58(),
      routerConfig: routerConfig.toBase58(),
    },
    authorities: {
      coldMultisig: authorities.psm.roleAdmin.toBase58(),
      warmMultisig: authorities.psm.pauser.toBase58(),
      orchestrator: authorities.bridge.orchestratorSigner.toBase58(),
      feeRecipient: authorities.bridge.feeRecipient.toBase58(),
    },
  };

  saveDeployment(network, deployment);

  // Step 7: Verify
  await verifyDeployment(provider, deployment);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Deployment Complete');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Deployment saved to: deployments/' + network + '.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
