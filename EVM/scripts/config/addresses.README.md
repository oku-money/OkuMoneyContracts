# Address book state

`addresses.json` is the LIVE, tracked address book that
`scripts/utils/addressBook.ts` reads/writes.

**Current state: `v0.3` is deployed.** The book holds all five contracts
(`MockUSDC`, `OkuMoney`, `OkuDollar`, `RedemptionQueue`, `LitePSM`) for each of
the four MVP testnets — `sepolia`, `baseSepolia`, `arbSepolia`, `bscTestnet`.
Addresses are identical across chains because every deploy goes through the
Arachnid CREATE2 factory with a `DEPLOYMENT_VERSION`-scoped salt.

`base` / `bsc` (mainnet) are **not** in this book. They carry a live
pre-streaming `v0.2` deployment from before the streaming-yield refactor
(`setOkuMYieldRate` did not exist in that source tree), and they are not part
of the internal-testing MVP chain set
(`scripts/config/epochChains.ts::DEFAULT_EPOCH_CHAINS`). They were not
redeployed and are expected to show as drifted by
`operator:checkMultiplierDrift`, which deliberately scans wider than the
participating set.

## The `tryAttach` hazard — read before any `DEPLOYMENT_VERSION` bump

`tryAttach` reuses whatever address is CURRENTLY in the book, checking only
that it has on-chain bytecode — **not** that the address matches the current
version's CREATE2 salt. So on a version bump the four contract keys must be
cleared for every network *before* deploying, or the new deploy silently
"reuses" the previous version's live contracts instead of deploying the new
ones at their own addresses.

`MockUSDC` is the deliberate exception: its key is retained across bumps so
`deployMockUSDC`'s reuse path finds the existing, already-funded token. Its
salt is version-scoped too, so clearing it would mint a fresh token with no
balances.

## Note on addresses after `bytecodeHash = "none"`

`foundry.toml` and `hardhat.config.ts` no longer embed the source-text
metadata hash in creation bytecode, so CREATE2 addresses no longer move when a
comment changes. The change itself moved them once: the addresses in this book
were computed under the old setting.

This does not affect the deployed fleet. Proxy addresses are permanent, and
`scripts/upgrade/index.ts` resolves them from this book rather than
recomputing. What it does mean is that a **from-scratch deploy, or a deploy to
a new chain, will land at different addresses than the entries here** — and
that block-explorer verification of the current contracts is stale against
present-day source until they are next upgraded. Testnet-only; accepted.

## Archive

`addresses.pre-streaming.json` is the archived `v0.2` state, including the
`base`/`bsc` mainnet entries, kept for forensic reference (matching
`SVM/oku-programs/deployments/README.md`'s convention on the SVM side). NOT a
template; nothing reads it.
