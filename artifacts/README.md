# OkuMoney Artifacts

Curated build outputs for downstream consumers (backend services, SDKs, frontends).
Each file is a stable JSON representation that can be imported directly without running the contract tooling locally.

> **This directory is auto-generated.** Do not hand-edit files here. Run the relevant export command after rebuilding to refresh.

## Layout

```
artifacts/
  evm/          # Solidity ABIs + bytecode (Hardhat format, slimmed)
  svm/          # Anchor IDLs (JSON)
```

## EVM — `artifacts/evm/*.json`

Each file has the shape:

```json
{
  "contractName": "OkuM",
  "sourceName": "src/token/OkuM.sol",
  "abi": [ ... ],
  "bytecode": "0x...",
  "deployedBytecode": "0x..."
}
```

Exported contracts (7):

| File | Purpose | Standards |
|------|---------|-----------|
| `OkuM.json` | Share token: stepwise `M_oku` multiplier | ERC-20 + ERC-2612 + ERC-8056 + ERC-4626-conversion-subset (`convertToAssets`/`convertToShares`; not a full vault — no `deposit`/`withdraw`) |
| `USDOku.json` | Rebasing $1-pegged dollar wrapper: continuous `M_usd` multiplier | ERC-20 + ERC-2612 **only** — deliberately **not** ERC-8056. `supportsInterface(0xa60bf13d)` returns `false`. This is a deliberate double-scaling guard: USDOku already rebases balances internally via its own share/index accounting, so an integrator that also applied `uiMultiplier()`-style scaling on top would double-count. Do not assume ERC-8056 support just because `OkuM` has it |
| `USDOkuWrapper.json` | Wraps `OkuM` ↔ `USDOku` at the current `M_oku` mark; also holds `withdrawSurplus` (issuer capital recovery, gated by `WRAPPER_RESERVE_MANAGER`) | — |
| `SubscriptionModule.json` | USDC ↔ `OkuM` peg stability module (sole user-facing mint/burn surface in v1); also exposes one-transaction `mintUsdOku`/`redeemUsdOku` (USDC ↔ `USDOku`, routed through the wrapper internally) | — |
| `RedemptionQueue.json` | FIFO queue for `SubscriptionModule`-buffer-depleted redemptions | — |
| `OkuMultiplierAdapter.json` | Reads `OkuM.uiMultiplier()` for external price consumers (lending markets, AMMs) | — |
| `MockUSDC.json` | 6-decimal ERC-20 used on testnets | — |

`SubscriptionModule` is the current name for what was previously shipped as
`LitePSM`; `OkuDollar`/`rUSDOku` (a single continuous-accrual token) was the
name of an earlier single-token design and no longer exists as a contract —
its role is now split across `OkuM` (share token) and `USDOku` (dollar
wrapper). If you have integration code referencing `LitePSM.json` or
`OkuDollar.json`, it is stale.

> `OkuBridge.json`, `OkuBridgeRouter.json`, and `NttAdapter.json` were removed
> in the noBridge refactor. v1 cross-chain transfers are mediated by
> `SubscriptionModule`/`OkuM` mint/burn orchestrated off-chain. See
> `contracts/README.md` for the design.

**Refresh:**

```bash
cd EVM
npx hardhat compile   # regenerate artifacts/src/**/*.json
npm run export-abis   # slim + copy into ../artifacts/evm/
```

> **Note:** `scripts/utils/exportAbis.ts` (the source of truth for what
> `export-abis` writes) currently lists 6 contracts in its
> `PRODUCTION_CONTRACTS` array — `OkuM`, `USDOku`, `USDOkuWrapper`,
> `SubscriptionModule`, `RedemptionQueue`, `OkuMultiplierAdapter` —
> and does not include `MockUSDC`. `MockUSDC.json` in this directory is
> currently a leftover from a prior export rather than something
> `export-abis` will refresh; it will not be regenerated on the next run
> unless `exportAbis.ts` is updated to include it.

## SVM — `artifacts/svm/*.json`

Raw Anchor IDLs copied from `SVM/oku-programs/target/idl/`.

Exported programs (1):

| File | Purpose |
|------|---------|
| `lite_psm.json` | PSM (buffer-only — no redemption queue) + yield ops + compliance — single-token OkuM design with ScaledUiAmount extension (sole user-facing mint/burn surface in v1) |

> The program name `lite_psm` (and file name `lite_psm.json`) is unchanged and
> **does not track** the EVM-side rename of `LitePSM` to `SubscriptionModule`
> — SVM has no equivalent rename. SVM only ever had the single-token OkuM
> design; there is no SVM counterpart to EVM's `USDOku`/`USDOkuWrapper`, so
> nothing on this side changed as a result of the EVM two-token refactor.
>
> `oku_bridge_router.json` was removed in the noBridge refactor along
> with the EVM-side bridge artifacts (see note above). `oku_dollar.json`
> was removed in the single-token refactor (the vault program no longer
> exists; OkuM is now the sole mint managed by `lite-psm`). The
> redemption queue was subsequently removed entirely (buffer-only PSM
> — reverts `InsufficientBuffer` instead of escrowing). v1 cross-chain
> transfers are mint/burn orchestrated off-chain on both sides.

**Refresh:**

```bash
cd SVM/oku-programs
anchor build          # regenerate target/idl/*.json
npm run export-idls   # copy into ../../artifacts/svm/
```

## Current canonical deployments

See `/addresses.json` at the repo root for the addresses these ABIs / IDLs are
deployed at on each network. **As of this writing `addresses.json` still has
stale entries from the retired single-token layout** (keyed `okuMoney` /
`okuDollar` / `litePSM`) pending a fresh deploy of the current
`OkuM`/`USDOku`/`USDOkuWrapper`/`SubscriptionModule` set — see `TRACKER.md`
for status. Don't wire up against it until that's resolved.

## Usage examples

### TypeScript (ethers v6) — EVM

```ts
import OkuM from "okumoney-contracts/artifacts/evm/OkuM.json";
import USDOku from "okumoney-contracts/artifacts/evm/USDOku.json";
import deploymentAddresses from "okumoney-contracts/addresses.json";
import { Contract, JsonRpcProvider } from "ethers";

// Look up the current address per network from addresses.json
// rather than hardcoding it here -- addresses change on redeploy.
// NOTE: the contract keys below (okuM, usdOku) are the current naming
// convention; addresses.json has not yet been refreshed post-refactor
// (see "Current canonical deployments" above) so these keys may not
// exist there until that redeploy lands.
const { rpcUrl, contracts } = deploymentAddresses.evm.baseSepolia;
const provider = new JsonRpcProvider(rpcUrl);
const okuM = new Contract(contracts.okuM, OkuM.abi, provider);
const usdOku = new Contract(contracts.usdOku, USDOku.abi, provider);
```

### TypeScript (@anchor-lang/core) — SVM

```ts
import idl from "okumoney-contracts/artifacts/svm/lite_psm.json";
import { Program } from "@anchor-lang/core";

// `provider` is an AnchorProvider bound to a Solana connection + wallet.
// The IDL's `address` field is rewritten to the deployed program ID;
// see SVM/oku-programs/scripts/deploy/lib/programs.ts::loadIdlWithAddress.
const program = new Program(idl as any, provider);
```
