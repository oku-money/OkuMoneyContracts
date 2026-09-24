/**
 * RBAC authority mappings
 *
 * For localnet/devnet: uses deployer wallet for all authorities (simplifies signing)
 * For mainnet: requires separate pubkeys via environment variables
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NetworkName } from './networks';
import { DEFAULT_DIRECT_MINTER } from './constants';

/**
 * Path to the devnet/localnet operational key ("devnet operator").
 *
 * Overridable via `DEVNET_AUTHORITY_PATH` for CI, which may stage the key
 * somewhere other than the repo. Defaults to `keys/devnet-authority.json`
 * relative to the package root, as documented in `keys/README.md`.
 */
export function devnetAuthorityPath(): string {
  return (
    process.env.DEVNET_AUTHORITY_PATH ||
    path.join(process.cwd(), 'keys', 'devnet-authority.json')
  );
}

/**
 * Load the devnet operator keypair.
 *
 * This key holds the 9 granular authorities on non-mainnet deployments.
 * It CANNOT be the deployer wallet — see `allRolesToOperatorKey` below for
 * the on-chain constraint that forces the split.
 */
export function loadDevnetAuthority(): Keypair {
  const p = devnetAuthorityPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Devnet operator keypair not found at ${p}.\n` +
        `The lite-psm program requires the 9 granular authorities to be ` +
        `DISJOINT from role_admin (which must itself be the deployer / BPF ` +
        `upgrade authority), so devnet needs a second key.\n` +
        `Generate one with:\n` +
        `  solana-keygen new --outfile keys/devnet-authority.json\n` +
        `then fund it:\n` +
        `  solana transfer <pubkey> 0.5 --url devnet --allow-unfunded-recipient`
    );
  }
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf-8')))
  );
}

export interface AuthorityConfig {
  // PSM authorities (12 roles — matches `AuthorityRole` in roles.rs)
  psm: {
    roleAdmin: PublicKey;
    pauser: PublicKey;
    unpauser: PublicKey;
    freezer: PublicKey;
    unfreezer: PublicKey;
    bufferDepositor: PublicKey;
    bufferWithdrawer: PublicKey;
    capManager: PublicKey;
    allowanceManager: PublicKey;
    rebaser: PublicKey;
    /**
     * Operator / fiat gateway — can mint OkuM directly without USDC.
     * Cannot be the same as roleAdmin (separation-of-duties guard).
     * `PublicKey.default` means "not configured / disabled".
     */
    directMinter: PublicKey;
    /**
     * Operator / bridge backend — can burn OkuM directly without USDC
     * payout. Cannot be the same as roleAdmin (separation-of-duties guard).
     * `PublicKey.default` means "not configured / disabled".
     */
    directBurner: PublicKey;
  };
}

/**
 * Build an AuthorityConfig for localnet/devnet/fork deployments.
 *
 * WHY THIS IS A TWO-KEY MODEL
 * ---------------------------
 * Two on-chain constraints in `lite-psm` are jointly binding at
 * `initialize` time, and they force the deployer and the operational roles
 * onto DIFFERENT keys:
 *
 *   1. `contexts/init.rs` — `program_data.upgrade_authority_address ==
 *      Some(role_admin.key())`. The account that signs `initialize` and
 *      becomes `config.role_admin` MUST be the program's BPF upgrade
 *      authority, i.e. the deploying wallet. This is not negotiable from
 *      the client side.
 *
 *   2. `instructions/init.rs` — every one of the 9 granular authorities is
 *      checked `!= role_admin` (and `!= Pubkey::default()`). This mirrors
 *      `set_authority`'s separation-of-duties guard in `psm_admin.rs`: the
 *      root/claw-back meta-role must never also hold an operational role.
 *
 * Together: role_admin == deployer (forced by 1), therefore none of the 9
 * granular roles may be the deployer (forced by 2).
 *
 * Pointing any of the 9 at the deployer makes `initialize` revert with
 * `InvalidAuthority` (6024). So on non-mainnet all 9 granular roles are seated
 * on a single locally-held "devnet operator" key
 * (`keys/devnet-authority.json`): ONE key signs every operational call during
 * smoke testing, while satisfying the on-chain guard. The deployer retains
 * `role_admin`, and therefore unconditional claw-back of every role via
 * `set_authority`.
 */
function allRolesToOperatorKey(
  deployer: PublicKey,
  operator: PublicKey
): AuthorityConfig {
  if (operator.equals(deployer)) {
    throw new Error(
      `Devnet operator key (${operator.toBase58()}) must not equal the ` +
        `deployer/role_admin wallet — the on-chain initialize guard rejects ` +
        `any granular authority set to role_admin. Generate a distinct key ` +
        `at keys/devnet-authority.json.`
    );
  }
  return {
    psm: {
      // role_admin MUST be the BPF upgrade authority (constraint 1 above).
      roleAdmin: deployer,
      // The 9 granular roles collapse onto the operator key: distinct from
      // role_admin (constraint 2) but still a single signer for smoke tests.
      pauser: operator,
      unpauser: operator,
      freezer: operator,
      unfreezer: operator,
      bufferDepositor: operator,
      bufferWithdrawer: operator,
      capManager: operator,
      allowanceManager: operator,
      rebaser: operator,
      // directMinter/directBurner stay on the shared devnet delegate EOA —
      // these model a third-party operator (fiat gateway / bridge backend)
      // and are exercised via grant-roles.ts rather than the smoke test.
      directMinter: new PublicKey(DEFAULT_DIRECT_MINTER),
      directBurner: new PublicKey(DEFAULT_DIRECT_MINTER),
    },
  };
}

/**
 * Check if network uses deployer wallet for all authorities (testnet/fork mode)
 */
function isTestnetOrFork(network: NetworkName): boolean {
  return (
    network === 'localnet' ||
    network === 'devnet' ||
    network === 'devnet-fork' ||
    network === 'mainnet-fork'
  );
}

/**
 * Load authorities based on network
 *
 * - localnet/devnet/devnet-fork/mainnet-fork: `role_admin` is the deployer
 *   wallet; the 9 granular roles are seated on the locally-held devnet
 *   operator key (`keys/devnet-authority.json`). See
 *   `allRolesToOperatorKey` for why these cannot be the same key.
 * - mainnet-beta: loads separate pubkeys from MAINNET_* env vars.
 *
 * `litePsmProgramId` is accepted (and currently unused) for forward
 * compatibility with PDA-derived authorities if we reintroduce any.
 */
export function loadAuthorities(
  network: NetworkName,
  deployerPubkey?: PublicKey,
  _litePsmProgramId?: PublicKey
): AuthorityConfig {
  // Testnet/fork: deployer holds role_admin, operator key holds the rest.
  if (isTestnetOrFork(network)) {
    const deployer = deployerPubkey || PublicKey.default;
    const operator = loadDevnetAuthority().publicKey;
    return allRolesToOperatorKey(deployer, operator);
  }

  // For mainnet-beta only, load separate authority pubkeys from environment
  const coldMultisig = getEnvPubkey('MAINNET_COLD_MULTISIG', true);
  const warmMultisig = getEnvPubkey('MAINNET_WARM_MULTISIG', true);
  const orchestrator = getEnvPubkey('MAINNET_ORCHESTRATOR', true);

  const directMinter = getEnvPubkey('MAINNET_DIRECT_MINTER', false);
  const directBurner = getEnvPubkey('MAINNET_DIRECT_BURNER', false);

  return {
    psm: {
      roleAdmin: coldMultisig,
      pauser: warmMultisig,
      unpauser: coldMultisig,
      freezer: warmMultisig,
      unfreezer: coldMultisig,
      bufferDepositor: orchestrator,
      bufferWithdrawer: coldMultisig,
      capManager: coldMultisig,
      allowanceManager: coldMultisig,
      rebaser: orchestrator,
      directMinter,
      directBurner,
    },
  };
}

function getEnvPubkey(key: string, required: boolean = false): PublicKey {
  const value = process.env[key];

  if (!value) {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return PublicKey.default;
  }

  try {
    return new PublicKey(value);
  } catch (error) {
    throw new Error(`Invalid public key for ${key}: ${value}`);
  }
}
