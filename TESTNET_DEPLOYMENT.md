# OkuMoney Deployment Runbook

Complete guide for deploying OkuMoney on EVM chains + Solana, and exercising
the on-chain protocol end-to-end. v1 cross-chain transfers are mediated by
an off-chain orchestrator (PSM mint/burn on each chain) — there is no
on-chain bridge.

> Authoritative deployment state lives in [`testnet-addresses.json`](testnet-addresses.json) at the repo root — auto-synced by every successful live EVM deploy. Do NOT hand-edit it; rerun the deploy script to refresh.
>
> Per-chain working address book is at [`EVM/scripts/config/addresses.json`](EVM/scripts/config/addresses.json) (live `<chain>` keys + `fork:<chain>` namespaces for local-fork runs).

## Prerequisites

### Environment

1. **EVM**
   ```bash
   cd EVM
   cp .env.example .env
   # PRIVATE_KEY=<deployer key>
   # ALCHEMY_API_KEY=<alchemy key — covers Eth, Optimism, Arbitrum, Base, BSC, Sepolia>
   # ETHERSCAN_API_KEY=<single Etherscan V2 key — covers all of the above for verification>
   # Optional per-chain RPC overrides: SEPOLIA_RPC_URL, BASE_RPC_URL, BSC_RPC_URL, etc.
   ```

2. **SVM**
   ```bash
   cd SVM/oku-programs
   cp .env.example .env
   solana config set --url devnet
   solana-keygen new --outfile ~/.config/solana/id.json   # if needed
   ```

3. **Dependencies**
   ```bash
   cd EVM && npm install && npx hardhat compile
   cd SVM/oku-programs && npm install && anchor build
   ```

4. **(Optional) Surfpool** for SVM local-fork testing
   ```bash
   curl -sL https://run.surfpool.run/ | bash
   ```

---

## Phase 1: Local Fork Pre-Flight (Recommended)

Validate the deploy will succeed against real chain state before spending real
funds. Catches funding shortfalls, RPC quirks, and gas estimation issues.

### 1.1 EVM local fork

The deploy script auto-detects the target chain from the running fork node's
`eth_chainId`, so no env-var bookkeeping is required across terminals.

```bash
cd EVM

# Terminal 1 — pick which chain to fork (default: sepolia)
FORK_NETWORK=base hh node           # =sepolia, =opSepolia, =mainnet, =optimism,
                                    # =arbitrum, =base, =bsc

# Terminal 2 — deploy + run integration test against the fork
hh run scripts/deploy/index.ts --network localhost
hh run scripts/interactions/test-flow.ts --network localhost
```

What the deploy does in one run:
- Deploys MockUSDC, OkuMoney, OkuDollar, RedemptionQueue, LitePSM
- Configures all roles and minter allowances (LitePSM + RedemptionQueue hold OKUM_MINTER)
- Verifies deployment state

> The OkuBridge / OkuBridgeRouter steps and bridge configuration (fee, limits,
> deadline, supported chains) were removed in the noBridge refactor. v1
> cross-chain transfers are PSM-mediated mint/burn orchestrated off-chain.

Fork-deployed addresses land under `addresses.json["fork:<chain>"]` so they
never collide with live entries.

### 1.2 SVM local fork (Surfpool)

```bash
cd SVM/oku-programs
surfpool start --rpc-url https://api.devnet.solana.com   # terminal 1
# Two-phase deploy against the surfpool fork (terminal 2):
NETWORK=devnet-fork npm run deploy:programs:devnet-fork
NETWORK=devnet-fork npm run deploy:init:devnet-fork
# Smoke against the running fork:
NETWORK=devnet-fork npm run test:onchain:fork
```

The surfpool fork inherits devnet state (program IDs, Pyth feed) at
fork time, so deploys land using the `[programs.devnet]` IDs from
`Anchor.toml`. See `scripts/test/test-devnet.ts` for the per-step smoke
suite.

---

## Phase 2: Live Deploy

### 2.1 EVM

```bash
cd EVM

# Per-network shortcuts (defined in package.json):
npm run deploy:sepolia        # Eth Sepolia
npm run deploy:opSepolia      # OP Sepolia
npm run deploy:baseSepolia    # Base Sepolia
npm run deploy:bscTestnet     # BNB Smart Chain testnet (Chapel)
npm run deploy:base           # Base mainnet
npm run deploy:bsc            # BNB Smart Chain mainnet

# Chains without a pre-baked alias:
hh run scripts/deploy/index.ts --network arbitrum
hh run scripts/deploy/index.ts --network optimism
hh run scripts/deploy/index.ts --network mainnet
```

The script is **idempotent and resumable**:
- Already-deployed contracts are reused via the `tryAttach` bytecode check.
- Transient RPC errors (`nonce too low`, `replacement transaction underpriced`,
  BSC's `BAD_DATA: invalid address (value="")` pending-tx quirk, network
  timeouts) are absorbed by `withRetry` (exponential backoff, up to 5 attempts).
- Partial-deploy failures: just rerun. Contracts already on chain stay; only
  missing pieces deploy.

On success, addresses are written to:
- `EVM/scripts/config/addresses.json` under `"<chain>"`
- Repo-root `testnet-addresses.json` under `"evm.<chain>"` (full registry: chainId, rpcUrl, explorer, contracts, deployer)

### 2.2 SVM

```bash
cd SVM/oku-programs

# Pre-flight: ensure Anchor.toml [programs.devnet] IDs match the on-disk
# deployments/devnet.json (if any). loadDeployment() will warn loudly on
# mismatch; the recover-then-redeploy flow is documented at the bottom
# of this section.
anchor build
npm run cost                       # estimate one-time rent (≈0.067 SOL for the queue alone)

# Fund deployer (devnet) — needs enough SOL for program rent + queue rent.
solana airdrop 5 --url devnet
solana airdrop 5 --url devnet

# Phase 1 — deploy program .so files (writes program IDs into deployments/devnet.json)
NETWORK=devnet npm run deploy:programs

# Phase 2 — create tokens, initialize PSM and OkuDollar vault.
NETWORK=devnet npm run deploy:init
```

> **Anchor.toml update (post-`deploy:programs`):** `deploy:programs`
> prints a block at the end with the freshly-deployed program IDs and
> the exact lines to paste into `[programs.devnet]` (or `[programs.mainnet]`).
> We deliberately keep `[programs.devnet]` and `[programs.localnet]` as
> separate sections — they currently coincide because dev keypairs are
> reused, but the option to rotate one cluster's keypairs without
> touching the other is preserved. Until Anchor.toml matches the
> deployed IDs, the `[addressBook] WARNING:` block fires on every
> admin script.

Addresses recorded in `SVM/oku-programs/deployments/devnet.json` and (via the
SVM deploy script) mirrored into the repo-root `testnet-addresses.json` under
`"svm.devnet"`. The deployment file persists the `psmVaultUsdc` and
`vaultOkuMoney` PDAs so admin/test scripts can read them directly without
re-deriving from mint + config.

> **Stale `deployments/devnet.json`**: if you redeployed and the file's
> program IDs no longer match `Anchor.toml [programs.devnet]`, every
> script call will emit a `[addressBook] WARNING:` block and the txs
> will hit the *file's* program IDs (not Anchor.toml's). To fix:
>
> 1. **First, recover rent from the old programs.** Run the dedicated
>    close-and-reclaim wrapper:
>    ```bash
>    NETWORK=devnet npm run admin:close-programs -- --dry-run   # plan
>    NETWORK=devnet npm run admin:close-programs                # execute
>    ```
>    By default this reads the two program IDs from
>    `deployments/<network>.json::programs.*`, calls
>    `solana program show` on each (verifying the deployer wallet is
>    the upgrade authority and capturing rent balance), then runs
>    `solana program close` per program with the deployer wallet as
>    recipient. It refuses to close IDs currently declared in
>    `Anchor.toml [programs.<network>]` (those are the next-deploy
>    targets) unless you pass `--allow-anchor-toml-ids` AND rotate the
>    `target/deploy/<program>-keypair.json` files afterwards.
> 2. **Then overwrite or delete the stale file** and redeploy:
>    ```bash
>    rm deployments/devnet.json   # optional — deploy:init overwrites anyway
>    NETWORK=devnet npm run deploy:programs
>    NETWORK=devnet npm run deploy:init
>    ```
>
> The `loadDeploymentStrict()` helper in `scripts/utils/addressBook.ts`
> is available for any future script that should refuse to run on
> mismatch (recommended for mainnet admin paths).

---

## Phase 3: Verify Deployments

### 3.1 EVM

EVM diagnostics live in the hardhat tests + the test-flow script:

```bash
cd EVM

# Full happy-path smoke (in-process hardhat node)
npx hardhat test

# Live network round-trip + balance check
NETWORK=sepolia npm run test:flow:live
```

Expected: `LitePSM`, `OkuMoney`, `OkuDollar`, `RedemptionQueue` deployed
with the deployer holding the expected admin roles and `OKUM_MINTER` set
on the PSM and queue.

### 3.2 SVM

```bash
cd SVM/oku-programs

# Full end-to-end smoke across PSM, Vault, Oracle, Pause, SetAuthority,
# DistributeYield, queueRedeem (~30 s on devnet).
NETWORK=devnet npm run test:onchain
# Run a single step instead:
NETWORK=devnet npm run test:onchain -- --step=queueRedeem
```

The `test:onchain` runner expects `deployments/devnet.json` to be
current — see the stale-file note in §2.2 if it warns.

---

## Phase 4: Test Cross-Chain Transfers (noBridge / PSM-Mediated)

There is no on-chain bridge on either side in v1. Cross-chain transfers
run entirely off-chain through PSM mint/burn:

1. **Burn on source chain (EVM)**: user calls `LitePSM.redeemOkuM(amount)`
   to swap OkuM → USDC. The orchestrator observes the resulting `OkuMRedeemed`
   event and the corresponding USDC outflow.
2. **Mint on destination chain (EVM or SVM)**: orchestrator deposits USDC
   from its custody into the destination PSM and calls `LitePSM.mintOkuM`
   (or the SVM equivalent), crediting OkuM to the recipient.
3. **Buffer rebalance**: treasury periodically tops up / drains PSM USDC
   buffers per chain to keep liquidity matched to demand.

There is no on-chain BridgeRequest, EIP-712 signature, or refund flow in v1.
Operationally the orchestrator runs the relay loop, exposing chain ID +
recipient address as input parameters.

OkuBridge / NTT / CCIP will be re-introduced as additive components; the
`BRIDGE_*` / `ROUTER_*` / `NTT_*` roles and `IOkuBridgeNative` /
`IBridgeAdapter` interfaces in the EVM tree are the reserved seams for that
future work. See `EVM/README.md` § Cross-Chain Transfers.

The EVM cross-chain accounting is covered by
`EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts`.

### Test 4: Queue drain (SVM only)

Validates the Phase 13b 200-entry zero-copy queue and the auto-batching
orchestrator drain. Either run the dedicated smoke step:

```bash
cd SVM/oku-programs
NETWORK=devnet npm run test:onchain -- --step=queueRedeem
```

…or exercise the orchestrator path directly:

```bash
NETWORK=devnet npm run admin:process-queue                # drain to empty
NETWORK=devnet npm run admin:process-queue -- --max=25    # cap at 25 entries this run
NETWORK=devnet npm run admin:process-queue -- --dry-run   # plan + simulate only
```

`admin:process-queue` auto-batches at `MAX_BATCH_ENTRIES = 50` per tx, so
a full 200-entry queue drains in 4 sequential txs from a single
invocation. Operationally the orchestrator runs this on a cron (see
`SVM/README.md` § Queue capacity SLA).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Sender doesn't have enough funds` | Top up the dev wallet on the target chain. The pre-flight fork run shows the *real* funding shortfall before you spend live ETH. |
| `nonce too low` / `replacement transaction underpriced` | RPC nonce-cache race. `withRetry` should absorb it on its own; if it persists, switch RPC (set `BASE_RPC_URL` / `BSC_RPC_URL` / etc.) or wait a few seconds and rerun. |
| `BAD_DATA: invalid address (value="")` | BSC pending-tx response shape quirk. `scripts/utils/rpcCompat.ts` should normalise it; if you ever see this fall through, check that `resolveNetworkContext()` ran (look for `RPC compat:` line in script output). |
| `Chain ID mismatch: local node reports chainId X, but NETWORK=Y expects Z` | Restart `hh node` with `FORK_NETWORK=Y`, OR unset `NETWORK` so the script auto-detects from the running fork. |

### Useful read-only commands

```bash
# SVM: full smoke against the live cluster
NETWORK=devnet npm run test:onchain

# SVM: full smoke against a surfpool fork (no real SOL spent)
NETWORK=devnet-fork npm run test:onchain:fork

# View txns
solana confirm -v <signature> --url devnet
# https://etherscan.io/tx/<hash>      (mainnet)
# https://sepolia.etherscan.io/tx/<hash>
# https://basescan.org/tx/<hash>
# https://bscscan.com/tx/<hash>
```

---

## Chain ID Reference

EVM chain IDs follow EIP-155. SVM chain identifiers (the Ankr convention)
are protocol-internal and no longer stored on-chain after the noBridge
refactor — they appear only in deployment registry metadata.

| Network | EIP-155 / chain ID | Type |
|---|---|---|
| Solana Mainnet | 101 | Ankr convention |
| Solana Devnet | 103 | Ankr convention |
| Ethereum | 1 | EIP-155 |
| Optimism | 10 | EIP-155 |
| BNB Smart Chain | 56 | EIP-155 |
| Base | 8453 | EIP-155 |
| Arbitrum One | 42161 | EIP-155 |
| Eth Sepolia | 11155111 | EIP-155 |
| OP Sepolia | 11155420 | EIP-155 |

---

## Security Notes

1. **Testnet uses deployer as orchestrator** for convenience. Production deployments MUST use a separate KMS-backed orchestrator key.
2. **Never commit `.env` files** or private keys to git.
3. **RPC reliability**: Alchemy is preferred for live runs. Public RPCs can lag on nonce / mempool state and exacerbate the transient errors above.
4. **No on-chain bridge in v1.** Cross-chain replay/refund protection is the orchestrator's responsibility — the protocol surface is just PSM mint/burn.
