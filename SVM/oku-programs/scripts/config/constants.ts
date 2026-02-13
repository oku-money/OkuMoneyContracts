/**
 * Shared constants across all deployments
 */

import { PublicKey } from '@solana/web3.js';

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuUSD (6 decimals)
export const MINTER_ALLOWANCE = 100_000_000 * 1_000_000; // 100M initial allowance

// Bridge configuration
export const BRIDGE_FEE_BPS = 10; // 0.1% (10 basis points)
export const MIN_BRIDGE_AMOUNT = 1 * 1_000_000; // 1 OkuUSD
export const MAX_BRIDGE_AMOUNT = 10_000_000 * 1_000_000; // 10M OkuUSD

// Supported destination chains (EVM chain IDs)
export const SUPPORTED_CHAINS = [
  1, // Ethereum Mainnet
  10, // Optimism
  42161, // Arbitrum One
  8453, // Base
];

// Oracle configuration
export const ORACLE_STALENESS_THRESHOLD = 60; // 60 seconds

// Token decimals
export const USDC_DECIMALS = 6;
export const OKUSD_DECIMALS = 6;

// Initial interest rate (0% - can be updated by orchestrator)
export const INITIAL_INTEREST_RATE_BPS = 0;

// Program IDs (from Anchor.toml)
export const PROGRAM_IDS = {
  localnet: {
    litePsm: new PublicKey('FbYGHcN1wyXebY51vFpNmmNMuSZoXpEiEgCu3Lm9GujX'),
    wokusdVault: new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'),
    okuBridgeRouter: new PublicKey('BRdgEiDLhPzrV2bJzjVdKaGm1FzLiVmSqLkQCJ2mX4Fq'),
  },
  devnet: {
    litePsm: new PublicKey('FbYGHcN1wyXebY51vFpNmmNMuSZoXpEiEgCu3Lm9GujX'),
    wokusdVault: new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'),
    okuBridgeRouter: new PublicKey('BRdgEiDLhPzrV2bJzjVdKaGm1FzLiVmSqLkQCJ2mX4Fq'),
  },
  'mainnet-beta': {
    litePsm: new PublicKey('FbYGHcN1wyXebY51vFpNmmNMuSZoXpEiEgCu3Lm9GujX'),
    wokusdVault: new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'),
    okuBridgeRouter: new PublicKey('BRdgEiDLhPzrV2bJzjVdKaGm1FzLiVmSqLkQCJ2mX4Fq'),
  },
};

// Token-2022 program
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);
