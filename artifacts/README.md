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
  "contractName": "OkuMoney",
  "sourceName": "src/token/OkuMoney.sol",
  "abi": [ ... ],
  "bytecode": "0x...",
  "deployedBytecode": "0x..."
}
```

Exported contracts (5):

| File | Purpose |
|------|---------|
| `OkuMoney.json` | Non-rebasing base token (OkuM) |
| `OkuDollar.json` | Rebasing $1-pegged stablecoin (usdOku) |
| `LitePSM.json` | USDC ↔ OkuM peg stability module (sole user-facing mint/burn surface in v1) |
| `RedemptionQueue.json` | FIFO queue for PSM-buffer-depleted redemptions |
| `MockUSDC.json` | 6-decimal ERC-20 used on testnets |

> `OkuBridge.json`, `OkuBridgeRouter.json`, and `NttAdapter.json` were removed
> in the noBridge refactor. v1 cross-chain transfers are PSM-mediated
> mint/burn orchestrated off-chain. See `contracts/README.md` for the design.

**Refresh:**

```bash
cd EVM
npx hardhat compile   # regenerate artifacts/src/**/*.json
npm run export-abis   # slim + copy into ../artifacts/evm/
```

## SVM — `artifacts/svm/*.json`

Raw Anchor IDLs copied from `SVM/oku-programs/target/idl/`.

Exported programs (3):

| File | Purpose |
|------|---------|
| `lite_psm.json` | PSM + bridge + redemption queue + yield ops + compliance |
| `oku_dollar.json` | OkuDollar vault (wrap/unwrap OkuMoney → usdOku) |
| `oku_bridge_router.json` | Convenience CPI coordinator for single-tx user flows |

**Refresh:**

```bash
cd SVM/oku-programs
anchor build          # regenerate target/idl/*.json
npm run export-idls   # copy into ../../artifacts/svm/
```

## Current canonical deployments

See `/testnet-addresses.json` at the repo root for the addresses these ABIs / IDLs are deployed at on each network.

## Usage examples

### TypeScript (ethers v6) — EVM

```ts
import OkuMoney from "okumoney-contracts/artifacts/evm/OkuMoney.json";
import { Contract, JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.sepolia.org");
const addr = "0xe548f960EbB46f9DC504e4107A552309796c863b";
const okuMoney = new Contract(addr, OkuMoney.abi, provider);
```

### TypeScript (@coral-xyz/anchor) — SVM

```ts
import idl from "okumoney-contracts/artifacts/svm/lite_psm.json";
import { Program, AnchorProvider } from "@coral-xyz/anchor";

const program = new Program(idl as any, provider);
```
