# Localnet Development Workflow

This guide explains how to work with the local Solana validator for development and testing.

## Quick Start

### Option 1: Fresh Start (Recommended)
Automatically stops existing validators, starts a fresh one, and deploys:

```bash
npm run localnet:deploy:fresh
```

**Use this when:**
- Starting a new development session
- Validators are stuck or conflicting
- You want a clean slate

### Option 2: Manual Control
For more control over the validator lifecycle:

```bash
# Terminal 1: Start validator
npm run localnet:start

# Terminal 2: Deploy
npm run deploy
```

**Use this when:**
- You want to inspect validator state between deployments
- Testing incremental changes
- Debugging specific transactions

### Option 3: Auto-Reset (Advanced)
Automatically resets the validator before each deployment:

```bash
AUTO_RESET=true npm run deploy
```

**Use with caution:**
- Kills ALL running validators
- Deletes all validator data
- Good for CI/CD pipelines
- Not recommended for development (unexpected behavior)

---

## New Scripts

### Validator Management
```bash
npm run localnet:start          # Start validator (with --reset)
npm run localnet:stop           # Kill all validator instances
npm run localnet:restart        # Stop + Start
npm run localnet:deploy         # Deploy to localnet (alias)
npm run localnet:deploy:fresh   # Fresh validator + deploy
npm run localnet:full           # Deploy + run full simulation
```

### Cleanup
```bash
npm run clean                   # Clean build artifacts + deployments
npm run clean:all               # Clean everything (build + validator + ledger)
```

---

## Validator Health Check

The deployment script now **automatically checks validator health** on localnet:

1. **Connection Check**: Verifies validator is responding
2. **Block Production**: Ensures validator is producing blocks (not stuck)
3. **Multiple Instances**: Warns if multiple validators are running

If health check fails, you'll see:
```
✗ Validator health check failed!

Quick Fix Options:

1. Fresh Start (Recommended):
   npm run localnet:deploy:fresh

2. Manual Control:
   npm run localnet:stop
   npm run localnet:start
   npm run deploy

3. Auto-Reset (use with caution):
   AUTO_RESET=true npm run deploy
```

---

## Common Issues & Solutions

### Issue: "Validator is stuck (not producing blocks)"
**Cause:** Validator process is running but not working properly
**Solution:**
```bash
npm run localnet:restart
npm run deploy
```

### Issue: "Found 3+ validator processes (expected 1-2)"
**Cause:** Multiple validator instances from previous sessions
**Solution:**
```bash
npm run localnet:stop    # Kill all validators
npm run localnet:start   # Start fresh
npm run deploy
```

### Issue: "Transaction expired: block height exceeded"
**Cause:** Validator conflicts or network issues
**Solution:**
```bash
npm run localnet:deploy:fresh
```

### Issue: "Cannot connect to validator"
**Cause:** No validator running
**Solution:**
```bash
npm run localnet:start
```

---

## Best Practices

### Development Workflow
1. **Morning:** `npm run localnet:deploy:fresh` - start with clean state
2. **Iteration:** Use manual control to preserve state between changes
3. **Before PR:** `npm run localnet:deploy:fresh && npm run localnet:full` - verify full flow

### CI/CD Workflow
```yaml
# .github/workflows/test.yml
- name: Deploy to Localnet
  run: AUTO_RESET=true npm run deploy
```

### Debugging
If you need to inspect validator logs:
```bash
# Start validator with logs
solana-test-validator --reset > validator.log 2>&1 &

# Watch logs
tail -f validator.log

# Deploy in another terminal
npm run deploy
```

---

## Architecture Decisions

### Why Not Auto-Reset by Default?

**Pros of Manual Control:**
- Developer controls when state resets
- Can inspect accounts between deployments
- Multiple processes can share same validator
- Preserves test data for debugging

**Cons:**
- Requires manual validator management
- Can lead to stuck validators
- Stale state can cause confusion

**Decision:** Use **health checks** + **opt-in auto-reset** to get best of both worlds:
- Health check warns about issues
- Auto-reset available when needed
- Default behavior is safe and predictable

### Why Separate Scripts?

Following Anchor/Solana ecosystem conventions:
- Clear separation of concerns
- Composable workflows
- Familiar to Solana developers
- Easy to customize for specific needs

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NETWORK` | `localnet` | Network to deploy to |
| `AUTO_RESET` | `false` | Auto-reset validator before deployment |

---

## Troubleshooting Commands

```bash
# Check if validator is running
ps aux | grep solana-test-validator

# Check validator version
solana --version

# Check cluster info
solana cluster-version --url http://127.0.0.1:8899

# Check recent logs
solana logs --url http://127.0.0.1:8899

# Kill stuck validators (use as last resort)
pkill -9 solana-test-validator

# Nuclear option (clean everything)
npm run clean:all
npm run localnet:deploy:fresh
```

---

## Next Steps

- **For Devnet:** See [DEVNET_DEPLOYMENT_GUIDE.md](./DEVNET_DEPLOYMENT_GUIDE.md)
- **For Testing:** See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)
- **For Architecture:** See [DEPLOYMENT.md](./DEPLOYMENT.md)
