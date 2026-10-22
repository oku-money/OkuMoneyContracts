/**
 * Single source for RPC URL resolution. No hardhat imports, so hardhat.config.ts,
 * scripts and tests can all use it.
 *
 * Precedence per chain: explicit env URL > Ankr freemium > Alchemy > public.
 * Env is read at call time, so call after dotenv has loaded.
 */

export type RpcChain =
  | "mainnet" | "sepolia"
  | "optimism" | "opSepolia"
  | "arbitrum" | "arbSepolia"
  | "base" | "baseSepolia"
  | "bsc" | "bscTestnet";

interface RpcEntry {
  /** Env var holding an explicit URL (highest precedence). */
  env: string;
  /** Ankr slug, only where the freemium key is verified to work (incl. archive reads). */
  ankr?: string;
  alchemy: string;
  publicUrl: string;
}

// Optimism is deliberately without an Ankr slug: the freemium key is rejected
// for it (403 "API key is not allowed to access blockchain") despite the docs.
const RPC: Record<RpcChain, RpcEntry> = {
  mainnet:     { env: "MAINNET_RPC_URL",      ankr: "eth",                alchemy: "eth-mainnet",  publicUrl: "https://ethereum-rpc.publicnode.com" },
  sepolia:     { env: "SEPOLIA_RPC_URL",      ankr: "eth_sepolia",        alchemy: "eth-sepolia",  publicUrl: "https://ethereum-sepolia-rpc.publicnode.com" },
  optimism:    { env: "OPTIMISM_RPC_URL",                                 alchemy: "opt-mainnet",  publicUrl: "https://mainnet.optimism.io" },
  opSepolia:   { env: "OP_SEPOLIA_RPC_URL",                               alchemy: "opt-sepolia",  publicUrl: "https://sepolia.optimism.io" },
  arbitrum:    { env: "ARBITRUM_RPC_URL",     ankr: "arbitrum",           alchemy: "arb-mainnet",  publicUrl: "https://arb1.arbitrum.io/rpc" },
  arbSepolia:  { env: "ARB_SEPOLIA_RPC_URL",  ankr: "arbitrum_sepolia",   alchemy: "arb-sepolia",  publicUrl: "https://sepolia-rollup.arbitrum.io/rpc" },
  base:        { env: "BASE_RPC_URL",         ankr: "base",               alchemy: "base-mainnet", publicUrl: "https://mainnet.base.org" },
  baseSepolia: { env: "BASE_SEPOLIA_RPC_URL", ankr: "base_sepolia",       alchemy: "base-sepolia", publicUrl: "https://sepolia.base.org" },
  bsc:         { env: "BSC_RPC_URL",          ankr: "bsc",                alchemy: "bnb-mainnet",  publicUrl: "https://bsc-dataseed.binance.org" },
  bscTestnet:  { env: "BSC_TESTNET_RPC_URL",  ankr: "bsc_testnet_chapel", alchemy: "bnb-testnet",  publicUrl: "https://bsc-testnet-rpc.publicnode.com" },
};

export type RpcSource = "explicit" | "ankr" | "alchemy" | "public";
export type RpcPurpose = "live" | "fork";

/**
 * Where the URL comes from. Precedence by purpose:
 *   live: explicit chain URL > Ankr > Alchemy > public   (deploys and real sends)
 *   fork: Ankr > Alchemy > explicit chain URL > public   (FORK_URL beats all, see rpcUrl)
 * Forks prefer archive providers: the chain URLs in env are for live sends and are
 * often plain public nodes, which cannot serve a pinned block.
 */
export function rpcSource(chain: RpcChain, purpose: RpcPurpose = "live"): RpcSource {
  const e = RPC[chain];
  const ankr = !!e.ankr && !!process.env.ANKR_FREEMIUM_API_KEY;
  const alchemy = !!process.env.ALCHEMY_API_KEY;
  const explicit = !!process.env[e.env];
  if (purpose === "live" && explicit) return "explicit";
  if (ankr) return "ankr";
  if (alchemy) return "alchemy";
  if (explicit) return "explicit";
  return "public";
}

export function rpcUrl(chain: RpcChain, purpose: RpcPurpose = "live"): string {
  const e = RPC[chain];
  if (purpose === "fork" && process.env.FORK_URL) return process.env.FORK_URL;
  switch (rpcSource(chain, purpose)) {
    case "explicit": return process.env[e.env]!;
    case "ankr":     return `https://rpc.ankr.com/${e.ankr}/${process.env.ANKR_FREEMIUM_API_KEY}`;
    case "alchemy":  return `https://${e.alchemy}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
    default:         return e.publicUrl;
  }
}

/** Keyless public URL. Use this for anything written to a committed file. */
export function publicRpcUrl(chain: RpcChain): string {
  return RPC[chain].publicUrl;
}

/**
 * Public nodes prune old state, so a fork can only be pinned to a past block when the
 * fork endpoint is a known archive provider (Ankr freemium, Alchemy) or FORK_URL, which
 * is the caller's explicit choice. A chain env URL is not assumed to be archive.
 */
export function hasArchive(chain: RpcChain): boolean {
  if (process.env.FORK_URL) return true;
  const src = rpcSource(chain, "fork");
  return src === "ankr" || src === "alchemy";
}

/** Pinned fork blocks. Bump deliberately; changing one changes every fork test's world. */
const PINNED_FORK_BLOCKS: Partial<Record<RpcChain, number>> = {
  mainnet: 26035000,
};

/**
 * Block to fork from: FORK_BLOCK_NUMBER if set, else the pinned block when an archive
 * endpoint is available, else undefined (latest).
 */
export function forkBlock(chain: RpcChain): number | undefined {
  if (process.env.FORK_BLOCK_NUMBER) return parseInt(process.env.FORK_BLOCK_NUMBER, 10);
  return hasArchive(chain) ? PINNED_FORK_BLOCKS[chain] : undefined;
}
