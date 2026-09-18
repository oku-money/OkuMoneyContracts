# Address book state

`addresses.json` is the LIVE, tracked address book `scripts/utils/addressBook.ts`
reads/writes. As of the `DEPLOYMENT_VERSION` bump to `v0.3` (clean-slate
streaming-yield deploy), it holds **only `MockUSDC` entries** for the four
MVP testnets (`sepolia`, `baseSepolia`, `arbSepolia`, `bscTestnet`) —
deliberately, so `deployMockUSDC`'s `tryAttach` reuse path finds and reuses
the EXISTING MockUSDC deployment on each chain rather than deploying a new
one (MockUSDC's CREATE2 salt is also `DEPLOYMENT_VERSION`-scoped, so it would
otherwise get a fresh, funded-with-nothing token).

`OkuMoney` / `OkuDollar` / `RedemptionQueue` / `LitePSM` entries were
deliberately REMOVED for every network, and `base` / `bsc` (mainnet) were
removed entirely:

- **Why remove the four contract keys for the testnets**: `tryAttach` reuses
  whatever address is CURRENTLY in the book, checking only that it has
  on-chain bytecode — not that it matches the current `DEPLOYMENT_VERSION`'s
  CREATE2 salt. Left in place, a `v0.3` deploy would silently "reuse" the
  live `v0.2` (pre-streaming) contract instead of deploying the new one at
  its own CREATE2 address.
- **Why remove `base`/`bsc` entirely**: those two mainnets carry a live
  pre-streaming (`v0.2`) deployment that predates the streaming-yield
  refactor (`setOkuMYieldRate` didn't exist in that source tree) and are not
  part of the internal-testing MVP's chain set
  (`scripts/config/epochChains.ts::DEFAULT_EPOCH_CHAINS`). They are not being
  redeployed as part of this pass.

`addresses.pre-streaming.json` is the **archived** `v0.2` state — every
contract address just described, for the record, kept for forensic reference
(matching `SVM/oku-programs/deployments/README.md`'s convention for the SVM
side). NOT a template; nothing reads it.
