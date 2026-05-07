/**
 * Helpers for parsing the on-chain `BridgeBurnEvent` from a confirmed Solana
 * transaction. Anchor emits each event as a base64-encoded `Program data: ...`
 * log line; we leverage `program.coder.events.decode` to deserialize.
 *
 * Why this exists: the bridge-burn flow MUST take the event-emitted values
 * (nonce, deadline, fee, request_id) verbatim. Recomputing locally with
 * `Date.now()` and `bridgeNonce.nextNonce - 1` is racy on devnet (clock skew,
 * concurrent burns) and silently produces request_ids that the on-chain code
 * never emitted, so the EVM relayer cannot match them.
 */

import { BorshCoder, Idl } from '@anchor-lang/core';
import { ConfirmedTransactionMeta, Connection, VersionedTransactionResponse } from '@solana/web3.js';

const PROGRAM_DATA_PREFIX = 'Program data: ';

export interface DecodedEvent<T = any> {
  name: string;
  data: T;
}

/**
 * Iterate the program-data log lines of a transaction and return all decoded
 * events that match `eventName`. Anchor 1.x's coder does the discriminator
 * matching for us — events that don't belong to this IDL are returned with
 * `null` from `decode` and skipped.
 */
export function findEventsInLogs<T = any>(
  meta: ConfirmedTransactionMeta | null | undefined,
  idl: Idl,
  eventName: string
): T[] {
  if (!meta || !meta.logMessages) return [];
  const coder = new BorshCoder(idl);
  const out: T[] = [];
  for (const line of meta.logMessages) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    const decoded: DecodedEvent | null = coder.events.decode(b64) as any;
    if (decoded && decoded.name === eventName) {
      out.push(decoded.data as T);
    }
  }
  return out;
}

/**
 * Find the first `BridgeBurnEvent` emitted by the lite-psm program in the
 * supplied transaction signature. Throws if none found.
 */
export async function fetchBridgeBurnEvent(
  connection: Connection,
  txSignature: string,
  idl: Idl
): Promise<{
  requestId: number[];
  user: string;
  recipient: number[];
  sourceChainId: number;
  destinationChain: number;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  dollarValue: bigint;
  feeAmount: bigint;
}> {
  await connection.confirmTransaction(txSignature, 'confirmed');
  const tx: VersionedTransactionResponse | null = await connection.getTransaction(
    txSignature,
    {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }
  );
  if (!tx || !tx.meta) {
    throw new Error(`Transaction ${txSignature} not found or has no meta`);
  }
  const events = findEventsInLogs(tx.meta, idl, 'BridgeBurnEvent');
  if (events.length === 0) {
    throw new Error(
      `BridgeBurnEvent not found in tx ${txSignature}. ` +
        `Logs:\n${(tx.meta.logMessages ?? []).join('\n')}`
    );
  }
  // Anchor's BorshCoder hands back BN/Buffer/PublicKey-typed values; normalise
  // to JS-native types for the burn-script consumer.
  const ev: any = events[0];
  const toByteArray = (v: any): number[] => {
    if (Array.isArray(v)) return v as number[];
    if (v && typeof v.toBuffer === 'function') return Array.from(v.toBuffer() as Buffer);
    return Array.from(v as Uint8Array);
  };
  return {
    requestId: toByteArray(ev.requestId),
    user: ev.user?.toBase58 ? ev.user.toBase58() : String(ev.user),
    recipient: toByteArray(ev.recipient),
    sourceChainId: Number(ev.sourceChainId),
    destinationChain: Number(ev.destinationChain),
    amount: BigInt(ev.amount?.toString?.() ?? ev.amount),
    nonce: BigInt(ev.nonce?.toString?.() ?? ev.nonce),
    deadline: BigInt(ev.deadline?.toString?.() ?? ev.deadline),
    dollarValue: BigInt(ev.dollarValue?.toString?.() ?? ev.dollarValue),
    feeAmount: BigInt(ev.feeAmount?.toString?.() ?? ev.feeAmount),
  };
}
