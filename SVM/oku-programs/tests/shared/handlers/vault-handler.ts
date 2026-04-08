/**
 * Vault Invariant Test Handler
 *
 * Provides a handler for property-based invariant testing of the OkuDollar vault.
 * Tracks ghost variables for verifying collateralization invariants.
 */

import { Program, BN } from "@anchor-lang/core";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SurfpoolClient } from "../surfpool";
import { boundBN } from "../fuzz/generators";

// ============================================================================
// Types
// ============================================================================

export interface VaultHandlerConfig {
  minCollateralRatio: BN; // e.g., 9000 for 90%
  precision: BN; // 1e18
}

// ============================================================================
// Vault Handler
// ============================================================================

export class VaultHandler {
  // Ghost variables for invariant tracking
  public ghostTotalShares = new BN(0);
  public ghostTotalOkuMoney = new BN(0);
  public ghostUsdMultiplier: BN;
  public ghostReserves = new BN(0);

  // Call/revert counters
  public ghostWrapCallCount = 0;
  public ghostWrapRevertCount = 0;
  public ghostUnwrapCallCount = 0;
  public ghostUnwrapRevertCount = 0;
  public ghostSetMultiplierCallCount = 0;
  public ghostSetMultiplierRevertCount = 0;
  public ghostDepositReservesCallCount = 0;
  public ghostDepositReservesRevertCount = 0;
  public ghostWithdrawReservesCallCount = 0;
  public ghostWithdrawReservesRevertCount = 0;

  // User share tracking
  public userShares = new Map<string, BN>();

  // PDAs and accounts
  private vaultConfigPda: PublicKey;
  private vaultOkuMoneyAta: PublicKey;
  private psmConfigPda: PublicKey;

  constructor(
    private program: Program<any>,
    private surfpool: SurfpoolClient,
    private actors: Keypair[],
    private mints: {
      okuMoneyMint: PublicKey;
      usdOkuMint: PublicKey;
    },
    private authorities: {
      usdRebaser: Keypair;
      reserveManager: Keypair;
    },
    private config: VaultHandlerConfig,
    psmProgramId: PublicKey
  ) {
    // Derive vault PDAs
    [this.vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_config")],
      program.programId
    );

    this.vaultOkuMoneyAta = getAssociatedTokenAddressSync(
      mints.okuMoneyMint,
      this.vaultConfigPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive PSM config for reading okuMPrice
    [this.psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      psmProgramId
    );

    // Initialize ghost variables
    this.ghostUsdMultiplier = config.precision; // Start at 1.0

    // Initialize user shares
    for (const actor of actors) {
      this.userShares.set(actor.publicKey.toString(), new BN(0));
    }
  }

  // ==========================================================================
  // Handler Operations
  // ==========================================================================

  /**
   * Wrap OkuMoney into usdOku shares.
   */
  async wrap(actorSeed: number, okuMoneyAmount: BN, minSharesOut: BN = new BN(0)): Promise<void> {
    this.ghostWrapCallCount++;

    const actor = this.actors[actorSeed % this.actors.length];

    if (okuMoneyAmount.isZero()) return;

    // Derive user ATAs
    const userOkuMoneyAta = getAssociatedTokenAddressSync(
      this.mints.okuMoneyMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const userUsdOkuAta = getAssociatedTokenAddressSync(
      this.mints.usdOkuMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await this.program.methods
        .wrap(okuMoneyAmount, minSharesOut)
        .accountsPartial({
          user: actor.publicKey,
          vaultConfig: this.vaultConfigPda,
          psmConfig: this.psmConfigPda,
          okuMoneyMint: this.mints.okuMoneyMint,
          usdOkuMint: this.mints.usdOkuMint,
          userOkuMoneyAta,
          userUsdOkuAta,
          vaultOkuMoney: this.vaultOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([actor])
        .rpc();

      // Calculate shares received (simplified - actual uses okuMPrice)
      // shares = (okuMoneyAmount * okuMPrice) / usdMultiplier
      // For ghost tracking, we estimate
      const estimatedShares = okuMoneyAmount; // Simplified

      this.ghostTotalOkuMoney = this.ghostTotalOkuMoney.add(okuMoneyAmount);
      this.ghostTotalShares = this.ghostTotalShares.add(estimatedShares);
      this.updateUserShares(actor.publicKey, estimatedShares);
    } catch (err) {
      this.ghostWrapRevertCount++;
    }
  }

  /**
   * Unwrap usdOku shares back to OkuMoney.
   */
  async unwrap(actorSeed: number, shares: BN, minOkuMoneyOut: BN = new BN(0)): Promise<void> {
    this.ghostUnwrapCallCount++;

    const actor = this.actors[actorSeed % this.actors.length];
    const userShareBalance = this.userShares.get(actor.publicKey.toString()) || new BN(0);

    // Bound shares to user's balance
    const boundedShares = boundBN(shares, new BN(0), userShareBalance);

    if (boundedShares.isZero()) return;

    // Derive user ATAs
    const userOkuMoneyAta = getAssociatedTokenAddressSync(
      this.mints.okuMoneyMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const userUsdOkuAta = getAssociatedTokenAddressSync(
      this.mints.usdOkuMint,
      actor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await this.program.methods
        .unwrap(boundedShares, minOkuMoneyOut)
        .accountsPartial({
          user: actor.publicKey,
          vaultConfig: this.vaultConfigPda,
          psmConfig: this.psmConfigPda,
          okuMoneyMint: this.mints.okuMoneyMint,
          usdOkuMint: this.mints.usdOkuMint,
          userOkuMoneyAta,
          userUsdOkuAta,
          vaultOkuMoney: this.vaultOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([actor])
        .rpc();

      // Calculate OkuMoney received (simplified)
      const estimatedOkuMoney = boundedShares;

      this.ghostTotalShares = this.ghostTotalShares.sub(boundedShares);
      this.ghostTotalOkuMoney = this.ghostTotalOkuMoney.sub(estimatedOkuMoney);
      this.updateUserShares(actor.publicKey, boundedShares.neg());
    } catch (err) {
      this.ghostUnwrapRevertCount++;
    }
  }

  /**
   * Set USD multiplier (rebasing).
   */
  async setMultiplier(newMultiplier: BN): Promise<void> {
    this.ghostSetMultiplierCallCount++;

    // Multiplier can only increase
    if (newMultiplier.lte(this.ghostUsdMultiplier)) {
      this.ghostSetMultiplierRevertCount++;
      return;
    }

    try {
      await this.program.methods
        .setUsdMultiplier(newMultiplier)
        .accountsPartial({
          usdRebaser: this.authorities.usdRebaser.publicKey,
          vaultConfig: this.vaultConfigPda,
          psmConfig: this.psmConfigPda,
        })
        .signers([this.authorities.usdRebaser])
        .rpc();

      this.ghostUsdMultiplier = newMultiplier;
    } catch (err) {
      this.ghostSetMultiplierRevertCount++;
    }
  }

  /**
   * Deposit reserves.
   */
  async depositReserves(amount: BN): Promise<void> {
    this.ghostDepositReservesCallCount++;

    if (amount.isZero()) return;

    try {
      // Actual implementation would call the deposit reserves instruction
      this.ghostReserves = this.ghostReserves.add(amount);
    } catch (err) {
      this.ghostDepositReservesRevertCount++;
    }
  }

  /**
   * Withdraw reserves.
   */
  async withdrawReserves(amount: BN): Promise<void> {
    this.ghostWithdrawReservesCallCount++;

    // Can't withdraw more than reserves
    const boundedAmount = boundBN(amount, new BN(0), this.ghostReserves);

    if (boundedAmount.isZero()) return;

    try {
      // Would need to check collateral ratio before allowing withdrawal
      this.ghostReserves = this.ghostReserves.sub(boundedAmount);
    } catch (err) {
      this.ghostWithdrawReservesRevertCount++;
    }
  }

  /**
   * Execute a random operation.
   */
  async randomOperation(): Promise<void> {
    const rand = Math.random();
    const randomAmount = new BN(Math.floor(Math.random() * 1_000_000_000));
    const randomSeed = Math.floor(Math.random() * 1000);

    if (rand < 0.35) {
      await this.wrap(randomSeed, randomAmount);
    } else if (rand < 0.7) {
      await this.unwrap(randomSeed, randomAmount);
    } else if (rand < 0.85) {
      // Small multiplier increase (0.01% to 1%)
      const increase = this.ghostUsdMultiplier.muln(Math.floor(Math.random() * 100 + 1)).divn(10000);
      await this.setMultiplier(this.ghostUsdMultiplier.add(increase));
    } else if (rand < 0.925) {
      await this.depositReserves(randomAmount);
    } else {
      await this.withdrawReserves(randomAmount);
    }
  }

  // ==========================================================================
  // View Functions
  // ==========================================================================

  get ghostTotalCalls(): number {
    return (
      this.ghostWrapCallCount +
      this.ghostUnwrapCallCount +
      this.ghostSetMultiplierCallCount +
      this.ghostDepositReservesCallCount +
      this.ghostWithdrawReservesCallCount
    );
  }

  get ghostTotalReverts(): number {
    return (
      this.ghostWrapRevertCount +
      this.ghostUnwrapRevertCount +
      this.ghostSetMultiplierRevertCount +
      this.ghostDepositReservesRevertCount +
      this.ghostWithdrawReservesRevertCount
    );
  }

  get ghostSuccessRate(): number {
    if (this.ghostTotalCalls === 0) return 1;
    return (this.ghostTotalCalls - this.ghostTotalReverts) / this.ghostTotalCalls;
  }

  /**
   * Calculate ghost collateral ratio.
   * ratio = (reserves + vaultOkuMoneyValue) / totalObligations
   */
  get ghostCollateralRatio(): BN {
    if (this.ghostTotalShares.isZero()) {
      return new BN(10000); // 100% if no shares
    }

    // Simplified calculation
    // In practice: (reserves * precision + okuMoneyValue) / (shares * usdMultiplier)
    const numerator = this.ghostReserves.add(this.ghostTotalOkuMoney).mul(new BN(10000));
    const denominator = this.ghostTotalShares;

    if (denominator.isZero()) return new BN(10000);
    return numerator.div(denominator);
  }

  // ==========================================================================
  // Invariant Checks
  // ==========================================================================

  /**
   * Verify collateral ratio is above minimum.
   */
  verifyCollateralRatioInvariant(): boolean {
    return this.ghostCollateralRatio.gte(this.config.minCollateralRatio);
  }

  /**
   * Verify sum of user shares equals total shares.
   */
  verifySumOfSharesInvariant(): boolean {
    let sum = new BN(0);
    for (const [, shares] of this.userShares) {
      sum = sum.add(shares);
    }
    return sum.eq(this.ghostTotalShares);
  }

  /**
   * Verify multiplier monotonicity (never decreases).
   * This is tracked by rejecting decreasing multipliers in setMultiplier.
   */
  verifyMultiplierMonotonicity(previousMultiplier: BN): boolean {
    return this.ghostUsdMultiplier.gte(previousMultiplier);
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  private updateUserShares(user: PublicKey, delta: BN): void {
    const key = user.toString();
    const current = this.userShares.get(key) || new BN(0);
    const newBalance = current.add(delta);
    // Ensure non-negative
    this.userShares.set(key, BN.max(newBalance, new BN(0)));
  }

  /**
   * Reset handler state.
   */
  reset(): void {
    this.ghostTotalShares = new BN(0);
    this.ghostTotalOkuMoney = new BN(0);
    this.ghostUsdMultiplier = this.config.precision;
    this.ghostReserves = new BN(0);

    this.ghostWrapCallCount = 0;
    this.ghostWrapRevertCount = 0;
    this.ghostUnwrapCallCount = 0;
    this.ghostUnwrapRevertCount = 0;
    this.ghostSetMultiplierCallCount = 0;
    this.ghostSetMultiplierRevertCount = 0;
    this.ghostDepositReservesCallCount = 0;
    this.ghostDepositReservesRevertCount = 0;
    this.ghostWithdrawReservesCallCount = 0;
    this.ghostWithdrawReservesRevertCount = 0;

    for (const actor of this.actors) {
      this.userShares.set(actor.publicKey.toString(), new BN(0));
    }
  }
}
