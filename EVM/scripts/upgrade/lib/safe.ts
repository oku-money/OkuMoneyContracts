/**
 * Safe Transaction Builder batch files.
 *
 * Import the generated `*.safe.json` in the Safe{Wallet} UI (Apps -> Transaction
 * Builder -> drag the file in). Every transaction is a plain call with explicit
 * calldata, so the UI shows exactly what will be signed; no ABI is needed.
 * Signers should check each `to` against the address book and each `data`
 * against the proposal file before signing.
 */

export interface SafeTx {
  to: string;
  value: string;
  data: string;
}

export interface SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
  };
  transactions: Array<SafeTx & { contractMethod: null; contractInputsValues: null }>;
}

export function buildSafeBatch(args: {
  chainId: bigint | number;
  safe: string;
  name: string;
  description: string;
  txs: SafeTx[];
}): SafeBatch {
  return {
    version: "1.0",
    chainId: args.chainId.toString(),
    createdAt: Date.now(),
    meta: {
      name: args.name,
      description: args.description,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: args.safe,
      createdFromOwnerAddress: "",
    },
    transactions: args.txs.map((t) => ({ ...t, contractMethod: null, contractInputsValues: null })),
  };
}
