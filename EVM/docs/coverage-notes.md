# Forge Coverage Notes (Auditor Reference)

**Last run:** see `forge coverage --no-match-coverage 'test/|script/' --report summary` in CI.

## Current state

| File | Lines | Statements | Branches | Funcs |
| --- | --- | --- | --- | --- |
| `src/lib/MathLib.sol` | **100%** | 96% | 40% | 100% |
| `src/lib/ReentrancyGuardUpgradeable.sol` | **100%** | 100% | 100% | 100% |
| `src/lib/SafeApprove.sol` | **100%** | 100% | 100% | 100% |
| `src/lib/YieldSandwichGuard.sol` | **100%** | 100% | 100% | 100% |
| `src/psm/LitePSM.sol` | **98.43%** | 93.51% | 57.14% | 100% |
| `src/psm/RedemptionQueue.sol` | **100%** | 96.09% | 66.67% | 100% |
| `src/token/OkuDollar.sol` | **98.30%** | 94.79% | 75.51% | 97.56% |
| `src/token/OkuMoney.sol` | **100%** | 97.58% | 83.33% | 100% |
| **Total** | **99.00%** | 95.22% | 69.35% | 99.23% |

A CI gate in `.github/workflows/test.yml` fails the build if any `src/` file
or the overall total drops below **95% line coverage**.

## Uncovered lines (intentional)

The 7 remaining uncovered lines are **defensive guards that are unreachable
from the contracts as currently composed**. They are kept for future-proofing
against changes to dependent contracts. Driving them in tests would require
malicious mock contracts that misrepresent the multiplier or share-conversion
semantics — a test surface area we judged not worth the maintenance cost.

### `src/psm/LitePSM.sol`

| Line | Code | Why unreachable today |
| --- | --- | --- |
| 249 | `revert RoundTripDriftTooLarge` in `mintOkuM` | The round-trip check `dollarsToUsdc(okuMToDollars(okuMAmount, okuMMult), dm)` is mathematically bounded above by `usdcAmount` for any well-behaved `okuMMultiplier()`. The check defends against an OkuMoney variant whose multiplier mutates between reads inside one transaction — impossible under the current `setOkuMMultiplier` + yield-distribution-guard policy. |
| 336 | `revert OutputBelowMinimum` in `_redeemOkuMShared` | `usdcAmount = dollarsToUsdc(okuMToDollars(okuMAmount, okuMMult), dm)` is computed once. The floor `okuMFloor = (okuMAmount / dm) * dm` then `minUsdcExpected = dollarsToUsdc(okuMToDollars(okuMFloor, ...), dm)` is bounded above by `usdcAmount` by construction (truncation only loses precision). Defends against an OkuMoney whose multiplier shifts during the same call. |
| 401 | `revert RoundTripDriftTooLarge` in `mintUsdOku` | Mirror of line 249 for the wrap path. Same reasoning. |

### `src/token/OkuDollar.sol`

| Lines | Code | Why unreachable today |
| --- | --- | --- |
| 383–386 | `_update(from, to, amount)` guards | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting, so the inherited ERC20 `_update` hook is only reachable via the inherited `_mint` (`from == address(0)`) or `_burn` (`to == address(0)`) — which the contract never calls (`wrap` / `unwrap` manage `usdShares` directly). The peer-to-peer fall-through (`super._update`) is also unreachable since `transfer` / `transferFrom` bypass ERC20's internal path. The guards exist to halt any future refactor that accidentally invokes `_mint` or `_burn`. |

## Auditor checklist — sensitive functions

These four areas were called out as audit-priority. Each is covered:

1. **`OkuDollar.withdrawSurplus` post-withdrawal ratio math**
   - `test_WithdrawSurplus_SucceedsAtExactFloor` — postRatio == minCollateralRatio (inclusive).
   - `test_WithdrawSurplus_OneWeiBelowFloor_Reverts` — postRatio == minCollateralRatio - 1 wei → `BelowMinimumCollateral`.
   - `test_WithdrawSurplus_ZeroObligations_UsesInfiniteRatio` — `obligations == 0` → `type(uint256).max`.
   - `test_WithdrawSurplus_EventPostRatioMatchesView` — post-tx ratio observable matches `collateralizationRatio()`.
   - Plus pre-existing happy-path + role + yield-sandwich-guard coverage.

2. **`LitePSM._redeemOkuMShared(okuMAtPsm=true)` branch**
   - `test_RedeemUsdOku_OkuMAtPsmInstant_NoOkuMRedeemedEvent` — buffer-covered redemption suppresses `OkuMRedeemed` (asserted via log-walking).
   - `test_RedeemUsdOku_OkuMAtPsmQueued_OkuMRoutedToQueue` — buffer-drained redemption routes OkuM to the queue without pulling from user.
   - Implicitly exercised in 8+ `redeemUsdOku` rebasing-redeem tests.

3. **`RedemptionQueue.processQueue` TransferFailed soft-skip path**
   - `test_ProcessQueue_TransferFailed_SoftSkipEmitsEvent` — blocked recipient → `RedemptionSkipped(idx, TransferFailed)`, OkuM stays in escrow, `totalQueuedOkuM` unchanged, slot intact.
   - `test_ProcessQueue_TransferFailed_NextEntryStillProcesses` — interleaved blocked + clean users.
   - `test_ProcessQueue_TransferFailed_ThenRescueClearsIt` — soft-skip + `rescueQueueEntry` round trip.
   - `test_ProcessQueue_AlreadyCleared_SoftSkipEmitsEvent` — companion skip path.
   - `test_ProcessQueue_InsufficientFunds_EmitsEventAndBreaks` — third skip path.
   - Backed by `MockUSDC.setBlocked` (test/mocks/MockUSDC.sol) which mirrors Circle USDC's revert-on-blacklist semantics.

4. **`setNextUsdYieldRate` boundary conditions (`block.timestamp >= usdRateEnd`)**
   - `test_SetNextUsdYieldRate_RevertAtExactEndBoundary` — `block.timestamp == usdRateEnd` → `RateAlreadyExpired` (closed inequality).
   - `test_SetNextUsdYieldRate_RevertOneSecondPastEnd` — `block.timestamp == usdRateEnd + 1` → `RateAlreadyExpired`.
   - `test_SetNextUsdYieldRate_SucceedsOneSecondBeforeEnd` — `block.timestamp == usdRateEnd - 1` → success.
   - `test_SetNextUsdYieldRate_RevertsOnRateTooHigh` — companion `RateTooHigh` boundary.
   - Plus the pre-existing `HeadToTailTransition`, `RevertsWhenNoEnd`, `RevertsOnNegativeRate`, `OnlyUsdRebaser` cases.

## Test harnesses

Two test-only harness contracts expose `internal` library surface to drive the
last-mile branches:

- `test/mocks/MathLibHarness.sol` — exposes `MathLib.rpow` + helpers so the
  `x == 0` and `mul`-overflow branches of MakerDAO's `rpow` assembly are
  reachable from Solidity. See `test/lib/MathLib.t.sol`.
- `test/mocks/ReentrancyGuardHarness.sol` — exposes `nonReentrant` + the
  initializer so the `ReentrancyGuardReentrantCall` revert can be driven
  directly. See `test/lib/ReentrancyGuard.t.sol`.

Neither is included in any production import path.

## Audit finding surfaced + remediated during coverage work

While extending `MockUSDC` with a `setBlocked` mapping to drive the
TransferFailed branch, I observed that `RedemptionQueue.processQueue`
previously used the low-level `.call` pattern:

```solidity
// PRE-FIX (vulnerable to return-false ERC-20s):
(bool ok,) = address(usdcContract).call(
    abi.encodeWithSelector(
        usdcContract.transferFrom.selector, msg.sender, entry.user, usdcAmount
    )
);
if (!ok) { /* soft-skip */ }
```

That snippet treated a `transferFrom` returning `false` (without reverting)
as success, because `ok == true` for any non-reverting call. Real Circle
USDC's blacklist reverts so production behavior was safe, but a non-standard
ERC-20 (or a future USDC variant) that returns `false` would have silently
drained queue entries without paying users.

**Fix:** replaced the raw `.call` with `SafeERC20.trySafeTransferFrom`, which
both (a) swallows reverts and (b) decodes the boolean return value,
collapsing the two failure shapes into a single `bool ok` that is `false`
for either:

```solidity
// POST-FIX (uniform across both failure shapes):
bool ok = usdcContract.trySafeTransferFrom(msg.sender, entry.user, usdcAmount);
if (!ok) {
    emit RedemptionSkipped(i, RedemptionSkipReason.TransferFailed);
    continue;
}
```

Test coverage now drives both shapes independently:

- `test_ProcessQueue_TransferFailed_SoftSkipEmitsEvent` — revert shape
  (matches real USDC blacklist). MockUSDC's `setBlocked(addr, true)` reverts
  with `MockUSDCBlocked()`.
- `test_ProcessQueue_TransferFailed_ReturnFalse_IsAlsoSoftSkipped` —
  return-false shape (hypothetical non-standard USDC). MockUSDC's
  `setReturnFalse(addr, true)` makes `transferFrom` return `false` without
  reverting. **This test is the regression guard for the audit finding.**
