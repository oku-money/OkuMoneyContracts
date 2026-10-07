/**
 * Grant OPERATIONAL (non-governance) roles to a delegate EOA ("operate, don't own").
 *
 * Grants only:
 *   - directMinter      mint OkuM directly, capped by direct_minter_allowance
 *   - directBurner      burn OkuM directly, capped by direct_burner_allowance
 *   - rebaser           sets the yield-rate schedule / multiplier override
 *   - bufferDepositor   deposit into the USDC buffer
 *
 * NEVER grants roleAdmin (retaining it is the deployer's claw-back power via
 * set_authority) or the governance/safety roles (pauser, unpauser, freezer,
 * unfreezer, capManager, allowanceManager, bufferWithdrawer). In particular,
 * allowanceManager must not go to the party whose allowance it caps. Do not
 * extend this script to grant them; use `set-authority.ts` for those.
 *
 * Idempotent: skips roles already held by the delegate. The signer must hold
 * `role_admin` on the PSM program.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/grant-roles.ts [--delegate=<pubkey>] [--dry-run] [--mint-usdc]
 *   (--mint-usdc: opt-in mock USDC mint to the delegate)
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
import { createProvider, detectNetwork, loadKeypair } from '../utils/network';
import { loadDevnetAuthority } from '../config/authorities';
import { loadDeploymentStrict } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

// ============================================================================
// Configuration
// ============================================================================

import {
  DEFAULT_DIRECT_MINTER,
  DIRECT_MINTER_ALLOWANCE as DIRECT_MINTER_ALLOWANCE_CONST,
  DIRECT_BURNER_ALLOWANCE as DIRECT_BURNER_ALLOWANCE_CONST,
} from '../config/constants';

const DEFAULT_DELEGATE = DEFAULT_DIRECT_MINTER;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const delegateArg = parseArg('delegate');
const DELEGATE_PUBKEY = new PublicKey(delegateArg ?? DEFAULT_DELEGATE);

/** Opt-in: mint mock USDC to a recipient. Off by default. */
const MINT_USDC = hasFlag('mint-usdc');

/** Amount of mock USDC to mint (100k USDC, 6 decimals). */
const USDC_MINT_AMOUNT = 100_000 * 1_000_000; // 100,000 USDC

/** Recipient for mock USDC mint (may differ from the delegate EOA). */
const USDC_RECIPIENT = new PublicKey(
  parseArg('usdc-recipient') ?? '2rWhEhK8kqdsS8NjtAQZdG6CK17NZMnPKmsrrsDuotoo'
);

// ============================================================================
// Role definitions
// ============================================================================

/** OPERATIONAL PSM roles granted to the delegate (see header for exclusions). */
const PSM_ROLES = [
  'directMinter',
  'directBurner',
  'rebaser',
  'bufferDepositor',
] as const;

/** Governance/safety roles this script deliberately does NOT touch (documented for operator visibility). */
const RETAINED_GOVERNANCE_ROLES = [
  'pauser',
  'unpauser',
  'freezer',
  'unfreezer',
  'capManager',
  'allowanceManager',
  'bufferWithdrawer',
] as const;

/** Direct-minter allowance to set after granting roles (1M OkuM, 6 decimals). */
const DIRECT_MINTER_ALLOWANCE = DIRECT_MINTER_ALLOWANCE_CONST;

/** Direct-burner allowance to set after granting roles (1M OkuM, 6 decimals). */
const DIRECT_BURNER_ALLOWANCE = DIRECT_BURNER_ALLOWANCE_CONST;

// ============================================================================
// Types
// ============================================================================

type GrantStatus = 'granted' | 'already' | 'would_grant' | 'skipped' | 'error';

/**
 * Resolve the extra signers needed to act as `allowance_manager` (on
 * devnet/localnet the operator key, not the deployer; see
 * `config/authorities.ts::allRolesToOperatorKey`).
 *   - `[]`   the signer already IS allowance_manager
 *   - `[kp]` the locally-held operator key is allowance_manager
 *   - `null` we do not hold it — caller must skip
 */
function resolveAllowanceManagerSigners(
  signer: PublicKey,
  allowanceManager: PublicKey
): Keypair[] | null {
  if (allowanceManager.equals(signer)) return [];
  try {
    const operator = loadDevnetAuthority();
    if (operator.publicKey.equals(allowanceManager)) return [operator];
  } catch {
    // No local operator key available.
  }
  return null;
}

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

  if (DELEGATE_PUBKEY.equals(PublicKey.default)) {
    throw new Error('Delegate pubkey cannot be the zero pubkey.');
  }

  const dryRun = isDryRun();
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No lite-psm deployment for ${network}; run deploy:programs first.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);

  const psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;

  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const roleAdmin = provider.wallet.publicKey;

  logger.info(
    summaryBlock('grant-roles plan', {
      network,
      delegate: DELEGATE_PUBKEY.toBase58(),
      'signer (role_admin)': roleAdmin.toBase58(),
      'PSM config': psmConfig.toBase58(),
      'granting (operational)': `${PSM_ROLES.length} -- ${PSM_ROLES.join(', ')}`,
      'retaining (governance, untouched)': `${RETAINED_GOVERNANCE_ROLES.length} -- ${RETAINED_GOVERNANCE_ROLES.join(', ')}`,
      'dry-run': String(dryRun),
      'mint-usdc': String(MINT_USDC),
    })
  );

  if (!dryRun) {
    await confirmIfMainnet(network, 'grant-roles: about to send role-rotation transactions.', provider.connection);
  }

  const results: GrantResult[] = [];

  // ---- Set direct-minter / direct-burner allowances BEFORE rotating roles ----
  // allowanceManager is never rotated here. If the signer (or a local operator
  // key) is not allowanceManager this section skips with a warning; use
  // `set-direct-{minter,burner}-allowance.ts` with that key instead.
  logger.section('Direct-minter allowance (pre-rotation)');

  {
    const psmCfgPre = await psmProgram.account.psmConfig.fetch(psmConfig);
    const currentAllowance = (psmCfgPre as any).directMinterAllowance;
    const targetAllowance = new anchor.BN(DIRECT_MINTER_ALLOWANCE);
    const currentAllowanceManager = (psmCfgPre as any).allowanceManager as PublicKey;

    const extraSigners = resolveAllowanceManagerSigners(roleAdmin, currentAllowanceManager);

    if (currentAllowance && currentAllowance.eq(targetAllowance)) {
      logger.info(`  direct_minter_allowance already ${targetAllowance.toString()} -- skipping`);
    } else if (extraSigners === null) {
      logger.warning(
        `  allowanceManager is ${currentAllowanceManager.toBase58().slice(0, 12)}... ` +
          `(not the signer, and no matching local operator key). ` +
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
            allowanceManager: currentAllowanceManager,
            config: psmConfig,
          })
          .signers(extraSigners)
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

  logger.section('Direct-burner allowance (pre-rotation)');

  {
    const psmCfgPre = await psmProgram.account.psmConfig.fetch(psmConfig);
    const currentAllowance = (psmCfgPre as any).directBurnerAllowance;
    const targetAllowance = new anchor.BN(DIRECT_BURNER_ALLOWANCE);
    const currentAllowanceManager = (psmCfgPre as any).allowanceManager as PublicKey;

    const extraSigners = resolveAllowanceManagerSigners(roleAdmin, currentAllowanceManager);

    if (currentAllowance && currentAllowance.eq(targetAllowance)) {
      logger.info(`  direct_burner_allowance already ${targetAllowance.toString()} -- skipping`);
    } else if (extraSigners === null) {
      logger.warning(
        `  allowanceManager is ${currentAllowanceManager.toBase58().slice(0, 12)}... ` +
          `(not the signer, and no matching local operator key). ` +
          `Skipping -- use set-direct-burner-allowance.ts with the allowanceManager wallet.`
      );
    } else if (dryRun) {
      logger.info(
        `  Would set direct_burner_allowance to ${targetAllowance.toString()} ` +
          `(current: ${currentAllowance?.toString() ?? '0'})`
      );
    } else {
      try {
        const sig = await psmProgram.methods
          .setDirectBurnerAllowance(targetAllowance)
          .accountsPartial({
            allowanceManager: currentAllowanceManager,
            config: psmConfig,
          })
          .signers(extraSigners)
          .rpc();
        logger.success(
          `  set_direct_burner_allowance(${targetAllowance.toString()}) -- tx: ${sig.slice(0, 20)}...`
        );
      } catch (e: any) {
        const msg = e?.message?.slice(0, 80) ?? String(e);
        logger.error(`  set_direct_burner_allowance failed: ${msg}`);
      }
    }
  }

  // ---- PSM roles (operational only -- see header) ----
  logger.section('lite-psm roles (operational)');

  // Single config snapshot is enough for the idempotency check.
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
  if (DELEGATE_PUBKEY.equals(psmRoleAdmin)) {
    throw new Error(
      `Delegate pubkey equals PSM role_admin (${psmRoleAdmin.toBase58()}). ` +
        `The contract rejects setting non-RoleAdmin roles to the role_admin pubkey ` +
        `(separation-of-duties guard).`
    );
  }

  for (const role of PSM_ROLES) {
    const current = (psmCfg as any)[role] as PublicKey;
    if (current && current.equals(DELEGATE_PUBKEY)) {
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
        .setAuthority(roleEnum, DELEGATE_PUBKEY)
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

  // ---- Mint mock USDC to delegate EOA (opt-in via --mint-usdc) ----
  logger.section('Mock USDC mint');

  if (!MINT_USDC) {
    logger.info('Skipped (opt-in via --mint-usdc).');
  } else {
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
  logger.info(
    `Retained (not touched): roleAdmin, ${RETAINED_GOVERNANCE_ROLES.join(', ')}`
  );

  if (errors > 0) {
    throw new Error(`${errors} role grant(s) failed.`);
  }

  logger.success(
    `All ${PSM_ROLES.length} operational roles ` +
      (dryRun ? 'would be ' : '') +
      `granted to ${DELEGATE_PUBKEY.toBase58()}. ` +
      `Governance/safety roles remain with role_admin / the governance key.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
