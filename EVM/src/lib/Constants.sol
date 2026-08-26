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

    /// @notice Ceiling on a single `M_oku` step, in basis points.
    /// @dev Binds together with `MAX_FEE_BPS` via the step-coverage invariant
    ///      `tin + tout >= stepBps`: a step larger than the round-trip fee can
    ///      cover is refused (`StepNotCovered`), so the *effective* ceiling is
    ///      `min(MAX_STEP_BPS, tin + tout)`.
    ///
    ///      At a 5% annual target a daily step is ~1.34 bps, weekly ~9.6 bps,
    ///      monthly ~40.7 bps. 100 bps covers steps up to roughly a 2.4-month
    ///      cadence.
    ///
    ///      PLACEHOLDER — needs a treasury number and a published cadence.
    ///
    ///      SVM mirror: `oku_shared::MAX_STEP_BPS`.
    uint256 internal constant MAX_STEP_BPS = 100;

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

    // ============ Post-step sync window ============
    //
    // `M_oku` is stepwise and written on every chain by the same orchestrator
    // tick. A tick is not atomic across chains, so for a short interval the two
    // sides price a raw token differently. Each chain fences ITSELF: every
    // `setOkuMultiplier` write auto-arms a bounded lock on the operations that
    // price through the multiplier. There is no cross-chain epoch protocol —
    // parity is verified off-chain by comparing the multiplier VALUES directly
    // (`check-sync-parity.ts`), which is strictly stronger than any epoch
    // bookkeeping (equal epochs never proved equal values).
    //
    // The window is NOT a step-arbitrage defence: holding raw across a step
    // needs no transaction while the window is open, so no window length deters
    // it. The step-coverage invariant (`tin + tout >= stepBps`) is the control.

    /// @notice Hard ceiling on the post-step sync window.
    /// @dev Liveness backstop: mint/redeem resume unaided after at most this
    ///      long. There is no code path that extends a window past this bound,
    ///      which is what stops the mechanism becoming an indefinite pause held
    ///      by a key warmer than `PSM_UNPAUSER`.
    ///
    ///      SVM mirror: `oku_shared::MAX_SYNC_WINDOW_SECS`.
    uint256 internal constant MAX_SYNC_WINDOW = 15 minutes;

    /// @notice Sync window length written at `initialize`.
    /// @dev Deployments ship with the window ON. A zero default would leave the
    ///      protection installed but inert, and therefore dependent on someone
    ///      remembering to enable it — the class of dependency this design
    ///      exists to remove.
    ///
    ///      A cross-chain propagation budget, not an economic parameter: it need
    ///      only cover the time between the first chain's write and the last's.
    ///
    ///      SVM mirror: `oku_shared::DEFAULT_SYNC_WINDOW_SECS`.
    uint256 internal constant DEFAULT_SYNC_WINDOW = 60;

    // ============ Module fees ============

    /// @notice Hard ceiling on `tin` / `tout`, in basis points (100 = 1%).
    /// @dev Anti-confiscation bound AND the binding constraint on maximum step
    ///      size via step coverage. The worst case of a compromised cold key is
    ///      a 1% haircut per side rather than seizure of every mint and
    ///      redemption.
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
