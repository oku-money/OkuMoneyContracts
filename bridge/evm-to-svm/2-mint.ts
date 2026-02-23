#!/usr/bin/env ts-node
/**
 * evm-to-svm/2-mint.ts
 *
 * Step 2 of EVM → Solana bridge:
 *   - Reads pending/evm-to-svm.json written by step 1
 *   - Constructs the 80-byte SVM bridge message
 *   - Signs with Ed25519 orchestrator keypair
 *   - Builds a Solana transaction:
 *       ix0: Ed25519Program.createInstructionWithPublicKey (signature verification)
 *       ix1: bridge_mint (Anchor instruction)
 *   - Sends the transaction and waits for confirmation
 *   - Updates the handoff file: status = "completed"
 *
 * Required env vars:
 *   LITE_PSM_PROGRAM_ID            - Solana lite-psm program address
 *   OKUSD_MINT                     - OkuUSD Token-2022 mint address
 *
 * Optional env vars:
 *   SOLANA_RPC                     - Solana RPC URL (default: https://api.devnet.solana.com)
 *   SOLANA_ORCHESTRATOR_KEYPAIR    - Path to Ed25519 keypair JSON file
 *                                    (default: ~/.config/solana/id.json)
 *
 * Usage:
 *   LITE_PSM_PROGRAM_ID=<prog_id> \
 *   OKUSD_MINT=<mint_addr> \
 *   SOLANA_ORCHESTRATOR_KEYPAIR=~/.config/solana/id.json \
 *   ts-node evm-to-svm/2-mint.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import * as nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  getSolanaRpc,
  getSolanaOrchestratorKeypairPath,
  getLitePsmProgramId,
  getOkusdMint,
  EVM_TO_SVM_PENDING,
} from "../config";

// ============ Types ============

interface EvmToSvmHandoff {
  direction: "evm-to-svm";
  sourceTxHash: string;
  sourceChainId: number;
  destChainIdBridge: number;
  evmSender: string;
  solanaRecipient: string;
  shares: string;
  amount: string;
  nonce: string;
  deadline: number;
  status: "pending" | "completed" | "failed";
  destTxHash?: string;
}

// ============ Helpers ============

/** Load a Solana keypair from a JSON file (array of 64 bytes). */
function loadKeypair(filePath: string): Keypair {
  const expanded = filePath.replace(/^~/, process.env.HOME || "~");
  const raw = JSON.parse(fs.readFileSync(expanded, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Serialize the 80-byte bridge mint message exactly as verified by the SVM program.
 *
 * Layout (all little-endian):
 *   source_chain_id  u16   2 bytes
 *   dest_chain_id    u16   2 bytes
 *   sender           [u8;20] 20 bytes  (EVM address)
 *   recipient        [u8;32] 32 bytes  (Solana OkuUSD ATA pubkey)
 *   amount           u64   8 bytes
 *   nonce            u64   8 bytes
 *   deadline         i64   8 bytes
 *   ─────────────────────────────
 *   Total:                80 bytes
 */
function serializeBridgeMintMessage(params: {
  sourceChainId: number;
  destChainId: number;
  evmSenderHex: string; // "0x..." or bare hex, 20 bytes
  recipientAta: PublicKey; // Solana OkuUSD ATA
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}): Buffer {
  const buf = Buffer.alloc(80);
  let offset = 0;

  // chain IDs (u16 LE)
  offset = buf.writeUInt16LE(params.sourceChainId, offset);
  offset = buf.writeUInt16LE(params.destChainId, offset);

  // sender (20 bytes EVM address)
  const senderHex = params.evmSenderHex.replace(/^0x/, "");
  const senderBytes = Buffer.from(senderHex.padStart(40, "0"), "hex");
  if (senderBytes.length !== 20) {
    throw new Error(`Sender must be 20 bytes, got ${senderBytes.length}`);
  }
  senderBytes.copy(buf, offset);
  offset += 20;

  // recipient ATA (32 bytes Solana pubkey)
  const recipientBytes = params.recipientAta.toBytes();
  Buffer.from(recipientBytes).copy(buf, offset);
  offset += 32;

  // amount (u64 LE)
  offset = Number(buf.writeBigUInt64LE(params.amount, offset));

  // nonce (u64 LE)
  offset = Number(buf.writeBigUInt64LE(params.nonce, offset));

  // deadline (i64 LE)
  buf.writeBigInt64LE(params.deadline, offset);

  if (buf.length !== 80) {
    throw new Error(`Message should be 80 bytes, got ${buf.length}`);
  }

  return buf;
}

/** Compute request_id = keccak256(message) — must match SVM keccak derivation. */
function computeRequestId(message: Buffer): Buffer {
  // Use @noble/hashes keccak_256
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { keccak_256 } = require("@noble/hashes/sha3") as {
    keccak_256: (data: Uint8Array) => Uint8Array;
  };
  return Buffer.from(keccak_256(new Uint8Array(message)));
}

/** Derive ProcessedRequest PDA: seeds = ["bridge_request", request_id] */
function deriveProcessedRequestPDA(
  programId: PublicKey,
  requestId: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_request"), requestId],
    programId
  );
}

// ============ Main ============

async function main() {
  // Load handoff file
  if (!fs.existsSync(EVM_TO_SVM_PENDING)) {
    console.error(`Handoff file not found: ${EVM_TO_SVM_PENDING}`);
    console.error("Run evm-to-svm/1-burn.ts first.");
    process.exit(1);
  }

  const handoff: EvmToSvmHandoff = JSON.parse(
    fs.readFileSync(EVM_TO_SVM_PENDING, "utf-8")
  );

  if (handoff.status !== "pending") {
    console.error(`Handoff status is "${handoff.status}", expected "pending".`);
    process.exit(1);
  }

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > handoff.deadline) {
    console.error(
      `Handoff deadline has passed (${new Date(handoff.deadline * 1000).toISOString()}).` +
        " Re-run step 1 to create a fresh burn."
    );
    process.exit(1);
  }

  console.log("=== EVM → Solana Bridge: Step 2 (Mint) ===");
  console.log(`Source tx:        ${handoff.sourceTxHash}`);
  console.log(`Source chain:     ${handoff.sourceChainId}`);
  console.log(`EVM sender:       ${handoff.evmSender}`);
  console.log(`Solana recipient: ${handoff.solanaRecipient}`);
  console.log(`Amount:           ${handoff.amount} (raw)`);
  console.log(`Nonce:            ${handoff.nonce}`);
  console.log(`Deadline:         ${new Date(handoff.deadline * 1000).toISOString()}`);
  console.log("");

  const solanaRpc = getSolanaRpc();
  const orchestratorPath = getSolanaOrchestratorKeypairPath();
  const programIdStr = getLitePsmProgramId();
  const okusdMintStr = getOkusdMint();

  // Connect
  const connection = new Connection(solanaRpc, "confirmed");
  const orchestrator = loadKeypair(orchestratorPath);
  const programId = new PublicKey(programIdStr);
  const okusdMint = new PublicKey(okusdMintStr);
  const recipientWallet = new PublicKey(handoff.solanaRecipient);

  console.log(`Solana RPC:         ${solanaRpc}`);
  console.log(`Orchestrator:       ${orchestrator.publicKey.toBase58()}`);
  console.log(`Program ID:         ${programId.toBase58()}`);
  console.log(`OkuUSD Mint:        ${okusdMint.toBase58()}`);
  console.log(`Recipient wallet:   ${recipientWallet.toBase58()}`);

  // Derive recipient's OkuUSD ATA (Token-2022)
  const recipientAta = getAssociatedTokenAddressSync(
    okusdMint,
    recipientWallet,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`Recipient ATA:      ${recipientAta.toBase58()}`);

  // Derive standard PDAs
  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config")],
    programId
  );
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    programId
  );
  console.log(`PSM Config PDA:     ${psmConfig.toBase58()}`);
  console.log(`Bridge Config PDA:  ${bridgeConfig.toBase58()}`);
  console.log("");

  // Build the 80-byte message
  const message = serializeBridgeMintMessage({
    sourceChainId: handoff.sourceChainId,
    destChainId: handoff.destChainIdBridge,
    evmSenderHex: handoff.evmSender,
    recipientAta,
    amount: BigInt(handoff.amount),
    nonce: BigInt(handoff.nonce),
    deadline: BigInt(handoff.deadline),
  });

  console.log(`Message (hex): ${message.toString("hex")}`);

  // Compute request_id
  const requestId = computeRequestId(message);
  console.log(`Request ID:    ${requestId.toString("hex")}`);

  // Sign with Ed25519
  const signature = nacl.sign.detached(
    new Uint8Array(message),
    orchestrator.secretKey
  );
  console.log(`Signature:     ${Buffer.from(signature).toString("hex").slice(0, 32)}...`);

  // Derive ProcessedRequest PDA
  const [processedRequestPda] = deriveProcessedRequestPDA(programId, requestId);
  console.log(`ProcessedRequest PDA: ${processedRequestPda.toBase58()}`);

  // Ensure recipient ATA exists; create it if needed
  const provider = new AnchorProvider(connection, new Wallet(orchestrator), {
    commitment: "confirmed",
  });

  let ataExists = false;
  try {
    await getAccount(connection, recipientAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    ataExists = true;
    console.log("Recipient ATA already exists.");
  } catch {
    console.log("Recipient ATA does not exist — will create it.");
  }

  // Load lite-psm IDL dynamically (relative to CWD or env var)
  const idlPath =
    process.env.LITE_PSM_IDL_PATH ||
    path.join(
      __dirname,
      "../../SVM/oku-programs/target/idl/lite_psm.json"
    );
  if (!fs.existsSync(idlPath)) {
    console.error(
      `IDL not found at ${idlPath}. Set LITE_PSM_IDL_PATH or build the Anchor program first.`
    );
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  // Anchor 0.30+ infers program ID from idl.address; set it explicitly if needed.
  if (!idl.address) idl.address = programId.toBase58();
  const program = new Program(idl, provider);

  // Build the bridge_mint instruction
  const bridgeMintIx = await program.methods
    .bridgeMint(
      message,
      Buffer.from(signature),
      Array.from(requestId)
    )
    .accountsPartial({
      payer: orchestrator.publicKey,
      bridgeConfig,
      config: psmConfig,
      processedRequest: processedRequestPda,
      okusdMint,
      recipientOkusdAta: recipientAta,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Build transaction: Ed25519 verification first, then bridge_mint
  const tx = new Transaction();

  // Optionally create ATA if needed
  if (!ataExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        orchestrator.publicKey,
        recipientAta,
        recipientWallet,
        okusdMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // ix0: Ed25519 signature verification (MUST be before bridge_mint)
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: orchestrator.publicKey.toBytes(),
    message: new Uint8Array(message),
    signature,
  });
  tx.add(ed25519Ix);

  // ix1: bridge_mint
  tx.add(bridgeMintIx);

  console.log("\nSending transaction...");
  const txSig = await sendAndConfirmTransaction(connection, tx, [orchestrator], {
    commitment: "confirmed",
  });
  console.log(`\n✓ Bridge mint confirmed!`);
  console.log(`  Solana tx: ${txSig}`);
  console.log(
    `  Explorer:  https://solscan.io/tx/${txSig}?cluster=devnet`
  );

  // Update handoff file
  handoff.status = "completed";
  handoff.destTxHash = txSig;
  fs.writeFileSync(EVM_TO_SVM_PENDING, JSON.stringify(handoff, null, 2));
  console.log(`\n✓ Handoff file updated: ${EVM_TO_SVM_PENDING}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
