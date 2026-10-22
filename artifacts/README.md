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

Exported by `export-abis` (3 production contracts):

| File | Purpose |
|------|---------|
| `OkuMoney.json` | Non-rebasing base token (OkuM) |
| `OkuDollar.json` | Rebasing $1-pegged stablecoin (usdOku) |
| `LitePSM.json` | USDC ↔ OkuM peg stability module (sole user-facing mint/burn surface in v1) |

There is no `MockUSDC.json`: the testnet mock USDC (6-decimal, open `mint`) is not
exported. It is a standard ERC-20, so any ERC-20 ABI works; the source is
`EVM/test/mocks/MockUSDC.sol`.

There are no bridge artifacts: v1 has no on-chain bridge on either stack
([`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated)).

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
| `lite_psm.json` | Buffer-backed PSM + yield rate schedule + compliance + direct mint/burn — single-token OkuM with the ScaledUiAmount extension (sole user-facing mint/burn surface in v1) |

`lite_psm` is the **only** SVM program: no bridge or vault program; `OkuM` is the
sole mint and its `ScaledUiAmount` extension supplies the $1-pegged display.
Error codes are positional, so match on names or regenerate after any program
change. See [`../SVM/README.md`](../SVM/README.md).

**Refresh:**

```bash
cd SVM/oku-programs
anchor build          # regenerate target/idl/*.json
npm run export-idls   # copy into ../../artifacts/svm/
```

## Current canonical deployments

See `/testnet-addresses.json` at the repo root for the addresses these ABIs / IDLs are deployed at on each network (EVM v0.4 on sepolia, baseSepolia, arbSepolia, bscTestnet, opSepolia; SVM devnet `lite_psm` `FxTLKSUPmuUJWQZ7EaYHkpcvAg3h4HZvmnUhhPCD5DwW`).

## Usage examples

### TypeScript (ethers v6) — EVM

```ts
import OkuMoney from "okumoney-contracts/artifacts/evm/OkuMoney.json";
import testnetAddresses from "okumoney-contracts/testnet-addresses.json";
import { Contract, JsonRpcProvider } from "ethers";

// Look up the current address per network from testnet-addresses.json
// rather than hardcoding it here -- addresses change on redeploy.
const { rpcUrl, contracts } = testnetAddresses.evm.baseSepolia;
const provider = new JsonRpcProvider(rpcUrl);
const okuMoney = new Contract(contracts.okuMoney, OkuMoney.abi, provider);
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
