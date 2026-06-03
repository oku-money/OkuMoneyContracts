# EVM ↔ SVM divergence reference

> Companion document to `SVM/README.md`. Lists every place where the SVM
> implementation deliberately diverges from the EVM one, with the rationale.
> Programs and scripts link back here from inline `// see EVM_VS_SVM.md`
> comments — keep the two in sync.

The SVM port is a faithful translation of the EVM contracts in spirit, but
Solana's runtime, account model, and Token-2022 layout force a number of
deliberate departures. None of the items below are bugs; they are documented
trade-offs.

In v1 both sides run the **noBridge model**: there is no on-chain bridge on
either side. Cross-chain transfers are mediated by an off-chain orchestrator
that calls the PSM's `mint_oku_m` / `redeem_oku_m` (SVM) or
`mintOkuM` / `redeemOkuM` (EVM) on each chain. The bridge-specific divergence
rows that used to live in this file (signature scheme, 80-byte wire format,
two-step refund, etc.) have been deleted; if a future on-chain bridge is
introduced, the divergence catalogue will be re-added at that time.

## Workspace layout (where the EVM libs went)

EVM groups protocol-wide invariants into `EVM/src/lib/`:

| EVM file | SVM equivalent |
|---|---|
| `lib/Constants.sol` | `crates/oku-shared/src/constants.rs` |
| `lib/MathLib.sol` | `crates/oku-shared/src/math.rs` |
| `lib/YieldSandwichGuard.sol` | `programs/lite-psm/src/helpers/yield_lock.rs` (PSM-side) + `programs/oku-dollar/src/helpers.rs::check_vault_yield_lock` (vault-side) |
| `lib/Roles.sol` | `programs/lite-psm/src/roles.rs`, `programs/oku-dollar/src/roles.rs` (split because each program owns its own RBAC enum) |
| `lib/Errors.sol` | `programs/{lite-psm,oku-dollar}/src/errors.rs` (split because Anchor expects per-program `#[error_code]` enums) |
| `lib/events/*.sol` | `programs/*/src/events.rs` (split; same reason as errors) |
| `lib/SafeApprove.sol` | not ported — SPL Token-2022 doesn't have the EIP-20 allowance-zeroing footgun |
| `lib/ReentrancyGuardUpgradeable.sol` | not ported — Solana's account-lock model + no fallback fns means reentrancy isn't reachable the same way; the no-`TransferHook` init invariant closes the one residual path |

`oku-shared` is a pure-Rust workspace crate with **zero dependencies**
(no `solana-*`, no `anchor-lang`). It lives in `crates/` rather than
`programs/` because `anchor build` walks `programs/*` and requires every
member to declare an `idl-build` feature; `crates/*` is for ordinary
workspace libs. Both `lite-psm` and `oku-dollar` re-export the relevant
shared constants from their own `constants.rs` modules so call sites
still write `use crate::constants::*` without caring where the value is
authored.

## Token model and precision

| Aspect | EVM | SVM |
|---|---|---|
| OkuMoney decimals | 18 | 6 |
| usdOku decimals | 18 | 6 |
| USDC decimals | 6 (with `usdcDecimalMultiplier`) | 6 (asserted at init) |
| `PRECISION` | 1e18 | 1e9 |
| `oku_m_price` units | $1.00 = 1e18 | $1.00 = 1e9 |
| `usd_multiplier` units | $1.00 = 1e18 | $1.00 = 1e9 |
| `MAX_OKU_M_PRICE` ceiling | implicit via overflow | explicit `1e15` (≈ \$1M / token) |

Implication: the off-chain orchestrator must scale by `1e9` when
reflecting value across the EVM ↔ SVM boundary.

## OkuMoney rebasing model

EVM `OkuDollar` accrues USD yield continuously between calls via
`MathLib._rpow`. SVM `oku-dollar` uses a discrete `usd_multiplier` that's
bumped per orchestrator call (`update_usd_multiplier`). Reasons:

- Solana's Token-2022 `Scaled UI Amount` extension stores a flat scalar
  (no per-second compounding), so wallets cannot show continuously-growing
  balances anyway.
- Recomputing `_rpow` on every wrap/unwrap blows the BPF compute budget.

Economic effect: identical between calls, indistinguishable to users. Price
observers reading the multiplier between bumps see the *current* multiplier,
exactly like reading EVM's `usdMultiplier()` at an arbitrary block.

## Yield-distribution sandwich guard

EVM uses the `whenYieldNotDistributing` modifier to fence:

- `LitePSM.{mint,redeem,processQueue,...}` against `setOkuMMultiplier` /
  `distributeYield`
- `OkuDollar.{wrap,unwrap}` against the multiplier-update path

SVM mirrors this with two slot stamps:

- `lite_psm::PsmConfig::last_yield_distribution_slot` — set by
  `set_oku_m_price` and `distribute_yield`. Read by `mint_oku_m` and
  `redeem_oku_m`. (Also indirectly consulted by `wrap`/`unwrap` because
  the vault reads `oku_m_price` from the PSM config; both consumers
  re-check the slot via `helpers::yield_lock::check_yield_lock`.)
- `oku_dollar::OkuDollarConfig::last_yield_distribution_slot` — set by
  `update_usd_multiplier`. Read by `wrap` and `unwrap` via
  `helpers::check_vault_yield_lock`.

`Clock::slot` is ~400ms vs Ethereum's 12s blocks, so the SVM lock window
is much tighter — but the orchestrator only needs to land its update
into one slot, then any wraps/unwraps that target that exact slot are
rejected. Net sandwich-protection equivalence holds.

## `distributeYield` zero-yield guard

Both EVM and SVM reject a `yieldAmount` (EVM) / `yield_amount` (SVM) that
truncates to zero per token (`yieldAmount * PRECISION / supply == 0`).
Without this guard, a sub-threshold yield call would stamp
`lastYieldDistributionBlock` / `last_yield_distribution_slot` without
actually moving the multiplier, wasting the sandwich-lock window for the
entire block/slot.

- EVM: `OkuMoney.distributeYield` reverts `YieldTooSmall()`.
- SVM: `distribute_yield` reverts `LitePsmError::YieldTooSmall`.

Additionally, on EVM `lastYieldDistributionBlock` is now only stamped
**after** the `YieldTooSmall` check, so a reverting call never consumes
the sandwich-lock slot.

## Authority / role naming

EVM uses `keccak256("ROLE_NAME")` byte string IDs registered with OZ's
`AccessControl`. SVM stores 12 authority pubkeys directly on the PSM
config PDA plus 5 on the vault config PDA. The `AuthorityRole` enum
variants and admin scripts map one-to-one. See `SVM/README.md` for the
mapping table.

## Pause-bypass deltas

| Operation | EVM | SVM |
|---|---|---|
| `freeze_account` / `thaw_account` | bypasses pause (Token-2022 freeze authority is independent of `Pausable`) | bypasses pause (Token-2022 freeze CPI signed by config PDA — pause check is intentionally omitted) |
| `unwrap` when paused | reverts (full freeze) | reverts (full freeze) |
| `process_queue` when paused | proceeds — pause must not lock users in the queue | proceeds, same rationale |

## Oracle

EVM uses Chainlink AggregatorV3 (`latestRoundData`, single staleness
check). SVM uses Pyth V2 with three independent checks: aggregate status
must equal `Trading`, `expo == 0`, and `now − aggregate.publish_timestamp
≤ staleness_threshold`. The accepted Pyth program owner pubkey is
stored on `PsmConfig::pyth_program_owner` and rotatable via
`set_pyth_program_owner` (oracle_manager-gated). The modern Pyth Solana
Receiver (`PriceUpdateV2`) layout is NOT supported until a parallel
parser is added.

## Inflation defense (vault first deposit)

Both sides reject zero-share mints via `AmountTooSmall`. SVM
additionally locks `MINIMUM_LIQUIDITY = 1_000_000` (1 usdOku at 6
decimals) of dead shares into a System Program ATA on the first
deposit, à la Uniswap V2. The EVM side relies on the OZ ERC4626
`previewDeposit` rounding and `_decimalsOffset` only; no dead shares.

## Queue model

| Aspect | EVM | SVM |
|---|---|---|
| Storage | unbounded `mapping(uint256 → RedemptionEntry)` | fixed `[QueueEntry; 200]` zero-copy ring buffer |
| Cap | none | 200 (raised from 10 in Phase 13b; capped by Solana's 10 KB single-CPI alloc budget) |
| Strict FIFO | yes (via `head`/`tail`) | yes (via `head`/`tail` u64 absolute indices) |
| Batch limit | none | `MAX_BATCH_ENTRIES = 50` per `process_queue` tx (CU budget) |

A 500-entry SVM queue would require a multi-step `init + 2× realloc`
deploy. Defer until the 200-entry SLA is a real production constraint.

## Vault rebasing model (OkuDollar)

EVM `OkuDollar.usdMultiplier()` is monotone-increasing and bumped
implicitly by `_rpow` per block. SVM `OkuDollarConfig.usd_multiplier`
is bumped discretely by `update_usd_multiplier` (`usd_rebaser` role).
Both have `MultiplierCannotDecrease` guards.

## Surplus accounting

Both sides compute vault surplus as
`max(reserve_balance × oku_m_price × PRECISION − total_supply × usd_multiplier, 0)`
and treat it as withdrawable to the `reserve_manager` while preserving
`min_collateral_ratio`.

## OkuMoney admin parity

| EVM (`OkuMoney.sol`) | SVM (`lite_psm` admin) |
|---|---|
| `setMaxSupply(uint256)` | `set_max_supply(u64)` |
| `configureMinterAllowance(address, uint256)` | `set_minter_allowance(u64)` (single minter = PSM) |
| `pause()` / `unpause()` | `pause` / `unpause` |
| `blacklist(address)` / `unblacklist(address)` | `freeze_account` / `thaw_account` (Token-2022 freeze authority) |
| `setOkuMMultiplier(uint256)` | `set_oku_m_price(u64)` |
| `distributeYield(uint256)` | `distribute_yield(u64)` |

## Blacklist semantics

EVM uses an explicit `mapping(address ⇒ bool) _blacklisted` checked on
every transfer/mint/burn. SVM uses Token-2022's `freeze_account` /
`thaw_account` extension — the on-chain effect is identical (frozen
accounts cannot send or receive), and the freeze authority is the PSM
config PDA. The exemption list that previously prevented freezing the
bridge / router PDAs has been removed (no infrastructure PDAs in v1
noBridge).

## Approval model

EVM uses `IERC20.approve` + `transferFrom`. SVM uses SPL's account
ownership: each operation has a `Signer` field on the account context,
and Anchor validates ownership at deserialization. No global approval
table.

## Round-trip drift

PSM mint/redeem rounding direction is identical on both sides (round
down, favouring the protocol). End-to-end USDC→OkuM→USDC round-trips
lose at most 1 wei (EVM) / 1 micro-USDC (SVM) of dust per round-trip
from integer-division truncation; tested by the round-trip cases in
`EVM/test/psm/LitePSM.t.sol` and `EVM/test/token/OkuDollar.t.sol`
on the EVM side, and `SVM/tests/bankrun/oku-dollar.ts::round-trip accuracy`
on the SVM side.

## Cross-chain operational requirements (v1 noBridge)

The orchestrator holds:

- A Solana keypair with the SVM `buffer_depositor`, `queue_processor`,
  and `rebaser` roles. Same key signs `mint_oku_m` / `redeem_oku_m` for
  cross-chain settlement, using its own ATAs as the source/destination.
- An EVM EOA with `PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR`, and
  `OKUM_REBASER` (and a separate EVM owner key for the relevant LitePSM
  admin actions).

Both keys should be KMS-backed. There are no on-chain bridge state
accounts, no chain whitelist, no nonces, no refund flow — all
cross-chain coordination is off-chain.

## Convenience functions

EVM `LitePSM` ships single-tx convenience flows (e.g. `mintUsdOku`,
`redeemUsdOku`). SVM previously housed these in a separate
`oku-bridge-router` program; that program was removed in the noBridge
refactor. SVM SDK consumers now compose multi-step flows from the raw
`mint_oku_m` / `wrap` / `unwrap` / `redeem_oku_m` instructions.

## Events

PSM, Vault, and queue events have matching shapes across EVM and SVM
with minor naming differences (e.g. `BufferRefilled` ↔ `BufferRefilledEvent`).
Indexers can map by the event name + field positions documented in each
side's `events.rs` / `events.sol`.

## Programs that exist on one side only

| Component | EVM | SVM | Notes |
|---|---|---|---|
| `OkuMoney` (ERC20 / SPL Token-2022) | yes | yes | parity |
| `OkuDollar` vault | yes | yes (separate `oku-dollar` program) | parity |
| `LitePSM` | yes (`EVM/src/psm/LitePSM.sol`) | yes (`programs/lite-psm`) | parity |
| `RedemptionQueue` | inside `LitePSM` (separate file) | inside `lite-psm` (`state::RedemptionQueue`) | parity |
| `oku-bridge-router` convenience program | n/a | removed in noBridge | EVM never had a router program; SVM removed its router along with the bridge |
| On-chain bridge | removed in noBridge (`OkuBridge`, `OkuBridgeRouter`, `NttAdapter` deleted) | removed in noBridge | both sides v1 are off-chain orchestrator-mediated |

## Where this is enforced in code

Yield lock: `EVM/src/lib/YieldSandwichGuard.sol` ↔ `programs/lite-psm/src/helpers/yield_lock.rs` + `programs/oku-dollar/src/helpers.rs::check_vault_yield_lock`.

Token decimal pinning: `EVM/src/psm/LitePSM.sol::initialize` (`usdcDecimalMultiplier`) ↔ `programs/lite-psm/src/instructions/init.rs` (asserts both USDC and OkuMoney mints have 6 decimals).

`TransferHook` reject (SVM only — EVM ERC-20 has no equivalent extension):
`programs/lite-psm/src/instructions/init.rs` parses the OkuMoney mint's
Token-2022 extension list and rejects `TransferHook`.
