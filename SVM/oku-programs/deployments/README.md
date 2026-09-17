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

The next real devnet deploy writes a clean `deployments/devnet.json` from
scratch (see `SVM/README.md` deploy runbook — clean-slate redeploy is required
regardless, since the account layout changed).
