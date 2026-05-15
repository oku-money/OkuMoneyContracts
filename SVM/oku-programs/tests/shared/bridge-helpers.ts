/**
 * Bridge-test helpers — Ed25519 signing, message serialisation, and
 * tx-construction utilities shared by the bridge_security and
 * oku-bridge-router suites.
 *
 * The canonical wire format lives in `scripts/lib/bridge/message.ts`:
 *   - `serializeMintMessage` for EVM-burn -> SVM-mint (20-byte EVM
 *     sender, 32-byte Solana recipient).
 *   - `serializeBurnMessage` for SVM-burn -> EVM-mint (32-byte Solana
 *     sender, 20-byte EVM recipient).
 *
 * These helpers wrap those encoders with the Ed25519 precompile +
 * `program.methods.bridgeMint(...)` instruction construction so test
 * files don't repeat 100+ LOC of boilerplate.
 */

import { Program, BN } from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import * as nacl from "tweetnacl";
import { serializeMintMessage } from "../../scripts/lib/bridge";
import type { BankrunHarness } from "./bankrun";

// ---------------------------------------------------------------------------
// Pure helpers (no harness state required)
// ---------------------------------------------------------------------------

/** keccak256 of an arbitrary buffer. The on-chain `bridge_mint` derives
 *  `request_id = keccak256(message_bytes)`; this is the TS twin. */
export function calculateRequestId(message: Buffer | Uint8Array): Uint8Array {
  return keccak_256(message);
}

/** Detached Ed25519 signature with `keypair`'s secret key. */
export function signMessage(message: Buffer | Uint8Array, keypair: Keypair): Uint8Array {
  return nacl.sign.detached(message, keypair.secretKey);
}

/** Cryptographically random 20-byte EVM address. */
export function randomEvmAddress(): Uint8Array {
  const addr = new Uint8Array(20);
  crypto.getRandomValues(addr);
  return addr;
}

/**
 * EVM-burn -> SVM-mint message encoder. Thin wrapper around the
 * canonical `serializeMintMessage` from `scripts/lib/bridge/message.ts`
 * that accepts the Solana recipient as a `PublicKey` directly (the
 * canonical encoder also accepts `PublicKey`, but the test files use a
 * named `recipientWallet` argument and we keep the legacy parameter
 * name to avoid widespread call-site churn).
 */
export function serializeBridgeMintMessage(params: {
  sourceChainId: number;
  destinationChainId: number;
  sender: Uint8Array;
  recipientWallet: PublicKey;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}): Buffer {
  return serializeMintMessage({
    sourceChainId: params.sourceChainId,
    destChainId: params.destinationChainId,
    sender: params.sender,
    recipient: params.recipientWallet,
    amount: params.amount,
    nonce: params.nonce,
    deadline: params.deadline,
  });
}

// ---------------------------------------------------------------------------
// Context-bearing helpers (need program + PDA pubkeys)
// ---------------------------------------------------------------------------

export interface BridgeTestContext {
  h: BankrunHarness;
  program: Program<any>;
  configPda: PublicKey;
  bridgeConfigPda: PublicKey;
  okuMoneyMint: PublicKey;
}

/**
 * Build a `bridge_mint` transaction (Ed25519 precompile + bridge_mint
 * instruction). The Ed25519 ix MUST come first; the on-chain
 * `verify_ed25519_signature` reads it via sysvar introspection at
 * fixed index 0.
 */
export async function createBridgeMintTx(
  ctx: BridgeTestContext,
  params: {
    message: Buffer;
    signature: Uint8Array;
    orchestrator: Keypair;
    recipientWallet: PublicKey;
    payer: Keypair;
    requestId: Uint8Array;
  }
): Promise<Transaction> {
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: params.orchestrator.publicKey.toBytes(),
    message: new Uint8Array(params.message),
    signature: params.signature,
  });

  const [processedRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_request"), Buffer.from(params.requestId)],
    ctx.program.programId
  );
  const recipientAta = getAssociatedTokenAddressSync(
    ctx.okuMoneyMint,
    params.recipientWallet,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Surface a clear error if the test forgot to pre-create the ATA.
  try {
    await getAccount(
      ctx.h.provider.connection as any,
      recipientAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  } catch {
    throw new Error(
      `Recipient ATA ${recipientAta.toString()} does not exist. Create it in the test setup.`
    );
  }

  const bridgeMintIx = await ctx.program.methods
    .bridgeMint(
      params.message,
      Buffer.from(params.signature),
      Array.from(params.requestId)
    )
    .accountsPartial({
      payer: params.payer.publicKey,
      bridgeConfig: ctx.bridgeConfigPda,
      config: ctx.configPda,
      processedRequest: processedRequestPda,
      okuMoneyMint: ctx.okuMoneyMint,
      recipientOkuMoneyAta: recipientAta,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction();
  tx.add(ed25519Ix); // MUST come first
  tx.add(bridgeMintIx);
  return tx;
}

/**
 * Submit a `bridge_burn` via `banksClient.processTransaction` and
 * return the program logs. The Anchor instruction-builder's `.rpc()`
 * path goes through `BankrunProvider.sendAndConfirm` which discards
 * the tx meta on success; this helper takes the longer route so the
 * caller can decode `BridgeBurnEvent` from the logs.
 */
export async function bridgeBurnAndGetLogs(
  ctx: BridgeTestContext,
  params: {
    user: Keypair;
    payer: Keypair;
    userOkuMoneyAta: PublicKey;
    feeRecipientAta: PublicKey;
    burnAmount: BN;
    evmRecipient: Uint8Array;
    destChain: number;
  }
): Promise<string[]> {
  const [noncePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_nonce"), Buffer.from([params.destChain, 0])],
    ctx.program.programId
  );
  const ix = await ctx.program.methods
    .bridgeBurn(params.burnAmount, Array.from(params.evmRecipient), params.destChain)
    .accountsPartial({
      user: params.user.publicKey,
      bridgeConfig: ctx.bridgeConfigPda,
      config: ctx.configPda,
      bridgeNonce: noncePda,
      okuMoneyMint: ctx.okuMoneyMint,
      userOkuMoneyAta: params.userOkuMoneyAta,
      feeRecipientAta: params.feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction().add(ix);
  const blockhashRes = await ctx.h.context.banksClient.getLatestBlockhash();
  if (!blockhashRes) throw new Error("bankrun returned null blockhash");
  tx.recentBlockhash = blockhashRes[0];
  tx.feePayer = params.payer.publicKey;
  tx.sign(params.payer, params.user);
  const meta = await ctx.h.context.banksClient.processTransaction(tx);
  return meta.logMessages;
}

/**
 * Submit a (typically Ed25519-wrapped) `Transaction` via bankrun's
 * `tryProcessTransaction` and assert that the program rejects with
 * `expectedCode`. Bankrun returns the result+meta alongside the error
 * string instead of throwing; this helper inspects both.
 */
export async function expectBridgeMintProgramError(
  ctx: BridgeTestContext,
  tx: Transaction,
  signers: Keypair[],
  expectedCode: string
): Promise<void> {
  const blockhashRes = await ctx.h.context.banksClient.getLatestBlockhash();
  if (!blockhashRes) throw new Error("bankrun returned null blockhash");
  tx.recentBlockhash = blockhashRes[0];
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const res = await ctx.h.context.banksClient.tryProcessTransaction(tx);
  const errStr = res.result;
  const logs = res.meta?.logMessages ?? [];

  if (!errStr) {
    throw new Error(
      `Expected on-chain failure matching "${expectedCode}" but transaction succeeded.\n` +
        `Logs:\n  ${logs.join("\n  ")}`
    );
  }
  const haystack = [errStr, ...logs].join(" ");
  if (!haystack.includes(expectedCode)) {
    throw new Error(
      `Expected on-chain error to match "${expectedCode}" but got:\n` +
        `  result: ${errStr}\n` +
        `  logs:\n    ${logs.join("\n    ")}`
    );
  }
}

/**
 * Anchor-friendly `expectError`: searches the full surface of err
 * shapes (errorCode.code, errorMessage, toString, logs) so the assertion
 * works whether the program threw an Anchor structured error or
 * bankrun's `SendTransactionError`.
 */
export async function expectError(
  fn: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await fn();
    throw new Error("Expected error but transaction succeeded");
  } catch (err: any) {
    if (err.message === "Expected error but transaction succeeded") throw err;
    const parts: string[] = [];
    if (err.error?.errorCode?.code) parts.push(err.error.errorCode.code);
    if (err.error?.errorMessage) parts.push(err.error.errorMessage);
    parts.push(err.toString());
    if (err.logs) parts.push((err.logs as string[]).join(" "));
    const haystack = parts.join(" ");
    if (!haystack.includes(expectedCode)) {
      throw new Error(
        `Expected error matching "${expectedCode}" but got: ${haystack.slice(0, 400)}`
      );
    }
  }
}
