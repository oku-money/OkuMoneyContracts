// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants and ERC-8056 interface IDs for the OkuMoney contracts.
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * TWO TOKENS, TWO INDICES, ONE REALIZED BACKING:
 *   - OkuM   : the share token. Fixed raw balances; stepwise realized index.
 *   - USDOku : the dollar wrapper. Rebasing balances; continuous declared index.
 *
 * AMOUNTS:
 *   - rawAmount    : raw OkuM count — what `balanceOf`/`transfer`/`approve` move (18 dp)
 *   - uiAmount     : dollar value of an OkuM amount — what `balanceOfUI` returns (18 dp)
 *   - usdcAmount   : USDC amount in its native decimals (6 dp on every targeted chain)
 *   - shares       : USDOku's invariant ledger quantity — `sharesOf`
 *
 * INDICES:
 *   - M_oku / uiMultiplier : dollar value of 1 raw OkuM (starts 1e18 = $1.00).
 *                            STEPWISE, monotone, written by `setOkuMultiplier`.
 *   - M_usd / usdOkuIndex  : USDOku's rebase index. CONTINUOUS, monotone,
 *                            driven by `setUsdOkuRate`. NOT a conversion rate.
 *
 * KEY FORMULAS:
 *   USDC -> raw:    raw    = (usdcAmount * usdcDecimalMultiplier) * PRECISION / M_oku
 *   raw -> USDC:    usdc   = (raw * M_oku / PRECISION) / usdcDecimalMultiplier
 *   raw -> UI:      ui     = raw * M_oku / PRECISION          // toUIAmount
 *   UI -> raw:      raw    = ui * PRECISION / M_oku           // fromUIAmount
 *   OkuM -> USDOku: usdOku = okuM * M_oku / PRECISION         // wrap — M_oku, NOT M_usd
 *   USDOku -> OkuM: okuM   = usdOku * PRECISION / M_oku       // unwrap — M_oku, NOT M_usd
 *   USDOku balance: bal    = shares * M_usd / PRECISION
 *
 * ============================================
 */
library Constants {
    // ============ Fixed point ============

    /// @notice Standard precision for multiplier and rate math (1e18 = $1.00).
    /// @dev Doubly mandated: ERC-8056 requires 18-decimal multiplier precision.
    uint256 internal constant PRECISION = 1e18;

    /// @notice Basis-points denominator (10_000 = 100%).
    uint256 internal constant BASIS_POINTS = 10_000;

    /// @notice Seconds in a 365-day year, used to annualize `ratePerSecond`.
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    // ============ M_oku authority bounds (OkuM, stepwise) ============

    /// @notice Ceiling on a single `M_oku` step, in basis points. ALSO the floor
    ///         under `tout`.
    /// @dev THE single number defining the step-arbitrage defence, and the only
    ///      economic parameter this design really has. Two rules reference it:
    ///
    ///          OkuM.setOkuMultiplier:        stepBps <= MAX_STEP_BPS
    ///          SubscriptionModule.setFees:   tout    >= MAX_STEP_BPS
    ///
    ///      Composed, the largest mark the protocol can take is at most what the
    ///      exit fee charges, so the round trip mint-hold-redeem is loss-making
    ///      for every mark and every fee the contracts admit. No state, no
    ///      ratchet, no cross-contract read.
    ///
    ///      TOUT ONLY, NOT BOTH LEGS. The attacker's gain is realised on EXIT,
    ///      and the only exit that drains the buffer is `redeem`, which always
    ///      charges `tout`. `tin` is irrelevant to the attack — including
    ///      cross-chain, since whichever chain they exit on charges its own
    ///      `tout`. So deposits are free.
    ///
    ///      THE FEE IS THE PRICE OF DISCRETENESS, and the mark cadence is the
    ///      dial that sets it. One mark is worth `APY x interval`:
    ///
    ///          monthly   ~40.7 bps      weekly   ~9.6 bps
    ///          daily      ~1.37 bps     6-hourly ~0.34 bps
    ///          hourly     ~0.057 bps
    ///
    ///      Mark more often and the required fee approaches zero — which is
    ///      exactly why continuously-accruing designs (Maker's `chi`, Aave's
    ///      liquidity index, Ondo's USDY oracle) need no fee at all. We cannot
    ///      accrue continuously because Token-2022's `ScaledUiAmount` stores a
    ///      discrete multiplier, so this fee is the exact cost of that
    ///      constraint and nothing more.
    ///
    ///      AT 2 BPS, SIZED FOR A 6-HOURLY CADENCE: ~0.34 bps per mark leaves
    ///      ~6x headroom, and one mark can absorb ~1.5 days of catch-up after an
    ///      outage. A longer outage is walked over several marks.
    ///
    ///      Must satisfy `MAX_STEP_BPS <= MAX_FEE_BPS`, asserted in
    ///      `StepArbitrageTest`.
    ///
    ///      SVM mirror: `oku_shared::MAX_STEP_BPS`.
    uint256 internal constant MAX_STEP_BPS = 2;

    /// @notice Minimum wall-clock gap between two `M_oku` marks.
    /// @dev Makes `MAX_STEP_BPS` mean what everyone assumes it means.
    ///
    ///      Without this, `MAX_STEP_BPS` bounds ONE step but nothing bounds how
    ///      many land in a block: a compromised `OKU_RATE_SETTER` could loop
    ///      `setOkuMultiplier`, each call individually legal, and compound the
    ///      multiplier arbitrarily fast — bounded only by `MAX_MULTIPLIER`. The
    ///      per-step ceiling gave the APPEARANCE of bounding the rate of change
    ///      without doing so.
    ///
    ///      With it, yield is bounded per unit time rather than per call, which
    ///      is the property the exit fee is sized against.
    ///
    ///      Ondo enforces the same control on OUSG at 23 hours
    ///      (`RWAOracleRateCheck.MIN_PRICE_UPDATE_WINDOW`). One hour is chosen
    ///      instead because our cadence is far finer; it is well under the
    ///      intended 6-hourly interval, so it never binds in normal operation.
    ///
    ///      DOES NOT BLOCK INCIDENT RESPONSE: `haltAccrual` is separate,
    ///      immediate, and ungated. The lever for "this mark was wrong" is to
    ///      halt, not to overwrite within the hour.
    ///
    ///      SVM mirror: `oku_shared::MIN_MARK_INTERVAL_SECS`.
    uint256 internal constant MIN_MARK_INTERVAL = 1 hours;

    /// @notice Absolute ceiling for the cumulative `M_oku` multiplier.
    /// @dev `1e24` = $1,000,000 of value per raw token. Mirrors the SVM-side
    ///      `MAX_MULTIPLIER` guard (`oku-shared::constants::MAX_MULTIPLIER`,
    ///      scaled for SVM's 1e9 precision). Math-sanity bound, not a constraint
    ///      on a trusted operator. Also bounds the `M_usd` projection.
    uint256 internal constant MAX_MULTIPLIER = 1e24;

    // ============ M_usd authority bounds (USDOku, continuous) ============

    /// @notice Maximum nominal annualized rate accepted by `setUsdOkuRate`, in bps.
    /// @dev THE bound that actually binds `M_usd`. Annualization is
    ///      *simple/nominal*:
    ///      `apr = (ratePerSecond - PRECISION) * SECONDS_PER_YEAR / PRECISION`.
    ///      At 1000 bps the per-second ceiling is `PRECISION + 3_170_979_198`,
    ///      which continuously compounds to ~10.52% APY — the delivered APY is
    ///      therefore slightly above the nominal cap by construction. Documented
    ///      rather than corrected, because a monotonic-in-rate check is cheaper
    ///      and simpler to audit than an `rpow` round trip in the setter.
    ///
    ///      A short-duration T-Bill product cannot legitimately exceed this.
    ///      PLACEHOLDER — needs a real number.
    uint256 internal constant MAX_IMPLIED_APR = 1000;

    /// @notice Maximum `rateEnd - block.timestamp` accepted by `setUsdOkuRate`.
    /// @dev Caps the exposure window of any single rate write. Combined with
    ///      `MAX_IMPLIED_APR`, worst-case over-accrual from a compromised setter
    ///      key before anyone intervenes is ~0.82% (1000 bps over 30 days).
    ///
    ///      OPERATIONAL CONSEQUENCE: a missed re-up freezes USDOku yield until
    ///      someone acts, and because the APR cap also binds the catch-up rate,
    ///      a long outage cannot be fully compensated afterwards. This is the
    ///      operator-absence protection working as designed.
    uint256 internal constant MAX_RATE_DURATION = 30 days;

    /// @notice How far USDOku's declared liability may outrun realized backing,
    ///         in basis points of backing.
    /// @dev The number that defines the product's risk. A constant, not a config
    ///      field — no key can widen it. `setUsdOkuRate` reverts
    ///      `SolvencyGapExceeded` if the liability *projected to `rateEnd`*
    ///      would breach this bound against current realized backing. Because
    ///      `M_oku` is monotone, any step landing after the check only
    ///      *increases* backing, so the projection is conservative.
    ///
    ///      THIS IS A CUMULATIVE CEILING, NOT A PER-WRITE ONE, and the
    ///      distinction is not obvious from the code. Worst-case accrual inside
    ///      a single maximum-length segment is `MAX_IMPLIED_APR` over
    ///      `MAX_RATE_DURATION` ~= **79 bps**, which is *below* this bound. So no
    ///      single rate write starting from a zero gap can ever be refused: the
    ///      three constants interact such that this check only bites once
    ///      several consecutive segments have out-run realized marks.
    ///
    ///      That is a coherent design — the bound is the ceiling on accumulated
    ///      divergence, and the per-segment exposure is bounded separately by
    ///      the APR and duration caps — but it means anyone re-tuning these
    ///      numbers must tune them together. Setting this below ~79 bps makes it
    ///      the binding per-write constraint instead, which is a different
    ///      product. `SolvencyTest` asserts the cumulative behaviour explicitly
    ///      so the relationship cannot be changed silently.
    ///
    ///      PLACEHOLDER — needs treasury sign-off, not an engineering guess.
    ///
    ///      No SVM mirror: USDOku is EVM-only.
    uint256 internal constant MAX_SOLVENCY_GAP_BPS = 100;

    // ============ Supply ============

    /// @notice Hard ceiling on `maxSupply`, in raw units (1e15 whole tokens at 18 dp).
    /// @dev Enforced in BOTH `initialize` and `setMaxSupply`. `maxSupply` is
    ///      mutable by `OKU_CAP_MANAGER`, so an init-only assertion would
    ///      evaporate the first time the cap moved — this constant is what makes
    ///      the overflow invariant a theorem rather than an assumption.
    ///
    ///      `MAX_TOTAL_SUPPLY * MAX_MULTIPLIER = 1e57`, which is ~1e20x below
    ///      `type(uint256).max` (~1.158e77). Balances of this token therefore
    ///      cannot overflow the UI conversion even under a naive
    ///      multiply-then-divide; `Math.mulDiv` is used for explicit rounding
    ///      control and for the arbitrary-input public views, not because the
    ///      token's own balances need it. Asserted in `MulDivBoundsTest`.
    uint256 internal constant MAX_TOTAL_SUPPLY = 1e33;

    // ============ Post-step sync window — REMOVED ============
    //
    // `MAX_SYNC_WINDOW` and `DEFAULT_SYNC_WINDOW` are gone, along with the
    // mechanism. On EVM the window gated nothing: it was narrowed to "bridge
    // legs", and EVM has no bridge leg — `OkuM.mint`/`burn` are the shared
    // supply hooks the module and queue use for ordinary local subscription and
    // redemption, so gating them would gate the entire PSM.
    //
    // A future EVM bridge adapter needs no protocol state to reproduce it:
    //
    //     if (block.timestamp < okuM.lastSteppedAt() + PROPAGATION_BUDGET) revert;
    //
    // `lastSteppedAt` is stored anyway for ERC-8056's `effectiveAt()`. The check
    // belongs in the adapter, at the point of use.
    //
    // SVM keeps its window, where it gates two dedicated bridge instructions
    // (`mint_oku_m_direct` / `burn_oku_m_direct`) that genuinely move value
    // across a multiplier boundary as a pair.

    // ============ Module fees ============

    /// @notice Hard ceiling on `tin` / `tout`, in basis points (100 = 1%).
    /// @dev Anti-confiscation bound. The worst case of a compromised cold key is
    ///      a 1% haircut per side rather than seizure of every mint and
    ///      redemption.
    ///
    ///      Applies to both legs. Only `tout` also has a FLOOR
    ///      (`MAX_STEP_BPS`); `tin` is free to be zero, and ships that way. The
    ///      two constants interact only through `MAX_STEP_BPS <= MAX_FEE_BPS`,
    ///      without which `setFees` would admit no `tout` at all.
    ///
    ///      SVM mirror: `oku_shared::MAX_FEE_BPS`.
    uint256 internal constant MAX_FEE_BPS = 100;

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC is 6 dp on every targeted chain. Capping at 18 rather than
    ///      hardcoding 6 is intentional forward-compatibility with non-Circle
    ///      variants; above 18 the decimal multiplier would need a negative
    ///      exponent.
    uint8 internal constant MAX_USDC_DECIMALS = 18;

    // ============ ERC-8056 interface IDs ============
    //
    // From the Draft EIP's published table. Held as constants rather than inline
    // literals so a spec revision is a one-line change.
    //
    // PRECEDENCE RULE (decided up front, see EVM/README.md): the interface *text*
    // is normative, so `type(I).interfaceId` wins on any divergence from the
    // published literal, and `supportsInterface` returns true for BOTH until the
    // EIP is corrected. A false positive on a stale published ID is harmless — we
    // genuinely implement the functions — whereas a false negative silently
    // breaks every integrator performing ERC-165 detection.
    //
    // `ERC8056IdConformanceTest` asserts each constant against its computed
    // counterpart. All four match as of the 2025-10-20 draft.

    /// @notice `type(IScaledUIAmount).interfaceId`
    bytes4 internal constant IID_SCALED_UI_CORE = 0xa60bf13d;
    /// @notice `type(IScaledUIAmountNewUIMultiplier).interfaceId`
    bytes4 internal constant IID_SCALED_UI_PENDING = 0x4bd27648;
    /// @notice `type(IScaledUIAmountConversion).interfaceId`
    bytes4 internal constant IID_SCALED_UI_CONVERSION = 0x57854fc3;
    /// @notice `type(IScaledUIAmountBalances).interfaceId`
    bytes4 internal constant IID_SCALED_UI_BALANCES = 0xd890fd71;
}
