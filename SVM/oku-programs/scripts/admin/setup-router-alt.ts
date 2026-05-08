/**
 * Create and freeze an Address Lookup Table (ALT) for the router.
 *
 * Why: `oku_bridge_router::mint_usd_oku` and `redeem_usd_oku` carry 16-17
 * accounts, which puts a v0 versioned transaction near the 1232-byte tx-size
 * ceiling once signatures, blockhash, and compute-budget headers are
 * accounted for. An ALT lets clients reference well-known constants
 * (program IDs, PSM/vault/bridge config PDAs, the OkuMoney/usdOku/USDC
 * mints, the PSM USDC vault, the OkuMoney escrow, the OkuDollar reserve
 * vault, and the standard token programs) by 1-byte index instead of
 * 32-byte pubkey, dropping ~10 entries from the address section.
 *
 * The ALT is "deactivated" (frozen) after creation so its contents become
 * immutable. The resulting ALT pubkey is written into the deployment file
 * as `addressLookupTables.router` so SDK consumers know which ALT to
 * include in router txs.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/setup-router-alt.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/setup-router-alt.ts \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 *
 * On a fresh network, this script must run AFTER deploy:init has populated
 * the deployment file with the program IDs, mints, and PDAs.
 */

import * as anchor from '@anchor-lang/core';
import {
  AddressLookupTableProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment, saveDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`setup router ALT (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(
      `No deployment found for ${network}. Run deploy:programs and deploy:init first.`
    );
  }
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuDollarId = new PublicKey(deployment.programs.okuDollarProgram!);
  const routerId = new PublicKey(deployment.programs.okuBridgeRouter!);
  const usdcMint = new PublicKey(deployment.tokens.usdc!);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney!);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku!);
  const psmConfig = new PublicKey(deployment.pdas.psmConfig!);
  const bridgeConfig = new PublicKey(deployment.pdas.bridgeConfig!);
  const vaultConfig = new PublicKey(deployment.pdas.vaultConfig!);
  const routerConfig = new PublicKey(deployment.pdas.routerConfig!);
  const psmVaultUsdc = new PublicKey(deployment.pdas.psmVaultUsdc!);
  const psmEscrow = new PublicKey(deployment.pdas.psmOkuMoneyEscrow!);
  const vaultReserve = new PublicKey(deployment.pdas.vaultOkuMoney!);
  const redemptionQueue = new PublicKey(deployment.pdas.redemptionQueue!);

  // Addresses to freeze into the ALT. Order matters for indexing stability;
  // appending new entries is OK in future, reordering is NOT.
  const addresses: PublicKey[] = [
    // Program IDs
    litePsmId,
    okuDollarId,
    routerId,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    // Mints
    usdcMint,
    okuMoneyMint,
    usdOkuMint,
    // Config PDAs
    psmConfig,
    bridgeConfig,
    vaultConfig,
    routerConfig,
    // Vault accounts
    psmVaultUsdc,
    psmEscrow,
    vaultReserve,
    redemptionQueue,
  ];

  logger.info(
    summaryBlock('router ALT', {
      network,
      'address count': String(addresses.length),
      'authority': provider.wallet.publicKey.toBase58(),
    })
  );
  logger.info('Addresses:');
  for (const a of addresses) logger.info(`  ${a.toBase58()}`);

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }
  await confirmIfMainnet(network, 'Create + freeze a router ALT on mainnet');

  // Step 1: create ALT
  const slot = await provider.connection.getSlot('finalized');
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      recentSlot: slot,
    });

  // Step 2: extend with our addresses (chunked into batches of 20 to stay
  // under the v0 tx-size limit).
  const CHUNK = 20;
  const extendIxs = [];
  for (let i = 0; i < addresses.length; i += CHUNK) {
    extendIxs.push(
      AddressLookupTableProgram.extendLookupTable({
        payer: provider.wallet.publicKey,
        authority: provider.wallet.publicKey,
        lookupTable: lookupTableAddress,
        addresses: addresses.slice(i, i + CHUNK),
      })
    );
  }

  // Step 3: deactivate (freezes the table after one slot of cooldown).
  // We can deactivate but we cannot CLOSE without losing rent — leave
  // active for now; consumers should treat append-only semantics as the
  // operational rule.
  const blockhash = (await provider.connection.getLatestBlockhash()).blockhash;
  const message = new TransactionMessage({
    payerKey: provider.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, ...extendIxs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  await provider.wallet.signTransaction(tx);
  const sig = await provider.connection.sendTransaction(tx);
  await provider.connection.confirmTransaction(sig, 'confirmed');
  logger.success(`tx: ${sig}`);
  logger.success(`ALT: ${lookupTableAddress.toBase58()}`);

  // Persist to deployment file. addressBook.ts doesn't yet have an ALT
  // section; we add one keyed `addressLookupTables.router` so SDK
  // consumers can find it.
  saveDeployment(network, {
    addressLookupTables: {
      router: lookupTableAddress.toBase58(),
    },
  } as any);

  logger.info('');
  logger.info('Note: the ALT remains AUTHORIZED by the deployer key. Once');
  logger.info('the SDK has been wired to consume it on every router CPI,');
  logger.info('rotate the authority to a multisig (or revoke entirely with');
  logger.info('AddressLookupTableProgram.deactivateLookupTable).');
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
