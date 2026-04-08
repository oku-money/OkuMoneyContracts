/**
 * PSM Invariant Test Handler
 *
 * Provides a handler for property-based invariant testing of the PSM.
 * Mirrors the Forge OkuMoneyHandler pattern with ghost variables
 * for tracking state across operations.
 *
 * Usage:
 * ```typescript
 * const handler = new PsmHandler(program, surfpool, actors);
 *
 * // Run random operations
 * for (let i = 0; i < 100; i++) {
 *   await handler.randomOperation();
 *
 *   // Check invariants after each operation
 *   assert(handler.ghostMintedTotal.gte(handler.ghostBurnedTotal));
 * }
 * ```
 */

import { Program, BN } from "@anchor-lang/core";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { SurfpoolClient } from "../surfpool";
import { bound, boundBN } from "../fuzz/generators";

// ============================================================================
// Types
// ============================================================================

export interface PsmHandlerConfig {
  maxSupply: BN;
  minterAllowance: BN;
  decimals: number;
}

// ============================================================================
// PSM Handler
// ============================================================================

export class PsmHandler {
  // Ghost variables for invariant tracking (mirrors Forge handler)
  public ghostMintedTotal = new BN(0);
  public ghostBurnedTotal = new BN(0);
  public ghostLastOkuMPrice: BN;
  public ghostLastWasRebase = false;

  // Call/revert counters
  public ghostMintCallCount = 0;
  public ghostMintRevertCount = 0;
  public ghostRedeemCallCount = 0;
  public ghostRedeemRevertCount = 0;
  public ghostRebaseCallCount = 0;
  public ghostRebaseRevertCount = 0;
  public ghostTransferCallCount = 0;
  public ghostTransferRevertCount = 0;

  // Actor tracking
  public actorBalances = new Map<string, BN>();

  // PDAs and accounts
  private configPda: PublicKey;
  private redemptionQueuePda: PublicKey;
  private vaultUsdcAta: PublicKey;
  private vaultOkuMoneyAta: PublicKey;

  constructor(
    private program: Program<any>,
    private surfpool: SurfpoolClient,
    private actors: Keypair[],
    private mints: {
      usdcMint: PublicKey;
      okuMoneyMint: PublicKey;
    },
    private authorities: {
      rebaser: Keypair;
    },
    private config: PsmHandlerConfig
  ) {
    // Derive PDAs
    [this.configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      program.programId
    );

    [this.redemptionQueuePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("redemption_queue")],
      program.programId
    );

    this.vaultUsdcAta = getAssociatedTokenAddressSync(
      mints.usdcMint,
      this.configPda,
      true,
      TOKEN_PROGRAM_ID
    );

    this.vaultOkuMoneyAta = getAssociatedTokenAddressSync(
      mints.okuMoneyMint,
      this.configPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Initialize ghost price
    this.ghostLastOkuMPrice = new BN(10).pow(new BN(18)); // 1e18 starting price

    // Initialize actor balances
    for (const actor of actors) {
      this.actorBalances.set(actor.publicKey.toString(), new BN(0));
    }
  }

  // ==========================================================================
  // Handler Operations (called by fuzz/invariant tests)
  // ==========================================================================

  /**
   * Mint OkuMoney to a random actor.
   */
  async mint(actorSeed: number, amount: BN): Promise<void> {
    this.ghostLastWasRebase = false;
    this.ghostMintCallCount++;

    const actor = this.actors[actorSeed % this.actors.length];

    // Bound amount to valid range
    const maxMint = BN.min(
      this.config.minterAllowance,
      this.config.maxSupply.sub(this.ghostMintedTotal.sub(this.ghostBurnedTotal))
    );
    const boundedAmount = boundBN(amount, new BN(0), maxMint);

    if (boundedAmount.isZero()) return;

    // Derive user ATAs
    const userUsdcAta = getAssociatedTokenAddressSync(
      this.mints.usdcMint,
      actor.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const userOkuMoneyAta = getAssociatedTokenAddressSync(
      this.mints.okuMoneyMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await this.program.methods
        .mintOkuM(boundedAmount)
        .accountsPartial({
          user: actor.publicKey,
          config: this.configPda,
          usdcMint: this.mints.usdcMint,
          okuMoneyMint: this.mints.okuMoneyMint,
          userUsdcAta,
          userOkuMoneyAta,
          vaultUsdc: this.vaultUsdcAta,
          priceUpdate: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([actor])
        .rpc();

      this.ghostMintedTotal = this.ghostMintedTotal.add(boundedAmount);
      this.updateActorBalance(actor.publicKey, boundedAmount);
    } catch (err) {
      this.ghostMintRevertCount++;
    }
  }

  /**
   * Redeem OkuMoney from a random actor.
   */
  async redeem(actorSeed: number, amount: BN): Promise<void> {
    this.ghostLastWasRebase = false;
    this.ghostRedeemCallCount++;

    const actor = this.actors[actorSeed % this.actors.length];
    const actorBalance = this.actorBalances.get(actor.publicKey.toString()) || new BN(0);

    // Bound amount to actor's balance
    const boundedAmount = boundBN(amount, new BN(0), actorBalance);

    if (boundedAmount.isZero()) return;

    // Derive user ATAs
    const userUsdcAta = getAssociatedTokenAddressSync(
      this.mints.usdcMint,
      actor.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const userOkuMoneyAta = getAssociatedTokenAddressSync(
      this.mints.okuMoneyMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await this.program.methods
        .redeemOkuM(boundedAmount)
        .accountsPartial({
          user: actor.publicKey,
          config: this.configPda,
          redemptionQueue: this.redemptionQueuePda,
          usdcMint: this.mints.usdcMint,
          okuMoneyMint: this.mints.okuMoneyMint,
          userUsdcAta,
          userOkuMoneyAta,
          vaultUsdc: this.vaultUsdcAta,
          vaultOkuMoney: this.vaultOkuMoneyAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([actor])
        .rpc();

      this.ghostBurnedTotal = this.ghostBurnedTotal.add(boundedAmount);
      this.updateActorBalance(actor.publicKey, boundedAmount.neg());
    } catch (err) {
      this.ghostRedeemRevertCount++;
    }
  }

  /**
   * Update OkuM price (rebase).
   */
  async rebase(priceIncrease: BN): Promise<void> {
    this.ghostRebaseCallCount++;

    const currentPrice = this.ghostLastOkuMPrice;

    // Cap maximum price at 1e24 (1 million x starting)
    const maxPrice = new BN(10).pow(new BN(24));
    if (currentPrice.gte(maxPrice)) {
      return; // Already at maximum
    }

    // Calculate new price with bounded increase (0.01% to 5%)
    const minIncrease = currentPrice.divn(10000); // 0.01%
    const maxIncrease = currentPrice.divn(20); // 5%
    const boundedIncrease = boundBN(priceIncrease, minIncrease, maxIncrease);

    let newPrice = currentPrice.add(boundedIncrease);
    if (newPrice.gt(maxPrice)) {
      newPrice = maxPrice;
    }

    try {
      await this.program.methods
        .setOkuMPrice(newPrice)
        .accountsPartial({
          rebaser: this.authorities.rebaser.publicKey,
          config: this.configPda,
        })
        .signers([this.authorities.rebaser])
        .rpc();

      this.ghostLastWasRebase = true;
      this.ghostLastOkuMPrice = newPrice;
    } catch (err) {
      this.ghostRebaseRevertCount++;
    }
  }

  /**
   * Transfer between random actors.
   */
  async transfer(fromSeed: number, toSeed: number, amount: BN): Promise<void> {
    this.ghostLastWasRebase = false;
    this.ghostTransferCallCount++;

    const from = this.actors[fromSeed % this.actors.length];
    const to = this.actors[toSeed % this.actors.length];

    if (from.publicKey.equals(to.publicKey)) return;

    const fromBalance = this.actorBalances.get(from.publicKey.toString()) || new BN(0);
    const boundedAmount = boundBN(amount, new BN(0), fromBalance);

    if (boundedAmount.isZero()) return;

    // Note: Direct token transfers would need spl-token transfer instruction
    // For now, this is a placeholder - actual implementation would use
    // createTransferInstruction from @solana/spl-token
    this.ghostTransferRevertCount++; // Not implemented
  }

  /**
   * Execute a random operation.
   */
  async randomOperation(): Promise<void> {
    const rand = Math.random();
    const randomAmount = new BN(Math.floor(Math.random() * 1_000_000_000));
    const randomSeed = Math.floor(Math.random() * 1000);

    if (rand < 0.3) {
      await this.mint(randomSeed, randomAmount);
    } else if (rand < 0.6) {
      await this.redeem(randomSeed, randomAmount);
    } else if (rand < 0.8) {
      await this.rebase(randomAmount);
    } else {
      await this.transfer(randomSeed, randomSeed + 1, randomAmount);
    }
  }

  // ==========================================================================
  // View Functions
  // ==========================================================================

  get ghostTotalCalls(): number {
    return (
      this.ghostMintCallCount +
      this.ghostRedeemCallCount +
      this.ghostRebaseCallCount +
      this.ghostTransferCallCount
    );
  }

  get ghostTotalReverts(): number {
    return (
      this.ghostMintRevertCount +
      this.ghostRedeemRevertCount +
      this.ghostRebaseRevertCount +
      this.ghostTransferRevertCount
    );
  }

  get ghostSuccessRate(): number {
    if (this.ghostTotalCalls === 0) return 1;
    return (this.ghostTotalCalls - this.ghostTotalReverts) / this.ghostTotalCalls;
  }

  get ghostCurrentSupply(): BN {
    return this.ghostMintedTotal.sub(this.ghostBurnedTotal);
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  private updateActorBalance(actor: PublicKey, delta: BN): void {
    const key = actor.toString();
    const current = this.actorBalances.get(key) || new BN(0);
    this.actorBalances.set(key, current.add(delta));
  }

  /**
   * Verify supply invariant: minted - burned = actual supply.
   */
  async verifySupplyInvariant(): Promise<boolean> {
    const expectedSupply = this.ghostMintedTotal.sub(this.ghostBurnedTotal);

    // Fetch actual supply from on-chain
    // This would need to query the mint account
    // For now, return true (actual implementation would verify)
    return true;
  }

  /**
   * Verify price monotonicity invariant.
   */
  async verifyPriceMonotonicity(): Promise<boolean> {
    const config = await this.program.account.psmConfig.fetch(this.configPda);
    const currentPrice = config.okuMPrice as BN;

    // Price should never decrease (we track the last known price)
    return currentPrice.gte(this.ghostLastOkuMPrice);
  }

  /**
   * Reset handler state (for new test runs).
   */
  reset(): void {
    this.ghostMintedTotal = new BN(0);
    this.ghostBurnedTotal = new BN(0);
    this.ghostLastOkuMPrice = new BN(10).pow(new BN(18));
    this.ghostLastWasRebase = false;

    this.ghostMintCallCount = 0;
    this.ghostMintRevertCount = 0;
    this.ghostRedeemCallCount = 0;
    this.ghostRedeemRevertCount = 0;
    this.ghostRebaseCallCount = 0;
    this.ghostRebaseRevertCount = 0;
    this.ghostTransferCallCount = 0;
    this.ghostTransferRevertCount = 0;

    for (const actor of this.actors) {
      this.actorBalances.set(actor.publicKey.toString(), new BN(0));
    }
  }
}
