# EVM ↔ SVM divergence reference

> Companion document to `SVM/README.md`. Lists every place where the SVM
> implementation deliberately diverges from the EVM one, with the rationale.
> Programs and scripts link back here from inline `// see EVM_VS_SVM.md`
> comments — keep the two in sync.

The SVM port is a faithful translation of the EVM contracts in spirit, but
Solana's runtime, account model, and Token-2022 layout force a number of
deliberate departures. None of the items below are bugs; they are documented
trade-offs.

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

Implication: cross-chain reconciliation must scale by `1e9` between the two
representations.

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

- `LitePSM.{mint,redeem,processQueue,...}` against `setOkuMPrice` /
  `distributeYield`
- `OkuDollar.{wrap,unwrap}` against the multiplier-update path

SVM mirrors this with two slot stamps:

- `lite_psm::PsmConfig::last_yield_distribution_slot` — set by
  `set_oku_m_price` and `distribute_yield`. Read by `mint_oku_m`,
  `redeem_oku_m`, `bridge_mint`, `bridge_burn`, `confirm_refund`,
  `wrap`, `unwrap`.
- `oku_dollar::OkuDollarConfig::last_yield_distribution_slot` — set by
  `update_usd_multiplier`. Read by `wrap` and `unwrap`.

`Clock::slot` is ~400ms vs Ethereum's 12s blocks, so the SVM lock window is
much tighter — but the orchestrator only needs to land its update into one
slot, then any wraps/unwraps that target that exact slot are rejected. Net
sandwich-protection equivalence holds.

## Bridge wire format (CRITICAL: dual 80-byte layouts)

The SVM bridge uses **two** distinct 80-byte layouts that share the same
total length:

```
SVM-burn → EVM-mint (built by lite_psm::bridge_burn,
                     consumed by EVM OkuBridge.bridgeMint)

  off  size  field
   0     2  source_chain_id   (u16  LE)
   2     2  dest_chain_id     (u16  LE)
   4    32  sender            (Solana pubkey)
  36    20  recipient         (EVM address)
  56     8  amount            (u64  LE, 6 decimals)
  64     8  nonce             (u64  LE)
  72     8  deadline          (i64  LE, unix seconds)

EVM-burn → SVM-mint (built by EVM OkuBridge.bridgeBurn / serializeMintMessage,
                     consumed by lite_psm::bridge_mint via BridgeRequest::to_message_bytes)

  off  size  field
   0     2  source_chain_id   (u16  LE)
   2     2  dest_chain_id     (u16  LE)
   4    20  sender            (EVM address)
  24    32  recipient         (Solana pubkey)
  56     8  amount            (u64  LE, 6 decimals)
  64     8  nonce             (u64  LE)
  72     8  deadline          (i64  LE, unix seconds)
```

`request_id = keccak256(message_bytes)`.

The TS canonical encoder is `scripts/lib/bridge/message.ts`. The Rust
canonical encoders are `lite_psm::instructions::bridge::bridge_burn`
(SVM→EVM) and `lite_psm::state::BridgeRequest::to_message_bytes` (EVM→SVM).
Do NOT inline buffer construction at call sites — drift between the JS and
Rust encoders is the most dangerous category of bug in the bridge.

EVM's `OkuBridge` signs `_hashTypedDataV4(structHash)` over the EIP-712
domain separator `("OkuBridge", "1")`. SVM's `bridge_mint` verifies an
Ed25519 signature over the **raw 80-byte payload** with no domain tag. The
two formats are byte-for-byte distinct (different sender/recipient widths,
LE vs BE field encoding), so a signature for one cannot be replayed against
the other even if the orchestrator key is shared.

**Operationally** the orchestrator therefore needs to sign with TWO distinct
keys (or at minimum two distinct signature schemes): a secp256k1 EIP-712
sig for EVM burns and an Ed25519 raw-byte sig for SVM mints.

## Authority / role naming

| EVM role | SVM field | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `role_admin` | OK |
| `PSM_PAUSER` | `pauser` | OK |
| `OKUM_BLACKLISTER` | `freezer` | renamed (semantically identical) |
| `OKUM_UNBLACKLISTER` | `unfreezer` | renamed |
| `OKUM_REBASER` | `rebaser` | OK |
| `PSM_UPGRADER` / `BRIDGE_UPGRADER` / `OKUM_UPGRADER` | (absent) | SVM upgrades are governed by the BPF loader upgrade authority on the program data account, NOT by `PsmConfig`. |
| `OKUM_MINTER` | (implicit, PSM PDA) | EVM has explicit minter role; on SVM the PSM config PDA is the sole mint authority. |
| `QUEUE_RESCUER` | `queue_processor` | **Collapsed**: a single role can both `process_queue` (paying USDC) and `rescue_queue_entry` (returning OkuMoney). On EVM these are separate roles. |

## Pause-bypass deltas

Both implementations use OZ-style `Pausable`. The exact functions that
deliberately ignore the pause state:

| Function | EVM bypasses pause? | SVM bypasses pause? |
|---|---|---|
| `processQueue` / `process_queue` | YES (so queued users can drain) | YES (matches) |
| `rescue_queue_entry` | YES | YES (matches) |
| `freeze_account` / `thaw_account` | YES (compliance must work) | YES (matches) |
| `initiate_refund` / `confirm_refund` / `cancel_refund` | YES | YES (matches) |
| `deposit_reserves` | NO (`whenNotPaused`) | NO (matches; restored in Phase 3) |
| `withdraw_reserves` / `withdrawSurplus` | NO | NO (matches; restored in Phase 3) |
| `bridge_mint` | NO | NO |
| `bridge_burn` | NO | NO |

## Oracle

EVM uses Chainlink AggregatorV3Interface and validates `answeredInRound`,
`updatedAt`, and `answer > 0`. SVM uses Pyth V2 (legacy) and validates:
- `agg.status == Trading` (1)
- `expo == 0` (the price is interpreted as raw token base units of reserves;
  any other expo would silently scale incorrectly)
- staleness in `[ORACLE_MIN_STALENESS_SECS=60, ORACLE_MAX_STALENESS_SECS=7d]`
- `agg.price >= 0`

Pyth's modern Solana Receiver (`PriceUpdateV2`) uses a different layout and
is NOT yet supported. Operators wanting to consume Receiver feeds should
add a parallel parser.

The accepted Pyth program-owner pubkey is per-deployment
(`PsmConfig::pyth_program_owner`, set at `initialize` and rotatable via
`set_pyth_program_owner`).

## Inflation defense (vault first deposit)

EVM `OkuDollar.wrap` reverts with `AmountTooSmall` when `sharesToMint == 0`.
SVM additionally implements the Uniswap-V2-style **dead-shares** pattern:
the first depositor mints `MINIMUM_LIQUIDITY = 1e6` shares to a canonical
ATA owned by the System Program (whose private key is unknowable, so the
shares are unrecoverable). This protects against the classic first-depositor
inflation attack on a rebasing share token.

The dead ATA must be:
1. Owned by `system_program::ID`
2. For the `usd_oku_mint`
3. The canonical Associated Token Account derived from those two

(Phase 1 added the canonical-address check to prevent off-canonical
placements that would split the dead supply.)

## Bridge UX deltas

| Aspect | EVM | SVM |
|---|---|---|
| Convenience flows | Live on `LitePSM` (`mintUsdOku`, `redeemUsdOku`, `redeemOkuMWithPermit`) | Live on `OkuBridgeRouter` (CPI-based) |
| Permit / single-tx UX | EIP-2612 permit | Durable nonces / Lookup Tables (not yet wired) |
| Third-party adapters | `NttAdapter`, future CCIP | None (native bridge only) |
| Bridge refund | Two-step (initiator + confirmer) | Two-step (matches; Phase 3 added per-call `InitiatorCannotConfirm` check) |
| Wallet price display | Frontends call `okuMPrice()` view | Frontends read `PsmConfig` PDA |

## Queue model

EVM `RedemptionQueue` is mapping-backed and effectively unbounded. SVM's
current implementation uses a fixed `[QueueEntry; 10]` ring buffer
(see `state::RedemptionQueue::MAX_ENTRIES`). This is an internal-prototype
limitation; a follow-up will replace it with per-user PDAs to lift the cap.
Until then, operators must keep the buffer topped up to ensure
`redeem_oku_m` falls into the instant path.

## Events

SVM events generally include richer context (`actor` fields on admin events,
`old_*` and `new_*` for rotations) than the EVM equivalents. Indexers
parsing both chains must accept the superset and tolerate missing fields on
the EVM side.

The `RedemptionSkippedEvent` (Phase 1) has no EVM analog because EVM never
needed to skip — its mapping-backed queue can always read the next non-zero
entry.

## Programs that exist on one side only

- EVM `OkuBridgeRouter.sweep` — unimplemented on SVM (the router never holds
  escrow because all CPI calls use the user as authority).
- EVM `OkuBridgeRouter.bridgeWrappedVia` / `bridgeVia` (NTT/CCIP adapters) —
  unimplemented on SVM.
- SVM `set_pyth_program_owner` — has no EVM analog (Chainlink address is
  set once at init).
- SVM `initialize_blacklist_exempt` — has no EVM analog (EVM uses an
  `AccessControl` role-based exempt-list rather than a one-shot
  pubkey-pair).

## Where this is enforced in code

- `lite_psm::state::BridgeRequest::to_message_bytes` — EVM→SVM mint layout
- `lite_psm::instructions::bridge::bridge_burn` — SVM→EVM burn layout
- `lite_psm::helpers::yield_lock::check_yield_lock` — PSM-side slot fence
- `oku_dollar::helpers::check_vault_yield_lock` — vault-side slot fence
- `lite_psm::helpers::oracle::check_oracle_reserves` — Pyth V2 parser
- `oku_bridge_router::validation::*` — cross-program PDA assertions
- `scripts/lib/bridge/message.ts` — TS canonical bridge encoder
