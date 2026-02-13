# OkuUSD SVM Deployment Guide

This guide covers deploying the OkuUSD Solana/Anchor programs (lite-psm, wokusd-vault, oku-bridge-router) to localnet, devnet, and mainnet.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start (Localnet)](#quick-start-localnet)
- [Deployment Scripts](#deployment-scripts)
- [Network Configuration](#network-configuration)
- [Authority Setup](#authority-setup)
- [Mainnet Deployment](#mainnet-deployment)
- [Simulation & Testing](#simulation--testing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Tools

- **Solana CLI** v1.18+ (`solana --version`)
- **Anchor CLI** v0.29.0 (`anchor --version`)
- **Node.js** v18+ (`node --version`)
- **Yarn/NPM** (`npm --version`)

### Installation

```bash
# Install dependencies
npm install

# Build programs
anchor build

# Verify setup
anchor test
```

## Quick Start (Localnet)

Deploy and test the full system on localnet in under 2 minutes:

```bash
# Terminal 1: Start local validator
npm run localnet:start

# Terminal 2: Deploy all contracts + run simulation
npm run localnet:full
```

This will:
1. Deploy mock USDC + OkuUSD (Token-2022)
2. Build and deploy all 3 programs
3. Initialize all PDAs and authorities
4. Run full user flow simulation
5. Generate deployment manifest

**Output**: `deployments/localnet.json` with all addresses

## Deployment Scripts

The deployment system uses **numbered TypeScript scripts** (mirroring Hardhat pattern):

| Script | Description | Dependencies |
|--------|-------------|--------------|
| `001-deploy-tokens.ts` | Create USDC (localnet) + OkuUSD mint | None |
| `002-deploy-programs.ts` | Build & deploy all programs | 001 |
| `003-initialize-psm.ts` | Initialize PSM + Bridge configs | 001, 002 |
| `004-initialize-vault.ts` | Create wOkuUSD mint + vault config | 001-003 |
| `005-initialize-bridge.ts` | Initialize bridge nonce PDAs | 001-003 |
| `006-initialize-router.ts` | Initialize router config | 001-005 |
| `007-verify-deployment.ts` | Verify all configs + authorities | 001-006 |

### Run All Scripts

```bash
# Localnet
npm run deploy:localnet

# Devnet
npm run deploy:devnet

# Mainnet (requires --confirm-mainnet flag)
npm run deploy:mainnet -- --confirm-mainnet
```

### Run Individual Scripts

```bash
# Example: Only initialize PSM
NETWORK=devnet npm run deploy:psm

# Example: Verify deployment
NETWORK=devnet npm run deploy:verify
```

## Network Configuration

### Localnet

**Features**:
- Mock USDC mint created automatically
- Ephemeral authority keypairs (no ENV vars needed)
- Oracle disabled (`Pubkey::default()`)
- Upgrade authority retained for iteration
- No Squads multisigs

**Usage**:
```bash
solana config set --url localhost
npm run deploy:localnet
```

### Devnet

**Features**:
- Uses Circle's devnet USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Pyth devnet USDC/USD feed: `5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7`
- Loads authorities from `.env` (supports regular keypairs for testing)
- Transfers upgrade authority to cold multisig
- Manual confirmation recommended

**Setup**:
```bash
# 1. Configure environment
cp .env.example .env.devnet
# Edit .env.devnet with your pubkeys

# 2. Fund deployer wallet
solana airdrop 5 --url devnet

# 3. Deploy
NETWORK=devnet npm run deploy:devnet
```

### Mainnet-Beta

**Features**:
- Uses Circle's mainnet USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Pyth mainnet USDC/USD feed: `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD`
- **REQUIRES** Squads multisig vaults (errors if ENV vars missing)
- **REQUIRES** `--confirm-mainnet` flag
- Immediately transfers upgrade authority
- Uses `finalized` commitment

**Setup**: See [Mainnet Deployment](#mainnet-deployment) below

## Authority Setup

The system uses **23 granular authorities** across 3 programs:

### PSM Authorities (12 roles)

| Role | Assignee | Description |
|------|----------|-------------|
| `role_admin` | Cold Multisig | Grant/revoke all PSM roles |
| `pauser` | Warm Multisig | Emergency pause |
| `unpauser` | Cold Multisig | Resume operations |
| `freezer` | Warm Multisig | Freeze accounts (compliance) |
| `unfreezer` | Cold Multisig | Unfreeze accounts |
| `queue_processor` | Orchestrator | Process redemption queue |
| `buffer_depositor` | Orchestrator | Deposit USDC buffer |
| `buffer_withdrawer` | Cold Multisig | Withdraw buffer |
| `oracle_manager` | Cold Multisig | Configure Pyth feed |
| `cap_manager` | Cold Multisig | Set supply cap |
| `allowance_manager` | Cold Multisig | Set minter allowance |
| `rebaser` | Orchestrator | Update Token-2022 interest rate |

### Bridge Authorities (8 roles)

| Role | Assignee | Description |
|------|----------|-------------|
| `bridge_admin` | Cold Multisig | Update orchestrator, limits |
| `bridge_pauser` | Warm Multisig | Emergency pause bridge |
| `bridge_unpauser` | Cold Multisig | Resume bridge |
| `orchestrator_signer` | Bridge Orchestrator | Ed25519 signature authority |
| `fee_recipient` | Fee Recipient | Collect bridge fees |
| `chain_manager` | Warm Multisig | Add/remove chains |
| `fee_manager` | Cold Multisig | Update bridge fee |
| `nonce_admin` | Cold Multisig | Emergency nonce skip |

### Vault Authorities (3 roles)

| Role | Assignee | Description |
|------|----------|-------------|
| `vault_role_admin` | Cold Multisig | Meta role |
| `vault_pauser` | Warm Multisig | Pause wrap/unwrap |
| `vault_unpauser` | Cold Multisig | Resume vault |

### Environment Variables

Create `.env.devnet` or `.env.mainnet`:

```bash
# Required for devnet/mainnet
DEVNET_COLD_MULTISIG=<pubkey>
DEVNET_WARM_MULTISIG=<pubkey>
DEVNET_ORCHESTRATOR=<pubkey>
DEVNET_BRIDGE_ORCHESTRATOR=<pubkey>
DEVNET_FEE_RECIPIENT=<pubkey>

# Mainnet variants
MAINNET_COLD_MULTISIG=<squads-vault-pubkey>
MAINNET_WARM_MULTISIG=<squads-vault-pubkey>
MAINNET_ORCHESTRATOR=<kms-backed-pubkey>
MAINNET_BRIDGE_ORCHESTRATOR=<kms-backed-pubkey>
MAINNET_FEE_RECIPIENT=<treasury-pubkey>
```

## Mainnet Deployment

### Security Checklist

- [ ] Cold/Warm multisigs are Squads vaults (NOT EOAs)
- [ ] Multisig thresholds: Cold ≥3-of-5, Warm ≥2-of-3
- [ ] Orchestrator keypairs are KMS-backed
- [ ] All authorities reviewed by security team
- [ ] Deployment manifest reviewed
- [ ] Upgrade authorities will transfer immediately
- [ ] `--confirm-mainnet` flag ready

### Squads Setup

1. **Create Squads Vaults**:
   - Go to https://v4.squads.so
   - Create Cold vault (3-of-5 or higher)
   - Create Warm vault (2-of-3 or higher)
   - Fund each with ~0.5 SOL for rent + fees

2. **Configure KMS**:
   - Generate orchestrator keypair in KMS
   - Generate bridge orchestrator Ed25519 keypair in KMS
   - Export public keys only
   - Document key IDs in runbook

3. **Set Environment**:
   ```bash
   cp .env.example .env.mainnet
   # Add all MAINNET_* variables
   ```

4. **Deploy**:
   ```bash
   # Dry run on devnet first
   NETWORK=devnet npm run deploy:devnet

   # Verify devnet deployment
   NETWORK=devnet npm run deploy:verify

   # Deploy to mainnet
   NETWORK=mainnet-beta npm run deploy:mainnet -- --confirm-mainnet
   ```

5. **Post-Deployment**:
   - Verify upgrade authorities transferred
   - Configure Squads to recognize program upgrade authority
   - Save deployment manifest (`deployments/mainnet-beta.json`) to secure location
   - Test read-only calls to verify configs
   - Document all addresses in runbook

### Mainnet Confirmation Flow

When deploying to mainnet, you'll see:

```
⚠️  ========================================
⚠️    MAINNET DEPLOYMENT WARNING
⚠️  ========================================
⚠️  This will deploy to MAINNET-BETA
⚠️  Ensure all configurations are correct
⚠️  Upgrade authorities will be transferred
⚠️  ========================================
```

Deployment will fail if:
- `--confirm-mainnet` flag not provided
- Any ENV var missing
- Upgrade authority transfer fails

## Simulation & Testing

### Full Flow Simulation

Simulates complete user journey:

```bash
# Run on localnet (after deployment)
NETWORK=localnet npm run simulate:full

# Steps simulated:
# 1. Airdrop SOL to test user
# 2. Mint test USDC (localnet only)
# 3. Swap USDC → OkuUSD via PSM
# 4. Wrap OkuUSD → wOkuUSD
# 5. Unwrap wOkuUSD → OkuUSD
# 6. Redeem OkuUSD → USDC
# 7. Bridge burn to Optimism (Solana-side only)
```

### State Verification

Verify on-chain state matches deployment manifest:

```bash
NETWORK=devnet npm run simulate:verify

# Checks:
# - All PDAs exist and initialized
# - Mint authorities correct
# - Token decimals correct
# - Nonce PDAs initialized
```

### Manual Testing

```typescript
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { loadDeployment } from './scripts/utils/addressBook';

// Load deployment
const deployment = loadDeployment('devnet');
const litePsmProgramId = new PublicKey(deployment.programs.litePsm);

// Load IDL and create program
const program = new Program(idl, litePsmProgramId, provider);

// Call PSM mint
await program.methods
  .mint(new BN(1000_000000)) // 1000 USDC
  .accounts({
    psmConfig: deployment.pdas.psmConfig,
    // ... other accounts
  })
  .rpc();
```

## Troubleshooting

### Common Issues

**Error: Missing environment variable**
```bash
# Solution: Create .env file with required variables
cp .env.example .env.devnet
# Edit with your pubkeys
```

**Error: Insufficient SOL for deployment**
```bash
# Solution: Fund deployer wallet
solana airdrop 5 --url devnet
```

**Error: Program build failed**
```bash
# Solution: Clean and rebuild
anchor clean
anchor build
```

**Error: Deployment already exists**
```bash
# Solution: Clear deployment (localnet only)
rm deployments/localnet.json
```

**Error: Upgrade authority transfer failed**
```bash
# Solution: Run manually
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG> \
  --url devnet
```

### Logs and Debugging

- **Deployment manifest**: `deployments/{network}.json`
- **Verification report**: `deployments/{network}-verification.json`
- **Program logs**: Use `solana logs` while deploying
- **Transaction explorer**: https://explorer.solana.com

### Getting Help

- GitHub Issues: https://github.com/oku/oku-money/issues
- Documentation: See `SVM/CLAUDE.md` for architecture
- Anchor Docs: https://www.anchor-lang.com

## File Structure

```
SVM/oku-programs/
├── scripts/
│   ├── config/
│   │   ├── networks.ts          # Network-specific configs
│   │   ├── authorities.ts       # RBAC role mappings
│   │   └── constants.ts         # Shared constants
│   ├── utils/
│   │   ├── network.ts           # Network detection
│   │   ├── addressBook.ts       # Deployment manifest
│   │   ├── logger.ts            # Colored logging
│   │   ├── tokenHelpers.ts      # Token-2022 utilities
│   │   └── pdaHelpers.ts        # PDA derivation
│   ├── deploy/
│   │   ├── 001-deploy-tokens.ts
│   │   ├── 002-deploy-programs.ts
│   │   ├── 003-initialize-psm.ts
│   │   ├── 004-initialize-vault.ts
│   │   ├── 005-initialize-bridge.ts
│   │   ├── 006-initialize-router.ts
│   │   └── 007-verify-deployment.ts
│   ├── simulate/
│   │   ├── full-flow.ts         # Full user flow
│   │   └── verify-state.ts      # State verification
│   └── deploy-all.ts            # Master orchestration
├── deployments/                 # Generated deployment manifests
│   ├── localnet.json
│   ├── devnet.json
│   └── mainnet-beta.json
├── .env.example                 # Environment template
└── DEPLOYMENT.md                # This file
```

## Next Steps

After successful deployment:

1. **Update Documentation**: Add deployed addresses to main README
2. **Configure Monitoring**: Set up alerts for program accounts
3. **Test Integration**: Verify frontend/backend can interact with contracts
4. **Orchestrator Setup**: Configure orchestrator to monitor bridge events
5. **Security Review**: Conduct final audit of deployed configuration
6. **Emergency Procedures**: Document pause/unpause flows for multisig holders

## Additional Resources

- **Architecture**: `SVM/CLAUDE.md`
- **Program Code**: `programs/lite-psm/`, `programs/wokusd-vault/`
- **Tests**: `tests/lite-psm.ts`, `tests/integration.ts`
- **Anchor Book**: https://book.anchor-lang.com
- **Solana Cookbook**: https://solanacookbook.com
