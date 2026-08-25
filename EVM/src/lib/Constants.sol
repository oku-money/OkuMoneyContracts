// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants and ERC-8056 interface IDs for the OkuDollar contracts.
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * ONE TOKEN, ONE MULTIPLIER:
 *   - OkuDollar / rUSDOku : the single non-rebasing ERC-20 (contract name + ticker)
 *
 * AMOUNTS:
 *   - rawAmount   : raw token count — what `balanceOf`/`transfer`/`approve` move (18 dp)
 *   - uiAmount    : dollar value — what `balanceOfUI` returns (18 dp)
 *   - usdcAmount  : USDC amount in its native decimals (6 dp on every targeted chain)
 *
 * MULTIPLIER:
 *   - uiMultiplier   : dollar value of 1 raw token (starts 1e18 = $1.00, only increases)
 *   - ratePerSecond  : compound per-second accrual rate (1e18 = no yield)
 *   - rateEnd        : accrual halt boundary; also ERC-8056's `effectiveAt()`
 *
 * KEY FORMULAS:
 *   USDC -> raw:  raw  = (usdcAmount * usdcDecimalMultiplier) * PRECISION / uiMultiplier
 *   raw -> USDC:  usdc = (raw * uiMultiplier / PRECISION) / usdcDecimalMultiplier
 *   raw -> UI:    ui   = raw * uiMultiplier / PRECISION            // toUIAmount
 *   UI -> raw:    raw  = ui * PRECISION / uiMultiplier             // fromUIAmount
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

    // ============ Multiplier authority bounds ============

    /// @notice Maximum nominal annualized rate accepted by `setYieldRate`, in bps.
    /// @dev THE bound that actually binds. Annualization is *simple/nominal*:
    ///      `apr = (ratePerSecond - PRECISION) * SECONDS_PER_YEAR / PRECISION`.
    ///      At 1000 bps the per-second ceiling is `PRECISION + 3_170_979_198`,
    ///      which continuously compounds to ~10.52% APY — the delivered APY is
    ///      therefore slightly above the nominal cap by construction. Documented
    ///      rather than corrected, because a monotonic-in-rate check is cheaper
    ///      and simpler to audit than an `rpow` round trip in the setter.
    ///
    ///      A short-duration T-Bill product cannot legitimately exceed this.
    uint256 internal constant MAX_IMPLIED_APR = 1000;

    /// @notice Maximum `rateEnd - block.timestamp` accepted by `setYieldRate`.
    /// @dev Caps the exposure window of any single rate write. Combined with
    ///      `MAX_IMPLIED_APR`, worst-case over-accrual from a compromised setter
    ///      key before anyone intervenes is ~0.82% (1000 bps over 30 days).
    ///
    ///      OPERATIONAL CONSEQUENCE: a missed re-up freezes yield until someone
    ///      acts, and because the APR cap also binds the catch-up rate, a long
    ///      outage cannot be fully compensated afterwards. At a 1000 bps cap
    ///      against a 450 bps target, recovery costs ~0.82 days at the cap per
    ///      day of outage. This is the operator-absence protection working as
    ///      designed; see EVM/README.md Limitations.
    uint256 internal constant MAX_RATE_DURATION = 30 days;

    /// @notice Absolute ceiling for the cumulative UI multiplier.
    /// @dev `1e24` = $1,000,000 of value per raw token. Mirrors the SVM-side
    ///      `MAX_MULTIPLIER` guard (`oku-shared::constants::MAX_MULTIPLIER`,
    ///      scaled for SVM's 1e9 precision). Math-sanity bound, not a constraint
    ///      on a trusted operator.
    uint256 internal constant MAX_MULTIPLIER = 1e24;

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

    // ============ USDC ============

    // ============ Cross-chain multiplier sync window ============
    //
    // A multiplier tick is not atomic across chains. Between the EVM write and
    // the SVM write the two sides price a raw token differently, so anything
    // converting value *through* the multiplier in that interval settles at a
    // stale price on one side. The sync window is a bounded, auto-expiring,
    // epoch-attested block on exactly those operations.
    //
    // Structurally different from the local step-arbitrage surface, which is
    // holding raw across a discrete multiplier step. The window cannot address
    // that (the attacker never transacts during it) — `tout` does. EVM has no
    // local step at all, since accrual here is continuous; the window exists on
    // this side purely for cross-chain parity.
    //
    // Both bounds are constants rather than config fields so no key, warm or
    // cold, can widen the window or shorten the gap.

    /// @notice Hard ceiling on a single sync window.
    /// @dev Auto-expiry is the liveness backstop: if the orchestrator dies
    ///      mid-tick, mint/redeem resume unaided after at most this long. There
    ///      is no code path that extends a window past this bound, which is what
    ///      stops the mechanism becoming an indefinite pause held by a key
    ///      warmer than `PSM_UNPAUSER`.
    ///
    ///      SVM mirror: `oku_shared::MAX_SYNC_WINDOW_SECS`.
    uint256 internal constant MAX_SYNC_WINDOW = 15 minutes;

    /// @notice Sync window length written at `initialize`.
    /// @dev Deployments ship with the window ON. A zero default would leave the
    ///      protection installed but inert, and therefore dependent on someone
    ///      remembering to enable it — the class of dependency this design
    ///      exists to remove.
    ///
    ///      A cross-chain propagation budget, not an economic parameter: the
    ///      orchestrator normally closes the window explicitly as soon as the
    ///      tick lands everywhere, so this length only matters when that
    ///      confirmation never arrives.
    ///
    ///      SVM mirror: `oku_shared::DEFAULT_SYNC_WINDOW_SECS`.
    uint256 internal constant DEFAULT_SYNC_WINDOW = 60;

    /// @notice Minimum gap between the end of one sync window and the start of
    ///         the next.
    /// @dev The anti-griefing bound. Without it a compromised rate setter could
    ///      chain windows back-to-back and hold a permanent block. With it the
    ///      on-chain availability floor is
    ///      `MIN_SYNC_WINDOW_GAP / (MIN_SYNC_WINDOW_GAP + MAX_SYNC_WINDOW)`
    ///      = `6h / 6.25h` = **96%**, independent of operator behaviour.
    ///
    ///      Interacts with the clamp rule: a `setYieldRate` inside the gap still
    ///      succeeds, it just does not re-arm. Rejecting it instead would make
    ///      the rate setter censorable, which contradicts its deliberate
    ///      un-gated status (see `OkuDollar.setYieldRate`).
    ///
    ///      SVM mirror: `oku_shared::MIN_SYNC_WINDOW_GAP_SECS`.
    uint256 internal constant MIN_SYNC_WINDOW_GAP = 6 hours;

    // ============ PSM fees ============

    /// @notice Hard ceiling on `tin` / `tout`, in basis points (100 = 1%).
    /// @dev Anti-confiscation bound. The fee setter is `OKU_CAP_MANAGER` (cold),
    ///      but a bounded parameter still beats an unbounded one: the worst case
    ///      of a compromised cold key is a 1% haircut rather than seizure of
    ///      every mint and redemption.
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
