/**
 * Grant all non-RoleAdmin roles to a master EOA.
 *
 * Idempotently rotates every authority on both lite-psm (11 roles) and
 * oku-dollar (4 roles) to a single "master" pubkey so that one dev
 * wallet can do everything during testing.
 *
 * RoleAdmin is intentionally skipped -- it uses a two-step transfer
 * (propose + accept) and should be handled separately if needed.
 *
 * The signer must hold `role_admin` on both programs (the deployer
 * wallet on testnet deployments).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/grant-roles.ts
 *   NETWORK=devnet tsx scripts/admin/grant-roles.ts --master=<pubkey>
 *   NETWORK=devnet tsx scripts/admin/grant-roles.ts --dry-run
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from '@solana/spl-token';
import * as os from 'os';
import { LitePsm } from '../../target/types/lite_psm';
import { OkuDollar } from '../../target/types/oku_dollar';
import { createProvider, detectNetwork, loadKeypair } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA, deriveVaultConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

// ============================================================================
// Configuration
// ============================================================================

import {
  DEFAULT_DIRECT_MINTER,
  DIRECT_MINTER_ALLOWANCE as DIRECT_MINTER_ALLOWANCE_CONST,
} from '../config/constants';

const DEFAULT_MASTER = DEFAULT_DIRECT_MINTER;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

const MASTER_PUBKEY = new PublicKey(parseArg('master') ?? DEFAULT_MASTER);

/** Amount of mock USDC to mint (100k USDC, 6 decimals). */
const USDC_MINT_AMOUNT = 100_000 * 1_000_000; // 100,000 USDC

/** Recipient for mock USDC mint (may differ from the master EOA). */
const USDC_RECIPIENT = new PublicKey(
  parseArg('usdc-recipient') ?? '2rWhEhK8kqdsS8NjtAQZdG6CK17NZMnPKmsrrsDuotoo'
);

// ============================================================================
// Role definitions
// ============================================================================

/** PSM roles (excluding roleAdmin -- two-step, handled separately). */
const PSM_ROLES = [
  'pauser',
  'unpauser',
  'freezer',
  'unfreezer',
  'queueProcessor',
  'bufferDepositor',
  'bufferWithdrawer',
  'oracleManager',
  'capManager',
  'allowanceManager',
  'rebaser',
  'directMinter',
] as const;

/** Direct-minter allowance to set after granting roles (1M OkuMoney, 6 decimals). */
const DIRECT_MINTER_ALLOWANCE = DIRECT_MINTER_ALLOWANCE_CONST;

/** OkuDollar vault roles (excluding roleAdmin). */
const VAULT_ROLES = [
  'pauser',
  'unpauser',
  'usdRebaser',
  'reserveManager',
] as const;

// ============================================================================
// Types
// ============================================================================

type GrantStatus = 'granted' | 'already' | 'would_grant' | 'skipped' | 'error';

interface GrantResult {
  program: string;
  role: string;
  status: GrantStatus;
  detail?: string;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const network = detectNetwork();
  logger.header(`grant-roles (${network})`);

  if (MASTER_PUBKEY.equals(PublicKey.default)) {
    throw new Error('Master pubkey cannot be the zero pubkey.');
  }

  const dryRun = isDryRun();
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No lite-psm deployment for ${network}; run deploy:programs first.`);
  }
  const okuDollarProgramId = deployment.programs.okuDollarProgram ?? deployment.programs.okuDollar;
  if (!okuDollarProgramId) {
    throw new Error(`No oku-dollar deployment for ${network}; run deploy:programs first.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuDollarId = new PublicKey(okuDollarProgramId);

  const psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;
  const vaultProgram = anchor.workspace.OkuDollar as Program<OkuDollar>;

  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);

  const roleAdmin = provider.wallet.publicKey;

  logger.info(
    summaryBlock('grant-roles plan', {
      network,
      master: MASTER_PUBKEY.toBase58(),
      'signer (role_admin)': roleAdmin.toBase58(),
      'PSM config': psmConfig.toBase58(),
      'Vault config': vaultConfig.toBase58(),
      'PSM roles': `${PSM_ROLES.length} (roleAdmin skipped, includes directMinter)`,
      'Vault roles': `${VAULT_ROLES.length} (roleAdmin skipped)`,
      'dry-run': String(dryRun),
    })
  );

  if (!dryRun) {
    await confirmIfMainnet(network, 'grant-roles: about to send role-rotation transactions.');
  }

  const results: GrantResult[] = [];

  // ---- Set direct-minter allowance BEFORE rotating roles ----
  // IMPORTANT: This must run BEFORE the PSM role grants loop below.
  // The loop rotates `allowanceManager` from the deployer to MASTER_PUBKEY,
  // after which the deployer can no longer sign `setDirectMinterAllowance`.
  // By setting the allowance first (while `allowanceManager` is still the
  // deployer), we avoid the chicken-and-egg ordering problem.
  logger.section('Direct-minter allowance (pre-rotation)');

  {
    const psmCfgPre = await psmProgram.account.psmConfig.fetch(psmConfig);
    const currentAllowance = (psmCfgPre as any).directMinterAllowance;
    const targetAllowance = new anchor.BN(DIRECT_MINTER_ALLOWANCE);
    const currentAllowanceManager = (psmCfgPre as any).allowanceManager as PublicKey;

    if (currentAllowance && currentAllowance.eq(targetAllowance)) {
      logger.info(`  direct_minter_allowance already ${targetAllowance.toString()} -- skipping`);
    } else if (!currentAllowanceManager.equals(roleAdmin)) {
      logger.warning(
        `  allowanceManager is ${currentAllowanceManager.toBase58().slice(0, 12)}... (not the signer). ` +
          `Skipping -- use set-direct-minter-allowance.ts with the allowanceManager wallet.`
      );
    } else if (dryRun) {
      logger.info(
        `  Would set direct_minter_allowance to ${targetAllowance.toString()} ` +
          `(current: ${currentAllowance?.toString() ?? '0'})`
      );
    } else {
      try {
        const sig = await psmProgram.methods
          .setDirectMinterAllowance(targetAllowance)
          .accountsPartial({
            allowanceManager: roleAdmin,
            config: psmConfig,
          })
          .rpc();
        logger.success(
          `  set_direct_minter_allowance(${targetAllowance.toString()}) -- tx: ${sig.slice(0, 20)}...`
        );
      } catch (e: any) {
        const msg = e?.message?.slice(0, 80) ?? String(e);
        logger.error(`  set_direct_minter_allowance failed: ${msg}`);
      }
    }
  }

  // ---- PSM roles ----
  logger.section('lite-psm roles');

  // Fetch config once; re-fetch after mutations would be ideal but for
  // idempotency checking the initial snapshot is sufficient -- we only
  // skip roles that already point to MASTER_PUBKEY, and the on-chain
  // set_authority is itself idempotent (re-setting to the same value
  // would succeed, though it wastes a tx).
  const psmCfg = await psmProgram.account.psmConfig.fetch(psmConfig);

  // Verify signer is role_admin
  const psmRoleAdmin = psmCfg.roleAdmin as PublicKey;
  if (!psmRoleAdmin.equals(roleAdmin)) {
    throw new Error(
      `PSM role_admin is ${psmRoleAdmin.toBase58()} but signer is ${roleAdmin.toBase58()}. ` +
        `The signer must hold role_admin to grant roles.`
    );
  }

  // Separation-of-duties guard: new_authority must != role_admin
  if (MASTER_PUBKEY.equals(psmRoleAdmin)) {
    throw new Error(
      `Master pubkey equals PSM role_admin (${psmRoleAdmin.toBase58()}). ` +
        `The contract rejects setting non-RoleAdmin roles to the role_admin pubkey ` +
        `(separation-of-duties guard).`
    );
  }

  for (const role of PSM_ROLES) {
    const current = (psmCfg as any)[role] as PublicKey;
    if (current && current.equals(MASTER_PUBKEY)) {
      logger.info(`  ${role.padEnd(20)} already`);
      results.push({ program: 'lite-psm', role, status: 'already' });
      continue;
    }

    if (dryRun) {
      logger.info(`  ${role.padEnd(20)} would_grant (current: ${current?.toBase58() ?? '?'})`);
      results.push({ program: 'lite-psm', role, status: 'would_grant' });
      continue;
    }

    try {
      const roleEnum = { [role]: {} } as any;
      const sig = await psmProgram.methods
        .setAuthority(roleEnum, MASTER_PUBKEY)
        .accountsPartial({
          roleAdmin,
          config: psmConfig,
        })
        .rpc();
      logger.success(`  ${role.padEnd(20)} granted (tx: ${sig.slice(0, 20)}...)`);
      results.push({ program: 'lite-psm', role, status: 'granted' });
    } catch (e: any) {
      const msg = e?.message?.slice(0, 80) ?? String(e);
      logger.error(`  ${role.padEnd(20)} error: ${msg}`);
      results.push({ program: 'lite-psm', role, status: 'error', detail: msg });
    }
  }

  // ---- Vault roles ----
  logger.section('oku-dollar roles');

  const vaultCfg = await vaultProgram.account.okuDollarConfig.fetch(vaultConfig);

  const vaultRoleAdmin = vaultCfg.roleAdmin as PublicKey;
  if (!vaultRoleAdmin.equals(roleAdmin)) {
    throw new Error(
      `Vault role_admin is ${vaultRoleAdmin.toBase58()} but signer is ${roleAdmin.toBase58()}.`
    );
  }

  if (MASTER_PUBKEY.equals(vaultRoleAdmin)) {
    throw new Error(
      `Master pubkey equals Vault role_admin (${vaultRoleAdmin.toBase58()}). ` +
        `Separation-of-duties guard would reject.`
    );
  }

  for (const role of VAULT_ROLES) {
    const current = (vaultCfg as any)[role] as PublicKey;
    if (current && current.equals(MASTER_PUBKEY)) {
      logger.info(`  ${role.padEnd(20)} already`);
      results.push({ program: 'oku-dollar', role, status: 'already' });
      continue;
    }

    if (dryRun) {
      logger.info(`  ${role.padEnd(20)} would_grant (current: ${current?.toBase58() ?? '?'})`);
      results.push({ program: 'oku-dollar', role, status: 'would_grant' });
      continue;
    }

    try {
      const roleEnum = { [role]: {} } as any;
      const sig = await vaultProgram.methods
        .setAuthority(roleEnum, MASTER_PUBKEY)
        .accountsPartial({
          roleAdmin,
          config: vaultConfig,
        })
        .rpc();
      logger.success(`  ${role.padEnd(20)} granted (tx: ${sig.slice(0, 20)}...)`);
      results.push({ program: 'oku-dollar', role, status: 'granted' });
    } catch (e: any) {
      const msg = e?.message?.slice(0, 80) ?? String(e);
      logger.error(`  ${role.padEnd(20)} error: ${msg}`);
      results.push({ program: 'oku-dollar', role, status: 'error', detail: msg });
    }
  }

  // ---- Mint mock USDC to master EOA ----
  logger.section('Mock USDC mint');

  const usdcMintAddr = deployment.tokens?.usdc;
  if (!usdcMintAddr) {
    logger.warning('No USDC mint in deployment; skipping mock USDC mint.');
  } else {
    const usdcMint = new PublicKey(usdcMintAddr);

    // Load the deployer keypair (needed for signing mintTo -- the deployer
    // is the mint authority on mock USDC).
    const walletPath =
      process.env.WALLET_PATH || `${os.homedir()}/.config/solana/id.json`;
    const deployer = loadKeypair(walletPath);
    const connection = provider.connection;

    // Get or create the recipient's USDC ATA.
    logger.info(`USDC recipient: ${USDC_RECIPIENT.toBase58()}`);
    const recipientUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      USDC_RECIPIENT,
      true,
      TOKEN_PROGRAM_ID
    );
    const ataInfo = await connection.getAccountInfo(recipientUsdcAta);
    if (!ataInfo) {
      if (dryRun) {
        logger.info(`Would create USDC ATA for ${USDC_RECIPIENT.toBase58().slice(0, 12)}...`);
      } else {
        const createAtaTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            deployer.publicKey,
            recipientUsdcAta,
            USDC_RECIPIENT,
            usdcMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(connection, createAtaTx, [deployer]);
        logger.success(`Created USDC ATA ${recipientUsdcAta.toBase58().slice(0, 12)}...`);
      }
    }

    if (dryRun) {
      logger.info(
        `Would mint ${USDC_MINT_AMOUNT / 1_000_000} USDC to ${USDC_RECIPIENT.toBase58().slice(0, 12)}...`
      );
    } else {
      const mintTx = new Transaction().add(
        createMintToInstruction(
          usdcMint,
          recipientUsdcAta,
          deployer.publicKey,
          USDC_MINT_AMOUNT,
          [],
          TOKEN_PROGRAM_ID
        )
      );
      const sig = await sendAndConfirmTransaction(connection, mintTx, [deployer]);
      logger.success(
        `Minted ${USDC_MINT_AMOUNT / 1_000_000} USDC to ${USDC_RECIPIENT.toBase58().slice(0, 12)}... (tx: ${sig.slice(0, 20)}...)`
      );

      // Verify
      const acct = await getAccount(connection, recipientUsdcAta, 'confirmed', TOKEN_PROGRAM_ID);
      logger.info(`Recipient USDC balance: ${Number(acct.amount) / 1_000_000} USDC`);
    }
  }

  // ---- Summary ----
  logger.section('Summary');

  const granted = results.filter((r) => r.status === 'granted').length;
  const already = results.filter((r) => r.status === 'already').length;
  const wouldGrant = results.filter((r) => r.status === 'would_grant').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log('  Program       Role                  Status');
  console.log('  -----------   --------------------  ------');
  for (const r of results) {
    const icon =
      r.status === 'granted'
        ? '\x1b[32mGRANTED\x1b[0m'
        : r.status === 'already'
          ? '\x1b[36malready\x1b[0m'
          : r.status === 'would_grant'
            ? '\x1b[33mwould_grant\x1b[0m'
            : '\x1b[31mERROR\x1b[0m';
    console.log(`  ${r.program.padEnd(13)} ${r.role.padEnd(22)} ${icon}`);
    if (r.detail) console.log(`               ${r.detail}`);
  }
  console.log();

  logger.info(`Granted:     ${granted}`);
  logger.info(`Already:     ${already}`);
  if (wouldGrant) logger.info(`Would grant: ${wouldGrant} (dry-run)`);
  if (errors) logger.error(`Errors:      ${errors}`);
  logger.info(`Skipped:     roleAdmin (two-step; handle separately)`);

  if (errors > 0) {
    throw new Error(`${errors} role grant(s) failed.`);
  }

  logger.success(
    `All ${PSM_ROLES.length + VAULT_ROLES.length} roles ` +
      (dryRun ? 'would be ' : '') +
      `granted to ${MASTER_PUBKEY.toBase58()}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
