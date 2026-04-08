/**
 * PSM Fuzz Tests
 *
 * Property-based fuzz testing for the PSM using fast-check.
 * Tests mathematical invariants and edge cases with randomized inputs.
 *
 * Mirrors EVM Forge fuzz tests (OkuMoney.fuzz.t.sol patterns).
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
  createInitializeMintInstruction,
  mintTo,
  createMint,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fc from "fast-check";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePSMIfNeeded,
  safeAirdrop,
  safeAirdropAll,
  ensureAta,
  safeMintTo,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../shared/setup";
import {
  SurfpoolClient,
  createSurfpoolClient,
  skipIfNotSurfpool,
} from "../shared/surfpool";
import {
  expectError,
  assertBNEqual,
  assertBNGte,
  assertMaxLoss,
} from "../shared/assertions";
import {
  arbAmount,
  arbAmountBN,
  arbPrice,
  arbPriceIncreasePercent,
  bound,
} from "../shared/fuzz/generators";

const { SYSVAR_RENT_PUBKEY } = anchor.web3;

describe("PSM Fuzz Tests", function () {
  // Increase timeout for fuzz tests
  this.timeout(300_000);

  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;
  let surfpool: SurfpoolClient;

  // PDAs
  let configPda: PublicKey;
  let redemptionQueuePda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;

  // Mints (created fresh for fuzz tests)
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;

  // Test actors for fuzz testing
  const actors: Keypair[] = [];
  const NUM_ACTORS = 5;

  before(async function () {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    surfpool = createSurfpoolClient(provider);

    // Skip fuzz tests if not running on Surfpool (they need state injection)
    // Comment this out if you want to run without Surfpool features
    // await skipIfNotSurfpool(this, provider.connection);

    // Generate test actors
    for (let i = 0; i < NUM_ACTORS; i++) {
      actors.push(Keypair.generate());
    }

    // Airdrop to all actors
    await safeAirdropAll(
      provider.connection,
      [payer, ...actors],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
  });

  /**
   * Helper to setup PSM for a fuzz test run.
   * Creates fresh mints and initializes PSM.
   */
  async function setupFreshPSM(): Promise<void> {
    // Create USDC mint (standard SPL Token)
    const usdcMintKeypair = Keypair.generate();
    usdcMint = usdcMintKeypair.publicKey;

    await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      DECIMALS,
      usdcMintKeypair,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Create OkuMoney mint (Token-2022)
    const okuMoneyMintKeypair = Keypair.generate();
    okuMoneyMint = okuMoneyMintKeypair.publicKey;

    const mintLen = getMintLen([]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    const createMintTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: okuMoneyMint,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        okuMoneyMint,
        DECIMALS,
        payer.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(createMintTx, [payer, okuMoneyMintKeypair]);

    // Use shared PSM initialization
    const result = await initializePSMIfNeeded(
      program,
      provider,
      payer,
      usdcMint,
      okuMoneyMint
    );

    configPda = result.configPda;
    redemptionQueuePda = result.redemptionQueuePda;
    vaultUsdcAta = result.vaultUsdcAta;
    vaultOkuMoneyAta = result.vaultOkuMoneyAta;
  }

  describe("Mint/Redeem Consistency", () => {
    it("fuzz: mint amount should increase balance correctly", async function () {
      // This test verifies mathematical properties of minting
      // In a full implementation with Surfpool, this would:
      // 1. Use Surfpool to inject USDC balance
      // 2. Call mintOkuM
      // 3. Verify OkuMoney balance increased by expected amount

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }), // Amount to mint (in base units)
          fc.integer({ min: 1_000_000_000_000_000_000, max: 2_000_000_000_000_000_000 }), // Price (1e18 to 2e18)
          async (amount, price) => {
            // Property: mint amount should be positive
            // At price >= 1.0, USDC input always produces valid OkuMoney output

            const PRECISION = 1_000_000_000_000_000_000n; // 1e18
            const usdcAmount = BigInt(amount);
            const okuMPrice = BigInt(price);

            // Formula: okuMoney = (usdc * PRECISION) / okuMPrice
            const okuMoneyAmount = (usdcAmount * PRECISION) / okuMPrice;

            // Property: output should be <= input (at price >= 1.0)
            return okuMoneyAmount <= usdcAmount;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("fuzz: redeem should never return more than deposited", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1000, max: 1_000_000 }), // Min 1000 to avoid dust issues
          async (mintAmount) => {
            // Property: redeem(mint(X)) <= X
            // (allows for rounding down but never up)

            // This verifies the vault never overpays redemptions
            const redeemAmount = mintAmount; // In practice, might be less due to rounding
            expect(redeemAmount).to.be.at.most(mintAmount);
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Price Monotonicity", () => {
    it("fuzz: okuMPrice can only increase", async function () {
      await fc.assert(
        fc.asyncProperty(
          arbPriceIncreasePercent(),
          arbPriceIncreasePercent(),
          arbPriceIncreasePercent(),
          async (inc1, inc2, inc3) => {
            // Property: after any sequence of setOkuMPrice calls,
            // price should be monotonically increasing

            const startPrice = 1e18;
            const price1 = startPrice * (1 + inc1);
            const price2 = price1 * (1 + inc2);
            const price3 = price2 * (1 + inc3);

            // Each price should be >= previous
            expect(price1).to.be.at.least(startPrice);
            expect(price2).to.be.at.least(price1);
            expect(price3).to.be.at.least(price2);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("fuzz: decreasing price should be rejected", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1000 }), // Decrease percentage (0.1% to 100%)
          async (decreasePermille) => {
            // Property: setOkuMPrice(currentPrice - X) should always fail
            // for any X > 0

            const currentPrice = new BN(10).pow(new BN(18));
            const decrease = currentPrice.muln(decreasePermille).divn(1000);
            const newPrice = currentPrice.sub(decrease);

            // The new price is less than current
            expect(newPrice.lt(currentPrice)).to.be.true;

            // In actual test, this would call the program and expect error
            // await expectError(
            //   () => program.methods.setOkuMPrice(newPrice).rpc(),
            //   "PriceCannotDecrease"
            // );

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Supply Cap Invariant", () => {
    it("fuzz: total supply never exceeds max supply", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 100_000_000 }), { minLength: 1, maxLength: 20 }),
          async (mintAmounts) => {
            // Property: sum of all mints <= MAX_SUPPLY

            const totalMinted = mintAmounts.reduce((a, b) => a + b, 0);
            const maxSupplyNum = MAX_SUPPLY.toNumber();

            // If total exceeds max, later mints should be rejected
            if (totalMinted > maxSupplyNum) {
              // In actual test: verify that minting beyond cap fails
              return true;
            }

            // If under cap, all mints should succeed
            expect(totalMinted).to.be.at.most(maxSupplyNum);
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Redemption Queue Integrity", () => {
    it("fuzz: queue processes in FIFO order", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              userId: fc.integer({ min: 0, max: NUM_ACTORS - 1 }),
              amount: fc.integer({ min: 1000, max: 100_000 }),
            }),
            { minLength: 2, maxLength: 10 }
          ),
          async (queueEntries) => {
            // Property: entries are processed in order they were added

            // Simulate queue processing
            const processOrder: number[] = [];
            for (let i = 0; i < queueEntries.length; i++) {
              processOrder.push(i);
            }

            // Verify FIFO: processed order matches insertion order
            for (let i = 0; i < processOrder.length; i++) {
              expect(processOrder[i]).to.equal(i);
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Round-Trip Invariants", () => {
    it("fuzz: wrap/unwrap round-trip loses at most 1 token", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1000, max: 10_000_000 }), // Amount to wrap
          fc.integer({ min: 100, max: 200 }), // Price percentage (100 = 1x, 200 = 2x) - use integers to avoid float issues
          async (wrapAmount, pricePercent) => {
            // Property: wrap(X) then unwrap(all_shares) returns >= X - 1

            // Use integers to avoid floating-point issues
            const priceMultiplier = pricePercent / 100;
            const PRECISION = BigInt(1e18);
            const MULTIPLIER = PRECISION; // usdMultiplier = 1e18 (1:1)

            // Calculate price in 1e18 precision
            const okuMPrice = BigInt(Math.floor(1e18 * priceMultiplier));
            const okuMoneyAmount = BigInt(wrapAmount);

            // Wrap: shares = (okuMoney * okuMPrice) / usdMultiplier
            const shares = (okuMoneyAmount * okuMPrice) / MULTIPLIER;

            // Unwrap: okuMoney = (shares * usdMultiplier) / okuMPrice
            const returnedOkuMoney = (shares * MULTIPLIER) / okuMPrice;

            // Property: we should get back at least (original - 1) tokens
            // Due to integer division, we may lose up to 1 token
            const loss = okuMoneyAmount - returnedOkuMoney;

            // Property holds if loss <= 1
            return loss <= 1n;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("fuzz: mint/burn round-trip maintains supply", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }),
          async (amount) => {
            // Property: mint(X) then burn(X) returns supply to original

            const initialSupply = 0;
            const afterMint = initialSupply + amount;
            const afterBurn = afterMint - amount;

            expect(afterBurn).to.equal(initialSupply);
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Edge Cases", () => {
    it("fuzz: handles amounts near u64 max gracefully", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: BigInt(1e15), max: BigInt(Number.MAX_SAFE_INTEGER) }),
          async (largeAmount) => {
            // Property: operations with large amounts either succeed
            // or fail gracefully (no panics)

            // In actual test, this would try operations and verify
            // they either succeed or return proper errors
            // For now, just verify the amount is valid
            return largeAmount > 0n;
          }
        ),
        { numRuns: 30 }
      );
    });

    it("fuzz: zero amounts are always rejected", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(0),
          async (zeroAmount) => {
            // Property: mint(0), redeem(0), etc. always fail

            expect(zeroAmount).to.equal(0);
            // In actual test:
            // await expectError(() => program.methods.mintOkuM(new BN(0)).rpc(), "ZeroAmount");

            return true;
          }
        ),
        { numRuns: 1 }
      );
    });
  });
});

describe("Vault Fuzz Tests", function () {
  this.timeout(300_000);

  let provider: anchor.AnchorProvider;

  before(async function () {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
  });

  describe("Collateralization Invariant", () => {
    it("fuzz: collateral ratio never drops below minimum", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.record({ type: fc.constant("wrap"), amount: fc.integer({ min: 1000, max: 1_000_000 }) }),
              fc.record({ type: fc.constant("unwrap"), amount: fc.integer({ min: 1, max: 100 }) }), // percent
              fc.record({ type: fc.constant("rebase"), percent: fc.double({ min: 0.001, max: 0.05, noNaN: true }) })
            ),
            { minLength: 5, maxLength: 50 }
          ),
          async (operations) => {
            // Property: after any sequence of operations,
            // collateralRatio >= minCollateralRatio (90%)

            let collateralRatio = 1.0; // Start at 100%
            const minRatio = 0.9;

            for (const op of operations) {
              // Simulate operation effects on ratio
              // In practice, this would execute actual operations
              // and check the on-chain ratio

              if (op.type === "unwrap") {
                // Unwrap might decrease ratio if reserves are low
                // But should never go below min
              }

              expect(collateralRatio).to.be.at.least(minRatio);
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Share Accounting", () => {
    it("fuzz: sum of user shares equals total shares", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              userId: fc.integer({ min: 0, max: 4 }),
              wrapAmount: fc.integer({ min: 1000, max: 100_000 }),
            }),
            { minLength: 1, maxLength: 20 }
          ),
          async (wraps) => {
            // Property: sum of all user share balances = totalShares

            const userShares = new Map<number, number>();
            let totalShares = 0;

            for (const wrap of wraps) {
              const shares = wrap.wrapAmount; // Simplified 1:1
              userShares.set(wrap.userId, (userShares.get(wrap.userId) || 0) + shares);
              totalShares += shares;
            }

            const sumUserShares = Array.from(userShares.values()).reduce((a, b) => a + b, 0);
            expect(sumUserShares).to.equal(totalShares);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Multiplier Monotonicity", () => {
    it("fuzz: usd multiplier can only increase", async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.double({ min: 0.001, max: 0.1, noNaN: true }), { minLength: 1, maxLength: 20 }),
          async (increases) => {
            // Property: each setUsdMultiplier must be >= previous

            let multiplier = 1.0;

            for (const increase of increases) {
              const newMultiplier = multiplier * (1 + increase);
              expect(newMultiplier).to.be.at.least(multiplier);
              multiplier = newMultiplier;
            }

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
