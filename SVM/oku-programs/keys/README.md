# SVM Signing Keypairs

This directory holds **local** Solana keypair files used during development and
deployment. They are gitignored and must be generated per-developer.

> **IMPORTANT:** Never commit any `.json` file in this directory.
> Each file is a 64-byte ed25519 keypair in standard Solana format
> (`solana-keygen new` output). If any file was accidentally committed,
> rotate the key immediately and rewrite git history.

---

## Expected files

| Filename | Purpose | Mainnet env var in `scripts/config/authorities.ts` |
|---|---|---|
| `orchestrator.json` | PSM rebaser / orchestrator (KMS-backed on mainnet) | `MAINNET_ORCHESTRATOR` |
| `bridge-orchestrator.json` | Bridge mint authority (KMS-backed on mainnet) | `MAINNET_BRIDGE_ORCHESTRATOR` |
| `cold-multisig.json` | Cold multisig proxy (Squads vault on mainnet) | `MAINNET_COLD_MULTISIG` |
| `warm-multisig.json` | Warm multisig proxy (Squads vault on mainnet) | `MAINNET_WARM_MULTISIG` |
| `fee-recipient.json` | Bridge fee recipient (mainnet only; testnet uses a PDA) | `MAINNET_FEE_RECIPIENT` |
| `devnet-authority.json` | Devnet-only deployer / all-roles key | — |

On **localnet / devnet / forks** all signer roles collapse to a single deployer
wallet (see `scripts/config/authorities.ts::allRolesToSingleKey`), and the
bridge fee recipient is set to a program-derived address
(`deriveBridgeFeeTreasuryPDA`) so fees accumulate in a distinct account from the
deployer. You only need one key with SOL to run devnet flows end-to-end.

On **mainnet**, each env var above must be set to the corresponding Squads
vault or KMS public key; the private keys never touch this machine.

---

## Generating keys locally

```bash
# Dev-only all-roles key (localnet / devnet)
solana-keygen new --outfile keys/devnet-authority.json

# Separate role keys (mainnet only — mirror the production split)
solana-keygen new --outfile keys/orchestrator.json
solana-keygen new --outfile keys/bridge-orchestrator.json
solana-keygen new --outfile keys/cold-multisig.json
solana-keygen new --outfile keys/warm-multisig.json
solana-keygen new --outfile keys/fee-recipient.json

# Fund the deployer on devnet / localnet
solana airdrop 10 $(solana-keygen pubkey keys/devnet-authority.json) --url devnet
```
