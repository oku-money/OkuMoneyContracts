/**
 * Deployment address book management
 *
 * `deployments/<network>.json` is written by `scripts/deploy/deploy-init.ts`
 * after a successful Phase-2 deploy. **The file is per-target-network**:
 * `deployments/devnet.json` should hold devnet program IDs, `localnet.json`
 * the localnet IDs, and so on.
 *
 * Stale-file failure mode the assertion below guards against: it is easy
 * for `deployments/devnet.json` to get left behind from a previous run
 * (e.g. against the localnet program IDs in `Anchor.toml [programs.localnet]`)
 * after a `Anchor.toml [programs.devnet]` redeploy. Any script that loads
 * the wrong file then sends instructions to a *different* program than the
 * one currently active for `NETWORK=devnet`. Symptoms: `Cross-program
 * invocation with unauthorized signer` or `AccountNotFound` for PDAs that
 * "should" exist. Hard to debug from the script side.
 *
 * Mitigation: every `loadDeployment` call cross-checks the on-disk program
 * IDs against `Anchor.toml [programs.<network>]` and prints a loud warning
 * if they don't match. Callers that want to refuse to proceed on mismatch
 * can use `loadDeploymentStrict()` which throws instead.
 *
 * Operational note (rent recovery): when an old `deployments/<network>.json`
 * holds program IDs from a previous deploy, the program data accounts at
 * those IDs may still be holding rent SOL. Recover with:
 *
 *     solana program close <OLD_PROGRAM_ID> --bypass-warning \
 *         --recipient <YOUR_DEPLOYER_PUBKEY> --url devnet
 *
 * before deleting the stale `deployments/<network>.json`. Do NOT delete the
 * file first or the old program IDs are gone from the repo and you have to
 * fish them out of explorer history. See SVM/TESTNET_DEPLOYMENT.md for the
 * full rent-recovery walkthrough.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { NetworkName } from '../config/networks';

export interface DeploymentAddresses {
  network: NetworkName;
  timestamp: string;
  tokens: {
    usdc?: string;
    okuMoney?: string;
    usdOku?: string;
  };
  programs: {
    litePsm?: string;
    okuDollarProgram?: string;
    okuBridgeRouter?: string;
  };
  pdas: {
    psmConfig?: string;
    redemptionQueue?: string;
    psmVaultUsdc?: string;
    psmOkuMoneyEscrow?: string;
    vaultConfig?: string;
    vaultOkusd?: string;
    vaultOkuMoney?: string;
    bridgeConfig?: string;
    routerConfig?: string;
  };
  nonces?: Record<number, string>; // chain_id -> nonce PDA
  authorities?: {
    coldMultisig?: string;
    warmMultisig?: string;
    orchestrator?: string;
    bridgeOrchestrator?: string;
    feeRecipient?: string;
  };
  /**
   * Address Lookup Tables (Phase 8.6). The router ALT collapses ~10
   * common pubkeys into 1-byte indices so `mint_usd_oku`/`redeem_usd_oku`
   * fit under the v0 tx-size ceiling. Created by
   * `scripts/admin/setup-router-alt.ts`. SDK consumers must include the
   * router ALT in every router CPI tx.
   */
  addressLookupTables?: {
    router?: string;
  };
}

const DEPLOYMENTS_DIR = path.join(process.cwd(), 'deployments');

/**
 * Ensure deployments directory exists
 */
function ensureDeploymentsDir() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
}

/**
 * Get deployment file path for network
 */
function getDeploymentPath(network: NetworkName): string {
  return path.join(DEPLOYMENTS_DIR, `${network}.json`);
}

/**
 * Read `Anchor.toml`'s `[programs.<section>]` block and return the program
 * IDs declared there. Returns `{}` if the section is absent or the file
 * can't be read.
 *
 * Anchor.toml section name conventions:
 *   - 'devnet' for NETWORK=devnet / NETWORK=devnet-fork
 *   - 'localnet' for NETWORK=localnet
 *   - 'mainnet' for NETWORK=mainnet-beta / NETWORK=mainnet-fork
 */
function readAnchorTomlPrograms(
  section: 'devnet' | 'localnet' | 'mainnet'
): Record<string, string> {
  const tomlPath = path.join(process.cwd(), 'Anchor.toml');
  if (!fs.existsSync(tomlPath)) return {};
  let content: string;
  try {
    content = fs.readFileSync(tomlPath, 'utf-8');
  } catch {
    return {};
  }
  // Match the `[programs.<section>]` block up to the next `[` header or EOF.
  const re = new RegExp(
    `\\[programs\\.${section}\\][^\\[]*`,
    'm'
  );
  const block = content.match(re);
  if (!block) return {};
  const out: Record<string, string> = {};
  // Each row is `key = "Pubkey"`.
  const rowRe = /^\s*([a-z_][a-z0-9_]*)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gim;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block[0])) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function anchorSectionFor(network: NetworkName): 'devnet' | 'localnet' | 'mainnet' {
  if (network === 'devnet' || network === 'devnet-fork') return 'devnet';
  if (network === 'mainnet-beta' || network === 'mainnet-fork') return 'mainnet';
  return 'localnet';
}

/**
 * Compare the on-disk deployment's program IDs against
 * `Anchor.toml [programs.<network>]`. Returns the list of (key, fromFile,
 * fromAnchorToml) tuples for any mismatch; empty array means all match.
 *
 * Snake-case → camelCase mapping between Anchor.toml's keys and the
 * `deployments/*.json` `programs` keys:
 *   lite_psm           ↔  litePsm
 *   oku_dollar         ↔  okuDollarProgram
 *   oku_bridge_router  ↔  okuBridgeRouter
 */
export function diffDeploymentProgramIds(
  network: NetworkName,
  deployment: DeploymentAddresses
): { key: string; fromFile: string; fromAnchorToml: string }[] {
  const anchorPrograms = readAnchorTomlPrograms(anchorSectionFor(network));
  if (Object.keys(anchorPrograms).length === 0) return [];
  const map: Array<[string, keyof DeploymentAddresses['programs']]> = [
    ['lite_psm', 'litePsm'],
    ['oku_dollar', 'okuDollarProgram'],
    ['oku_bridge_router', 'okuBridgeRouter'],
  ];
  const diffs: { key: string; fromFile: string; fromAnchorToml: string }[] = [];
  for (const [tomlKey, fileKey] of map) {
    const fromAnchorToml = anchorPrograms[tomlKey];
    const fromFile = deployment.programs?.[fileKey];
    if (fromAnchorToml && fromFile && fromAnchorToml !== fromFile) {
      diffs.push({ key: tomlKey, fromFile, fromAnchorToml });
    }
  }
  return diffs;
}

/**
 * Load deployment addresses for network. Prints a loud warning to stderr
 * if the on-disk program IDs don't match `Anchor.toml [programs.<network>]`
 * — this catches the "stale deployments file from a previous deploy"
 * failure mode. Callers that should refuse to run on mismatch (deploys,
 * admin txs against mainnet) can use `loadDeploymentStrict()` instead.
 */
export function loadDeployment(network: NetworkName): DeploymentAddresses | null {
  const filepath = getDeploymentPath(network);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  let data: DeploymentAddresses;
  try {
    data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (error) {
    console.error(`Failed to parse ${filepath}:`, error);
    return null;
  }

  const diffs = diffDeploymentProgramIds(network, data);
  if (diffs.length > 0) {
    const lines = diffs.map(
      (d) =>
        `  ${d.key}: deployments/${network}.json=${d.fromFile} ` +
        `but Anchor.toml=${d.fromAnchorToml}`
    );
    // eslint-disable-next-line no-console
    console.warn(
      [
        '',
        `[addressBook] WARNING: deployments/${network}.json program IDs do `,
        `[addressBook] NOT match Anchor.toml [programs.${anchorSectionFor(network)}]:`,
        ...lines,
        `[addressBook] This usually means deployments/${network}.json is `,
        `[addressBook] stale from a previous deploy run. Either:`,
        `[addressBook]   1. Run \`npm run deploy:init\` to overwrite with current IDs, or`,
        `[addressBook]   2. \`solana program close <OLD_ID> --recipient <YOU> --url ${network}\``,
        `[addressBook]      to recover rent from the old program(s), then delete the file.`,
        `[addressBook] Continuing with file contents — admin/bridge txs will hit `,
        `[addressBook] the FILE-level program IDs, NOT the Anchor.toml IDs.`,
        '',
      ].join('\n')
    );
  }

  return data;
}

/**
 * Like `loadDeployment` but throws if the file is missing OR if its program
 * IDs don't match `Anchor.toml [programs.<network>]`. Use from deploy /
 * mainnet-admin paths where a stale file is a hard error.
 */
export function loadDeploymentStrict(
  network: NetworkName
): DeploymentAddresses {
  const data = loadDeployment(network);
  if (!data) {
    throw new Error(
      `No deployments/${network}.json found. Run \`npm run deploy:init\` first.`
    );
  }
  const diffs = diffDeploymentProgramIds(network, data);
  if (diffs.length > 0) {
    const lines = diffs.map(
      (d) =>
        `  ${d.key}: deployments/${network}.json=${d.fromFile} ` +
        `but Anchor.toml=${d.fromAnchorToml}`
    );
    throw new Error(
      [
        `deployments/${network}.json is stale relative to Anchor.toml ` +
          `[programs.${anchorSectionFor(network)}]:`,
        ...lines,
        `Refusing to run — see addressBook.ts header for rent-recovery steps.`,
      ].join('\n')
    );
  }
  return data;
}

/**
 * Save deployment addresses for network
 */
export function saveDeployment(
  network: NetworkName,
  addresses: Partial<DeploymentAddresses>
) {
  ensureDeploymentsDir();

  const filepath = getDeploymentPath(network);
  const existing = loadDeployment(network) || {
    network,
    timestamp: new Date().toISOString(),
    tokens: {},
    programs: {},
    pdas: {},
    nonces: {},
    authorities: {},
  };

  // Merge with existing
  const updated: DeploymentAddresses = {
    ...existing,
    ...addresses,
    network,
    timestamp: new Date().toISOString(),
    tokens: { ...existing.tokens, ...addresses.tokens },
    programs: { ...existing.programs, ...addresses.programs },
    pdas: { ...existing.pdas, ...addresses.pdas },
    nonces: { ...existing.nonces, ...addresses.nonces },
    authorities: { ...existing.authorities, ...addresses.authorities },
    addressLookupTables: {
      ...existing.addressLookupTables,
      ...addresses.addressLookupTables,
    },
  };

  fs.writeFileSync(filepath, JSON.stringify(updated, null, 2));
}

/**
 * Update a specific section of the deployment
 */
export function updateDeployment(
  network: NetworkName,
  section: keyof Omit<DeploymentAddresses, 'network' | 'timestamp'>,
  data: Record<string, string>
) {
  const existing = loadDeployment(network) || {
    network,
    timestamp: new Date().toISOString(),
    tokens: {},
    programs: {},
    pdas: {},
    nonces: {},
    authorities: {},
  };

  const existingSection = existing[section] || {};
  saveDeployment(network, {
    ...existing,
    [section]: { ...existingSection, ...data },
  });
}

/**
 * Get a specific address from deployment
 */
export function getAddress(
  network: NetworkName,
  section: keyof Omit<DeploymentAddresses, 'network' | 'timestamp'>,
  key: string
): PublicKey | null {
  const deployment = loadDeployment(network);
  if (!deployment) return null;

  const sectionData = deployment[section] as any;
  if (!sectionData || !sectionData[key]) return null;

  try {
    return new PublicKey(sectionData[key]);
  } catch {
    return null;
  }
}

/**
 * Check if a deployment exists for the network
 */
export function hasDeployment(network: NetworkName): boolean {
  return fs.existsSync(getDeploymentPath(network));
}

/**
 * Clear deployment for network (for testing)
 */
export function clearDeployment(network: NetworkName) {
  const filepath = getDeploymentPath(network);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }
}

/**
 * Load deployment for the effective network.
 * For fork networks (devnet-fork, mainnet-fork), loads from the parent network
 * since programs/tokens are forked from there.
 */
export function loadDeploymentForFork(network: NetworkName): DeploymentAddresses | null {
  // For fork networks, load from parent network
  if (network === 'devnet-fork') {
    return loadDeployment('devnet');
  }
  if (network === 'mainnet-fork') {
    return loadDeployment('mainnet-beta');
  }
  return loadDeployment(network);
}
