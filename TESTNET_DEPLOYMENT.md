# OkuMoney Testnet Deployment & Bridge Testing Runbook

Complete guide for deploying to testnet and testing the bidirectional EVM ↔ SVM bridge.

## Prerequisites

### Environment Setup

1. **EVM (OP Sepolia)**
   ```bash
   cd EVM
   cp .env.example .env
   # Edit .env and set:
   # PRIVATE_KEY=<your-deployer-private-key>
   # ALCHEMY_API_KEY=<your-alchemy-api-key>
   ```

2. **SVM (Solana Devnet)**
   ```bash
   cd SVM/oku-programs
   cp .env.example .env
   # Edit .env and set:
   # API_KEY=<your-alchemy-api-key>  # Optional, for Alchemy devnet RPC

   # Ensure you have a Solana wallet
   solana-keygen new --outfile ~/.config/solana/id.json  # If needed
   solana config set --url devnet
   ```

3. **Install Dependencies**
   ```bash
   # EVM
   cd EVM && npm install && npx hardhat compile

   # SVM
   cd SVM/oku-programs && npm install && anchor build
   ```

4. **Install Surfpool** (for local fork testing)
   ```bash
   curl -sL https://run.surfpool.run/ | bash
   ```

---

## Phase 1: Local Fork Testing (Recommended First)

Test the deployment and bridge scripts on local forks before going to testnet.

### 1.1 EVM Local Fork (Single Command)

The unified deployment script works directly with Hardhat's built-in fork:

```bash
cd EVM

# Deploy to hardhat fork (auto-forks OP Sepolia from hardhat.config.ts)
npm run deploy:fork

# Or with fresh fork state:
npm run deploy:fork:reset
```

This single command:
- Deploys MockUSDC, OkuMoney, OkuDollar, RedemptionQueue, LitePSM
- Deploys OkuBridge and OkuBridgeRouter
- Configures all roles and permissions
- Sets testnet bridge parameters (10 bps fee, Solana Devnet support)
- Verifies the deployment

### 1.2 SVM Local Fork (Surfpool)

```bash
cd SVM/oku-programs

# Start Surfpool with devnet fork
surfpool start --rpc-url https://api.devnet.solana.com

# In another terminal, deploy to the fork
NETWORK=localnet npm run deploy
```

### 1.3 Test Bridge Flow Locally

```bash
# SVM: Test bridge flow
cd SVM/oku-programs
NETWORK=devnet-fork tsx scripts/bridge/test-bridge-flow.ts
```

---

## Phase 2: Deploy to Testnet

### 2.1 Deploy EVM to OP Sepolia (Single Command)

```bash
cd EVM

# Ensure wallet has OP Sepolia ETH
# Get testnet ETH from: https://www.alchemy.com/faucets/optimism-sepolia

# Deploy all contracts with single command
npm run deploy:testnet
```

This deploys and configures everything in one execution.

**Addresses saved to** `scripts/config/addresses.json`

### 2.2 Deploy SVM to Devnet

```bash
cd SVM/oku-programs

# Ensure wallet has devnet SOL
solana airdrop 5 --url devnet
solana airdrop 5 --url devnet

# Deploy all programs
NETWORK=devnet npm run deploy
```

**Record addresses** from `deployments/devnet.json`.

### 2.3 Update Shared Address Registry

Edit `testnet-addresses.json` with deployed addresses:

```json
{
  "evm": {
    "network": "op-sepolia",
    "chainId": 11155420,
    "contracts": {
      "okuMoney": "<from EVM addresses.json>",
      "okuDollar": "<from EVM addresses.json>",
      "litePSM": "<from EVM addresses.json>",
      "okuBridge": "<from EVM addresses.json>",
      "okuBridgeRouter": "<from EVM addresses.json>",
      "mockUSDC": "<from EVM addresses.json>"
    },
    "orchestrator": "<deployer address>"
  },
  "svm": {
    "network": "devnet",
    "chainId": 103,
    "programs": {
      "litePsm": "<from SVM devnet.json>",
      "okuDollar": "<from SVM devnet.json>",
      "okuBridgeRouter": "<from SVM devnet.json>"
    },
    "mints": {
      "okuMoney": "<from SVM devnet.json>",
      "usdOku": "<from SVM devnet.json>",
      "usdc": "<from SVM devnet.json>"
    },
    "orchestrator": "<deployer pubkey>"
  }
}
```

---

## Phase 3: Verify Deployments

### 3.1 Verify EVM Contracts

```bash
cd EVM

# Check bridge state
npm run bridge:state -- --network opSepolia

# Or for local fork:
npm run bridge:state -- --network hardhat
```

Expected output:
- OkuBridge address
- Authorized signer = deployer
- Solana Devnet (103) is supported chain
- Bridge is not paused
- Min bridge: 1.0 OkuM
- Max bridge: 100000.0 OkuM

### 3.2 Verify SVM Programs

```bash
cd SVM/oku-programs

# Run verification
NETWORK=devnet npm run deploy:verify
```

Expected output:
- All programs deployed
- Bridge config initialized
- OP Sepolia (11155420) is supported destination
- Bridge nonce PDAs exist

---

## Phase 4: Test Bridging

### Test 1: EVM → SVM (OkuMoney)

**Step 1: Burn on EVM**
```bash
cd EVM

# Set test parameters in the script or via env
export BRIDGE_AMOUNT=10  # OkuM
export RECIPIENT_SOLANA=<solana-wallet-pubkey>

npx hardhat run scripts/bridge/bridge-burn-to-solana.ts --network opSepolia
```

This will:
1. Deposit MockUSDC to get OkuMoney (if needed)
2. Approve and burn OkuMoney on EVM
3. Emit `BridgeBurn` event
4. Generate `bridge-request.json`

**Step 2: Relay to SVM**
```bash
cd SVM/oku-programs

# Relay the burn event to mint on Solana
NETWORK=devnet tsx scripts/bridge/relay-from-evm.ts --request ../../EVM/bridge-request.json
```

This will:
1. Read the bridge request
2. Convert 18-decimal to 6-decimal (floor division)
3. Sign with Ed25519
4. Submit `bridge_mint` transaction
5. Verify recipient balance

**Step 3: Verify**
```bash
# Check SVM bridge state
NETWORK=devnet tsx scripts/bridge/check-bridge-state.ts
```

### Test 2: SVM → EVM (OkuMoney)

**Step 1: Burn on SVM**
```bash
cd SVM/oku-programs

# Set test parameters
export BRIDGE_AMOUNT=5  # OkuM (6 decimals)
export RECIPIENT_EVM=<evm-wallet-address>

NETWORK=devnet tsx scripts/bridge/bridge-burn-to-evm.ts
```

This will:
1. Burn OkuMoney on Solana
2. Emit bridge event
3. Generate `bridge-request.json`

**Step 2: Relay to EVM**
```bash
cd EVM

# Relay the burn event to mint on EVM
npx hardhat run scripts/bridge/relay-from-solana.ts --network opSepolia --request ../SVM/oku-programs/bridge-request.json
```

This will:
1. Read the bridge request
2. Convert 6-decimal to 18-decimal
3. Sign EIP-712 message
4. Submit `bridgeMint` transaction
5. Verify recipient balance

**Step 3: Verify**
```bash
npx hardhat run scripts/bridge/check-bridge-state.ts --network opSepolia
```

### Test 3: Round Trip (EVM → SVM → EVM)

Run Test 1 followed by Test 2 with the same tokens.

**Verify**:
- Final EVM balance = Initial - (2 * fee) - dust_loss
- Dust loss bound: at most `2e12` wei (18-decimal) over round trip

---

## Phase 5: Bridge Testing via OkuDollar

### EVM: Bridge OkuDollar to SVM

```bash
cd EVM

npx hardhat run scripts/bridge/bridge-usdoku-to-solana.ts --network opSepolia
```

This automatically:
1. Unwraps OkuDollar → OkuMoney
2. Burns OkuMoney via bridge
3. Generates `bridge-request.json`

Then relay as in Test 1.

---

## Troubleshooting

### Common Issues

**EVM: "Insufficient gas"**
- Get OP Sepolia ETH from faucet

**EVM: "Not authorized signer"**
- Ensure PRIVATE_KEY in .env matches the orchestrator set in bridge config

**SVM: "Account not found"**
- Ensure devnet deployment completed successfully
- Run `NETWORK=devnet npm run deploy:verify`

**SVM: "Signature verification failed"**
- Ensure the wallet signing matches the orchestrator in bridge config
- Check that Ed25519 signature instruction is first in transaction

**Bridge: "Request already processed"**
- Each (sourceChain, nonce) can only be used once
- Check `ProcessedRequest` PDA exists

**Bridge: "Unsupported chain"**
- Verify OP Sepolia (11155420) is in SVM's supported chains
- Verify Solana Devnet (103) is in EVM's supported chains

### Useful Commands

```bash
# EVM: Check bridge config
npx hardhat run scripts/bridge/check-bridge-state.ts --network opSepolia

# SVM: Check bridge config
NETWORK=devnet tsx scripts/bridge/check-bridge-state.ts

# SVM: Test flow without live execution
NETWORK=devnet-fork tsx scripts/bridge/test-bridge-flow.ts

# View Solana transaction
solana confirm -v <signature> --url devnet

# View OP Sepolia transaction
# https://sepolia-optimism.etherscan.io/tx/<hash>
```

---

## Chain ID Reference

| Network | Chain ID | Type |
|---------|----------|------|
| Solana Mainnet | 101 | Ankr convention |
| Solana Devnet | 103 | Ankr convention |
| OP Sepolia | 11155420 | EIP-155 |
| Optimism | 10 | EIP-155 |
| Arbitrum | 42161 | EIP-155 |
| Base | 8453 | EIP-155 |
| Ethereum | 1 | EIP-155 |

---

## Security Notes

1. **Testnet Only**: This guide uses deployer as orchestrator. Production deployments MUST use separate keys.

2. **Private Keys**: Never commit `.env` files or private keys to git.

3. **Fee Configuration**: Testnet uses 0.1% (10 bps) fee. Review for production.

4. **Rate Limits**: Public RPC endpoints are rate-limited. Use Alchemy or other providers for reliable testing.

5. **Replay Protection**: Each bridge request has a unique (chain, nonce) that can only be processed once.
