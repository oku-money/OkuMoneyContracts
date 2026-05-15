/**
 * Surfpool RPC Client
 *
 * Provides typed access to Surfpool's surfnet_* cheatcode methods.
 * These methods are only available when running against Surfpool (not solana-test-validator).
 *
 * Features:
 * - Time manipulation (timeTravel, pauseClock, resumeClock)
 * - Account state injection (setAccount, setTokenAccount, resetAccount)
 * - Transaction profiling (profileTransaction, getProfilesByTag)
 * - Network management (resetNetwork, exportSnapshot)
 * - Account streaming for mainnet fork (streamAccount)
 *
 * @see https://github.com/solana-foundation/surfpool
 */

import { config } from "dotenv";
import { resolve } from "path";

// Load .env from the oku-programs directory
config({ path: resolve(__dirname, "../../.env") });

import { Connection, PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";

// ============================================================================
// Types
// ============================================================================

export interface TimeTravelConfig {
  absoluteSlot?: number;
  absoluteEpoch?: number;
  absoluteTimestamp?: number;
  /** @deprecated Use absoluteTimestamp instead */
  timestamp?: number;
}

export interface TimeTravelResult {
  absoluteSlot: number;
  blockHeight: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  transactionCount: number;
}

export interface AccountUpdate {
  data?: string; // Hex-encoded
  executable?: boolean;
  lamports?: number;
  owner?: string; // Base-58 pubkey
  rentEpoch?: number;
}

export interface TokenAccountUpdate {
  amount?: number;
  closeAuthority?: string;
  delegate?: string;
  delegatedAmount?: number;
  state?: "initialized" | "frozen" | "closed";
}

export interface ProfileConfig {
  depth?: "transaction" | "instruction";
  encoding?: "base64" | "base58" | "jsonParsed";
}

export interface ComputeUnitsResult {
  computeUnitsConsumed: number;
  success: boolean;
  logMessages: string[];
  errorMessage: string | null;
}

export interface ProfileResult {
  computeUnits: ComputeUnitsResult;
  state: {
    preExecution: Record<string, any>;
    postExecution: Record<string, any>;
  };
}

export interface SnapshotConfig {
  includeParsedAccounts?: boolean;
  filter?: {
    includeProgramAccounts?: boolean;
    includeAccounts?: string[];
    excludeAccounts?: string[];
  };
  scope?: "network" | "preTransaction";
}

export interface StreamConfig {
  includeOwnedAccounts?: boolean;
}

export interface ResetConfig {
  includeOwnedAccounts?: boolean;
}

// ============================================================================
// Surfpool Client
// ============================================================================

/**
 * Surfpool RPC client for accessing cheatcode methods.
 *
 * @example
 * ```typescript
 * const surfpool = new SurfpoolClient(connection);
 *
 * // Time travel to test deadline expiration
 * await surfpool.timeTravel({ absoluteTimestamp: futureTimestamp });
 *
 * // Inject token balance for fast test setup
 * await surfpool.setTokenAccount(user, mint, { amount: 1_000_000 });
 *
 * // Profile a transaction for compute optimization
 * const profile = await surfpool.profileTransaction(tx, "my-test");
 * console.log(`CU consumed: ${profile.computeUnits.computeUnitsConsumed}`);
 * ```
 */
export class SurfpoolClient {
  private rpcEndpoint: string;

  constructor(private connection: Connection) {
    // Extract RPC endpoint from connection
    // @ts-ignore - _rpcEndpoint is internal but we need it
    this.rpcEndpoint = connection.rpcEndpoint || connection._rpcEndpoint;
  }

  /**
   * Make a raw JSON-RPC call to Surfpool.
   */
  private async rpcCall<T>(method: string, params: any[] = []): Promise<T> {
    const response = await fetch(this.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    const json = await response.json();
    if (json.error) {
      throw new Error(`Surfpool RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  // ==========================================================================
  // Time Manipulation
  // ==========================================================================

  /**
   * Time travel to a specific slot, epoch, or timestamp.
   * Note: absoluteTimestamp uses MILLISECONDS (not seconds).
   *
   * @example
   * ```typescript
   * // Travel to specific slot
   * await surfpool.timeTravel({ absoluteSlot: 1000 });
   *
   * // Travel to specific timestamp (Unix milliseconds - 1 hour in future)
   * await surfpool.timeTravel({ absoluteTimestamp: Date.now() + 3600_000 });
   *
   * // Travel to specific epoch
   * await surfpool.timeTravel({ absoluteEpoch: 100 });
   * ```
   */
  async timeTravel(config: TimeTravelConfig): Promise<TimeTravelResult> {
    // Convert legacy 'timestamp' to 'absoluteTimestamp' for backwards compatibility
    const normalizedConfig = { ...config };
    if (normalizedConfig.timestamp !== undefined && normalizedConfig.absoluteTimestamp === undefined) {
      // Legacy timestamp was in seconds, convert to milliseconds
      normalizedConfig.absoluteTimestamp = normalizedConfig.timestamp * 1000;
      delete normalizedConfig.timestamp;
    }
    return this.rpcCall<TimeTravelResult>("surfnet_timeTravel", [normalizedConfig]);
  }

  /**
   * Pause the network clock, halting block production.
   * Useful for precise transaction sequencing in tests.
   */
  async pauseClock(): Promise<void> {
    await this.rpcCall("surfnet_pauseClock", []);
  }

  /**
   * Resume the network clock after pausing.
   */
  async resumeClock(): Promise<void> {
    await this.rpcCall("surfnet_resumeClock", []);
  }

  /**
   * Get current epoch info from the network.
   */
  async getEpochInfo(): Promise<TimeTravelResult> {
    const info = await this.connection.getEpochInfo();
    return {
      absoluteSlot: info.absoluteSlot,
      blockHeight: info.blockHeight ?? 0,
      epoch: info.epoch,
      slotIndex: info.slotIndex,
      slotsInEpoch: info.slotsInEpoch,
      transactionCount: 0,
    };
  }

  // ==========================================================================
  // Account State Manipulation
  // ==========================================================================

  /**
   * Set or update an account's properties.
   *
   * @example
   * ```typescript
   * // Fund an account with SOL
   * await surfpool.setAccount(userPubkey, {
   *   lamports: 10 * LAMPORTS_PER_SOL,
   *   owner: SystemProgram.programId.toBase58(),
   * });
   * ```
   */
  async setAccount(pubkey: PublicKey, update: AccountUpdate): Promise<void> {
    await this.rpcCall("surfnet_setAccount", [pubkey.toBase58(), update]);
  }

  /**
   * Set or update a token account's properties.
   * This is the most powerful cheatcode for test setup - directly inject token balances.
   *
   * @example
   * ```typescript
   * // Give user 1000 USDC (6 decimals)
   * await surfpool.setTokenAccount(userPubkey, usdcMint, {
   *   amount: 1_000_000_000,
   *   state: "initialized",
   * });
   *
   * // Freeze a token account
   * await surfpool.setTokenAccount(userPubkey, mint, {
   *   state: "frozen",
   * });
   * ```
   */
  async setTokenAccount(
    owner: PublicKey,
    mint: PublicKey,
    update: TokenAccountUpdate,
    tokenProgram?: PublicKey
  ): Promise<void> {
    const params = [
      owner.toBase58(),
      mint.toBase58(),
      update,
    ];
    if (tokenProgram) {
      params.push(tokenProgram.toBase58());
    }
    await this.rpcCall("surfnet_setTokenAccount", params);
  }

  /**
   * Reset an account to its original state from the remote datasource (mainnet).
   * Only useful when running with mainnet fork.
   */
  async resetAccount(pubkey: PublicKey, config?: ResetConfig): Promise<void> {
    await this.rpcCall("surfnet_resetAccount", [pubkey.toBase58(), config || {}]);
  }

  /**
   * Register an account for streaming - it will be fetched fresh from mainnet on every access.
   * Useful for testing with live oracle data.
   *
   * @example
   * ```typescript
   * // Stream Pyth price feed to get live prices
   * await surfpool.streamAccount(PYTH_SOL_USD_ACCOUNT, { includeOwnedAccounts: false });
   * ```
   */
  async streamAccount(pubkey: PublicKey, config?: StreamConfig): Promise<void> {
    await this.rpcCall("surfnet_streamAccount", [pubkey.toBase58(), config || {}]);
  }

  /**
   * Get the list of accounts currently registered for streaming.
   */
  async getStreamedAccounts(): Promise<string[]> {
    return this.rpcCall<string[]>("surfnet_getStreamedAccounts", []);
  }

  // ==========================================================================
  // Transaction Profiling
  // ==========================================================================

  /**
   * Profile a transaction to analyze compute units and state changes.
   *
   * @example
   * ```typescript
   * const tx = await program.methods.mintOkuM(amount).transaction();
   * const profile = await surfpool.profileTransaction(tx, "mint-test");
   *
   * expect(profile.computeUnits.computeUnitsConsumed).to.be.lessThan(100_000);
   * ```
   */
  async profileTransaction(
    transaction: VersionedTransaction | Transaction,
    tag?: string,
    config?: ProfileConfig
  ): Promise<ProfileResult> {
    // Serialize transaction to base64
    let serialized: string;
    if (transaction instanceof VersionedTransaction) {
      serialized = Buffer.from(transaction.serialize()).toString("base64");
    } else {
      serialized = transaction.serialize({ requireAllSignatures: false }).toString("base64");
    }

    const params: any[] = [serialized];
    if (tag) params.push(tag);
    if (config) params.push(config);

    return this.rpcCall<ProfileResult>("surfnet_profileTransaction", params);
  }

  /**
   * Get the profile of a specific transaction by signature or UUID.
   */
  async getTransactionProfile(
    identifier: { signature: string } | { uuid: string },
    config?: ProfileConfig
  ): Promise<ProfileResult> {
    return this.rpcCall<ProfileResult>("surfnet_getTransactionProfile", [
      identifier,
      config || { depth: "instruction", encoding: "base64" },
    ]);
  }

  /**
   * Get all profiling results for transactions with a specific tag.
   */
  async getProfilesByTag(tag: string, config?: ProfileConfig): Promise<ProfileResult[]> {
    return this.rpcCall<ProfileResult[]>("surfnet_getProfileResultsByTag", [
      tag,
      config || { depth: "instruction", encoding: "base64" },
    ]);
  }

  // ==========================================================================
  // Network Management
  // ==========================================================================

  /**
   * Reset the entire network to its initial state.
   * Useful for ensuring clean state between test suites.
   */
  async resetNetwork(): Promise<void> {
    await this.rpcCall("surfnet_resetNetwork", []);
  }

  /**
   * Export a snapshot of all accounts in the network.
   */
  async exportSnapshot(config?: SnapshotConfig): Promise<any> {
    return this.rpcCall("surfnet_exportSnapshot", [config || {}]);
  }

  /**
   * Get recent transaction signatures from the local network.
   */
  async getLocalSignatures(limit: number = 50): Promise<string[]> {
    return this.rpcCall<string[]>("surfnet_getLocalSignatures", [limit]);
  }

  /**
   * Get Surfnet network information.
   */
  async getSurfnetInfo(): Promise<any> {
    return this.rpcCall("surfnet_getSurfnetInfo", []);
  }

  // ==========================================================================
  // Program Management
  // ==========================================================================

  /**
   * Clone a program account from one program ID to another.
   * Useful for testing against modified program versions.
   */
  async cloneProgramAccount(
    sourceProgramId: PublicKey,
    destinationProgramId: PublicKey
  ): Promise<void> {
    await this.rpcCall("surfnet_cloneProgramAccount", [
      sourceProgramId.toBase58(),
      destinationProgramId.toBase58(),
    ]);
  }

  /**
   * Set or remove the upgrade authority for a program.
   * Omit newAuthority to make the program immutable.
   */
  async setProgramAuthority(
    programId: PublicKey,
    newAuthority?: PublicKey
  ): Promise<void> {
    const params: any[] = [programId.toBase58()];
    if (newAuthority) {
      params.push(newAuthority.toBase58());
    }
    await this.rpcCall("surfnet_setProgramAuthority", params);
  }

  // ==========================================================================
  // Supply Management
  // ==========================================================================

  /**
   * Configure the network supply information.
   */
  async setSupply(update: {
    total?: number;
    circulating?: number;
    nonCirculating?: number;
    nonCirculatingAccounts?: string[];
  }): Promise<void> {
    await this.rpcCall("surfnet_setSupply", [update]);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a SurfpoolClient from an Anchor provider.
 */
export function createSurfpoolClient(provider: anchor.AnchorProvider): SurfpoolClient {
  return new SurfpoolClient(provider.connection);
}

/**
 * Check if we're running against Surfpool (vs solana-test-validator).
 * Returns true if Surfpool-specific RPC methods are available.
 */
export async function isSurfpoolAvailable(connection: Connection): Promise<boolean> {
  try {
    const client = new SurfpoolClient(connection);
    await client.getSurfnetInfo();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Constants for Mainnet Fork
// ============================================================================

/**
 * Known mainnet addresses for fork testing.
 */
export const MAINNET_ADDRESSES = {
  // Tokens
  USDC_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT_MINT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  SOL_MINT: new PublicKey("So11111111111111111111111111111111111111112"),

  // Pyth Oracles (mainnet-beta)
  PYTH_SOL_USD: new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
  PYTH_USDC_USD: new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"),
  PYTH_ETH_USD: new PublicKey("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"),
  PYTH_BTC_USD: new PublicKey("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU"),

  // Programs
  TOKEN_PROGRAM: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  TOKEN_2022_PROGRAM: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  ASSOCIATED_TOKEN_PROGRAM: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
};

/**
 * Alchemy RPC configuration using API_KEY from .env
 */
export const ALCHEMY_RPC = {
  mainnet: `https://solana-mainnet.g.alchemy.com/v2/${process.env.API_KEY}`,
  devnet: `https://solana-devnet.g.alchemy.com/v2/${process.env.API_KEY}`,
};

/**
 * Get the best available mainnet RPC endpoint.
 * Priority: MAINNET_RPC_URL env var > Alchemy API_KEY > public fallback.
 */
export function getMainnetRpcEndpoint(): string {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  if (process.env.API_KEY) return ALCHEMY_RPC.mainnet;
  console.warn("No API_KEY or MAINNET_RPC_URL set, using public endpoint (rate limited)");
  return "https://api.mainnet-beta.solana.com";
}
