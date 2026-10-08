# SVM Signing Keypairs

This directory holds **local** Solana keypair files for development. Everything here except this file
and `.gitkeep` is gitignored (`**/keys/**/*.json`).

> **IMPORTANT:** Never commit a keypair. Each file is a 64-byte ed25519 keypair in standard
> `solana-keygen new` format. If one is ever committed, rotate it immediately and rewrite history.

## Keys used by the scripts

| Key | Used for | Where read |
|---|---|---|
| deployer: `WALLET_PATH`, default `~/.config/solana/id.json` | Signs deploys and `initialize`; becomes `role_admin` and BPF upgrade authority | `scripts/utils/network.ts` |
| `keys/devnet-authority.json` (override: `DEVNET_AUTHORITY_PATH`) | **Operator key** on localnet / devnet / forks. It is **not** the deployer; it holds the 9 granular roles (`pauser`, `unpauser`, `freezer`, `unfreezer`, `buffer_depositor`, `buffer_withdrawer`, `cap_manager`, `allowance_manager`, `rate_manager`) | `scripts/config/authorities.ts::loadDevnetAuthority` |

`initialize` forces two keys: it requires `role_admin` to be the program's BPF upgrade authority (the
deployer) and rejects any granular role equal to `role_admin`. So localnet/devnet needs the deployer
**and** the operator key; the operator key collapses all 9 roles onto one signer so a single extra key
runs every flow. See [`SVM/README.md` § Two binding authority constraints at init](../../README.md#two-binding-authority-constraints-at-init).

`direct_minter` / `direct_burner` sit on a third key, the delegate EOA (`DEFAULT_DIRECT_MINTER` in
`scripts/config/constants.ts`), wired by `deploy-init` / `grant-roles.ts`. There is no on-chain bridge
program; the orchestrator key signs both PSM ops and the off-chain cross-chain mint/burn flow.

Program keypairs live in `target/deploy/<program>-keypair.json`, not here.

## Mainnet: env vars only

No keypair file in this directory is read on mainnet. `scripts/config/authorities.ts` takes **public
keys** from the environment, and the private keys (Squads vaults, KMS) never touch this machine:

| Env var | Required | Roles seated |
|---|---|---|
| `MAINNET_COLD_MULTISIG` | yes | `unpauser`, `unfreezer`, `buffer_withdrawer`, `cap_manager`, `allowance_manager` (and the intended `role_admin`, see below) |
| `MAINNET_WARM_MULTISIG` | yes | `pauser`, `freezer` |
| `MAINNET_ORCHESTRATOR` | yes | `buffer_depositor`, `rate_manager` |
| `MAINNET_DIRECT_MINTER` | optional | `direct_minter` (unset = disabled) |
| `MAINNET_DIRECT_BURNER` | optional | `direct_burner` (unset = disabled) |

Caveat: `initialize` always sets `role_admin` to the signing deployer, so `MAINNET_COLD_MULTISIG` does
**not** become `role_admin` at init. Hand it over afterwards with the two-step rotation in
[`SVM/README.md` § Mainnet `role_admin` handover](../../README.md#mainnet-role_admin-handover).

## Generating the devnet operator key

```bash
solana-keygen new --outfile keys/devnet-authority.json   # REQUIRED: deploy-init fails without it
solana transfer $(solana-keygen pubkey keys/devnet-authority.json) 0.5 \
    --url devnet --allow-unfunded-recipient
# or: solana airdrop 2 $(solana-keygen pubkey keys/devnet-authority.json) --url devnet
```

Fund the deployer wallet separately (`solana airdrop` on devnet/localnet).
