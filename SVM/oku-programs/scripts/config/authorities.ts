/**
 * RBAC authority mappings. Non-mainnet: deployer is `role_admin`, one local
 * operator key holds the granular roles. Mainnet: pubkeys from MAINNET_* env vars.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NetworkName } from './networks';
import { DEFAULT_DIRECT_MINTER } from './constants';

/** Devnet operator key path: `DEVNET_AUTHORITY_PATH`, else `keys/devnet-authority.json` (see keys/README.md). */
export function devnetAuthorityPath(): string {
  return (
    process.env.DEVNET_AUTHORITY_PATH ||
    path.join(process.cwd(), 'keys', 'devnet-authority.json')
  );
}

/** Load the devnet operator keypair (holds the 9 granular roles; must differ from the deployer). */
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
  // PSM authorities (matches `AuthorityRole` in roles.rs)
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
    /** Fiat gateway: mints OkuM without USDC. `PublicKey.default` = disabled. */
    directMinter: PublicKey;
    /** Bridge backend: burns OkuM without USDC payout. `PublicKey.default` = disabled. */
    directBurner: PublicKey;
  };
}

/**
 * Build an AuthorityConfig for localnet/devnet/fork deployments.
 *
 * Two-key model: `initialize` requires role_admin to be the BPF upgrade
 * authority (the deployer) and rejects any of the 9 granular roles equal to
 * role_admin (`InvalidAuthority`, 6024). So the deployer keeps `role_admin`
 * (and claw-back via `set_authority`) and one operator key
 * (`keys/devnet-authority.json`) holds the other 9.
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
      // role_admin MUST be the BPF upgrade authority.
      roleAdmin: deployer,
      // The 9 granular roles collapse onto the operator key (single signer for smoke tests).
      pauser: operator,
      unpauser: operator,
      freezer: operator,
      unfreezer: operator,
      bufferDepositor: operator,
      bufferWithdrawer: operator,
      capManager: operator,
      allowanceManager: operator,
      rebaser: operator,
      // directMinter/directBurner model third-party operators (see grant-roles.ts).
      directMinter: new PublicKey(DEFAULT_DIRECT_MINTER),
      directBurner: new PublicKey(DEFAULT_DIRECT_MINTER),
    },
  };
}

/** Testnet/fork networks use the two-key model. */
function isTestnetOrFork(network: NetworkName): boolean {
  return (
    network === 'localnet' ||
    network === 'devnet' ||
    network === 'devnet-fork' ||
    network === 'mainnet-fork'
  );
}

/**
 * Load authorities: testnet/fork use `allRolesToOperatorKey`; mainnet-beta
 * reads MAINNET_* env vars. `_litePsmProgramId` is currently unused.
 */
export function loadAuthorities(
  network: NetworkName,
  deployerPubkey?: PublicKey,
  _litePsmProgramId?: PublicKey
): AuthorityConfig {
  if (isTestnetOrFork(network)) {
    const deployer = deployerPubkey || PublicKey.default;
    const operator = loadDevnetAuthority().publicKey;
    return allRolesToOperatorKey(deployer, operator);
  }

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
