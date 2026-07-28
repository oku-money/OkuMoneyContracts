/**
 * Program initialization utilities
 */

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { logger } from '../../utils/logger';
import { loadAuthorities } from '../../config/authorities';
import { NetworkConfig } from '../../config/networks';
import { DIRECT_MINTER_ALLOWANCE } from '../../config/constants';
import {
  derivePsmConfigPDA,
} from '../../utils/pdaHelpers';
import { loadIdlWithAddress } from './programs';
import { DeploymentConfig } from './config';

// Import IDLs
import litePsmIdl from '../../../target/idl/lite_psm.json';

/**
 * Returns true if `error` indicates that the target account is already
 * initialized -- i.e. this initialize call is a no-op rather than a real failure.
 *
 * Anchor 1.0 surfaces this in multiple ways depending on the construction
 * path: the legacy 'already in use' string, AnchorError with code
 * `AccountAlreadyInitialized` (= 0), or the program-level
 * `EscrowAlreadyInitialized` from lite-psm's `setup_oku_m_escrow`.
 * We check all of them; brittle string-only matching has bitten us across
 * Anchor minor-version bumps.
 */
function isAlreadyInitialized(error: any): boolean {
  if (!error) return false;
  // Anchor 1.0 structured errors -- try first
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
  /** OkuM mint (Token-2022). Created on-chain by `initialize()`. */
  okuMMint: PublicKey;
  /** USDC vault ATA, owned by `psmConfig`. Created by `initialize()`. */
  vaultUsdc: PublicKey;
  /** OkuM escrow ATA, owned by `psmConfig`. Created by `setup_oku_m_escrow()`. */
  vaultOkuM: PublicKey;
}

/**
 * Initialize the PSM program.
 *
 * The on-chain `initialize` instruction creates the OkuM mint (Token-2022
 * with ScaledUiAmount + MetadataPointer + TokenMetadata extensions) via
 * CPIs. This function generates a fresh keypair for the mint and passes
 * it as an additional signer.
 */
export async function initializePsm(
  provider: AnchorProvider,
  programId: PublicKey,
  usdcMint: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  config: DeploymentConfig,
  networkConfig: NetworkConfig
): Promise<PsmInitResult> {
  logger.nextStep('Initializing PSM');

  const idl = loadIdlWithAddress(litePsmIdl, programId);
  const program = new Program(idl as any, provider);

  const [psmConfig] = derivePsmConfigPDA(programId);

  // PSM vault accounts
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  // Generate a fresh keypair for the OkuM mint. The on-chain
  // `initialize` instruction will create the account via CPI
  // (CreateAccount + extension inits + InitializeMint).
  const okuMMintKeypair = Keypair.generate();
  let okuMMint = okuMMintKeypair.publicKey;

  logger.info(`PSM Config PDA: ${psmConfig.toBase58()}`);
  logger.info(`OkuM mint (fresh keypair): ${okuMMint.toBase58()}`);

  logger.info('Calling initialize()...');
  try {
    await program.methods
      .initialize({
        maxSupply: config.maxSupply,
        minterAllowance: config.minterAllowance,
        pauser: authorities.psm.pauser,
        unpauser: authorities.psm.unpauser,
        freezer: authorities.psm.freezer,
        unfreezer: authorities.psm.unfreezer,
        bufferDepositor: authorities.psm.bufferDepositor,
        bufferWithdrawer: authorities.psm.bufferWithdrawer,
        capManager: authorities.psm.capManager,
        allowanceManager: authorities.psm.allowanceManager,
        rebaser: authorities.psm.rebaser,
        okuMUri: '', // metadata URI — empty for devnet, set in mainnet config
      })
      .accountsPartial({
        roleAdmin: provider.wallet.publicKey,
        config: psmConfig,
        usdcMint: usdcMint,
        okuMMint: okuMMint,
        vaultUsdc: vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([okuMMintKeypair])
      .rpc();
    logger.success('PSM initialized + OkuM mint created');
    logger.info(`OkuM mint: ${okuMMint.toBase58()}`);
  } catch (error: any) {
    if (isAlreadyInitialized(error)) {
      logger.warning('PSM already initialized -- reading OkuM mint from on-chain state');
      // Retrieve the OkuM mint from the existing PsmConfig
      const existingCfg: any = await program.account['psmConfig'].fetch(psmConfig);
      okuMMint = existingCfg.okuMMint as PublicKey;
      logger.info(`OkuM mint (from config): ${okuMMint.toBase58()}`);
    } else {
      throw error;
    }
  }

  // Setup OkuM escrow vault (ATA owned by config PDA).
  // Created via the standard ATA program (idempotent instruction).
  // The `setup_oku_m_escrow` on-chain instruction was removed with the
  // redemption queue; this is now a client-side ATA creation.
  const vaultOkuM = getAssociatedTokenAddressSync(okuMMint, psmConfig, true, TOKEN_2022_PROGRAM_ID);
  logger.info('Setting up OkuM escrow vault...');

  const existingAtaInfo = await provider.connection.getAccountInfo(
    vaultOkuM,
    'confirmed'
  );
  if (existingAtaInfo && existingAtaInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    logger.warning(
      `OkuM escrow vault ATA ${vaultOkuM.toBase58()} already exists (Token-2022 program). Skipping setup.`
    );
  } else {
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      provider.wallet.publicKey, // payer
      vaultOkuM,                // ata
      psmConfig,                // owner (PDA)
      okuMMint,                 // mint
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = new Transaction().add(createAtaIx);
    await provider.sendAndConfirm(tx);
    logger.success('OkuM escrow vault initialized');
  }

  // ---- Step 4: Configure direct-minter role + allowance ----
  // The Rust `initialize()` intentionally sets `direct_minter = Pubkey::default()`.
  // If the authorities config specifies a non-default directMinter, wire it up
  // here via `set_authority(DirectMinter, ...)` + `set_direct_minter_allowance(...)`.
  // This ensures the fiat-mint path is operational immediately after deploy-init,
  // without requiring a separate manual `grant-roles` step.
  const directMinter = authorities.psm.directMinter;
  if (directMinter && !directMinter.equals(PublicKey.default)) {
    logger.info('Configuring direct-minter role...');
    try {
      const currentCfg: any = await program.account['psmConfig'].fetch(psmConfig);
      const currentDirectMinter = currentCfg.directMinter as PublicKey;

      if (currentDirectMinter.equals(directMinter)) {
        logger.warning(
          `direct_minter already set to ${directMinter.toBase58().slice(0, 12)}... — skipping`
        );
      } else {
        await program.methods
          .setAuthority({ directMinter: {} }, directMinter)
          .accountsPartial({
            roleAdmin: provider.wallet.publicKey,
            config: psmConfig,
          })
          .rpc();
        logger.success(`direct_minter set to ${directMinter.toBase58().slice(0, 12)}...`);
      }

      // Set the direct-minter allowance (allowance_manager is still the
      // deployer at this point -- deploy-init runs before grant-roles).
      const currentAllowance = currentCfg.directMinterAllowance;
      const targetAllowance = new BN(DIRECT_MINTER_ALLOWANCE);
      if (currentAllowance && currentAllowance.eq(targetAllowance)) {
        logger.warning(
          `direct_minter_allowance already ${targetAllowance.toString()} — skipping`
        );
      } else {
        await program.methods
          .setDirectMinterAllowance(targetAllowance)
          .accountsPartial({
            allowanceManager: provider.wallet.publicKey,
            config: psmConfig,
          })
          .rpc();
        logger.success(
          `direct_minter_allowance set to ${targetAllowance.toString()}`
        );
      }
    } catch (error: any) {
      // Non-fatal -- directMinter can be configured later via grant-roles.ts
      logger.warning(
        `Direct-minter setup failed (non-fatal): ${error.message?.slice(0, 80)}`
      );
      logger.info(
        'Run NETWORK=<network> tsx scripts/admin/grant-roles.ts to configure separately.'
      );
    }
  } else {
    logger.info('No directMinter configured in authorities -- skipping (configure via grant-roles).');
  }

  return {
    psmConfig,
    okuMMint,
    vaultUsdc,
    vaultOkuM,
  };
}

