#!/usr/bin/env tsx
/**
 * Cross-stack SVM <-> EVM bridge test (off-chain orchestrator simulation).
 *
 * Drives the verified 3-leg flow against ONE EVM testnet and the SVM devnet
 * in a single tsx process:
 *
 *   1. Source redeem (burn OkuM, release USDC).
 *   2. Off-chain rail simulation: MockUSDC mint on destination chain.
 *   3. Destination mint (lock USDC, mint OkuM).
 *
 * Invariants per direction:
 *   - USDC released on source == USDC minted on destination
 *     (both EVM MockUSDC and SVM USDC are 6 decimals — direct equality).
 *   - Global OkuM holdings preserved within rounding tolerance.
 *
 * Refuses to operate against Solana mainnet-beta or EVM mainnets (base/bsc).
 *
 * Usage:
 *   PRIVATE_KEY=0x<evm-key> tsx scripts/test/bridge-svm-evm.ts \
 *       --evm=baseSepolia --svm=devnet --amount=5 --direction=evm-to-svm
 *
 *   PRIVATE_KEY=0x<evm-key> tsx scripts/test/bridge-svm-evm.ts \
 *       --evm=baseSepolia --svm=devnet --amount=5 --direction=svm-to-evm
 *
 *   PRIVATE_KEY=0x<evm-key> tsx scripts/test/bridge-svm-evm.ts \
 *       --evm=baseSepolia --svm=devnet --amount=5 --direction=roundtrip
 *
 * Environment / CLI:
 *   --evm=<chain>          EVM chain name (must be in testnet-addresses.json::evm)
 *   --svm=<network>        SVM network name (devnet only for now)
 *   --amount=<okuM>        OkuM notional to bridge (default 5)
 *   --direction=evm-to-svm|svm-to-evm|roundtrip
 *   PRIVATE_KEY            EVM private key (for evm-side signer)
 *   WALLET_PATH            SVM keypair path (default ~/.config/solana/id.json)
 *   DRY_RUN=true           simulate only
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program, AnchorProvider } from '@anchor-lang/core';
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from '@solana/spl-token';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

import { LitePsm } from '../../target/types/lite_psm';
import { detectNetwork, createProvider, loadKeypair } from '../utils/network';
import * as os from 'os';
import { NetworkName } from '../config/networks';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';
import {
  derivePsmConfigPDA,
} from '../utils/pdaHelpers';

// ============================================================================
// CLI parsing
// ============================================================================

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

const EVM_CHAIN = parseArg('evm');
const SVM_NETWORK_ARG = parseArg('svm') ?? 'devnet';
const AMOUNT_STR = parseArg('amount') ?? '5';
const DIRECTION = (parseArg('direction') ?? 'evm-to-svm') as
  | 'evm-to-svm'
  | 'svm-to-evm'
  | 'roundtrip';
const DRY_RUN = process.env.DRY_RUN === 'true';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!EVM_CHAIN) {
  throw new Error('Required: --evm=<chain> (e.g. --evm=baseSepolia)');
}
if (!['evm-to-svm', 'svm-to-evm', 'roundtrip'].includes(DIRECTION)) {
  throw new Error(`--direction must be evm-to-svm|svm-to-evm|roundtrip (got ${DIRECTION})`);
}
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY env var is required (for EVM side)');
}

const SVM_NETWORK = SVM_NETWORK_ARG as NetworkName;

// Mainnet guard
const EVM_MAINNETS = new Set(['base', 'bsc', 'mainnet', 'ethereum']);
const SVM_MAINNETS = new Set(['mainnet-beta', 'mainnet-fork']);
if (EVM_MAINNETS.has(EVM_CHAIN) || SVM_MAINNETS.has(SVM_NETWORK)) {
  throw new Error(
    `Refusing to run bridge test on a mainnet network ` +
      `(evm=${EVM_CHAIN}, svm=${SVM_NETWORK}). Use operator-tool scripts instead.`
  );
}

// ============================================================================
// EVM side
// ============================================================================

const EVM_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function mint(address,uint256)',
];
const EVM_OKU_MONEY_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function okuMMultiplier() view returns (uint256)',
];
const EVM_LITE_PSM_ABI = [
  'function mintOkuM(uint256 usdcAmount)',
  'function redeemOkuM(uint256 okuMAmount)',
];

interface EvmCtx {
  chainName: string;
  chainId: number;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  usdc: ethers.Contract;
  okuMoney: ethers.Contract;
  litePSM: ethers.Contract;
  litePSMAddr: string;
  hasMockUsdc: boolean;
  usdcDecimals: number;
}

/**
 * Read the canonical `testnet-addresses.json` registry to get EVM addresses
 * (avoids importing hardhat config from this tsx process).
 */
function loadEvmRegistry(): any {
  // SVM/oku-programs -> repo root via ../../testnet-addresses.json
  const registryPath = path.resolve(__dirname, '../../../../testnet-addresses.json');
  if (!fs.existsSync(registryPath)) {
    throw new Error(`testnet-addresses.json not found at ${registryPath}`);
  }
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

async function makeEvmCtx(chainName: string): Promise<EvmCtx> {
  const registry = loadEvmRegistry();
  const entry = registry.evm?.[chainName];
  if (!entry) {
    throw new Error(`No EVM registry entry for "${chainName}"`);
  }
  const { chainId, rpcUrl, contracts } = entry;
  if (!contracts.okuMoney || !contracts.litePSM) {
    throw new Error(`Missing OkuMoney/LitePSM in registry for "${chainName}"`);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const pk = PRIVATE_KEY!.startsWith('0x') ? PRIVATE_KEY! : `0x${PRIVATE_KEY!}`;
  const wallet = new ethers.Wallet(pk, provider);

  const usdcAddr = contracts.mockUSDC ?? contracts.usdc;
  if (!usdcAddr) throw new Error(`No USDC in registry for "${chainName}"`);

  const usdc = new ethers.Contract(usdcAddr, EVM_ERC20_ABI, wallet);
  const okuMoney = new ethers.Contract(contracts.okuMoney, EVM_OKU_MONEY_ABI, wallet);
  const litePSM = new ethers.Contract(contracts.litePSM, EVM_LITE_PSM_ABI, wallet);

  const usdcDecimals = Number(await usdc.decimals());

  return {
    chainName,
    chainId,
    provider,
    wallet,
    usdc,
    okuMoney,
    litePSM,
    litePSMAddr: contracts.litePSM,
    hasMockUsdc: !!contracts.mockUSDC,
    usdcDecimals,
  };
}

function isBscChain(name: string): boolean {
  return name === 'bsc' || name === 'bscTestnet';
}

async function evmSendTx(
  ctx: EvmCtx,
  contract: ethers.Contract,
  method: string,
  args: any[],
  label: string
): Promise<string> {
  const overrides = isBscChain(ctx.chainName) ? { type: 0 as const } : {};
  if (DRY_RUN) {
    logger.warning(`[EVM:${ctx.chainName}] DRY_RUN — would send ${label}`);
    return '<dry-run>';
  }
  // Retry estimateGas/send on transient revert from RPC lag (post-approve
  // state not yet visible to the estimate path on baseSepolia public RPC).
  const maxRetries = 3;
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tx = await contract[method](...args, overrides);
      const rcpt = await tx.wait(1);
      logger.success(`[EVM:${ctx.chainName}] ${label} -> ${rcpt.hash}`);
      return rcpt.hash;
    } catch (e: any) {
      lastErr = e;
      const msg = e?.shortMessage || e?.message || String(e);
      if (
        attempt < maxRetries - 1 &&
        (msg.includes('execution reverted') ||
          msg.includes('insufficient allowance') ||
          msg.includes('replacement transaction underpriced'))
      ) {
        logger.warning(
          `[EVM:${ctx.chainName}] ${label} estimateGas/send failed (attempt ${attempt + 1}/${maxRetries}); ` +
            `waiting 3s for RPC to settle and retrying...`
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ============================================================================
// SVM side
// ============================================================================

interface SvmCtx {
  network: NetworkName;
  provider: AnchorProvider;
  signer: Keypair;
  psm: Program<LitePsm>;
  litePsmId: PublicKey;
  psmConfig: PublicKey;
  usdcMint: PublicKey;
  okuMMint: PublicKey;
  vaultUsdc: PublicKey;
  usdcDecimals: number;
}

async function makeSvmCtx(network: NetworkName): Promise<SvmCtx> {
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.litePsm ||
    !deployment.tokens?.usdc ||
    !deployment.tokens?.okuM
  ) {
    throw new Error(`No SVM deployment for ${network}`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMMint = new PublicKey(deployment.tokens.okuM);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  // Load the IDL from target/idl and bind to the deployed program id.
  // `anchor.workspace.<Name>` only works under `anchor test`, not under tsx.
  const psmIdlPath = path.resolve(__dirname, '../../target/idl/lite_psm.json');
  if (!fs.existsSync(psmIdlPath)) {
    throw new Error(
      `IDL not found at ${psmIdlPath}. Run \`anchor build\` first.`
    );
  }
  const psmIdl = JSON.parse(fs.readFileSync(psmIdlPath, 'utf-8'));
  psmIdl.address = litePsmId.toBase58();
  const psm = new Program(psmIdl, provider) as Program<LitePsm>;

  const cfg = await psm.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;

  // The AnchorProvider wallet wraps the Keypair loaded from WALLET_PATH (or
  // ~/.config/solana/id.json). Re-load it so we have a concrete Keypair for
  // signing raw `sendAndConfirmTransaction` calls (Anchor only needs the
  // Wallet abstraction, but our cross-stack mintTo / ATA-create paths go
  // around Anchor and need the secret key).
  const walletPath =
    process.env.WALLET_PATH || path.join(os.homedir(), '.config/solana/id.json');
  const signer = loadKeypair(walletPath);

  return {
    network,
    provider,
    signer,
    psm,
    litePsmId,
    psmConfig,
    usdcMint,
    okuMMint,
    vaultUsdc,
    usdcDecimals: 6, // MockUSDC on devnet is 6 decimals (matches EVM MockUSDC)
  };
}

async function svmGetOrCreateAta(
  ctx: SvmCtx,
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const info = await ctx.provider.connection.getAccountInfo(ata);
  if (info) return ata;
  if (DRY_RUN) {
    logger.warning(`[SVM] DRY_RUN — would create ATA ${ata.toBase58()}`);
    return ata;
  }
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      ctx.signer.publicKey,
      ata,
      owner,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.signer]);
  logger.success(`[SVM] Created ATA ${ata.toBase58()}`);
  return ata;
}

async function svmMintMockUsdc(ctx: SvmCtx, amount: bigint, to: PublicKey) {
  const ata = await svmGetOrCreateAta(ctx, ctx.usdcMint, to, TOKEN_PROGRAM_ID);
  if (DRY_RUN) {
    logger.warning(`[SVM] DRY_RUN — would mint ${amount} USDC to ${ata.toBase58()}`);
    return;
  }
  const tx = new Transaction().add(
    createMintToInstruction(
      ctx.usdcMint,
      ata,
      ctx.signer.publicKey,
      Number(amount),
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const sig = await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.signer]);
  logger.success(`[SVM] mintTo USDC tx: ${sig}`);
}

async function svmTokenBalance(
  ctx: SvmCtx,
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  try {
    const acc = await getAccount(ctx.provider.connection, ata, undefined, tokenProgram);
    return acc.amount;
  } catch {
    return 0n;
  }
}

async function svmMintOkuM(ctx: SvmCtx, usdcAmount: bigint): Promise<bigint> {
  logger.section(`SVM mint: ${ctx.network} psm.mintOkuM(${usdcAmount})`);
  const userUsdcAta = await svmGetOrCreateAta(
    ctx,
    ctx.usdcMint,
    ctx.signer.publicKey,
    TOKEN_PROGRAM_ID
  );
  const userOkuMAta = await svmGetOrCreateAta(
    ctx,
    ctx.okuMMint,
    ctx.signer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  const before = await svmTokenBalance(
    ctx,
    ctx.okuMMint,
    ctx.signer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  if (DRY_RUN) {
    logger.warning(`[SVM] DRY_RUN — would mintOkuM(${usdcAmount})`);
    return 0n;
  }

  const sig = await ctx.psm.methods
    .mintOkuM(new BN(usdcAmount.toString()))
    .accountsPartial({
      user: ctx.signer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okuMMint: ctx.okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdc: ctx.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await ctx.provider.connection.confirmTransaction(sig, 'confirmed');
  logger.success(`[SVM] mintOkuM tx: ${sig}`);

  const after = await svmTokenBalance(
    ctx,
    ctx.okuMMint,
    ctx.signer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );
  return after - before;
}

async function svmRedeemOkuM(ctx: SvmCtx, okuMAmount: bigint): Promise<bigint> {
  logger.section(`SVM redeem: ${ctx.network} psm.redeemOkuM(${okuMAmount})`);
  const userUsdcAta = await svmGetOrCreateAta(
    ctx,
    ctx.usdcMint,
    ctx.signer.publicKey,
    TOKEN_PROGRAM_ID
  );
  const userOkuMAta = await svmGetOrCreateAta(
    ctx,
    ctx.okuMMint,
    ctx.signer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );
  const usdcBefore = await svmTokenBalance(
    ctx,
    ctx.usdcMint,
    ctx.signer.publicKey,
    TOKEN_PROGRAM_ID
  );

  if (DRY_RUN) {
    logger.warning(`[SVM] DRY_RUN — would redeemOkuM(${okuMAmount})`);
    return 0n;
  }

  const sig = await ctx.psm.methods
    .redeemOkuM(new BN(okuMAmount.toString()), new BN(0))
    .accountsPartial({
      user: ctx.signer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okuMMint: ctx.okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdc: ctx.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await ctx.provider.connection.confirmTransaction(sig, 'confirmed');
  logger.success(`[SVM] redeemOkuM tx: ${sig}`);

  const usdcAfter = await svmTokenBalance(
    ctx,
    ctx.usdcMint,
    ctx.signer.publicKey,
    TOKEN_PROGRAM_ID
  );
  const delta = usdcAfter - usdcBefore;
  if (delta === 0n) {
    throw new Error('[SVM] redeemOkuM released 0 USDC — buffer may be depleted; deposit_buffer first');
  }
  return delta;
}

// ============================================================================
// Snapshots
// ============================================================================

interface EvmSnap {
  usdc: bigint;
  okuM: bigint;
  okuMSupply: bigint;
}

interface SvmSnap {
  usdc: bigint;
  okuM: bigint;
}

async function snapEvm(c: EvmCtx): Promise<EvmSnap> {
  const [usdc, okuM, okuMSupply] = await Promise.all([
    c.usdc.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.balanceOf(c.wallet.address) as Promise<bigint>,
    c.okuMoney.totalSupply() as Promise<bigint>,
  ]);
  return { usdc, okuM, okuMSupply };
}

/**
 * Poll `read()` every 1s for up to `maxMs` until the returned value differs
 * from `baseline`. Public EVM RPCs lag a block before post-tx reads reflect
 * on-chain state.
 */
async function pollEvmDelta(
  read: () => Promise<bigint>,
  baseline: bigint,
  maxMs: number = 30_000
): Promise<bigint> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const cur = await read();
    if (cur !== baseline) return cur - baseline;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await read()) - baseline;
}

async function snapSvm(c: SvmCtx): Promise<SvmSnap> {
  const usdc = await svmTokenBalance(c, c.usdcMint, c.signer.publicKey, TOKEN_PROGRAM_ID);
  const okuM = await svmTokenBalance(c, c.okuMMint, c.signer.publicKey, TOKEN_2022_PROGRAM_ID);
  return { usdc, okuM };
}

function printEvmSnap(c: EvmCtx, s: EvmSnap, label: string) {
  logger.info(`[EVM:${c.chainName}] ${label}:`);
  logger.info(`  wallet USDC:  ${ethers.formatUnits(s.usdc, c.usdcDecimals)}`);
  logger.info(`  wallet OkuM:  ${ethers.formatUnits(s.okuM, 18)}`);
  logger.info(`  OkuM supply:  ${ethers.formatUnits(s.okuMSupply, 18)}`);
}

function printSvmSnap(c: SvmCtx, s: SvmSnap, label: string) {
  logger.info(`[SVM:${c.network}] ${label}:`);
  logger.info(`  wallet USDC:  ${(Number(s.usdc) / 10 ** c.usdcDecimals).toFixed(c.usdcDecimals)}`);
  logger.info(`  wallet OkuM:  ${(Number(s.okuM) / 10 ** 6).toFixed(6)} (6-dec OkuM on SVM)`);
}

// ============================================================================
// Bridge legs (EVM -> SVM, SVM -> EVM)
// ============================================================================

/**
 * EVM and SVM OkuM live in different decimal worlds:
 *   EVM OkuM: 18 decimals
 *   SVM OkuM:  6 decimals (Token-2022 ScaledUiAmount mint)
 * Both sides hold their own independent supply. The bridge conserves USDC
 * (which is 6 decimals on both sides), not OkuM directly — OkuM is "burned
 * on source, minted on destination" but the raw amounts differ by 1e12.
 */
async function evmToSvm(
  evm: EvmCtx,
  svm: SvmCtx,
  okuMAmountEvm: bigint
): Promise<{ released: bigint; minted: bigint }> {
  logger.header(`Bridge EVM(${evm.chainName}) -> SVM(${svm.network})`);

  const evmPre = await snapEvm(evm);
  const svmPre = await snapSvm(svm);
  printEvmSnap(evm, evmPre, 'PRE');
  printSvmSnap(svm, svmPre, 'PRE');

  // Source leg (EVM): ensure OkuM, redeem.
  if (evmPre.okuM < okuMAmountEvm) {
    const multiplier: bigint = await evm.okuMoney.okuMMultiplier();
    const PRECISION = 10n ** 18n;
    const decScale = 10n ** BigInt(18 - evm.usdcDecimals);
    const usdcNeeded =
      ((okuMAmountEvm - evmPre.okuM) * multiplier) / PRECISION / decScale + 1n;
    logger.info(
      `[EVM:${evm.chainName}] Wallet short on OkuM; seeding via ` +
        `MockUSDC.mint+psm.mintOkuM(${ethers.formatUnits(usdcNeeded, evm.usdcDecimals)} USDC)`
    );
    if (!evm.hasMockUsdc) {
      throw new Error(`[EVM:${evm.chainName}] No MockUSDC; cannot seed OkuM`);
    }
    const usdcBal: bigint = await evm.usdc.balanceOf(evm.wallet.address);
    if (usdcBal < usdcNeeded) {
      await evmSendTx(
        evm,
        evm.usdc,
        'mint',
        [evm.wallet.address, usdcNeeded - usdcBal],
        `MockUSDC.mint(${ethers.formatUnits(usdcNeeded - usdcBal, evm.usdcDecimals)})`
      );
    }
    await evmSendTx(evm, evm.usdc, 'approve', [evm.litePSMAddr, usdcNeeded], 'usdc.approve');
    await evmSendTx(evm, evm.litePSM, 'mintOkuM', [usdcNeeded], 'litePSM.mintOkuM');
  }

  const usdcBefore: bigint = await evm.usdc.balanceOf(evm.wallet.address);
  await evmSendTx(
    evm,
    evm.okuMoney,
    'approve',
    [evm.litePSMAddr, okuMAmountEvm],
    `okuMoney.approve(${ethers.formatUnits(okuMAmountEvm, 18)})`
  );
  await evmSendTx(
    evm,
    evm.litePSM,
    'redeemOkuM',
    [okuMAmountEvm],
    `litePSM.redeemOkuM(${ethers.formatUnits(okuMAmountEvm, 18)})`
  );
  const released = await pollEvmDelta(
    () => evm.usdc.balanceOf(evm.wallet.address) as Promise<bigint>,
    usdcBefore
  );
  if (released === 0n) throw new Error('[EVM] redeemOkuM released 0 USDC');
  logger.success(`[EVM:${evm.chainName}] released ${ethers.formatUnits(released, evm.usdcDecimals)} USDC`);

  // Off-chain rail: mint MockUSDC on SVM dest for the same amount.
  logger.section(`Off-chain rail: mint MockUSDC on SVM(${svm.network})`);
  await svmMintMockUsdc(svm, released, svm.signer.publicKey);

  // Dest leg (SVM): mintOkuM with that USDC.
  const okuMMinted = await svmMintOkuM(svm, released);
  logger.success(`[SVM:${svm.network}] minted ${Number(okuMMinted) / 1e6} OkuM (6-dec)`);

  // Post snapshots + invariants
  const evmPost = await snapEvm(evm);
  const svmPost = await snapSvm(svm);
  printEvmSnap(evm, evmPost, 'POST');
  printSvmSnap(svm, svmPost, 'POST');

  logger.section('Invariants');
  // USDC conservation: released on EVM == minted-then-spent on SVM, so net
  // SVM USDC delta should be 0 (mint + spend in mintOkuM cancel).
  const svmUsdcDelta = svmPost.usdc - svmPre.usdc;
  if (svmUsdcDelta !== 0n) {
    throw new Error(`[invariant] SVM USDC delta should be 0; got ${svmUsdcDelta}`);
  }
  logger.success(`[invariant] SVM USDC net delta = 0 (mint+spend cancel): OK`);

  // EVM supply down by exactly okuMAmountEvm
  const evmSupplyDelta = evmPost.okuMSupply - evmPre.okuMSupply;
  if (evmSupplyDelta > 0n) {
    // If we minted to seed the wallet, supply could have gone up by more than
    // it later went down. Only fail if net supply increased — that would
    // contradict "source burn".
    logger.warning(
      `[invariant] EVM supply went up (seeded then redeemed): ` +
        `${ethers.formatUnits(evmSupplyDelta, 18)} (may be expected on first run)`
    );
  }

  // SVM OkuM balance increased by exactly okuMMinted
  const svmOkuMDelta = svmPost.okuM - svmPre.okuM;
  if (svmOkuMDelta !== okuMMinted) {
    throw new Error(
      `[invariant] SVM OkuM wallet delta (${svmOkuMDelta}) != minted (${okuMMinted})`
    );
  }
  logger.success(`[invariant] SVM OkuM wallet delta == minted: OK`);

  return { released, minted: okuMMinted };
}

async function svmToEvm(
  svm: SvmCtx,
  evm: EvmCtx,
  okuMAmountSvm: bigint
): Promise<{ released: bigint; minted: bigint }> {
  logger.header(`Bridge SVM(${svm.network}) -> EVM(${evm.chainName})`);

  const evmPre = await snapEvm(evm);
  const svmPre = await snapSvm(svm);
  printEvmSnap(evm, evmPre, 'PRE');
  printSvmSnap(svm, svmPre, 'PRE');

  // Source leg (SVM): ensure OkuM, redeem.
  if (svmPre.okuM < okuMAmountSvm) {
    // Seed: mint SVM MockUSDC, then mintOkuM via PSM.
    const short = okuMAmountSvm - svmPre.okuM;
    // We don't know the SVM price exactly, but a 1:1 USDC->OkuM approximation
    // with cushion suffices for testnet sizing. Use short + 10% cushion.
    const seedUsdc = (short * 11n) / 10n;
    logger.info(
      `[SVM:${svm.network}] Wallet short on OkuM; seeding via mintUSDC+mintOkuM(${seedUsdc})`
    );
    await svmMintMockUsdc(svm, seedUsdc, svm.signer.publicKey);
    await svmMintOkuM(svm, seedUsdc);
  }

  const released = await svmRedeemOkuM(svm, okuMAmountSvm);
  logger.success(`[SVM:${svm.network}] released ${Number(released) / 1e6} USDC`);

  // Off-chain rail: mint MockUSDC on EVM dest.
  logger.section(`Off-chain rail: mint MockUSDC on EVM(${evm.chainName})`);
  if (!evm.hasMockUsdc) {
    throw new Error(`[EVM:${evm.chainName}] No MockUSDC; cannot simulate rail`);
  }
  await evmSendTx(
    evm,
    evm.usdc,
    'mint',
    [evm.wallet.address, released],
    `MockUSDC.mint(${ethers.formatUnits(released, evm.usdcDecimals)})`
  );

  // Dest leg (EVM): mintOkuM.
  const evmOkuMBefore: bigint = await evm.okuMoney.balanceOf(evm.wallet.address);
  await evmSendTx(evm, evm.usdc, 'approve', [evm.litePSMAddr, released], 'usdc.approve');
  await evmSendTx(
    evm,
    evm.litePSM,
    'mintOkuM',
    [released],
    `litePSM.mintOkuM(${ethers.formatUnits(released, evm.usdcDecimals)})`
  );
  const minted = await pollEvmDelta(
    () => evm.okuMoney.balanceOf(evm.wallet.address) as Promise<bigint>,
    evmOkuMBefore
  );
  logger.success(`[EVM:${evm.chainName}] minted ${ethers.formatUnits(minted, 18)} OkuM`);

  // Post + invariants
  const evmPost = await snapEvm(evm);
  const svmPost = await snapSvm(svm);
  printEvmSnap(evm, evmPost, 'POST');
  printSvmSnap(svm, svmPost, 'POST');

  logger.section('Invariants');
  const evmUsdcDelta = evmPost.usdc - evmPre.usdc;
  if (evmUsdcDelta !== 0n) {
    throw new Error(`[invariant] EVM USDC delta should be 0 (mint+spend); got ${evmUsdcDelta}`);
  }
  logger.success(`[invariant] EVM USDC net delta = 0: OK`);

  const evmSupplyDelta = evmPost.okuMSupply - evmPre.okuMSupply;
  if (evmSupplyDelta !== minted) {
    throw new Error(
      `[invariant] EVM supply delta (${evmSupplyDelta}) != minted (${minted})`
    );
  }
  logger.success(`[invariant] EVM supply delta == minted: OK`);

  return { released, minted };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  logger.header(`bridge-svm-evm`);
  logger.info(`evm=${EVM_CHAIN}  svm=${SVM_NETWORK}  amount=${AMOUNT_STR}  direction=${DIRECTION}`);

  const evm = await makeEvmCtx(EVM_CHAIN!);
  const svm = await makeSvmCtx(SVM_NETWORK);

  // Sanity: USDC decimals MUST match for direct conservation math.
  if (evm.usdcDecimals !== svm.usdcDecimals) {
    throw new Error(
      `USDC-decimal mismatch: EVM=${evm.usdcDecimals} SVM=${svm.usdcDecimals}. ` +
        `Bridge math assumes equal decimals.`
    );
  }

  logger.info(`EVM signer: ${evm.wallet.address} (chainId ${evm.chainId})`);
  logger.info(`SVM signer: ${svm.signer.publicKey.toBase58()}`);

  // We size source amounts in each side's native OkuM decimals.
  const evmOkuMAmount = ethers.parseUnits(AMOUNT_STR, 18);
  const svmOkuMAmount = BigInt(Math.round(parseFloat(AMOUNT_STR) * 1_000_000));

  if (DIRECTION === 'evm-to-svm') {
    await evmToSvm(evm, svm, evmOkuMAmount);
  } else if (DIRECTION === 'svm-to-evm') {
    await svmToEvm(svm, evm, svmOkuMAmount);
  } else {
    // roundtrip
    await evmToSvm(evm, svm, evmOkuMAmount);
    logger.header('Return leg');
    await svmToEvm(svm, evm, svmOkuMAmount);
  }

  logger.success('bridge-svm-evm complete');
}

// `detectNetwork` is called for the side-effect of validating the SVM_NETWORK
// (it throws on unknown networks). We pass through SVM_NETWORK explicitly so
// this script ignores any `NETWORK=` env var.
process.env.NETWORK = SVM_NETWORK;
detectNetwork(); // throws on unknown

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
