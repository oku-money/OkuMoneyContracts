/**
 * Program initialization utilities
 */

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import { loadDevnetAuthority } from '../../config/authorities';
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
import { DIRECT_MINTER_ALLOWANCE, DIRECT_BURNER_ALLOWANCE } from '../../config/constants';
import {
  derivePsmConfigPDA,
  programDataAddress,
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
 * path: the 'already in use' string or an `AnchorError` with code
 * `AccountAlreadyInitialized` (= 0). We check both, since structured-only
 * matching is not reliable across Anchor minor versions.
 */
function isAlreadyInitialized(error: any): boolean {
  if (!error) return false;
  // Anchor 1.0 structured errors -- try first
  const code = error?.error?.errorCode?.code ?? error?.errorCode?.code;
  const number = error?.error?.errorCode?.number ?? error?.errorCode?.number;
  if (code === 'AccountAlreadyInitialized') {
    return true;
  }
  // Anchor's `AccountAlreadyInitialized` is canonically error code 0.
  if (number === 0 && typeof code === 'string' && code.length > 0) {
    return true;
  }
  // Fallback: the validator returns 'already in use' before Anchor wraps it.
  const msg = String(error?.message ?? error);
  return (
    msg.includes('already in use') ||
    msg.includes('AccountAlreadyInitialized')
  );
}

/**
 * Resolve the extra signers needed to act as `allowance_manager`.
 *
 * `set_direct_minter_allowance` / `set_direct_burner_allowance` are gated on
 * `config.allowance_manager`, which on devnet/localnet is the OPERATOR key,
 * not the deployer (see `config/authorities.ts::allRolesToOperatorKey` — the
 * on-chain init guard forbids any granular role from equalling role_admin).
 *
 * Do NOT hardcode this to `provider.wallet.publicKey`: once the roles are
 * split that degrades to a non-fatal "Unauthorized" warning, leaving the
 * direct-mint/burn allowances at zero and the fiat/bridge paths dead.
 *
 * Returns the array to hand to `.signers()`:
 *   - `[]`      the provider wallet already IS allowance_manager
 *   - `[kp]`    the locally-held operator key is allowance_manager
 *   - `null`    allowance_manager is a key we do not hold — caller must skip
 */
function resolveAllowanceManagerSigners(
  provider: AnchorProvider,
  allowanceManager: PublicKey
): Keypair[] | null {
  if (allowanceManager.equals(provider.wallet.publicKey)) {
    return [];
  }
  try {
    const operator = loadDevnetAuthority();
    if (operator.publicKey.equals(allowanceManager)) {
      return [operator];
    }
  } catch {
    // No local operator key — fall through.
  }
  return null;
}

export interface PsmInitResult {
  psmConfig: PublicKey;
  /** OkuM mint (Token-2022). Created on-chain by `initialize()`. */
  okuMMint: PublicKey;
  /** USDC vault ATA, owned by `psmConfig`. Created by `initialize()`. */
  vaultUsdc: PublicKey;
  /** OkuM escrow ATA, owned by `psmConfig`. Created client-side (idempotent ATA). */
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
        // The program requires its initializer to BE its BPF upgrade
        // authority — see `contexts/init.rs`. The deploying wallet is that
        // authority by construction, so this is a no-op for a normal deploy
        // and a hard stop for anyone else racing to claim the config PDA.
        programData: programDataAddress(program.programId),
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

      // Treating "already initialized" as success is only safe if the
      // existing config is OURS. Verify before adopting it: a config whose
      // role_admin is someone else means this program ID was claimed by a
      // third party, and silently continuing would produce a deployment
      // record pointing at a PSM we do not control.
      //
      // `initialize` is now gated on the BPF upgrade authority
      // (`contexts/init.rs`), so this should be unreachable — but this
      // branch predates that gate and would have reported a hostile
      // land-grab as a clean deploy, so the check stays as defence in depth.
      const existingAdmin = existingCfg.roleAdmin as PublicKey;
      if (!existingAdmin.equals(provider.wallet.publicKey)) {
        throw new Error(
          `PsmConfig at ${psmConfig.toBase58()} already exists but its role_admin is ` +
            `${existingAdmin.toBase58()}, not this deployer ` +
            `(${provider.wallet.publicKey.toBase58()}). Refusing to adopt a PSM ` +
            `this wallet does not control. If this program ID was claimed by ` +
            `someone else, rotate to a new program keypair.`
        );
      }

      okuMMint = existingCfg.okuMMint as PublicKey;
      logger.info(`OkuM mint (from config): ${okuMMint.toBase58()}`);
    } else {
      throw error;
    }
  }

  // Setup OkuM escrow vault (ATA owned by config PDA).
  // Created client-side via the standard ATA program (idempotent); there is
  // no on-chain escrow-setup instruction.
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

      // Set the direct-minter allowance. Gated on `allowance_manager`, which
      // is the operator key on devnet/localnet -- resolve the signer rather
      // than assuming it is the deployer.
      const allowanceManager = currentCfg.allowanceManager as PublicKey;
      const extraSigners = resolveAllowanceManagerSigners(provider, allowanceManager);
      const currentAllowance = currentCfg.directMinterAllowance;
      const targetAllowance = new BN(DIRECT_MINTER_ALLOWANCE);
      if (currentAllowance && currentAllowance.eq(targetAllowance)) {
        logger.warning(
          `direct_minter_allowance already ${targetAllowance.toString()} — skipping`
        );
      } else if (extraSigners === null) {
        logger.warning(
          `allowance_manager is ${allowanceManager.toBase58().slice(0, 12)}... ` +
            `(not a locally-held key) — skipping direct_minter_allowance. ` +
            `Run set-direct-minter-allowance.ts with that wallet.`
        );
      } else {
        await program.methods
          .setDirectMinterAllowance(targetAllowance)
          .accountsPartial({
            allowanceManager,
            config: psmConfig,
          })
          .signers(extraSigners)
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

  // ---- Step 5: Configure direct-burner role + allowance (mirrors Step 4) ----
  // `direct_burner` defaults to Pubkey::default(), same as direct_minter.
  // Without this step the SVM->EVM bridge burn path stays dead until a
  // separate grant-roles run, with no error to signal it.
  const directBurner = authorities.psm.directBurner;
  if (directBurner && !directBurner.equals(PublicKey.default)) {
    logger.info('Configuring direct-burner role...');
    try {
      const currentCfg: any = await program.account['psmConfig'].fetch(psmConfig);
      const currentDirectBurner = currentCfg.directBurner as PublicKey;

      if (currentDirectBurner.equals(directBurner)) {
        logger.warning(
          `direct_burner already set to ${directBurner.toBase58().slice(0, 12)}... — skipping`
        );
      } else {
        await program.methods
          .setAuthority({ directBurner: {} }, directBurner)
          .accountsPartial({
            roleAdmin: provider.wallet.publicKey,
            config: psmConfig,
          })
          .rpc();
        logger.success(`direct_burner set to ${directBurner.toBase58().slice(0, 12)}...`);
      }

      const allowanceManager = currentCfg.allowanceManager as PublicKey;
      const extraSigners = resolveAllowanceManagerSigners(provider, allowanceManager);
      const currentAllowance = currentCfg.directBurnerAllowance;
      const targetAllowance = new BN(DIRECT_BURNER_ALLOWANCE);
      if (currentAllowance && currentAllowance.eq(targetAllowance)) {
        logger.warning(
          `direct_burner_allowance already ${targetAllowance.toString()} — skipping`
        );
      } else if (extraSigners === null) {
        logger.warning(
          `allowance_manager is ${allowanceManager.toBase58().slice(0, 12)}... ` +
            `(not a locally-held key) — skipping direct_burner_allowance. ` +
            `Run set-direct-burner-allowance.ts with that wallet.`
        );
      } else {
        await program.methods
          .setDirectBurnerAllowance(targetAllowance)
          .accountsPartial({
            allowanceManager,
            config: psmConfig,
          })
          .signers(extraSigners)
          .rpc();
        logger.success(
          `direct_burner_allowance set to ${targetAllowance.toString()}`
        );
      }
    } catch (error: any) {
      logger.warning(
        `Direct-burner setup failed (non-fatal): ${error.message?.slice(0, 80)}`
      );
      logger.info(
        'Run NETWORK=<network> tsx scripts/admin/grant-roles.ts to configure separately.'
      );
    }
  } else {
    logger.info('No directBurner configured in authorities -- skipping (configure via grant-roles).');
  }

  return {
    psmConfig,
    okuMMint,
    vaultUsdc,
    vaultOkuM,
  };
}

