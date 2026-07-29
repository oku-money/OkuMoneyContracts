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

Exported programs (1):

| File | Purpose |
|------|---------|
| `lite_psm.json` | PSM (buffer-only — no redemption queue) + yield ops + compliance — single-token OkuM design with ScaledUiAmount extension (sole user-facing mint/burn surface in v1) |

> `oku_bridge_router.json` was removed in the noBridge refactor along
> with the EVM-side bridge artifacts (see note above). `oku_dollar.json`
> was removed in the single-token refactor (the vault program no longer
> exists; OkuM is now the sole mint managed by `lite-psm`). The
> redemption queue was subsequently removed entirely (buffer-only PSM
> — reverts `InsufficientBuffer` instead of escrowing). v1 cross-chain
> transfers are PSM-mediated mint/burn orchestrated off-chain on both
> sides.

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

// bscTestnet / baseSepolia OkuMoney (see testnet-addresses.json for all chains)
const provider = new JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545/");
const addr = "0xe548f960EbB46f9DC504e4107A552309796c863b";
const okuMoney = new Contract(addr, OkuMoney.abi, provider);
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
