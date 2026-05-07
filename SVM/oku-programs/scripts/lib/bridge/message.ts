/**
 * Canonical 80-byte BridgeRequest encoding for OkuMoney's native bridge.
 *
 * The on-chain Rust program `lite-psm` uses *two* distinct 80-byte layouts
 * sharing the same total length:
 *
 *   SVM-burn → EVM-mint  (built by `instructions::bridge::bridge_burn`):
 *     2  source_chain_id   (u16  LE)
 *     2  dest_chain_id     (u16  LE)
 *    32  sender            (Solana pubkey)
 *    20  recipient         (EVM address)
 *     8  amount            (u64  LE, 6 decimals)
 *     8  nonce             (u64  LE)
 *     8  deadline          (i64  LE, unix seconds)
 *
 *   EVM-burn → SVM-mint  (parsed by `instructions::bridge::bridge_mint`,
 *                          declared as `BridgeRequest::to_message_bytes`):
 *     2  source_chain_id   (u16  LE)
 *     2  dest_chain_id     (u16  LE)
 *    20  sender            (EVM address)
 *    32  recipient         (Solana pubkey)
 *     8  amount            (u64  LE, 6 decimals)
 *     8  nonce             (u64  LE)
 *     8  deadline          (i64  LE, unix seconds)
 *
 * `request_id` is always `keccak256(message_bytes)`.
 *
 * This module is the single source of truth for both formats. All TypeScript
 * code (deploy scripts, tests, off-chain orchestrator) must import these
 * functions; do NOT inline buffer construction at call sites — drift between
 * the JS and Rust layouts is the most dangerous category of bug in the bridge
 * code path.
 */

import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

export const BRIDGE_MESSAGE_LEN = 80;
export const BRIDGE_SIGNATURE_LEN = 64;
export const BRIDGE_REQUEST_ID_LEN = 32;

// ----------------------------------------------------------------------
// Common helpers
// ----------------------------------------------------------------------

function toU64Bigint(x: number | bigint): bigint {
  const v = typeof x === 'bigint' ? x : BigInt(x);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  return v;
}

function toI64Bigint(x: number | bigint): bigint {
  const v = typeof x === 'bigint' ? x : BigInt(x);
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (v < min || v > max) {
    throw new Error(`i64 out of range: ${v}`);
  }
  return v;
}

function toU16(x: number): number {
  if (!Number.isInteger(x) || x < 0 || x > 0xffff) {
    throw new Error(`u16 out of range: ${x}`);
  }
  return x;
}

// ----------------------------------------------------------------------
// SVM-burn → EVM-mint
// ----------------------------------------------------------------------

export interface BridgeBurnMessage {
  /** Source chain ID (this Solana cluster's protocol ID, e.g. 103). */
  sourceChainId: number;
  /** Destination chain ID (EVM target). */
  destChainId: number;
  /** Solana pubkey of the burning user. */
  sender: PublicKey;
  /** EVM recipient address (20 raw bytes; pass without 0x prefix or padding). */
  recipient: Uint8Array;
  /** Net amount AFTER bridge-fee deduction, 6-decimal units. */
  amount: bigint | number;
  /** Sequential bridge nonce (per destination chain). */
  nonce: bigint | number;
  /** Unix-second deadline, mirrors the on-chain `i64`. */
  deadline: bigint | number;
}

/**
 * Serialize an SVM-burn → EVM-mint message exactly the way the on-chain
 * `bridge_burn` instruction does.
 */
export function serializeBurnMessage(req: BridgeBurnMessage): Buffer {
  if (req.recipient.length !== 20) {
    throw new Error(
      `recipient must be 20 bytes (got ${req.recipient.length})`
    );
  }
  const buf = Buffer.alloc(BRIDGE_MESSAGE_LEN);
  let off = 0;
  buf.writeUInt16LE(toU16(req.sourceChainId), off); off += 2;
  buf.writeUInt16LE(toU16(req.destChainId),   off); off += 2;
  req.sender.toBuffer().copy(buf, off);             off += 32;
  Buffer.from(req.recipient).copy(buf, off);        off += 20;
  buf.writeBigUInt64LE(toU64Bigint(req.amount),     off); off += 8;
  buf.writeBigUInt64LE(toU64Bigint(req.nonce),      off); off += 8;
  buf.writeBigInt64LE(toI64Bigint(req.deadline),    off);
  return buf;
}

export interface ParsedBurnMessage extends BridgeBurnMessage {
  /** Raw 80-byte message bytes. */
  bytes: Buffer;
  /** keccak256(bytes) — the on-chain request_id. */
  requestId: Buffer;
}

/** Parse the same wire format. Useful for round-trip tests. */
export function parseBurnMessage(bytes: Buffer | Uint8Array): ParsedBurnMessage {
  const b = Buffer.from(bytes);
  if (b.length !== BRIDGE_MESSAGE_LEN) {
    throw new Error(
      `expected ${BRIDGE_MESSAGE_LEN} bytes, got ${b.length}`
    );
  }
  const sourceChainId = b.readUInt16LE(0);
  const destChainId   = b.readUInt16LE(2);
  const sender        = new PublicKey(b.subarray(4, 36));
  const recipient     = b.subarray(36, 56);
  const amount        = b.readBigUInt64LE(56);
  const nonce         = b.readBigUInt64LE(64);
  const deadline      = b.readBigInt64LE(72);
  return {
    sourceChainId,
    destChainId,
    sender,
    recipient: new Uint8Array(recipient),
    amount,
    nonce,
    deadline,
    bytes: b,
    requestId: Buffer.from(keccak_256(b)),
  };
}

// ----------------------------------------------------------------------
// EVM-burn → SVM-mint
// ----------------------------------------------------------------------

export interface BridgeMintMessage {
  /** Source chain ID (EVM cluster's protocol ID). */
  sourceChainId: number;
  /** Destination chain ID (this Solana cluster's protocol ID). */
  destChainId: number;
  /** EVM sender address (20 raw bytes; pass without 0x prefix or padding). */
  sender: Uint8Array;
  /** Solana pubkey of the minting recipient. */
  recipient: PublicKey;
  /** Net amount, 6-decimal units. */
  amount: bigint | number;
  /** Sequential bridge nonce as emitted by the EVM `BridgeBurn` event. */
  nonce: bigint | number;
  /** Unix-second deadline, mirrors the on-chain `i64`. */
  deadline: bigint | number;
}

/**
 * Serialize an EVM-burn → SVM-mint message exactly the way the on-chain
 * `BridgeRequest::to_message_bytes` does. This is the format the on-chain
 * `bridge_mint` instruction parses.
 */
export function serializeMintMessage(req: BridgeMintMessage): Buffer {
  if (req.sender.length !== 20) {
    throw new Error(
      `sender must be 20 bytes (got ${req.sender.length})`
    );
  }
  const buf = Buffer.alloc(BRIDGE_MESSAGE_LEN);
  let off = 0;
  buf.writeUInt16LE(toU16(req.sourceChainId), off); off += 2;
  buf.writeUInt16LE(toU16(req.destChainId),   off); off += 2;
  Buffer.from(req.sender).copy(buf, off);           off += 20;
  req.recipient.toBuffer().copy(buf, off);          off += 32;
  buf.writeBigUInt64LE(toU64Bigint(req.amount),     off); off += 8;
  buf.writeBigUInt64LE(toU64Bigint(req.nonce),      off); off += 8;
  buf.writeBigInt64LE(toI64Bigint(req.deadline),    off);
  return buf;
}

export interface ParsedMintMessage extends BridgeMintMessage {
  bytes: Buffer;
  requestId: Buffer;
}

export function parseMintMessage(bytes: Buffer | Uint8Array): ParsedMintMessage {
  const b = Buffer.from(bytes);
  if (b.length !== BRIDGE_MESSAGE_LEN) {
    throw new Error(
      `expected ${BRIDGE_MESSAGE_LEN} bytes, got ${b.length}`
    );
  }
  const sourceChainId = b.readUInt16LE(0);
  const destChainId   = b.readUInt16LE(2);
  const sender        = b.subarray(4, 24);
  const recipient     = new PublicKey(b.subarray(24, 56));
  const amount        = b.readBigUInt64LE(56);
  const nonce         = b.readBigUInt64LE(64);
  const deadline      = b.readBigInt64LE(72);
  return {
    sourceChainId,
    destChainId,
    sender: new Uint8Array(sender),
    recipient,
    amount,
    nonce,
    deadline,
    bytes: b,
    requestId: Buffer.from(keccak_256(b)),
  };
}

// ----------------------------------------------------------------------
// Request-id helper
// ----------------------------------------------------------------------

/** Compute keccak256(message_bytes) — the canonical request_id. */
export function computeRequestId(messageBytes: Buffer | Uint8Array): Buffer {
  return Buffer.from(keccak_256(messageBytes));
}
