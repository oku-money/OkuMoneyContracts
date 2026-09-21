# Deployment state files

`devnet.v1-pre-streaming.json` / `devnet-fork.v1-pre-streaming.json` are
**archived**, not live. They record the discrete-multiplier-era deployment
(pre streaming-accrual refactor) and are known-stale in several ways:

- `pdas.psmConfig` points at a 562-byte account under the OLD PsmConfig layout
  (626 bytes now). The current program cannot deserialize it — it is an
  orphaned account, not a usable config.
- `tokens.okuMoney` / `tokens.usdOku`, `pdas.redemptionQueue`,
  `pdas.vaultConfig`, `pdas.vaultOkuMoney` are two-token-model keys from before
  the single-token collapse. Dead.
- `devnet-fork.json` additionally carries `programs.okuDollarProgram` — a
  program that no longer exists in this workspace.
- Several `upgrades[]` entries are for `OkuDollar`, likewise gone.

Kept for forensic reference (recovering stranded rent, understanding what a
past deploy looked like), NOT as a template. `scripts/utils/addressBook.ts`'s
`saveDeployment` MERGES into an existing file at the same path
(`{...existing.tokens, ...addresses.tokens}`), so if a fresh `devnet.json` were
written back to the un-archived name, these dead keys would silently survive
into it. That merge behavior is why these were renamed rather than left in
place — a genuinely fresh deploy should start from nothing.

## `devnet.json` — LIVE (clean-slate redeploy, 2026-09-19)

Written from scratch by the redeploy, so it carries none of the dead keys
above. Program ID was rotated (`BUQ1ULxn…` → `4k5gmUht…`) because the three
programs recorded in the archived files have since been **closed** for rent
recovery, and a closed program ID can never be redeployed.

Rent recovered at redeploy time (10.495 SOL total):

| Program ID | Was | Rent |
|---|---|---|
| `BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g` | old `lite_psm` | 4.351 SOL |
| `5SK6EhbXf9d7jW4vzobZfbtUsZBQmFyo9w3xuSQY3Zke` | `oku_dollar` (crate removed) | 3.286 SOL |
| `GAjPAbq7sqFNzfnyhEAxBD9ofTPSTk4EtjFpq45BjRWb` | `oku_bridge_router` (crate removed) | 2.858 SOL |

All three are now closed — `solana program show` on any of them returns
"has been closed". They remain in the archived files as explorer history
only.
