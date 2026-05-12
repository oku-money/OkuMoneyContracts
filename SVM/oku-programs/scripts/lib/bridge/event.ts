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
 *
 * Casing note: Anchor 1.x normalises event names in `target/types/*.ts`
 * to camelCase (`bridgeBurnEvent`), while the raw IDL JSON in
 * `target/idl/*.json` keeps PascalCase (`BridgeBurnEvent`). The caller
 * may pass either; we compare with both casings.
 */
export function findEventsInLogs<T = any>(
  meta: ConfirmedTransactionMeta | null | undefined,
  idl: Idl,
  eventName: string
): T[] {
  if (!meta || !meta.logMessages) return [];
  const coder = new BorshCoder(idl);
  const out: T[] = [];
  const camel = eventName.length > 0
    ? eventName.charAt(0).toLowerCase() + eventName.slice(1)
    : eventName;
  const pascal = eventName.length > 0
    ? eventName.charAt(0).toUpperCase() + eventName.slice(1)
    : eventName;
  for (const line of meta.logMessages) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    const decoded: DecodedEvent | null = coder.events.decode(b64) as any;
    if (decoded && (decoded.name === eventName || decoded.name === camel || decoded.name === pascal)) {
      out.push(decoded.data as T);
    }
  }
  return out;
}

export interface BridgeBurnEventDecoded {
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
}

/**
 * Normalise the raw decoded Anchor event into native JS types. Handles
 * both casings (Anchor 1.x generates camelCase in target/types/*.ts but
 * the raw IDL JSON has snake_case field names — the BorshCoder
 * passes through whichever casing the IDL declares).
 */
function normaliseBurnEvent(ev: any): BridgeBurnEventDecoded {
  const toByteArray = (v: any): number[] => {
    if (Array.isArray(v)) return v as number[];
    if (v && typeof v.toBuffer === 'function') return Array.from(v.toBuffer() as Buffer);
    return Array.from(v as Uint8Array);
  };
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (ev[k] !== undefined) return ev[k];
    }
    return undefined;
  };
  const user = pick('user');
  return {
    requestId: toByteArray(pick('requestId', 'request_id')),
    user: user?.toBase58 ? user.toBase58() : String(user),
    recipient: toByteArray(pick('recipient')),
    sourceChainId: Number(pick('sourceChainId', 'source_chain_id')),
    destinationChain: Number(pick('destinationChain', 'destination_chain')),
    amount: BigInt(pick('amount')?.toString?.() ?? pick('amount')),
    nonce: BigInt(pick('nonce')?.toString?.() ?? pick('nonce')),
    deadline: BigInt(pick('deadline')?.toString?.() ?? pick('deadline')),
    dollarValue: BigInt(pick('dollarValue', 'dollar_value')?.toString?.() ?? pick('dollarValue', 'dollar_value')),
    feeAmount: BigInt(pick('feeAmount', 'fee_amount')?.toString?.() ?? pick('feeAmount', 'fee_amount')),
  };
}

/**
 * Bankrun-friendly variant: takes a log-line array directly (typically
 * `meta.logMessages` from `banksClient.processTransaction`). No
 * `Connection` round-trip needed. Throws if none found.
 */
export function findBridgeBurnEventInLogs(
  logs: string[] | undefined | null,
  idl: Idl
): BridgeBurnEventDecoded {
  const events = findEventsInLogs({ logMessages: logs ?? [] } as any, idl, 'BridgeBurnEvent');
  if (events.length === 0) {
    throw new Error(
      `BridgeBurnEvent not found in tx logs. Logs:\n${(logs ?? []).join('\n')}`
    );
  }
  return normaliseBurnEvent(events[0]);
}

/**
 * Find the first `BridgeBurnEvent` emitted by the lite-psm program in the
 * supplied transaction signature. Throws if none found.
 *
 * Validator-mode helper: uses `connection.getTransaction`. For bankrun,
 * use `findBridgeBurnEventInLogs` directly off `meta.logMessages`.
 */
export async function fetchBridgeBurnEvent(
  connection: Connection,
  txSignature: string,
  idl: Idl
): Promise<BridgeBurnEventDecoded> {
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
  return normaliseBurnEvent(events[0]);
}
