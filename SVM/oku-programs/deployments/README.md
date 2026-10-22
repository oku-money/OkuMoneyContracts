# Deployment state files

## `devnet.json` — live

The current devnet deployment (program `4k5gmUht…`, see `Anchor.toml`). Written by
`deploy:programs` / `deploy:init`; `scripts/utils/addressBook.ts::saveDeployment` **merges** into any
existing file at the same path, so a genuinely fresh deploy should start from no file (move or delete
the old one first, or stale keys survive into the new record).

`authorities` is recorded from the deploy-time config (env vars on mainnet), not read back from chain;
confirm `role_admin` against `PsmConfig` (see [`../../README.md` § Mainnet `role_admin` handover](../../README.md#mainnet-role_admin-handover)).

## Archived: `devnet.v1-pre-streaming.json`, `devnet-fork.v1-pre-streaming.json`

Records of the pre-streaming, two-token-era deployments. **Not live and not a template.** They are
kept only to identify old program IDs and accounts (for example when reconciling rent):

- `pdas.psmConfig` is an orphaned account under a superseded `PsmConfig` layout (the current
  `PsmConfig::LEN` is 754); the current program cannot deserialize it and no migration exists.
- `tokens.okuMoney` / `tokens.usdOku`, `pdas.redemptionQueue`, `pdas.vaultConfig`,
  `pdas.vaultOkuMoney`, `programs.okuDollarProgram` and the `OkuDollar` `upgrades[]` entries refer to
  components that no longer exist in this workspace.

The program IDs these files record are all **closed** (`solana program show` reports "has been
closed"), and a closed program ID can never be redeployed:

| Program ID | Recorded in | Was |
|---|---|---|
| `BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g` | `devnet.v1-pre-streaming.json` | old `lite_psm` |
| `3CLDWjDTtvWcRr1iNS9SRtDvqXgEZLm6hq1P6426YC7N` | `devnet-fork.v1-pre-streaming.json` (and `upgrades[]` of the devnet archive) | old `lite_psm` |
| `3TeNwAqQxxGZwF7LSveLcVEKZ5tuXNKSvfMj6nz3PJgy` | `devnet-fork.v1-pre-streaming.json` | `oku_dollar` (crate removed) |
| `4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN` | `devnet.v2-4k5gm.json` | `lite_psm` v2 (closed 2026-10-22, 3.108 SOL reclaimed; config `EBL4…`, vault, OkuM mint `BZw8…` and `5B3k…` stranded) |

The current devnet deploy (`devnet.json`) is `lite_psm` `FxTLKSUPmuUJWQZ7EaYHkpcvAg3h4HZvmnUhhPCD5DwW`
(deployed 2026-10-22).
