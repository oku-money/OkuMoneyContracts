# OkuDollar (rUSDOku) — EVM Implementation

> See [`../README.md`](../README.md) for shared architecture and cross-VM design.

Solidity contracts for OkuDollar, a yield-bearing dollar-denominated token backed by
US Treasury Bills.

**One token. One multiplier. Fixed raw balances.**

---

## Design

`rUSDOku` is a standard, non-rebasing ERC-20. Raw balances move only on transfer,
mint, and burn. Yield accrues in a single **UI multiplier** that grows continuously
with elapsed time, and a holding's dollar value is `rawBalance × uiMultiplier / 1e18`.

```
              raw layer                              display layer
  ┌──────────────────────────────┐    ┌────────────────────────────────┐
  │  balanceOf(user) = 954.20     │  × │  uiMultiplier() = 1.048...e18  │
  │  transfer / approve / allowance│    │  (continuous, monotone)        │
  │  — fixed, stock ERC-20 —      │    └────────────────────────────────┘
  └──────────────────────────────┘                    ║
              ║                                       ▼
   DeFi prices and accounts        balanceOfUI(user) = $1,000.00
   against this                    totalSupplyUI()
```

Same construction as Solana's Token-2022 `ScaledUiAmount` extension, which ERC-8056
standardizes for EVM.

### Why not rebasing

A rebasing `balanceOf` breaks AMM pools, lending markets, and anything that snapshots
balances, because the number changes underneath the integration with no transfer to
observe. Fixing the raw balance and moving growth to a display multiplier gives users
the same experience without any of that.

The failure mode is graceful. A wallet that has never heard of ERC-8056 shows
`954.20 rUSDOku` rather than `$1,000.00` — different unit count, **same dollar value**,
no false claim about what the number means.

### Two interfaces, one number

ERC-8056 is a **display** extension. It makes no claim about value and specifies no
redemption semantics, so shipping it alone would leave integrators with a multiplier
and no standard way to price against it. The token also exposes the ERC-4626
conversion views:

| Layer | Functions | Consumers |
|---|---|---|
| **Display** | `uiMultiplier`, `balanceOfUI`, `toUIAmount`, … | Wallets, explorers, trackers |
| **Value** | `convertToAssets`, `convertToShares`, `asset`, `totalAssets` | Lending markets, AMM rate providers |

Both read the same multiplier, and an invariant holds them together at every block:

```
uiMultiplier() == convertToAssets(1e18)
```

### Naming

The `r` prefix follows the convention around Token-2022 scaled-UI-amount tokens on
Solana, expected to carry to ERC-8056 tokens on EVM. It marks a token whose *displayed*
amount is multiplier-scaled — **not** one whose raw balance rebases, which it does not.

---

## The multiplier

Four storage fields and one setter. There is no second multiplier, no pending
multiplier value, and no scheduled step.

```solidity
struct OkuDollarStorage {
    uint256 baseMultiplier;   // Anchor, snapshotted at the last rate write
    uint256 ratePerSecond;    // Compound per-second rate (1e18 = no yield)
    uint256 lastAccrualTime;  // When baseMultiplier was snapshotted
    uint256 rateEnd;          // Accrual halts here

    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
}
```

Raw balances, allowances, and total supply are **not** here — they live in OZ's
`ERC20Upgradeable` namespace, untouched. Nothing overrides `_update`, `_mint`, or
`_burn`. The raw layer is stock OpenZeppelin.

### Accrual

```solidity
function uiMultiplier() public view returns (uint256) {
    Storage storage $ = _s();
    uint256 until = block.timestamp < $.rateEnd ? block.timestamp : $.rateEnd;
    if (until <= $.lastAccrualTime) return $.baseMultiplier;
    return Math.mulDiv(
        $.baseMultiplier,
        MathLib.rpow($.ratePerSecond, until - $.lastAccrualTime, PRECISION),
        PRECISION
    );
}
```

Continuous, computed from a stored rate and elapsed time — the Aave liquidity-index /
`sDAI` `chi` pattern. It changes every second with no transaction.

Discrete revaluation would create a single block at which every cached multiplier in
every integration is simultaneously wrong, which is an arbitrage window against your
own integrators. Continuous accrual has no such block: at a rate change the multiplier
is continuous and only its *slope* moves, so there is nothing to front-run.

**Accrual halts at `rateEnd`.** This is a safety mechanism, not just scheduling — if
the rate setter stops functioning, the multiplier stops growing rather than accruing
indefinitely against assets that are not there. `rateEnd` is mandatory; a zero or
past value is rejected.

### The one setter

```solidity
function setYieldRate(uint256 ratePerSecond, uint256 endTimestamp) external; // OKU_RATE_SETTER
```

Snapshots `baseMultiplier = uiMultiplier()`, sets `lastAccrualTime = block.timestamp`,
then writes the new rate and end. Because it re-anchors from the current value, calling
it before `rateEnd` extends accrual seamlessly with no gap and no step — which is why
no separate "pending rate" staging field is needed.

| Constraint | Error |
|---|---|
| `ratePerSecond >= PRECISION` (monotone — see below) | `MultiplierCannotDecrease` |
| Annualized rate `<= MAX_IMPLIED_APR` | `RateAboveMaximum` |
| `endTimestamp > block.timestamp` | `RateEndNotInFuture` |
| `endTimestamp - block.timestamp <= MAX_RATE_DURATION` | `RateDurationTooLong` |
| `baseMultiplier` projected to `rateEnd` `<= MAX_MULTIPLIER` | `MultiplierAboveMaximum` |

### ERC-8056's pending-multiplier extension

The extension is Required and presumes a step function; this token accrues
continuously. The mapping falls out naturally from `rateEnd`:

```solidity
function newUIMultiplier() public view returns (uint256) {
    // The multiplier at rateEnd — where accrual stops absent a new rate.
    Storage storage $ = _s();
    return Math.mulDiv($.baseMultiplier,
        MathLib.rpow($.ratePerSecond, $.rateEnd - $.lastAccrualTime, PRECISION), PRECISION);
}

function effectiveAt() public view returns (uint256) { return _s().rateEnd; }
```

This reads the pair as "the multiplier will reach this value at this time, and stop
there unless the rate is renewed" — informative for an integrator, and it satisfies
the reference implementation's contract exactly at the boundary: once
`block.timestamp >= effectiveAt()`, `uiMultiplier()` returns `newUIMultiplier()`,
which is precisely what the reference does.

The divergence from the EIP's *intent* is that our pending value is where a trajectory
terminates rather than a discontinuous jump. Documented in NatSpec on `setYieldRate`
and raised as an open question below.

### Monotonic

`ratePerSecond` is floored at `PRECISION`, so the multiplier never decreases.
ERC-8056 explicitly supports reverse splits; this is a deliberate narrowing.

The consequence is that the multiplier cannot be corrected downward once published. If
a published rate over-accrues relative to what the backing supports, the gap must be
absorbed off-chain. Adding a downward path later is not a patch — it needs a longer
timelock on decreases than increases, mandatory advance notice, and liquidation-impact
review with every lending venue.

### The setter is an oracle write

The moment any lending market prices off `uiMultiplier()`, a wrong value mints
borrowing power directly. There is no on-chain referent to check against —
`totalAssets()` is *derived from* the multiplier, not measured. ERC-8056's reference
implementation guards only `> 0` and a future timestamp, which is not sufficient for a
value-bearing multiplier.

Three bounds, which together cap the damage from a compromised setter key:

- **`MAX_IMPLIED_APR`** — the rate ceiling. The binding economic bound.
- **`MAX_RATE_DURATION`** — the exposure window. Worst-case over-accrual is `MAX_IMPLIED_APR × MAX_RATE_DURATION` before anyone intervenes.
- **`haltAccrual()`** — `OKU_GUARDIAN` sets the rate to `PRECISION` (no yield) immediately, no timelock. Monotone-safe: it stops growth without reducing anything already accrued.

`MAX_IMPLIED_APR` is doing most of the work here, and it is currently a placeholder.

---

## Contracts

| Contract | Description |
|---|---|
| `src/token/OkuDollar.sol` | The token. Stock ERC-20 raw layer + ERC-8056 display layer + 4626 conversion views |
| `src/psm/LitePSM.sol` | Peg Stability Module — USDC ↔ rUSDOku at the multiplier |
| `src/psm/RedemptionQueue.sol` | FIFO queue for redemptions when the PSM buffer is depleted |
| `src/lib/ScaledUIAmountUpgradeable.sol` | ERC-8056 core + all three extensions, with ERC-165 registration |
| `src/oracle/OkuMultiplierAdapter.sol` | Chainlink `AggregatorV3Interface`-compatible read of `uiMultiplier()`, with bounds and staleness |
| `src/lib/MathLib.sol` | `toUiAmount`, `fromUiAmount`, `usdcToDollars`, `dollarsToUsdc`, `rpow` |
| `src/lib/Constants.sol` | Constants, interface IDs, terminology legend |
| `src/lib/Roles.sol` | RBAC role constants |
| `src/lib/Errors.sol` | Shared error types |
| `src/lib/SafeApprove.sol` | USDT-safe approve helpers |
| `src/lib/ReentrancyGuardUpgradeable.sol` | OZ-v5-compatible upgradeable reentrancy guard |

**Stack:** Solidity 0.8.28 / Cancun · Foundry (unit + invariant) + Hardhat (fork) ·
OpenZeppelin v5.6.1 Upgradeable · UUPS proxies · ERC-7201 namespaced storage.

### Interfaces claimed via ERC-165

| Interface | ID | Claimed |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | Yes |
| `IScaledUIAmountNewUIMultiplier` | `0x4bd27648` | Yes |
| `IScaledUIAmountConversion` | `0x57854fc3` | Yes |
| `IScaledUIAmountBalances` | `0xd890fd71` | Yes |
| `IERC4626` | — | **No** — conversion views only, see below |

> ERC-8056 is a Standards Track **Draft** (created 2025-10-20). IDs are constants in
> `Constants.sol`, never inline literals, so a spec revision is a one-line change.
> Budget for one revision.

---

## Token surface

### ERC-8056

```solidity
function uiMultiplier() external view returns (uint256);
function newUIMultiplier() external view returns (uint256);
function effectiveAt() external view returns (uint256);
function toUIAmount(uint256 rawAmount) external view returns (uint256);
function fromUIAmount(uint256 uiAmount) external view returns (uint256);
function balanceOfUI(address account) external view returns (uint256);
function totalSupplyUI() external view returns (uint256);
```

Two deliberate deviations from the EIP reference implementation:

1. **`Math.mulDiv`, not naive multiply.** The reference's `(raw * multiplier) / 1e18` reverts on intermediate overflow for large balances at high multipliers — reachable **inside the parameter space our own constants permit**. `mulDiv` computes the full 512-bit intermediate. ERC-8056 §Security Considerations 5 requires handling this.
2. **No `_update` hook for `TransferWithUIAmount`.** The reference emits from `_update`, which also fires on mint and burn where the counterparty UI amount is ambiguous. The token emits from its transfer path instead, leaving OZ's `_update` untouched.

### Value views

```solidity
function asset() external view returns (address);   // USDC on this chain
function totalAssets() external view returns (uint256);
function convertToAssets(uint256 shares) external view returns (uint256);
function convertToShares(uint256 assets) external view returns (uint256);
```

**Not ERC-4626 compliant, and `supportsInterface` does not claim to be.** `deposit` /
`mint` / `withdraw` / `redeem` are absent — subscription and redemption run through
`LitePSM` and may queue rather than settle. A `deposit()` that reverts for everyone
would be worse than an absent one, because integrators detect the interface and assume
it works. Redemption capacity is exposed on the PSM, where it actually lives, not
mirrored onto the token as `max*` views.

### Standard surface

ERC-20, ERC-2612 permit, `AccessControl`, `Pausable`, UUPS. Plus the usual regulated-
stablecoin controls: per-minter `minterAllowance`, global `maxSupply`, and a blacklist.

Pause is a full freeze on `transfer`, `transferFrom`, and `mint`. **Burn is not gated** —
self-burn works while paused, supporting the pause-then-blacklist protocol. Also not
gated: `setYieldRate`, `haltAccrual`, and `blacklist`, which are emergency levers that
must remain callable during an incident.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, rawAmount)` | Standard ERC-20, raw |
| `Approval(owner, spender, rawValue)` | Standard ERC-20, raw |
| `TransferWithUIAmount(from, to, amount, uiAmount)` | ERC-8056 optional; both figures |
| `UIMultiplierUpdated(oldMultiplier, newMultiplier, effectiveAtTimestamp)` | ERC-8056 required; emitted on every rate write |
| `YieldRateSet(oldRate, newRate, rateEnd, snapshotMultiplier)` | Rate write, with snapshot for off-chain reconstruction |
| `AccrualHalted(atMultiplier)` | `haltAccrual` |
| `MinterAllowanceUpdated(minter, oldAllowance, newAllowance)` | |
| `MaxSupplyUpdated(oldMaxSupply, newMaxSupply)` | |
| `Blacklisted(account)` / `Unblacklisted(account)` | |

---

## LitePSM.sol

USDC ↔ rUSDOku at the multiplier.

```solidity
function mint(uint256 usdcAmount) external returns (uint256 rawOut);
function redeem(uint256 rawAmount) external returns (uint256 usdcOut);
function redeemUiAmount(uint256 uiAmount) external returns (uint256 usdcOut);

function quoteMint(uint256 usdcAmount) external view returns (uint256 rawOut);
function quoteRedeem(uint256 rawAmount) external view returns (uint256 usdcOut);
function redeemableNow() external view returns (uint256 maxRawInstant);  // buffer capacity
```

```
USDC → raw:   raw  = (usdcAmount × usdcDecimalMultiplier) × PRECISION / uiMultiplier()
raw → USDC:   usdc = (raw × uiMultiplier() / PRECISION) / usdcDecimalMultiplier
```

At `uiMultiplier = 1.05e18`, depositing 100 USDC yields ~95.24 raw (displayed as
$100.00); redeeming 95.24 raw returns ~100 USDC.

`usdcDecimalMultiplier` is stored per-PSM (`10 ** (18 - usdcDecimals)`), computed at
`initialize` from the deployed USDC's `decimals()`. `1e12` on every chain targeted.

> **No sandwich guard, no announcement window, no forward pricing.** Continuous
> accrual has no distribution transaction to sandwich and no scheduled step to
> front-run. Pricing reads `uiMultiplier()` directly.

### Admin surface

```solidity
function depositBuffer(uint256 amount) external;             // PSM_BUFFER_DEPOSITOR
function withdrawUsdc(address to, uint256 amount) external;  // PSM_BUFFER_WITHDRAWER
function processQueue(uint256 startIndex, uint256 endIndex, uint256 approveAmount) external;
function pause() / unpause() external;                       // PSM_PAUSER / PSM_UNPAUSER
```

`withdrawUsdc` reverts with `ZeroAddress` on `to == 0` and `WouldStrandQueue` if the
withdrawal would drop the buffer below outstanding queue obligations.

Events: `Minted(user, usdcAmount, rawOut, uiMultiplier)`,
`Redeemed(user, rawIn, usdcOut, uiMultiplier)`,
`BufferDeposited`, `BufferWithdrawn`, `BufferRefilled`.

---

## RedemptionQueue.sol

Stores **raw** rUSDOku. Because raw balances are fixed, queued amounts do not grow in
count — but they appreciate in dollar value via the multiplier. At processing,
`usdcAmount = rawAmount × uiMultiplier() / PRECISION`, scaled to USDC decimals. The
multiplier is cached once per batch for gas and cross-entry consistency.

```solidity
function enqueue(address user, uint256 rawAmount) external;           // QUEUE_PSM, record-only
function processQueue(uint256 startIndex, uint256 endIndex) external; // QUEUE_PSM
function rescueQueueEntry(uint256 index, address alt) external;       // QUEUE_RESCUER
function advanceHead(uint256 maxSlots) external;                      // permissionless
```

`enqueue` is record-only — the PSM transfers tokens in before calling. `processQueue`
burns rUSDOku, pulls USDC from the PSM, and pays users. `rescueQueueEntry` returns
tokens for a stuck entry (e.g. a USDC-blacklisted recipient).

Neither `processQueue` nor `rescueQueueEntry` advances `queueHead`; `advanceHead`
amortizes the head walk into a separate gas-bounded transaction. `queueLength()` is an
upper bound on live entries until it runs. Redemption correctness is independent of the
cursor.

USDC transfers use `SafeERC20.trySafeTransferFrom`, which both swallows reverts and
decodes the boolean return — a non-standard ERC-20 returning `false` without reverting
is soft-skipped rather than treated as paid.

Events: `RedemptionQueued`, `RedemptionProcessed`, `RedemptionSkipped(index, reason)`
(`AlreadyCleared` / `InsufficientFunds` / `TransferFailed`), `RedemptionRescued`,
`QueueHeadAdvanced`.

---

## Precision and rounding

- **18 decimals on the raw token.** With a growing multiplier, 6 decimals would surface display-layer dust far sooner than expected.
- **One rounding direction, stated once:** every conversion rounds **against the caller, in favour of the protocol**. `toUIAmount` and `fromUIAmount` both truncate; the caller absorbs the loss.
- **Display precision:** truncate UI amounts to the token's decimals. Never render full multiplier precision — it implies precision the backing does not have.

### The max-send rule

> **A max-send must never round-trip through the display layer.** Compute the transfer
> from raw `balanceOf`; derive the displayed value *from that raw amount*. Never
> compute `fromUIAmount(displayedBalance)`.

`fromUIAmount(toUIAmount(x))` is `x - 1` for most `x`. A "Max" button built the wrong
way leaves dust on every send, or — rounding the other way — exceeds the balance and
reverts, which users read as a broken app.

This is the most likely user-visible bug in the system. Enforced in three places: the
SDK exposes `getMaxSendRaw()` and no inverse; the invariant suite fuzzes
`fromUIAmount(toUIAmount(x)) ∈ [x-1, x]`; `MaxSendTest` drives the real transfer path
across the full multiplier range.

---

## Integration surface

The contract is small. This is where the work is.

Every surface reading or writing a balance needs review: the app and any embedded
wallet; third-party wallets (the long tail — there is no EVM equivalent of Solana's
RPC-level `uiAmount`, so each must integrate explicitly); explorers, trackers,
indexers, subgraphs; custodians and exchanges; bridges.

**Hardware wallet signing is a launch blocker.** Ledger and Trezor render raw calldata
amounts. The app says "$1,050"; the device says "1,000." Ship **ERC-7730** clear-signing
metadata for the token and every PSM entry point before launch, not after.

Ship alongside the contracts, not after:

1. **Client SDK** — one `getDisplayBalance()`, one `getMaxSendRaw()` with no inverse, ERC-165 detection internal
2. **Display convention** — what to show, how to label it, what to do when ERC-8056 is unsupported
3. **ERC-7730 metadata**
4. **`OkuMultiplierAdapter`** — Chainlink-compatible, with bounds and staleness, so lending markets do not hand-roll it
5. **Reference integrations, open-sourced** — one AMM, one lending market

### Venue requirements

**AMMs — rate-aware pools only.** Curve stableswap with `uiMultiplier()` as the rate
provider, or a Uniswap v4 hook. A naive constant-product pair against USDC leaks
accrual to arbitrageurs continuously; LPs capture materially less than the yield rate.
State this in LP-facing docs.

**Lending — engage each risk team before launch.** The multiplier becomes their price
feed; they will want the rate bounds and `haltAccrual` semantics in writing.

**Cross-chain.** One canonical multiplier source pushed to satellites. Bridges move
**raw units and nothing else** — audit each for decimal or display handling. Define
acceptable skew and publish what integrations do at the boundary.

**SVM.** Token-2022 rejects `ScaledUiAmount` and `InterestBearingConfig` on the same
mint, making the Solana side **stepwise by construction**. *(Verify against current
Token-2022 docs — this is load-bearing for the cross-chain story.)* If it holds, the
two chains share an interface but not accrual granularity: multipliers diverge within
a step interval by up to one step's yield, and a small standing cross-chain arbitrage
cost is accepted. Making EVM stepwise to match was rejected for the reasons above.

---

## Terminology

| Term | Meaning |
|---|---|
| `rawAmount` | Raw token count — what `balanceOf`, `transfer`, `approve` move (18 dp) |
| `uiAmount` | Dollar value — what `balanceOfUI` returns (18 dp) |
| `usdcAmount` | USDC amount (6 dp on all targeted chains) |
| `uiMultiplier` | Dollar value of 1 raw token (starts `1e18` = $1.00, only increases) |
| `ratePerSecond` | Compound per-second accrual rate (`1e18` = no yield) |
| `rateEnd` | Accrual halt boundary; also ERC-8056's `effectiveAt()` |

```
USDC → raw:   raw  = (usdcAmount × usdcDecimalMultiplier) × PRECISION / uiMultiplier
raw → USDC:   usdc = (raw × uiMultiplier / PRECISION) / usdcDecimalMultiplier
raw → UI:     ui   = raw × uiMultiplier / PRECISION          // toUIAmount
UI → raw:     raw  = ui × PRECISION / uiMultiplier           // fromUIAmount
parity:       convertToAssets(1e18) == uiMultiplier()
```

---

## Constants

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1e18` | Fixed-point base. ERC-8056 requires 18-decimal multiplier precision, so doubly mandated. |
| `MAX_IMPLIED_APR` | `2000` bps (20%) | **The bound that actually binds.** A short-duration T-Bill product cannot legitimately exceed it. **Placeholder — needs a real number.** |
| `MAX_RATE_DURATION` | `90 days` | Caps the exposure window on any single rate write. Combined with the APR cap, bounds worst-case over-accrual from a compromised setter. Round-number convention. |
| `MAX_MULTIPLIER` | `1e24` | Overflow ceiling, six orders above `1e18`. Round-number convention. Also the bound making `Math.mulDiv` necessary. |
| `BASIS_POINTS` | `10_000` | Industry convention. |
| `MAX_USDC_DECIMALS` | `18` | ERC-20 upper bound; USDC is 6 dp everywhere targeted. Capping rather than hardcoding 6 is intentional forward-compat. |
| `IID_SCALED_UI_*` | see above | From the draft EIP. Pinned; changes if the draft changes. |

---

## Roles

Each contract's `initialize` grants its full role set to `admin`, who redistributes
post-deployment. One exception: `RedemptionQueue.QUEUE_PSM` is granted after deployment
to the `LitePSM` proxy, avoiding a circular dependency and keeping admin from calling
`enqueue` / `processQueue` directly.

| Role | Held by | Can do | Bounded by |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Cold multisig | Grant/revoke any role | Nothing — meta-role |
| `OKU_UPGRADER` / `PSM_UPGRADER` / `QUEUE_UPGRADER` | Cold multisig | Replace logic via UUPS | Nothing — mitigated by fork rehearsal and diff review |
| `OKU_ALLOWANCE_MANAGER` | Cold multisig | Set `minterAllowance` | Capped at `maxSupply`; minting still needs `OKU_MINTER` |
| `OKU_CAP_MANAGER` | Cold multisig | Set `maxSupply` | Cannot go below `totalSupply()` |
| `PSM_BUFFER_WITHDRAWER` | Cold multisig | Drain PSM buffer | Cannot drop below outstanding queue obligations |
| `OKU_PAUSER` / `PSM_PAUSER` | Warm multisig | Halt operations | Cannot unpause — cold only |
| `OKU_GUARDIAN` | Warm multisig | `haltAccrual()` | Can only stop growth; cannot set a rate or reduce the multiplier |
| `OKU_BLACKLISTER` | Warm multisig | Block an address | Cannot unblacklist (cold only); cannot access funds |
| `OKU_RATE_SETTER` | Orchestrator | `setYieldRate` | APR cap, duration cap, monotonicity, `MAX_MULTIPLIER` |
| `PSM_QUEUE_PROCESSOR` | Orchestrator | Process queue entries | Destination fixed to the entry's `user` |
| `PSM_BUFFER_DEPOSITOR` | Orchestrator | Deposit USDC to buffer | Caller must hold the USDC |
| `OKU_MINTER` | LitePSM (contract) | `mint()` inside swap paths | Per-minter allowance and `maxSupply`; never an EOA |
| `QUEUE_RESCUER` | Warm multisig | Return escrowed tokens for a stuck entry | Cannot redirect a live entry's payment |

Named `OKU_RATE_SETTER`, not `REBASER` — nothing rebases.

---

## Invariants

```
// Display / value parity
uiMultiplier() == convertToAssets(1e18)
totalSupplyUI() == totalSupply() × uiMultiplier() / PRECISION
balanceOfUI(u)  == balanceOf(u)  × uiMultiplier() / PRECISION
fromUIAmount(toUIAmount(x)) ∈ [x-1, x]                       // fuzzed, full range
|Σ balanceOfUI(holder) - totalSupplyUI()| <= N wei            // stated tolerance

// Multiplier
uiMultiplier() >= previousUiMultiplier                        // monotone
uiMultiplier() continuous across every setYieldRate call      // slope moves, value does not
uiMultiplier() constant once block.timestamp >= rateEnd       // accrual halts
uiMultiplier() == newUIMultiplier() once past rateEnd         // ERC-8056 boundary contract
maxSupply × MAX_MULTIPLIER < type(uint256).max                // asserted at init

// Raw layer
balanceOf(u) == OZ ERC20 _balances[u]                         // stock OZ, unmodified
totalSupply() <= maxSupply

// Interface
supportsInterface(0xa60bf13d) == true
supportsInterface(type(IERC4626).interfaceId) == false        // we do NOT claim this

// PSM / queue
token.balanceOf(litePsm) <= 1 wei                             // no stale tokens between calls
queue.totalQueuedRaw == token.balanceOf(queue)                // backed exactly
psmUsdcOutflow <= seededBuffer + trackedDeposits + tolerance

// Allowance
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                          // burns do not restore allowance
```

---

## Testing

```bash
forge install && forge build
forge test
forge test --match-path "test/invariants/*"          # 256 runs × 500 depth
npx hardhat compile && npx hardhat test              # Fork + scenarios
```

| Suite | Covers |
|---|---|
| `ERC8056Conformance` | All four interface IDs; conversion round-trips; balance identities; `UIMultiplierUpdated` emission; the `uiMultiplier() == newUIMultiplier()` boundary contract |
| `ValueDisplayParityTest` | `uiMultiplier == convertToAssets(1e18)` across the parameter space |
| `AccrualTest` | Continuity across rate changes; halt at `rateEnd`; re-anchoring on `setYieldRate`; APR and duration cap rejections; `haltAccrual` |
| `MaxSendTest` | The max-send rule against the real transfer path at low and high multiplier |
| `TenYearAccrualTest` | Long-horizon simulation: overflow, precision drift, dust accumulation |
| `MulDivOverflowTest` | `toUIAmount` at `MAX_MULTIPLIER` against a max-supply balance — the case the EIP reference implementation reverts on |
| `QueueSkipPathsTest` | `AlreadyCleared`, `InsufficientFunds`, `TransferFailed` soft-skips, driven by `MockUSDC.setBlocked` (revert) and a return-false variant |
| Fork tests | **Every intended integration, at both a low and a high multiplier.** A high-multiplier fork run is the only way to catch integrations that silently assume `multiplier ≈ 1e18`. |

Foundry is the authoritative functional coverage; Hardhat is for fork-dependent and
multi-contract scenario work. CI fails below 95% line coverage on any `src/` file, with
100% required on `ScaledUIAmountUpgradeable` — small, pure, and on every pricing path.

**Harnesses** (test-only, never in a production import path): `MathLibHarness` (exposes
`rpow` so the `x == 0` and `mul`-overflow branches of MakerDAO's assembly are reachable);
`ScaledUIHarness` (drives the multiplier to arbitrary values, including standard-legal
ones this token forbids, so the PSM can be tested against a hostile-but-conformant
counterparty); `MockScaledUIToken` (faithful port of the EIP reference implementation,
used as a differential-testing oracle); `MockUSDC` (6-decimal, with `setBlocked`
mirroring Circle's revert-on-blacklist semantics).

---

## Limitations

**1. Centralized multiplier authority.** No timelock. `MAX_IMPLIED_APR`,
`MAX_RATE_DURATION`, monotonicity, and `haltAccrual` bound the damage; role grants,
upgrades, and buffer withdrawals remain unbounded beyond multisig custody.

**2. No on-chain backing verification.** `totalAssets()` is derived from the multiplier,
not measured. The value interface is exactly as trustworthy as the multiplier authority.
Inherent to off-chain RWA backing, not a gap in the implementation.

**3. USDC peg monitoring is off-chain.** No oracle gates the mint/redeem path on USDC's
peg; the orchestrator monitors and pauses the PSM on a detected depeg. Note the
asymmetry: no oracle on the input side, but `OkuMultiplierAdapter` makes this system a
price *publisher* on the output side.

**4. Monotonicity has no downward path.** Over-accrual relative to backing cannot be
corrected on-chain.

**5. ERC-8056 is a Draft.** IDs shift if any signature changes; the pending-multiplier
extension could be redefined; the `rateEnd` reading of `newUIMultiplier` has no explicit
blessing in the text. Re-conforming is a one-line change and a single-contract upgrade.

**6. No $1-denominated raw unit.** Invoicing, payroll, and merchant flows require a
multiplier lookup. Non-integrated surfaces show the raw count — graceful, but a real
integration cost.

**7. Allowance value drift.** Allowances are denominated in **raw** units, so a bounded
approval's *dollar* value grows with the multiplier. A user who approved a fixed amount
a year ago has granted more value than intended. Infinite approvals are unaffected.
Mitigated by exposing `allowanceUI(owner, spender)` in the SDK and surfacing drifted
approvals in the app; there is no contract-level fix that preserves ERC-20 semantics.

**8. Max-send rounding hazard.** Inherent to any scaled-display token; mitigated by SDK
design rather than eliminated.

**9. `advanceHead` is permissionless.** No privileged effect — `queueHead` only moves
forward, only past cleared slots. Gas-bounded by `maxSlots`. A privileged version adds
no security and complicates the runbook.

**10. EVM/SVM accrual granularity divergence.** EVM continuous, SVM stepwise by
Token-2022 construction.

---

## Open questions

1. **Continuous accrual under a step-based extension.** Is the `rateEnd` reading of `newUIMultiplier()` / `effectiveAt()` correct, or does the standard need to address continuously-accruing tokens? To be raised on the [Ethereum Magicians thread](https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899).
2. **`MAX_IMPLIED_APR` and `MAX_RATE_DURATION`.** The first needs a real number; the second is a round-number convention. Together they define worst-case exposure to a compromised setter key.
3. **`OKU_GUARDIAN` — warm or cold?** Warm gives a fast halt; cold makes the halt harder to abuse. A halt withholds yield from holders, which is not nothing.
4. **Allowance drift.** Is an SDK-plus-app mitigation sufficient, or does this warrant something at the contract level?

---

## Deployment

`scripts/deploy/index.ts` provisions every contract for a chain in one run and writes to
a per-network address book. Proxies and implementations are CREATE2-deterministic via
the [Arachnid factory](https://github.com/Arachnid/deterministic-deployment-proxy)
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on every supported chain), so the
same source tree, `DEPLOYMENT_VERSION`, and constructor args produce the same address on
every chain. Salt: `keccak256("okumoney." + DEPLOYMENT_VERSION + "." + <name>)`.

`v0.x` is pre-audit iteration (addresses may change across versions); `v1.0+` is reserved
for post-audit. Bumping `DEPLOYMENT_VERSION` is one-way. Chains using real Circle USDC
diverge from testnets using `MockUSDC`, since constructor args differ.

**Networks:** `sepolia` (11155111), `opSepolia` (11155420), `baseSepolia` (84532),
`arbSepolia` (421614), `bscTestnet` (97), `mainnet` (1), `optimism` (10),
`arbitrum` (42161), `base` (8453), `bsc` (56).

**Address book:** `scripts/config/addresses.json` (working; `fork:<chain>` namespaced so
fork runs never overwrite live entries) and `../addresses.json` (canonical registry for
the SDK and orchestrator, live deploys only, carrying `chainId`, `rpcUrl`, `explorer`,
`contracts{}`, `standards[]`, `deployer`).

```bash
# Fork pre-flight
FORK_NETWORK=base hh node                            # Terminal 1
hh run scripts/deploy/index.ts --network localhost   # Terminal 2 — auto-detects chain

# Live
hh run scripts/deploy/index.ts --network base
```

Idempotent and resumable: `tryAttach` reuses any contract already in the address book
whose address still has bytecode, so a partial-deploy failure can be re-run. Transient
RPC errors — `nonce too low`, `replacement transaction underpriced`, BSC's
`BAD_DATA: invalid address (value="")` pending-tx quirk, timeouts — are retried with
exponential backoff (2s → 32s, five attempts) inside `withRetry`. A provider shim
(`scripts/utils/rpcCompat.ts`) normalises BSC's pending-tx response shape before ethers'
strict formatter sees it.

### Upgrades

```bash
FORK_NETWORK=sepolia hh node                         # Terminal 1
TARGETS=OkuDollar,LitePSM npm run upgrade            # Terminal 2 — rehearse
TARGETS=OkuDollar,LitePSM npm run upgrade:sepolia    # When the diff is clean
```

`scripts/upgrade/index.ts` verifies the `*_UPGRADER` role before broadcasting, runs OZ's
`prepareUpgrade` so a layout-breaking change aborts before any transaction, diffs
pre/post invariant state (`uiMultiplier`, `newUIMultiplier`, `effectiveAt`,
`convertToAssets(1e18)`, `supportsInterface(0xa60bf13d)`), and appends an audit trail
with old/new implementation, tx hash, signer, and timestamp.

---

## Dependencies

| Library | Version |
|---|---|
| `solc` | `0.8.28` |
| `@openzeppelin/contracts` / `-upgradeable` | `5.6.1` |
| `lib/openzeppelin-contracts` | `v5.6.1` @ `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| `lib/openzeppelin-contracts-upgradeable` | `v5.6.1` @ `7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf` |
| `lib/forge-std` | `v1.12.0` @ `7117c90c8cf6c68e5acce4f09a6b24715cea4de6` |

Node tooling pinned exactly in `package.json`. There is no OpenZeppelin reference
implementation of ERC-8056 to depend on — `ScaledUIAmountUpgradeable` is written against
the EIP text. The only OZ surface beyond a standard ERC-20 is `ERC165Upgradeable` and
`Math.mulDiv`, both in 5.6.1. `npm audit` findings are in transitive dev dependencies
and do not enter production bytecode.

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **SVM implementation:** [`../SVM/README.md`](../SVM/README.md)
- **ERC-8056 (Draft):** https://eips.ethereum.org/EIPS/eip-8056
- **ERC-8056 discussion:** https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899