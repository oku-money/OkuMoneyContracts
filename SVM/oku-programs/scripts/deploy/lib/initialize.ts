/**
 * Program initialization utilities
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider } from '@anchor-lang/core';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { logger } from '../../utils/logger';
import { loadAuthorities } from '../../config/authorities';
import { NetworkConfig } from '../../config/networks';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
  deriveVaultConfigPDA,
  deriveUsdOkuMintPDA,
} from '../../utils/pdaHelpers';
import { loadIdlWithAddress } from './programs';
import { DeploymentConfig } from './config';

// Import IDLs
import litePsmIdl from '../../../target/idl/lite_psm.json';
import okuDollarIdl from '../../../target/idl/oku_dollar.json';

/**
 * Returns true if `error` indicates that the target account is already
 * initialized — i.e. this initialize call is a no-op rather than a real failure.
 *
 * Anchor 1.0 surfaces this in multiple ways depending on the construction
 * path: the legacy 'already in use' string, AnchorError with code
 * `AccountAlreadyInitialized` (= 0), or the program-level
 * `EscrowAlreadyInitialized` from lite-psm's `setup_oku_money_escrow`.
 * We check all of them; brittle string-only matching has bitten us across
 * Anchor minor-version bumps.
 */
function isAlreadyInitialized(error: any): boolean {
  if (!error) return false;
  // Anchor 1.0 structured errors — try first
  const code = error?.error?.errorCode?.code ?? error?.errorCode?.code;
  const number = error?.error?.errorCode?.number ?? error?.errorCode?.number;
  if (
    code === 'AccountAlreadyInitialized' ||
    code === 'EscrowAlreadyInitialized'
  ) {
    return true;
  }
  // Anchor's `AccountAlreadyInitialized` is canonically error code 0.
  if (number === 0 && typeof code === 'string' && code.length > 0) {
    return true;
  }
  // Legacy / fallback: log strings still matter because the validator returns
  // 'already in use' before Anchor wraps it.
  const msg = String(error?.message ?? error);
  return (
    msg.includes('already in use') ||
    msg.includes('AccountAlreadyInitialized') ||
    msg.includes('EscrowAlreadyInitialized')
  );
}

export interface PsmInitResult {
  psmConfig: PublicKey;
  redemptionQueue: PublicKey;
  /**
   * USDC vault ATA, owned by `psmConfig`. Created by `initialize()`.
   * Persisted into the deployment file as `pdas.psmVaultUsdc` for
   * downstream scripts that need it without re-deriving from mint +
   * config.
   */
  vaultUsdc: PublicKey;
  /**
   * OkuMoney escrow ATA, owned by `psmConfig`. Created by
   * `setup_oku_money_escrow()`. Persisted as `pdas.psmOkuMoneyEscrow`.
   */
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
  config: DeploymentConfig,
  networkConfig: NetworkConfig
): Promise<PsmInitResult> {
  logger.nextStep('Initializing PSM');

  const idl = loadIdlWithAddress(litePsmIdl, programId);
  const program = new Program(idl as any, provider);

  const [psmConfig] = derivePsmConfigPDA(programId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(programId);

  // PSM vault accounts
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  logger.info(`PSM Config PDA: ${psmConfig.toBase58()}`);

  // Initialize PSM. The Pyth program-owner check is now configurable per-network
  // (was previously hardcoded in `programs/lite-psm/src/helpers/oracle.rs`).
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
        authorities.psm.rebaser,
        networkConfig.oracle.pythProgramOwner
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
    if (isAlreadyInitialized(error)) {
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
        roleAdmin: provider.wallet.publicKey,
        config: psmConfig,
        redemptionQueue: redemptionQueue,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.success('Redemption queue initialized');
  } catch (error: any) {
    if (isAlreadyInitialized(error)) {
      logger.warning('Redemption queue already exists');
    } else {
      throw error;
    }
  }

  // Bridge init / supported-chain / fee-recipient ATA setup removed in
  // the noBridge refactor (phase B). v1 cross-chain transfers are
  // mediated by an off-chain orchestrator that calls `mint_oku_m` /
  // `redeem_oku_m` directly; no on-chain bridge state remains.

  // Setup OkuMoney escrow vault (for queued redemptions).
  //
  // Idempotency note: `setupOkuMoneyEscrow()` creates an Associated Token
  // Account at the derived address. On a second deploy:init run, the ATA
  // already exists, and the ATA program returns `Provided owner is not
  // allowed` (NOT one of Anchor's standard already-initialized codes)
  // because its `create` path checks the existing account's owner against
  // a fresh-account expectation. The error isn't matched by
  // `isAlreadyInitialized()`, which is why this step blew up before this
  // short-circuit was added.
  //
  // Cleanest fix: pre-check whether the ATA exists at the derived address
  // with the expected Token-2022 program as owner and the expected mint.
  // If so, skip the on-chain call entirely. This is safer than catching
  // the post-failure error string (which can drift across Solana
  // versions).
  const vaultOkuMoney = getAssociatedTokenAddressSync(okuMoneyMint, psmConfig, true, TOKEN_2022_PROGRAM_ID);
  logger.info('Setting up OkuMoney escrow vault...');

  const existingAtaInfo = await provider.connection.getAccountInfo(
    vaultOkuMoney,
    'confirmed'
  );
  if (existingAtaInfo && existingAtaInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    logger.warning(
      `OkuMoney escrow vault ATA ${vaultOkuMoney.toBase58()} already exists (Token-2022 program). Skipping setup.`
    );
  } else {
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
      if (isAlreadyInitialized(error)) {
        logger.warning('OkuMoney escrow vault already initialized');
      } else {
        throw error;
      }
    }
  }

  return {
    psmConfig,
    redemptionQueue,
    vaultUsdc,
    vaultOkuMoney,
  };
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
    if (isAlreadyInitialized(error)) {
      logger.warning('Vault already initialized');
    } else {
      throw error;
    }
  }

  return { vaultConfig, usdOkuMint, reserveVault };
}


