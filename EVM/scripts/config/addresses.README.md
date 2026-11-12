# Address book state

`addresses.json` is the LIVE, tracked address book that
`scripts/utils/addressBook.ts` reads/writes.

**Current state: `DEPLOYMENT_VERSION = "v0.5"` is deployed** on the five testnets
(`sepolia`, `baseSepolia`, `arbSepolia`, `opSepolia`, `bscTestnet`) and, as an
internal test deployment (`INTERNAL_TESTING_MAINNET=true`), on `arbitrum` and `bsc`
mainnet using each chain's real USDC. `MockUSDC` was retained across the v0.4 -> v0.5
bump (testnets only), so it keeps its v0.4 address `0x9705F7e8...F09b`; `OkuMoney`
and `OkuDollar` share one address on every chain, `LitePSM` is identical across the
testnets and differs on `arbitrum` / `bsc` because its constructor takes the real
USDC. Addresses come from the Arachnid CREATE2 factory with a
`DEPLOYMENT_VERSION`-scoped salt. The authoritative list is `addresses.json` and the
root `testnet-addresses.json`.

`base` (mainnet) is **not** in this book. It carries a live pre-streaming `v0.2`
deployment from before the streaming-yield refactor (`setOkuMYieldRate` did not
exist in that source tree), was not redeployed, and is not part of the
internal-testing chain set. `bsc` previously carried the same `v0.2` deployment
(`0x0696...2796` etc., still live and orphaned); the v0.5 internal-test deploy
sits alongside it at fresh addresses, and the book only tracks the v0.5 one.
`arbitrum` and `bsc` are internal test deployments and are NOT in
`scripts/config/epochChains.ts::DEFAULT_EPOCH_CHAINS`; include them explicitly
with `CHAINS=` (plus `YES_MAINNET=true` for broadcasts) when running epoch tooling.

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
