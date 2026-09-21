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
| `orchestrator.json` | PSM rebaser + cross-chain orchestrator (KMS-backed on mainnet) | `MAINNET_ORCHESTRATOR` |
| `cold-multisig.json` | Cold multisig proxy (Squads vault on mainnet) | `MAINNET_COLD_MULTISIG` |
| `warm-multisig.json` | Warm multisig proxy (Squads vault on mainnet) | `MAINNET_WARM_MULTISIG` |
| `devnet-authority.json` | Devnet-only deployer / all-roles key | — |

On **localnet / devnet / forks** you need **two** keys, not one:

| Key | Holds | Why separate |
|---|---|---|
| deployer (`~/.config/solana/id.json`) | `role_admin` | `initialize` constrains `role_admin` == the program's BPF upgrade authority, i.e. whoever deployed. |
| `devnet-authority.json` | the 9 granular roles | `initialize` rejects any granular authority equal to `role_admin` (separation-of-duties, mirrors `set_authority`). |

See `scripts/config/authorities.ts::allRolesToOperatorKey` and the
"Two binding authority constraints at init" section of `SVM/README.md`.
The operator key still collapses all 9 roles onto ONE signer, so a single
extra key is enough to run every devnet flow end-to-end.

`direct_minter` / `direct_burner` sit on a third key (the delegate EOA,
`DEFAULT_DIRECT_MINTER` in `scripts/config/constants.ts`) for the same
separation reason; they're wired by `deploy-init` / `grant-roles.ts`.

Override the operator key path with `DEVNET_AUTHORITY_PATH`.

On **mainnet**, each env var above must be set to the corresponding Squads
vault or KMS public key; the private keys never touch this machine.

There is no on-chain bridge program; the orchestrator key above signs both
PSM ops and the off-chain cross-chain mint/burn flow.

---

## Generating keys locally

```bash
# Dev-only operator key holding the 9 granular roles (localnet / devnet).
# REQUIRED — deploy-init fails without it, since the granular roles cannot
# be seated on the deployer (which is role_admin).
solana-keygen new --outfile keys/devnet-authority.json
solana transfer $(solana-keygen pubkey keys/devnet-authority.json) 0.5 \
    --url devnet --allow-unfunded-recipient

# Separate role keys (mainnet only — mirror the production split)
solana-keygen new --outfile keys/orchestrator.json
solana-keygen new --outfile keys/cold-multisig.json
solana-keygen new --outfile keys/warm-multisig.json

# Fund the deployer on devnet / localnet
solana airdrop 10 $(solana-keygen pubkey keys/devnet-authority.json) --url devnet
```
