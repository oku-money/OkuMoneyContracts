// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants for the Oku Money contract suite.
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * NAMING:
 *   - Oku Money / OkuM   : Non-rebasing base token (contract name + ticker)
 *   - Oku Dollar / USDOku: Rebasing $1-denominated token (contract name + ticker)
 *
 * THE TWO INDICES:
 *   - M_oku (`uiMultiplier`): dollars per OkuM. Continuous, REAR-FACING — its rate is
 *     derived from yield the issuer has ALREADY banked, then delivered smoothly over
 *     the following window. This single number serves three roles simultaneously:
 *       1. ERC-8056 `uiMultiplier()`   (what wallets display)
 *       2. LitePSM mint/redeem price   (what USDC converts at)
 *       3. OkuM <-> USDOku conversion  (what wrap/unwrap convert at)
 *     They MUST be the same number. A display price that differs from the redemption
 *     price is two prices for one token.
 *
 *   - M_usd (`usdMultiplier`): USDOku's share -> dollar index. Continuous,
 *     FORWARD-LOOKING — a declared steady headline rate. It does NOT participate in
 *     the OkuM <-> USDOku exchange rate; it cancels algebraically out of `wrap`
 *     (shares are minted at `M_oku/M_usd` then valued back at `M_usd`) and does not
 *     appear in `unwrap`'s payout at all. Its only job is to make USDOku rebase.
 *
 * WHY M_oku IS CONTINUOUS RATHER THAN STEPPED:
 *   A discrete step is a free round-trip for anyone holding across it, and — more
 *   importantly for this deployment — it cannot be synchronised across chains. A
 *   continuous segment anchored to ABSOLUTE wall-clock time is a pure function of
 *   `block.timestamp`, so identical segment parameters yield an identical index on
 *   every chain at every instant, with no messaging, oracle, or sync window. See
 *   {IOkuM.setOkuMRate}.
 *
 * TOKEN AMOUNTS:
 *   - okuMAmount: raw OkuM token count (18dp, non-rebasing)
 *   - usdAmount:  USDOku amount in dollar terms (18dp, rebasing via M_usd)
 *   - usdcAmount: USDC in its native decimals (resolved per-deployment)
 *
 * KEY FORMULAS:
 *   USDC   -> OkuM:          okuMAmount = (usdcAmount * decimalMultiplier) * PRECISION / M_oku
 *   OkuM   -> USDC:          usdcAmount = (okuMAmount * M_oku / PRECISION) / decimalMultiplier
 *   OkuM   -> USDOku shares: shares     = okuMAmount * M_oku / M_usd
 *   USDOku -> OkuM:          okuMAmount = usdAmount * PRECISION / M_oku
 *
 * ============================================
 */
library Constants {
    /// @notice Fixed-point base for multipliers, rates and shares (1e18 = 1.0 = $1.00).
    uint256 public constant PRECISION = 1e18;

    /// @notice Basis points denominator (10_000 = 100%).
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Annualization base for APR conversions.
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ============ Accrual bounds ============
    //
    // These three constants are the ONLY on-chain guarantee that OkuM does not pay
    // out yield the issuer has not realized. That guarantee cannot be proven on-chain
    // — OkuM's backing is off-chain RWA and no contract can inspect it — so it is
    // procedural, and these bound the blast radius if the procedure fails or a key is
    // compromised:
    //
    //   worst-case unrealized accrual <= MAX_IMPLIED_APR_BPS applied for
    //                                    MAX_RATE_DURATION, after which accrual
    //                                    FLATLINES until a fresh operator action.
    //
    // Bounded and self-healing. Anything stronger requires an independent attester
    // (RWA custodian signature or a Proof-of-Reserve feed) — see TRACKER.md.

    /// @notice Nominal (simple) annualized cap on a declared rate's implied APR, in bps.
    /// @dev At the cap, delivered APY via per-second compounding is ~10.52%, and the
    ///      worst-case over-accrual from a compromised key is ~0.82% per 30-day
    ///      segment. PLACEHOLDER pending treasury sign-off — tracked in TRACKER.md.
    uint256 public constant MAX_IMPLIED_APR_BPS = 1000;

    /// @notice Per-second compounding-rate ceiling implied by {MAX_IMPLIED_APR_BPS}.
    /// @dev DERIVED, not independently set: this expression is the single source of
    ///      truth for the per-second cap {OkuM.setOkuMRate} actually enforces.
    ///      Previously this was a hand-precomputed literal (`PRECISION +
    ///      3_170_979_198`) that had no on-chain link back to `MAX_IMPLIED_APR_BPS` —
    ///      changing that constant silently left the enforced cap untouched. Solidity
    ///      folds this at compile time, so there is no runtime cost to deriving it.
    ///      Verified: compounded over `SECONDS_PER_YEAR` this yields ~10.517% APY,
    ///      over 30 days ~0.8253%.
    uint256 public constant MAX_RATE_PER_SECOND =
        PRECISION + (PRECISION * MAX_IMPLIED_APR_BPS / BASIS_POINTS) / SECONDS_PER_YEAR;

    /// @notice Maximum span of a single rate segment.
    /// @dev A missed renewal freezes accrual rather than compounding unboundedly. The
    ///      cap also binds catch-up, so a long outage cannot be fully compensated in
    ///      one segment — deliberate.
    uint256 public constant MAX_RATE_DURATION = 30 days;

    /// @notice How far ahead of `block.timestamp` a segment may be scheduled to start.
    /// @dev Forward scheduling is what makes multichain synchronisation work: publish
    ///      the same segment on every chain BEFORE `startTime`, and all chains switch
    ///      simultaneously by wall clock regardless of when each transaction landed.
    ///      This is also exactly ERC-8056's `effectiveAt` semantics — the pending
    ///      segment IS the pending multiplier. Bounded so a scheduled segment cannot
    ///      be parked indefinitely far out where it is easy to forget.
    uint256 public constant MAX_SCHEDULE_LEAD = 30 days;

    /// @notice Largest instantaneous jump permitted when installing a new segment, in bps.
    /// @dev Normally ZERO is used: an on-time declaration supplies a `baseIndex` exactly
    ///      equal to the index the live segment already reaches at `startTime`, so the
    ///      curve is continuous and there is no jump at all.
    ///
    ///      The tolerance exists solely for CATCH-UP. Because `baseIndex` is supplied as
    ///      an absolute value (which is what lets a chain that missed a segment self-heal
    ///      rather than diverge permanently), a late chain installs a base slightly above
    ///      its locally-computed index. At 10 bps that permits roughly a week of catch-up
    ///      at a 5% APR while capping any single step at 0.1%.
    ///
    ///      This is what makes "no step arbitrage" a CONTRACT-ENFORCED property rather
    ///      than a procedural one: even a fully compromised `OKUM_RATE_SETTER` cannot
    ///      manufacture a step larger than this.
    uint256 public constant MAX_REANCHOR_BPS = 10;

    /// @notice Largest instantaneous jump permitted when installing a new USDOku
    ///         segment, in bps. The `M_usd`-side analogue of {MAX_REANCHOR_BPS}.
    /// @dev Unlike OkuM's re-anchor, this does NOT also require immediate effect:
    ///      `M_usd` is a declared FORWARD rate that legitimately schedules ahead of
    ///      time as a matter of course (that is its whole purpose), unlike an OkuM
    ///      re-anchor, which is specifically a one-off catch-up for a chain that fell
    ///      behind. Only the JUMP MAGNITUDE needs bounding here — an unbounded jump
    ///      would let a rate setter (or the same compromised key) instantly reallocate
    ///      value to whoever holds USDOku shares at the moment of declaration, backed
    ///      only by `backingCoversLiability` (a vault-solvency check, not a step-size
    ///      one). Same numeric placeholder as {MAX_REANCHOR_BPS} pending calibration —
    ///      tracked in TRACKER.md alongside the other rate constants.
    uint256 public constant MAX_USD_REANCHOR_BPS = 10;

    /// @notice Absolute ceiling for any cumulative multiplier (`M_oku` and `M_usd`).
    /// @dev `1e24` = $1,000,000 per token. Keeps downstream `uint256 * uint256`
    ///      products away from the overflow region. Mirrors the SVM-side
    ///      `MAX_MULTIPLIER` guard (scaled for SVM's 1e9 precision).
    uint256 public constant MAX_MULTIPLIER = 1e24;

    /// @notice Absolute ceiling on `maxSupply`, so `supply * multiplier` cannot overflow.
    /// @dev `MAX_TOTAL_SUPPLY * MAX_MULTIPLIER < type(uint256).max` — asserted as a
    ///      static invariant in the test suite.
    uint256 public constant MAX_TOTAL_SUPPLY = 1e33;

    // ============ Vault / solvency ============

    /// @notice How far USDOku's declared liability may outrun the OkuM backing it.
    /// @dev **ZERO: the forward rate must be PRE-FUNDED.** `setUsdOkuRate` requires the
    ///      liability projected to `rateEnd` to be already covered by OkuM held in the
    ///      vault, so the issuer funds the smoothing wedge BEFORE declaring a rate that
    ///      pays it.
    ///
    ///      This is what makes `backing >= liability` a MAINTAINED invariant rather
    ///      than a monitoring threshold, and it closes the defect where a grown USDOku
    ///      balance was not fully redeemable: earlier exiters were paid in full and the
    ///      last one out was stranded.
    ///
    ///      Rounding favours the invariant in both directions: `wrap` FLOORS the share
    ///      credit (building surplus) and `unwrap` CEILS the share burn (so liability
    ///      falls at least as fast as backing).
    uint256 public constant MAX_SOLVENCY_GAP_BPS = 0;

    /// @notice Maximum supported USDC decimal count.
    /// @dev Circle USDC is 6dp on every EVM chain; 18 is the ERC-20 upper bound.
    ///      Capping rather than hardcoding 6 is deliberate forward-compatibility.
    uint8 public constant MAX_USDC_DECIMALS = 18;

    // ============ ERC-165 interface IDs ============
    //
    // Verified against the published ERC-8056 draft. Asserted against
    // `type(I).interfaceId` in the test suite so a drifting interface fails the build
    // rather than silently breaking wallet detection.

    bytes4 public constant IID_SCALED_UI_AMOUNT = 0xa60bf13d;
    bytes4 public constant IID_SCALED_UI_NEW_MULTIPLIER = 0x4bd27648;
    bytes4 public constant IID_SCALED_UI_CONVERSION = 0x57854fc3;
    bytes4 public constant IID_SCALED_UI_BALANCES = 0xd890fd71;
}
