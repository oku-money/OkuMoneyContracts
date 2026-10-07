# Address book state

`addresses.json` is the LIVE, tracked address book that
`scripts/utils/addressBook.ts` reads/writes.

**Current state: `DEPLOYMENT_VERSION = "v0.4"` is pending; the book is empty**
(every network key is `{}`, as are the EVM entries in the root
`testnet-addresses.json`). The first deploy populates `MockUSDC`, `OkuMoney`,
`OkuDollar` and `LitePSM` for each of the four MVP testnets — `sepolia`,
`baseSepolia`, `arbSepolia`, `bscTestnet`. Addresses are identical across chains
because every deploy goes through the Arachnid CREATE2 factory with a
`DEPLOYMENT_VERSION`-scoped salt. Until then, scripts that read EVM addresses
(operator scripts, `bridge-svm-evm.ts`) fail on a missing entry.

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
version's CREATE2 salt. So on a version bump the three proxy keys (`OkuMoney`,
`OkuDollar`, `LitePSM`) must be cleared for every network *before* deploying, or
the new deploy silently "reuses" the previous version's live contracts instead
of deploying new ones at their own addresses.

`MockUSDC` is normally retained across bumps so `deployMockUSDC`'s reuse path
finds the existing, already-funded token. Clearing it deploys a fresh token with
no balances, because its salt is version-scoped too. The `v0.4` bump cleared it
deliberately: the mock's bytecode changed, so a reused old token would not match
the current source.

## CREATE2 address stability

`foundry.toml` and `hardhat.config.ts` set `bytecodeHash = "none"`, so the
source-text metadata hash is not embedded in creation bytecode and CREATE2
addresses do not move when only a comment changes. They still move with any
code, compiler or constructor-arg change, and with `DEPLOYMENT_VERSION`; a deploy
to a new chain or with different constructor args (real USDC vs `MockUSDC`)
lands at different addresses. `scripts/upgrade/index.ts` resolves proxies from
this book rather than recomputing them, so proxy addresses are permanent once
deployed.

## Archive

`addresses.pre-streaming.json` is the archived `v0.2` state, including the
`base`/`bsc` mainnet entries, kept for forensic reference (matching
`SVM/oku-programs/deployments/README.md`'s convention on the SVM side). NOT a
template; nothing reads it.
