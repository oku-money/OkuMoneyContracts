// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants for the reviewed-conversion OkuMoney contract suite.
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * NAMING:
 *   - OkuM   : Non-rebasing share token. ERC-8056 display + 4626-shaped value views.
 *   - USDOku : Rebasing $1-denominated wrapper over OkuM.
 *
 * MULTIPLIERS:
 *   - M_oku / uiMultiplier: Dollar value of 1 raw OkuM. Stepwise, monotone.
 *   - M_usd / usdOkuIndex:  USDOku's continuous rebase index. NOT a conversion rate.
 *
 * AMOUNTS:
 *   - rawAmount: Raw OkuM count (18dp) — what `balanceOf`/`transfer` move.
 *   - uiAmount:  Dollar value of an OkuM amount — what `balanceOfUI` returns (18dp).
 *   - usdcAmount: USDC amount, native decimals (6dp on every chain targeted so far).
 *
 * All conversions round against the caller, in favour of the protocol.
 * See `EVM/README.md` for the full design rationale.
 * ==============================================
 */
library Constants {
    /// @notice Fixed-point base for multipliers, rates, and shares (1e18 = 1.0).
    uint256 public constant PRECISION = 1e18;

    /// @notice Basis points denominator (10_000 = 100%).
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Annualization base for APR/APY conversions.
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ============ M_oku authority ============

    /// @notice Ceiling on a single `setOkuMultiplier` step, in basis points.
    /// @dev Oracle-sanity bound against a compromised `OKU_RATE_SETTER` writing an
    ///      absurd step — NOT an arbitrage control (reviewed conversion removed that
    ///      threat model; see README "What reviewed conversion buys"). Derived from
    ///      a monthly mark cadence at a ~5% target annual yield (~42bps/month), sized
    ///      at ~2.4x so a single missed month can be caught up in one mark without
    ///      raising the ceiling.
    ///
    ///      PLACEHOLDER pending confirmation of the actual publish cadence — tracked
    ///      in TRACKER.md. Revisit if the operational cadence differs from monthly.
    uint256 public constant MAX_STEP_BPS = 100;

    /// @notice Absolute ceiling for any cumulative multiplier (`M_oku` and `M_usd`).
    /// @dev `1e24` = $1,000,000 of dollar value per token (`PRECISION` = $1.00). Keeps
    ///      downstream `uint256 * uint256` multiplications away from the overflow
    ///      region. `MAX_TOTAL_SUPPLY * MAX_MULTIPLIER` must stay below
    ///      `type(uint256).max` — asserted as a static invariant.
    uint256 public constant MAX_MULTIPLIER = 1e24;

    // ============ M_usd authority ============

    /// @notice Nominal (simple) annualized cap on `setUsdOkuRate`'s implied APR, in bps.
    /// @dev At the cap, delivered APY (via per-second compounding) is ~10.52%, and the
    ///      worst-case over-accrual from a compromised key is ~0.82% per 30-day
    ///      `MAX_RATE_DURATION` segment. See `MAX_USD_RATE_PER_SECOND` for the derived
    ///      per-second ceiling this bounds. PLACEHOLDER pending treasury sign-off —
    ///      tracked in TRACKER.md.
    uint256 public constant MAX_IMPLIED_APR_BPS = 1000;

    /// @notice Per-second compounding-rate ceiling implied by `MAX_IMPLIED_APR_BPS`.
    /// @dev `PRECISION + (PRECISION * MAX_IMPLIED_APR_BPS / BASIS_POINTS) / SECONDS_PER_YEAR`
    ///      = `PRECISION + 3_170_979_198`, precomputed as a constant (Solidity cannot
    ///      fold this division at compile time into a `constant` cheaply otherwise).
    ///      Verified: compounded over `SECONDS_PER_YEAR` this yields ~10.517% APY, and
    ///      over 30 days ~0.8253% — matching the figures documented above.
    uint256 public constant MAX_USD_RATE_PER_SECOND = PRECISION + 3_170_979_198;

    /// @notice Maximum exposure window of a single `setUsdOkuRate` write.
    /// @dev A missed renewal freezes yield rather than compounding unboundedly; a
    ///      long outage cannot be fully compensated because the cap also binds catch-up.
    uint256 public constant MAX_RATE_DURATION = 30 days;

    /// @notice How far USDOku's declared liability may outrun realized backing.
    /// @dev **ZERO: the forward rate must be PRE-FUNDED.** `setUsdOkuRate` requires
    ///      the liability projected to `rateEnd` to be already covered by OkuM held
    ///      in `USDOkuWrapper`, so the issuer must transfer the forward yield into
    ///      the wrapper *before* declaring a rate that pays it. Smoothing survives;
    ///      it simply has to be funded rather than promised out of future returns.
    ///
    ///      This makes `backing >= liability` a genuinely MAINTAINED invariant, not
    ///      a monitoring threshold:
    ///        - every `setUsdOkuRate` establishes it by projection to `rateEnd`;
    ///        - `wrap` moves both sides by the same dollar amount but FLOORS the
    ///          share credit, so it builds a small surplus;
    ///        - `unwrap` CEILS `sharesToBurn`, so liability falls at least as fast
    ///          as backing.
    ///      Rounding therefore favours the invariant in both directions.
    ///
    ///      Two consequences worth stating: `USDOkuWrapper.unwrap` can never revert
    ///      for want of reserves, and `withdrawSurplus` is safe to expose because
    ///      it can be gated on the same inequality.
    ///
    ///      A nonzero value would reintroduce a band in which a holder's displayed
    ///      USDOku balance is not fully redeemable. Do not raise it without
    ///      re-deciding who absorbs the shortfall.
    uint256 public constant MAX_SOLVENCY_GAP_BPS = 0;

    // ============ Supply ============

    /// @notice Ceiling on `maxSupply`, enforced in both `initialize` and `setMaxSupply`.
    /// @dev `maxSupply` is mutable, so an init-only assertion would evaporate the
    ///      first time the cap moved — and with it the overflow invariant on
    ///      `MAX_TOTAL_SUPPLY * MAX_MULTIPLIER`.
    uint256 public constant MAX_TOTAL_SUPPLY = 1e33;

    // ============ Requests ============

    /// @notice A request older than this cannot be fulfilled and must be resubmitted.
    /// @dev Bounds how stale a `minOut` slippage floor can be.
    uint256 public constant MAX_REQUEST_AGE = 7 days;

    /// @notice Minimum age before `cancelRequest` is callable.
    /// @dev Prevents submit-and-cancel probing of fulfillment timing. Does NOT
    ///      prevent fulfillment-racing after the delay elapses — that risk is
    ///      accepted, not eliminated; see `SubscriptionModule.cancelRequest`.
    uint256 public constant MIN_CANCEL_DELAY = 1 hours;

    // ============ Fees ============

    /// @notice Anti-confiscation ceiling on `tin` / `tout`.
    /// @dev Purely a commercial-parameter bound now — no permissionless round trip
    ///      exists for it to defend against (contrast the old PSM's step-coverage
    ///      floor, which this constant does not replace; see README "Fees").
    uint256 public constant MAX_FEE_BPS = 100;

    // ============ Misc ============

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC on every EVM chain targeted uses 6 decimals; capping at 18 keeps the
    ///      protocol forward-compatible with non-Circle stablecoin variants while
    ///      rejecting misconfiguration.
    uint8 public constant MAX_USDC_DECIMALS = 18;

    // ============ ERC-8056 interface IDs ============
    // Pinned as constants (never inline literals) so a spec revision is a one-line
    // change. Verified against https://eips.ethereum.org/EIPS/eip-8056 (Draft,
    // 2025-10-20).

    bytes4 public constant IID_SCALED_UI_AMOUNT = 0xa60bf13d;
    bytes4 public constant IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER = 0x4bd27648;
    bytes4 public constant IID_SCALED_UI_AMOUNT_CONVERSION = 0x57854fc3;
    bytes4 public constant IID_SCALED_UI_AMOUNT_BALANCES = 0xd890fd71;

    // ============ ERC-7540 / ERC-7575 interface IDs ============
    // Pinned so the suite can assert `supportsInterface` returns FALSE for each.
    // `SubscriptionModule` follows ERC-7540's request/fulfill *shape* and borrows
    // its event and view vocabulary, but deliberately does NOT claim compliance:
    //
    //   1. ERC-7540 mandates a pull-based Claim ("Vaults MUST NOT 'push' tokens
    //      onto the user after a Request"). Our fulfillment pushes the output
    //      directly to the user, so there is no Claimable state to claim from.
    //   2. ERC-7540 has no cancellation or rejection concept — both are
    //      explicitly deferred to a future EIP — and both are central here.
    //   3. ERC-7540 requires ERC-7575 (the `share` method), which does not apply:
    //      OkuM is not a vault share of the module.
    //
    // From https://eips.ethereum.org/EIPS/eip-7540 (Final, created 2023-10-18).
    bytes4 public constant IID_ERC7540_OPERATOR = 0xe3bc4e65;
    bytes4 public constant IID_ERC7575 = 0x2f0a18c5;
    bytes4 public constant IID_ERC7540_DEPOSIT = 0xce3bbe50;
    bytes4 public constant IID_ERC7540_REDEEM = 0x620ee8e4;
}
