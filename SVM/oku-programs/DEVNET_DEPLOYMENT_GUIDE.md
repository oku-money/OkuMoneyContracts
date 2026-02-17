# Devnet Deployment Guide

## Summary of Changes

We've updated the deployment scripts to properly handle **authority signing** for devnet deployment. The initialize functions require authorities to **sign** transactions (for authorization), but only the **deployer wallet** pays transaction fees.

### What Changed

**Updated Files:**
1. `scripts/config/authorities.ts` - Added `loadAuthorityKeypairs()` function
2. `scripts/deploy/001-deploy-tokens.ts` - Uses keypairs instead of public keys
3. `scripts/deploy/003-initialize-psm.ts` - Uses keypairs instead of public keys
4. `scripts/deploy/004-initialize-vault.ts` - Uses keypairs instead of public keys
5. `scripts/deploy/005-initialize-bridge.ts` - Uses keypairs instead of public keys
6. `scripts/deploy/006-initialize-router.ts` - Uses keypairs instead of public keys
7. `.env` - Updated to use keypair file paths instead of public key addresses

### Key Concept: Signing vs Paying Fees

On Solana:
- **Fee Payer** = The account that pays transaction fees (your deployer wallet)
- **Signers** = Accounts that sign for authorization (role authorities)

**Result:** Only your deployer wallet needs SOL. Role addresses don't need funding.

---

## What You Need for Devnet Deployment

### 1. Keypair Files for Each Role

You mentioned you have filesystem addresses with private keys. You need **5 keypair JSON files**:

```
/path/to/cold-multisig.json          # Cold multisig authority
/path/to/warm-multisig.json          # Warm multisig authority
/path/to/orchestrator.json           # Orchestrator authority
/path/to/bridge-orchestrator.json    # Bridge orchestrator authority
/path/to/fee-recipient.json          # Fee recipient authority
```

**Keypair Format:** Standard Solana keypair JSON (array of 64 bytes):
```json
[123,45,67,89,...]
```

### 2. Update .env File

Update your `.env` file with the **paths** to these keypair files:

```bash
# Network
NETWORK=devnet

# Wallet path (your deployer wallet)
WALLET_PATH=~/.config/solana/id.json

# Devnet Authority Keypair Paths (REQUIRED)
DEVNET_COLD_MULTISIG_KEYPAIR=/path/to/cold-multisig.json
DEVNET_WARM_MULTISIG_KEYPAIR=/path/to/warm-multisig.json
DEVNET_ORCHESTRATOR_KEYPAIR=/path/to/orchestrator.json
DEVNET_BRIDGE_ORCHESTRATOR_KEYPAIR=/path/to/bridge-orchestrator.json
DEVNET_FEE_RECIPIENT_KEYPAIR=/path/to/fee-recipient.json
```

**Important:** Use **absolute paths** or paths relative to `~` (home directory).

### 3. Verify Deployer Wallet Has SOL

**Required Balance:** 11.5 SOL minimum (9.57 SOL for deployment + 2 SOL buffer)

```bash
# Check balance
solana balance --url devnet

# If insufficient, request from faucet
solana airdrop 5 --url devnet
```

---

## How It Works

### Localnet (Current Working State)

For localnet, we use the deployer wallet for ALL roles:
```typescript
loadAuthorityKeypairs(network, provider.wallet.payer)
// Returns deployer keypair for all 23 authority roles
```

This works because:
- Deployer has the private key → can sign
- Deployer pays fees → works seamlessly

### Devnet (What You Need to Do)

For devnet, we load separate keypairs from files:
```typescript
loadAuthorityKeypairs(network, provider.wallet.payer)
// Loads keypairs from:
// - DEVNET_COLD_MULTISIG_KEYPAIR
// - DEVNET_WARM_MULTISIG_KEYPAIR
// - DEVNET_ORCHESTRATOR_KEYPAIR
// - DEVNET_BRIDGE_ORCHESTRATOR_KEYPAIR
// - DEVNET_FEE_RECIPIENT_KEYPAIR
```

**Deployment Flow:**
1. Script loads all authority keypairs from `.env` paths
2. Initialize transactions are constructed with authority accounts
3. Authorities sign for authorization (automatic via Anchor)
4. Deployer wallet pays transaction fees
5. Transaction submitted with multiple signers

**No SOL needed for role addresses** - they only sign, they don't pay.

---

## Authority Role Mapping

The 5 keypair files map to 23 on-chain roles as follows:

### Cold Multisig (9 roles)
- PSM: `role_admin`, `unpauser`, `unfreezer`, `buffer_withdrawer`, `oracle_manager`, `cap_manager`, `allowance_manager`
- Bridge: `bridge_admin`, `bridge_unpauser`, `fee_manager`, `nonce_admin`
- Vault: `role_admin`, `unpauser`

### Warm Multisig (6 roles)
- PSM: `pauser`, `freezer`
- Bridge: `bridge_pauser`, `chain_manager`
- Vault: `pauser`

### Orchestrator (4 roles)
- PSM: `queue_processor`, `buffer_depositor`, `rebaser`

### Bridge Orchestrator (1 role)
- Bridge: `orchestrator_signer` (Ed25519 keypair for signing bridge mint requests)

### Fee Recipient (1 role)
- Bridge: `fee_recipient` (receives bridge fees)

---

## Deployment Steps

### Step 1: Prepare Keypair Files

If you don't already have them in JSON format, convert them:

```bash
# If you have base58-encoded private keys
# Use this helper script (create it):
cat > convert-keypair.sh << 'EOF'
#!/bin/bash
# Usage: ./convert-keypair.sh <base58-private-key> <output-file>
echo "$1" | solana-keygen recover prompt:// -o "$2"
EOF

chmod +x convert-keypair.sh

# Convert each key
./convert-keypair.sh "YOUR_COLD_MULTISIG_PRIVATE_KEY" cold-multisig.json
./convert-keypair.sh "YOUR_WARM_MULTISIG_PRIVATE_KEY" warm-multisig.json
./convert-keypair.sh "YOUR_ORCHESTRATOR_PRIVATE_KEY" orchestrator.json
./convert-keypair.sh "YOUR_BRIDGE_ORCHESTRATOR_PRIVATE_KEY" bridge-orchestrator.json
./convert-keypair.sh "YOUR_FEE_RECIPIENT_PRIVATE_KEY" fee-recipient.json
```

**Alternative:** If you already have filesystem wallets, just use those paths directly.

### Step 2: Update .env

```bash
# Edit .env
nano .env

# Update the DEVNET_*_KEYPAIR paths to your actual file locations
```

### Step 3: Test on Localnet First

**IMPORTANT:** Always test on localnet before devnet.

```bash
# Terminal 1: Start validator
npm run localnet:start

# Terminal 2: Deploy
NETWORK=localnet npm run deploy

# Expected output:
# ✓ Step 1: Deploy Tokens
# ✓ Step 2: Deploy Programs
# ✓ Step 3: Initialize PSM
# ✓ Step 4: Initialize Vault
# ✓ Step 5: Initialize Bridge
# ✓ Step 6: Initialize Router
# ✓ Step 7: Verify Deployment
```

If all 7 steps pass on localnet, proceed to devnet.

### Step 4: Deploy to Devnet

```bash
# Ensure network is set to devnet
solana config set --url devnet

# Verify balance
solana balance
# Should show 11.5+ SOL

# Run deployment
NETWORK=devnet npm run deploy
```

**Expected Duration:** 2-3 minutes
**Cost:** ~9.57 SOL (from deployer wallet only)

### Step 5: Verify Deployment

```bash
# Run verification script
NETWORK=devnet npm run deploy:verify

# Check deployment manifest
cat deployments/devnet.json

# View programs in Solana Explorer
# (URLs will be printed during deployment)
```

---

## Troubleshooting

### Error: "Missing required environment variable: DEVNET_COLD_MULTISIG_KEYPAIR"

**Cause:** .env file doesn't have the keypair path set.

**Solution:**
```bash
# Check .env file
cat .env | grep DEVNET_

# Ensure all 5 variables are set with valid file paths
```

### Error: "Failed to load keypair from DEVNET_COLD_MULTISIG_KEYPAIR=/path/to/file.json"

**Cause:** File doesn't exist or is not valid JSON.

**Solution:**
```bash
# Verify file exists
ls -la /path/to/file.json

# Verify it's valid JSON
cat /path/to/file.json | jq .

# Verify it's a valid Solana keypair (64 bytes)
cat /path/to/file.json | jq '. | length'
# Should output: 64
```

### Error: "Signature verification failed"

**Cause:** Mismatch between keypair file and expected authority address.

**Solution:**
```bash
# Get public key from keypair file
solana-keygen pubkey /path/to/cold-multisig.json

# Ensure this matches what you expect
# If not, you may have the wrong keypair file
```

### Error: "Insufficient funds"

**Cause:** Deployer wallet doesn't have enough SOL.

**Solution:**
```bash
# Check balance
solana balance --url devnet

# Request more SOL from faucet
solana airdrop 5 --url devnet
```

---

## Security Considerations

### For Devnet Testing

- **Filesystem keypairs are acceptable** for devnet testing
- Keep private keys secure (don't commit to git)
- Use separate keypairs for each role to simulate production

### For Mainnet (Future)

- **MUST use Squads multisig** for cold/warm authorities
- **MUST use KMS-backed keys** for orchestrator roles
- Filesystem keypairs are **NOT acceptable** for mainnet

---

## Next Steps After Successful Deployment

1. **Save Deployment Manifest**
   ```bash
   cp deployments/devnet.json ~/backups/devnet-deployment-$(date +%Y%m%d).json
   ```

2. **Document Addresses**
   - Program IDs
   - Token mint addresses
   - PDA addresses
   - Authority public keys

3. **Test User Operations**
   - Mint OkuUSD with USDC
   - Redeem OkuUSD for USDC
   - Wrap OkuUSD → wOkuUSD
   - Unwrap wOkuUSD → OkuUSD

4. **Integration Testing**
   - Bridge operations (burn → mint)
   - Queue processing
   - Interest rate updates

5. **Update Frontend**
   - Point frontend to devnet program addresses
   - Test full user flows

6. **Security Review**
   - Audit deployed configuration
   - Verify authority setup
   - Test emergency pause/unpause

---

## Questions?

If you encounter any issues:

1. Check the deployment logs in `deployments/devnet.json`
2. Verify all 5 keypair files are valid and accessible
3. Ensure deployer wallet has sufficient SOL
4. Run on localnet first to verify setup

**Ready to deploy?** Just update the `.env` file with your keypair paths and run `NETWORK=devnet npm run deploy`.
