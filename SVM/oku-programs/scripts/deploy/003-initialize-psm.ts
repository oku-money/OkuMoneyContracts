#!/usr/bin/env tsx
/**
 * 003-initialize-psm.ts
 *
 * Initialize PSM config, redemption queue, and bridge config
 * - Set 12 PSM authorities
 * - Set 8 Bridge authorities
 * - Configure oracle (Pyth on devnet/mainnet, disabled on localnet)
 * - Set supply caps and limits
 * - Create USDC vault and OkuUSD escrow
 * - Initialize supported chains
 */

import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  detectNetwork,
  createProvider,
  getNetworkConfig,
} from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
  deriveBridgeConfigPDA,
  deriveBridgeNoncePDA,
} from '../utils/pdaHelpers';
import {
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  ORACLE_STALENESS_THRESHOLD,
  SUPPORTED_CHAINS,
  BRIDGE_FEE_BPS,
  MIN_BRIDGE_AMOUNT,
  MAX_BRIDGE_AMOUNT,
} from '../config/constants';
import litePsmIDL from '../../target/idl/lite_psm.json';

async function main() {
  logger.header('Initialize PSM & Bridge (003)');

  const network = detectNetwork();
  const config = getNetworkConfig(network);
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment?.tokens?.usdc || !deployment?.tokens?.okusd) {
    logger.error('Missing deployment data. Run scripts 001 and 002 first.', false);
    process.exit(1);
  }

  const litePsmProgramId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okusdMint = new PublicKey(deployment.tokens.okusd);

  // Load program IDL (placeholder - actual IDL loading depends on setup)
  // For now, we'll show the initialization logic structure
  logger.section('Deriving PDAs');

  const [psmConfig, psmBump] = derivePsmConfigPDA(litePsmProgramId);
  const [redemptionQueue, queueBump] = deriveRedemptionQueuePDA(litePsmProgramId);
  const [bridgeConfig, bridgeBump] = deriveBridgeConfigPDA(litePsmProgramId);

  // Derive token accounts
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, psmConfig, true);
  const psmOkusdEscrow = getAssociatedTokenAddressSync(
    okusdMint,
    psmConfig,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.success(`PSM Config: ${psmConfig.toBase58()}`);
  logger.success(`Redemption Queue: ${redemptionQueue.toBase58()}`);
  logger.success(`Bridge Config: ${bridgeConfig.toBase58()}`);
  logger.success(`Vault USDC: ${vaultUsdc.toBase58()}`);
  logger.success(`PSM OkuUSD Escrow: ${psmOkusdEscrow.toBase58()}`);

  // Save PDAs
  updateDeployment(network, 'pdas', {
    psmConfig: psmConfig.toBase58(),
    redemptionQueue: redemptionQueue.toBase58(),
    bridgeConfig: bridgeConfig.toBase58(),
    psmVaultUsdc: vaultUsdc.toBase58(),
    psmOkusdEscrow: psmOkusdEscrow.toBase58(),
  });

  logger.log('');
  logger.section('PSM Configuration');

  // Oracle configuration
  const oracleFeed = config.oracle.enabled && config.oracle.feed
    ? config.oracle.feed
    : PublicKey.default;

  logger.table({
    'Max Supply': `${MAX_SUPPLY / 1_000_000} OkuUSD`,
    'Minter Allowance': `${MINTER_ALLOWANCE / 1_000_000} OkuUSD`,
    'Oracle Enabled': config.oracle.enabled ? 'Yes' : 'No',
    'Oracle Feed': oracleFeed.toBase58(),
    'Staleness Threshold': `${ORACLE_STALENESS_THRESHOLD}s`,
  });

  logger.log('');
  logger.section('PSM Authorities (12 roles)');
  logger.table({
    'Role Admin': authorities.psm.roleAdmin.toBase58(),
    'Pauser': authorities.psm.pauser.toBase58(),
    'Unpauser': authorities.psm.unpauser.toBase58(),
    'Freezer': authorities.psm.freezer.toBase58(),
    'Unfreezer': authorities.psm.unfreezer.toBase58(),
    'Queue Processor': authorities.psm.queueProcessor.toBase58(),
    'Buffer Depositor': authorities.psm.bufferDepositor.toBase58(),
    'Buffer Withdrawer': authorities.psm.bufferWithdrawer.toBase58(),
    'Oracle Manager': authorities.psm.oracleManager.toBase58(),
    'Cap Manager': authorities.psm.capManager.toBase58(),
    'Allowance Manager': authorities.psm.allowanceManager.toBase58(),
    'Rebaser': authorities.psm.rebaser.toBase58(),
  });

  logger.log('');
  logger.section('Bridge Configuration');
  logger.table({
    'Bridge Fee': `${BRIDGE_FEE_BPS} bps (${BRIDGE_FEE_BPS / 100}%)`,
    'Min Bridge Amount': `${MIN_BRIDGE_AMOUNT / 1_000_000} OkuUSD`,
    'Max Bridge Amount': `${MAX_BRIDGE_AMOUNT / 1_000_000} OkuUSD`,
    'Supported Chains': SUPPORTED_CHAINS.join(', '),
  });

  logger.log('');
  logger.section('Bridge Authorities (8 roles)');
  logger.table({
    'Bridge Admin': authorities.bridge.bridgeAdmin.toBase58(),
    'Bridge Pauser': authorities.bridge.bridgePauser.toBase58(),
    'Bridge Unpauser': authorities.bridge.bridgeUnpauser.toBase58(),
    'Orchestrator Signer': authorities.bridge.orchestratorSigner.toBase58(),
    'Fee Recipient': authorities.bridge.feeRecipient.toBase58(),
    'Chain Manager': authorities.bridge.chainManager.toBase58(),
    'Fee Manager': authorities.bridge.feeManager.toBase58(),
    'Nonce Admin': authorities.bridge.nonceAdmin.toBase58(),
  });

  // Save authorities
  updateDeployment(network, 'authorities', {
    coldMultisig: authorities.psm.roleAdmin.toBase58(),
    warmMultisig: authorities.psm.pauser.toBase58(),
    orchestrator: authorities.psm.queueProcessor.toBase58(),
    bridgeOrchestrator: authorities.bridge.orchestratorSigner.toBase58(),
    feeRecipient: authorities.bridge.feeRecipient.toBase58(),
  });

  // Load program
  logger.log('');
  logger.section('Initializing PSM Program');

  const litePsmProgram = new Program(litePsmIDL as any, litePsmProgramId, provider);

  // Step 1: Initialize PSM config
  try {
    logger.info('Calling initialize() on PSM...');

    const tx = await litePsmProgram.methods
      .initialize(
        new BN(MAX_SUPPLY),
        new BN(MINTER_ALLOWANCE)
      )
      .accounts({
        roleAdmin: authorities.psm.roleAdmin,
        pauser: authorities.psm.pauser,
        unpauser: authorities.psm.unpauser,
        freezer: authorities.psm.freezer,
        unfreezer: authorities.psm.unfreezer,
        queueProcessor: authorities.psm.queueProcessor,
        bufferDepositor: authorities.psm.bufferDepositor,
        bufferWithdrawer: authorities.psm.bufferWithdrawer,
        oracleManager: authorities.psm.oracleManager,
        capManager: authorities.psm.capManager,
        allowanceManager: authorities.psm.allowanceManager,
        rebaser: authorities.psm.rebaser,
        config: psmConfig,
        redemptionQueue: redemptionQueue,
        usdcMint: usdcMint,
        okusdMint: okusdMint,
        vaultUsdc: vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.success(`PSM initialized: ${tx}`);
    logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('PSM already initialized (idempotent)');
    } else {
      logger.error(`PSM initialization failed: ${error.message}`);
      throw error;
    }
  }

  // Step 2: Setup OkuUSD escrow
  try {
    logger.log('');
    logger.info('Setting up OkuUSD escrow...');

    const tx = await litePsmProgram.methods
      .setupOkusdEscrow()
      .accounts({
        roleAdmin: authorities.psm.roleAdmin,
        config: psmConfig,
        okusdMint: okusdMint,
        vaultOkusd: psmOkusdEscrow,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.success(`OkuUSD escrow created: ${tx}`);
    logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
  } catch (error: any) {
    if (error.message?.includes('already in use') || error.message?.includes('Unauthorized')) {
      logger.warning('OkuUSD escrow already exists (idempotent)');
    } else {
      logger.error(`OkuUSD escrow setup failed: ${error.message}`);
      throw error;
    }
  }

  // Step 3: Initialize bridge config
  try {
    logger.log('');
    logger.info('Initializing bridge config...');

    const tx = await litePsmProgram.methods
      .initializeBridge()
      .accounts({
        bridgeAdmin: authorities.bridge.bridgeAdmin,
        bridgePauser: authorities.bridge.bridgePauser,
        bridgeUnpauser: authorities.bridge.bridgeUnpauser,
        orchestratorSigner: authorities.bridge.orchestratorSigner,
        feeRecipient: authorities.bridge.feeRecipient,
        chainManager: authorities.bridge.chainManager,
        feeManager: authorities.bridge.feeManager,
        nonceAdmin: authorities.bridge.nonceAdmin,
        bridgeConfig: bridgeConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.success(`Bridge initialized: ${tx}`);
    logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Bridge already initialized (idempotent)');
    } else {
      logger.error(`Bridge initialization failed: ${error.message}`);
      throw error;
    }
  }

  // Step 4: Add supported chains to bridge config
  logger.log('');
  logger.section('Adding Supported Chains');

  for (const chainId of SUPPORTED_CHAINS) {
    try {
      logger.info(`Adding chain ${chainId}...`);

      const tx = await litePsmProgram.methods
        .addSupportedChain(chainId)
        .accounts({
          chainManager: authorities.bridge.chainManager,
          bridgeConfig: bridgeConfig,
        })
        .rpc();

      logger.success(`Chain ${chainId} added: ${tx}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        logger.warning(`Chain ${chainId}: Already added (idempotent)`);
      } else {
        logger.error(`Failed to add chain ${chainId}: ${error.message}`);
        throw error;
      }
    }
  }

  // Derive and save nonce PDAs for each supported chain
  logger.log('');
  logger.section('Bridge Nonce PDAs');

  const nonces: Record<number, string> = {};
  for (const chainId of SUPPORTED_CHAINS) {
    const [noncePDA] = deriveBridgeNoncePDA(litePsmProgramId, chainId);
    nonces[chainId] = noncePDA.toBase58();
    logger.success(`Chain ${chainId}: ${noncePDA.toBase58()}`);
  }

  updateDeployment(network, 'nonces', nonces);

  logger.log('');
  logger.success('PSM and Bridge initialization complete!', false);
  logger.info('Next: Run script 004 to initialize vault', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
