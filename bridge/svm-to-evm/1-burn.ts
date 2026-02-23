#!/usr/bin/env ts-node
/**
 * svm-to-evm/1-burn.ts
 *
 * Step 1 of Solana → EVM bridge:
 *   - Calls bridge_burn on the Solana lite-psm program
 *   - Parses the BridgeBurnEvent from transaction logs
 *   - Connects to EVM to read rewardMultiplier for shares calculation
 *   - Writes pending/svm-to-evm.json for step 2
 *
 * Required env vars:
 *   LITE_PSM_PROGRAM_ID    - Solana lite-psm program address
 *   OKUSD_MINT             - OkuUSD Token-2022 mint address
 *   SOLANA_WALLET_KEYPAIR  - Path to user's Ed25519 keypair JSON
 *   EVM_RECIPIENT          - Destination EVM address (0x...)
 *   AMOUNT                 - Token amount to bridge (e.g. "10" for 10 OkuUSD)
 *   EVM_RPC                - EVM JSON-RPC URL (to read rewardMultiplier)
 *   OKUUSD_ADDRESS         - OkuUSD EVM address (to read rewardMultiplier)
 *
 * Optional env vars:
 *   SOLANA_RPC             - Solana RPC URL (default: https://api.devnet.solana.com)
 *   DEST_CHAIN_ID          - EVM destination chain ID (default: 31337 for local fork)
 *   SOLANA_BRIDGE_FEE_RECIPIENT - base58 pubkey of fee recipient (required by BridgeBurn accounts)
 *
 * Usage:
 *   LITE_PSM_PROGRAM_ID=<prog_id> \
 *   OKUSD_MINT=<mint_addr> \
 *   SOLANA_WALLET_KEYPAIR=~/.config/solana/id.json \
 *   EVM_RECIPIENT=0x... \
 *   AMOUNT=10 \
 *   EVM_RPC=http://127.0.0.1:8545 \
 *   OKUUSD_ADDRESS=0x... \
 *   ts-node svm-to-evm/1-burn.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { ethers } from "ethers";
import {
  getSolanaRpc,
  getSolanaWalletKeypairPath,
  getLitePsmProgramId,
  getOkusdMint,
  getEvmRpc,
  getOkuUsdAddress,
  SOLANA_BRIDGE_CHAIN_ID,
  SVM_TO_EVM_PENDING,
  PENDING_DIR,
  OKUUSD_ABI,
} from "../config";

// ============ Types ============

interface SvmToEvmHandoff {
  direction: "svm-to-evm";
  sourceTxHash: string;
  sourceChainIdBridge: number;
  destChainId: number;
  solanaSender: string;
  evmRecipient: string;
  amount: string;
  shares: string;
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

/** Derive bridge nonce PDA: seeds = ["bridge_nonce", chain_id_u16_le] */
function deriveBridgeNoncePDA(
  programId: PublicKey,
  chainId: number
): [PublicKey, number] {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16LE(chainId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_nonce"), buf],
    programId
  );
}

/**
 * Parse BridgeBurnEvent from Anchor transaction logs.
 * Anchor events are encoded as base64 in the "Program log: Program data: <base64>" lines.
 */
function parseBridgeBurnEvent(logs: string[]): {
  requestId: Buffer;
  user: string;
  recipient: Buffer; // 20 bytes EVM address
  sourceChainId: number;
  destinationChain: number;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
} | null {
  // Anchor encodes events as: "Program data: <base64>"
  for (const log of logs) {
    const match = log.match(/^Program data: (.+)$/);
    if (!match) continue;

    try {
      const decoded = Buffer.from(match[1], "base64");
      // Anchor event discriminator = sha256("event:BridgeBurnEvent")[0..8]
      // We'll parse the raw bytes assuming the known layout.
      // BridgeBurnEvent layout (Anchor borsh):
      //   discriminator: [u8; 8]  8 bytes
      //   request_id:    [u8; 32] 32 bytes
      //   user:          Pubkey   32 bytes
      //   recipient:     [u8; 20] 20 bytes
      //   source_chain_id: u16    2 bytes
      //   destination_chain: u16  2 bytes
      //   amount:          u64    8 bytes
      //   nonce:           u64    8 bytes
      //   deadline:        i64    8 bytes
      // Total: 8+32+32+20+2+2+8+8+8 = 120 bytes
      if (decoded.length < 120) continue;

      let offset = 8; // skip discriminator
      const requestId = decoded.slice(offset, offset + 32);
      offset += 32;
      const userBytes = decoded.slice(offset, offset + 32);
      offset += 32;
      const recipient = decoded.slice(offset, offset + 20);
      offset += 20;
      const sourceChainId = decoded.readUInt16LE(offset);
      offset += 2;
      const destinationChain = decoded.readUInt16LE(offset);
      offset += 2;
      const amount = decoded.readBigUInt64LE(offset);
      offset += 8;
      const nonce = decoded.readBigUInt64LE(offset);
      offset += 8;
      const deadline = decoded.readBigInt64LE(offset);

      const user = new PublicKey(userBytes).toBase58();

      return {
        requestId: Buffer.from(requestId),
        user,
        recipient: Buffer.from(recipient),
        sourceChainId,
        destinationChain,
        amount,
        nonce,
        deadline,
      };
    } catch {
      // not the event we're looking for
    }
  }
  return null;
}

// ============ Main ============

async function main() {
  const solanaRpc = getSolanaRpc();
  const walletPath = getSolanaWalletKeypairPath();
  const programIdStr = getLitePsmProgramId();
  const okusdMintStr = getOkusdMint();
  const evmRpc = getEvmRpc();
  const okuusdAddress = getOkuUsdAddress();

  const evmRecipientStr = process.env.EVM_RECIPIENT;
  if (!evmRecipientStr) {
    console.error("Missing EVM_RECIPIENT environment variable");
    process.exit(1);
  }

  const amountStr = process.env.AMOUNT;
  if (!amountStr) {
    console.error("Missing AMOUNT environment variable");
    process.exit(1);
  }

  const destChainId = parseInt(process.env.DEST_CHAIN_ID || "31337", 10);

  // Validate EVM recipient
  let evmRecipient: string;
  try {
    evmRecipient = ethers.getAddress(evmRecipientStr);
  } catch {
    console.error(`Invalid EVM_RECIPIENT: ${evmRecipientStr}`);
    process.exit(1);
  }

  console.log("=== Solana → EVM Bridge: Step 1 (Burn) ===");
  console.log(`Solana RPC:    ${solanaRpc}`);
  console.log(`Program ID:    ${programIdStr}`);
  console.log(`OkuUSD Mint:   ${okusdMintStr}`);
  console.log(`EVM recipient: ${evmRecipient}`);
  console.log(`Amount:        ${amountStr} OkuUSD`);
  console.log(`Dest chain ID: ${destChainId}`);
  console.log("");

  // Connect to Solana
  const connection = new Connection(solanaRpc, "confirmed");
  const wallet = loadKeypair(walletPath);
  const programId = new PublicKey(programIdStr);
  const okusdMint = new PublicKey(okusdMintStr);

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });

  // Load IDL
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

  // Derive PDAs
  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config")],
    programId
  );
  const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    programId
  );
  const [bridgeNonce] = deriveBridgeNoncePDA(programId, destChainId);

  console.log(`PSM Config PDA:    ${psmConfig.toBase58()}`);
  console.log(`Bridge Config PDA: ${bridgeConfigPda.toBase58()}`);
  console.log(`Bridge Nonce PDA:  ${bridgeNonce.toBase58()} (for chain ${destChainId})`);

  // Read bridge config to get fee_recipient
  const bridgeConfigAccount = await (program.account as any).bridgeConfig.fetch(
    bridgeConfigPda
  );
  const feeRecipientPubkey: PublicKey = bridgeConfigAccount.feeRecipient;
  console.log(`Fee recipient:     ${feeRecipientPubkey.toBase58()}`);

  // User and fee recipient ATAs
  const userOkusdAta = getAssociatedTokenAddressSync(
    okusdMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Ensure fee recipient ATA exists
  await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    okusdMint,
    feeRecipientPubkey,
    true,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  const feeRecipientAta = getAssociatedTokenAddressSync(
    okusdMint,
    feeRecipientPubkey,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Parse EVM recipient as 20-byte array
  const evmRecipientBytes = Array.from(
    Buffer.from(evmRecipient.replace(/^0x/, ""), "hex")
  );

  // Convert amount (6 decimals)
  const amount = parseFloat(amountStr) * 1_000_000;
  const amountBn = new BN(Math.floor(amount));

  console.log(`\nCalling bridge_burn(amount=${amountBn.toString()}, recipient=${evmRecipient}, destChain=${destChainId})...`);

  // Call bridge_burn
  const txSig = await program.methods
    .bridgeBurn(amountBn, evmRecipientBytes, destChainId)
    .accountsPartial({
      user: wallet.publicKey,
      bridgeConfig: bridgeConfigPda,
      config: psmConfig,
      bridgeNonce,
      okusdMint,
      userOkusdAta,
      feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(txSig, "confirmed");
  console.log(`Bridge burn tx: ${txSig}`);

  // Fetch transaction logs to parse BridgeBurnEvent
  const txDetails = await connection.getTransaction(txSig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!txDetails?.meta?.logMessages) {
    console.error("No log messages found in transaction");
    process.exit(1);
  }

  const burnEvent = parseBridgeBurnEvent(txDetails.meta.logMessages);
  if (!burnEvent) {
    console.error("BridgeBurnEvent not found in transaction logs");
    console.error("Logs:", txDetails.meta.logMessages);
    process.exit(1);
  }

  console.log(`\nBridgeBurnEvent:`);
  console.log(`  user:             ${burnEvent.user}`);
  console.log(`  recipient (EVM):  0x${burnEvent.recipient.toString("hex")}`);
  console.log(`  amount:           ${burnEvent.amount}`);
  console.log(`  nonce:            ${burnEvent.nonce}`);
  console.log(`  deadline:         ${burnEvent.deadline}`);
  console.log(`  sourceChainId:    ${burnEvent.sourceChainId}`);
  console.log(`  destChain:        ${burnEvent.destinationChain}`);

  // Connect to EVM to read rewardMultiplier for shares conversion
  console.log(`\nReading rewardMultiplier from EVM (${evmRpc})...`);
  const evmProvider = new ethers.JsonRpcProvider(evmRpc);
  const okuUsd = new ethers.Contract(okuusdAddress, OKUUSD_ABI, evmProvider);
  const rewardMultiplier: bigint = await okuUsd.rewardMultiplier();
  const PRECISION = BigInt("1000000000000000000"); // 1e18

  // SVM amount → EVM shares: shares = amount × 1e18 / rewardMultiplier
  const shares = (burnEvent.amount * PRECISION) / rewardMultiplier;
  console.log(`rewardMultiplier: ${rewardMultiplier}`);
  console.log(`EVM shares:       ${shares}`);

  // Write handoff file
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  const handoff: SvmToEvmHandoff = {
    direction: "svm-to-evm",
    sourceTxHash: txSig,
    sourceChainIdBridge: burnEvent.sourceChainId,
    destChainId: burnEvent.destinationChain,
    solanaSender: burnEvent.user,
    evmRecipient,
    amount: burnEvent.amount.toString(),
    shares: shares.toString(),
    nonce: burnEvent.nonce.toString(),
    deadline: Number(burnEvent.deadline),
    status: "pending",
  };

  fs.writeFileSync(SVM_TO_EVM_PENDING, JSON.stringify(handoff, null, 2));

  console.log(`\n✓ Handoff file written: ${SVM_TO_EVM_PENDING}`);
  console.log(`\nNext step:`);
  console.log(`  EVM_RPC=${evmRpc} \\`);
  console.log(`  EVM_ORCHESTRATOR_PRIVATE_KEY=0x... \\`);
  console.log(`  OKUBRIDGE_ADDRESS=<address> \\`);
  console.log(`  ts-node svm-to-evm/2-mint.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
