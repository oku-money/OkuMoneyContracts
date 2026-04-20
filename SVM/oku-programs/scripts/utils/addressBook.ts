/**
 * Deployment address book management
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
    okusd?: string;
    usdOku?: string;
  };
  programs: {
    litePsm?: string;
    wokusdVault?: string;
    okuBridgeRouter?: string;
  };
  pdas: {
    psmConfig?: string;
    redemptionQueue?: string;
    psmVaultUsdc?: string;
    psmOkusdEscrow?: string;
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
 * Load deployment addresses for network
 */
export function loadDeployment(network: NetworkName): DeploymentAddresses | null {
  const filepath = getDeploymentPath(network);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return data;
  } catch (error) {
    console.error(`Failed to parse ${filepath}:`, error);
    return null;
  }
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
