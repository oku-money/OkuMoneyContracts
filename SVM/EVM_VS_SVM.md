# EVM ↔ SVM divergence reference

> Companion document to `SVM/README.md`. Lists every place where the SVM
> implementation deliberately diverges from the EVM one, with the rationale.
> Programs and scripts link back here from inline `// see EVM_VS_SVM.md`
> comments — keep the two in sync.

The SVM port is a faithful translation of the EVM contracts in spirit, but
Solana's runtime, account model, and Token-2022 layout force a number of
deliberate departures. None of the items below are bugs; they are documented
trade-offs.

## Workspace layout (where the EVM libs went)

EVM groups protocol-wide invariants into `EVM/src/lib/`:

| EVM file | SVM equivalent |
|---|---|
| `lib/Constants.sol` | `crates/oku-shared/src/constants.rs` |
| `lib/MathLib.sol` | `crates/oku-shared/src/math.rs` |
| `lib/YieldSandwichGuard.sol` | `programs/lite-psm/src/helpers/yield_lock.rs` (PSM-side) + `programs/oku-dollar/src/helpers.rs::check_vault_yield_lock` (vault-side) |
| `lib/Roles.sol` | `programs/lite-psm/src/roles.rs`, `programs/oku-dollar/src/roles.rs`, `programs/oku-bridge-router/src/roles.rs` (split because each program owns its own RBAC enum) |
| `lib/Errors.sol` | `programs/{lite-psm,oku-dollar,oku-bridge-router}/src/errors.rs` (split because Anchor expects per-program `#[error_code]` enums) |
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
  `redeem_oku_m`, `bridge_mint`, `confirm_refund`. (Also indirectly
  consulted by `wrap`/`unwrap` because the vault reads `oku_m_price`
  from the PSM config; both consumers re-check the slot via
  `helpers::yield_lock::check_yield_lock`.)
- `oku_dollar::OkuDollarConfig::last_yield_distribution_slot` — set by
  `update_usd_multiplier`. Read by `wrap` and `unwrap` via
  `helpers::check_vault_yield_lock`.

Note: `bridge_burn` does NOT yield-lock on either side. It mirrors EVM
`OkuBridge.bridgeBurn` which has no `whenYieldNotDistributing` modifier
(the burn doesn't consume the price; only the destination mint does, and
that's already locked).

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
| Convenience flows | EVM splits between `LitePSM` (`mintUsdOku`, `redeemUsdOku`, `redeemOkuMWithPermit`) and `OkuBridgeRouter` (`bridgeWrappedVia`/`bridgeVia`) | SVM consolidates both kinds on `oku_bridge_router` (`mint_usd_oku`, `redeem_usd_oku`, `bridge_oku_m`, `bridge_usd_oku`) |
| Permit / one-tx UX | EIP-2612 permit | No analog. Solana doesn't have a directly-equivalent off-chain-signed-message + execute pattern. Future deployments may use durable nonces + a sponsored fee-payer relayer; the design is deferred. |
| Third-party adapters | `NttAdapter`, future CCIP | None (native bridge only) |
| Bridge refund | Two-step (initiator + confirmer) | Two-step (matches; Phase 3 added per-call `InitiatorCannotConfirm` check) |
| Wallet price display | Frontends call `okuMPrice()` view | Frontends read `PsmConfig` PDA |
| Router slippage params | None on `bridgeUsdOku`/`mintUsdOku` (atomic intra-block execution) | SVM router `bridge_usd_oku`, `redeem_usd_oku`, `mint_usd_oku` accept `min_*_out` slippage parameters because the discrete `usd_multiplier` creates a slippage window between sign and land. |
| Router transaction size | Single 1-tx convenience always fits | `mint_usd_oku` / `redeem_usd_oku` carry 16-17 accounts and need an Address Lookup Table (Phase 8.6 ships `scripts/admin/setup-router-alt.ts`). SDK consumers must include the ALT in every router CPI tx. |
| `OkuBridgeRouter.sweep` | Admin escape hatch for stuck tokens | Not implemented (router never holds escrow on SVM) |

## Queue model

EVM `RedemptionQueue` is mapping-backed and effectively unbounded. SVM's
implementation uses a fixed `[QueueEntry; 200]` zero-copy ring buffer
(see `state::RedemptionQueue::MAX_ENTRIES`).

**Sizing constraint.** The 200-entry cap is bounded by Solana's
`MAX_PERMITTED_DATA_INCREASE = 10_240` byte cap on CPI-driven account
allocations, which Anchor's `init` constraint goes through via the
System Program. A 200-entry queue is 9 640 bytes total — fits in one
shot. The original spec target was 500 (~24 KB); reaching that would
require either a multi-step `init + 2×realloc` deploy flow or
migrating to per-user PDAs. Both deferred — 200 closes the
operationally-urgent gap (the pre-Phase-13b cap was 10) and is bounded
by a documented Solana runtime constant, not by a code limitation we
can fix from the program side.

**Why zero-copy.** A naive `Account<RedemptionQueue>` at the
200-entry size would Borsh-deserialize ~9.6 KB into a BPF stack frame
on every handler entry and immediately overflow Solana's 4 KB stack.
`#[account(zero_copy)]` keeps the data in the account buffer and
byte-indexes into it via `AccountLoader::{load, load_mut, load_init}`.
The whole struct never lives on the stack. This is the standard
Anchor pattern for accounts > ~3-4 KB.

**Approximate-FIFO acceptable.** The on-chain ring buffer preserves
strict FIFO ordering by absolute `head` / `tail` indices (now `u64`,
widened from `u32` in Phase 13b). The user-visible "approximate FIFO"
caveat from the deferred-Phase-4c outline does not apply here — strict
on-chain FIFO survived the migration intact.

**Instruction signature differences.** EVM `processQueue(startIndex,
endIndex, approveAmount)` takes a USDC approval and an index range;
SVM `process_queue(max_entries)` takes only a batch size and uses CPI
signer-based authority. Phase 13b adds a hard `MAX_BATCH_ENTRIES = 50`
cap on the SVM side to keep CU usage predictable across the new
larger ring (200 entries × ~4 K CU per entry on burn+transfer would
otherwise let a misconfigured orchestrator tx OOM the budget).

Phase 8.1's `BufferRefilledEvent` (emitted at end of batch for indexer
reconciliation) still applies; its `processed_count` / `skipped_count`
fields were widened to `u64` in Phase 13b alongside the head/tail
widening.

## Vault rebasing model (OkuDollar)

Already covered for OkuMoney above; the same divergence applies to the
`usd_multiplier` (per-share USD value):

| Aspect | EVM | SVM |
|---|---|---|
| Accrual | Continuous via `_rpow(rate, dt)` | Discrete `update_usd_multiplier(absolute)` per orchestrator call |
| Rate-staging | `setUsdYieldRate(rate, endTimestamp)` and `setNextUsdYieldRate(pendingRate)` allow scheduled rate transitions | No rate concept — staging requires N+1 explicit `update_usd_multiplier` calls |
| Per-call ceiling | `MAX_RATE = PRECISION + 1e11` (≈3700% APY) bounds the rate | `MAX_USD_MULTIPLIER = 1e15` (Phase 8.1) bounds the absolute multiplier |
| `unwrap` parameterization | `unwrap(usdAmount)` — caller specifies dollar amount; ceiling-divides shares to favor the vault | `unwrap(shares)` — caller specifies share amount; floor-divides OkuMoney out |

Economic equivalence between calls is identical; the API shape and
intermediate rounding direction differ.

## Surplus accounting

EVM `OkuDollar.surplus()` is a public view that returns the OkuMoney
reserves above the minimum collateral ratio. SVM exposes the same formula
as a pure helper `oku_dollar::helpers::calculate_surplus` but does NOT
have an instruction-level view (Solana has no view fns). Clients
reconstruct off-chain from `OkuDollarConfig`, `reserve_vault.amount`,
`usd_oku_mint.supply`, and the configured `min_collateral_ratio`.

Similarly, EVM `OkuDollar.getStatus()` (snapshot view returning all
rate/share state) has no SVM analog; clients fetch the full
`OkuDollarConfig` PDA in one RPC call.

EVM `RedemptionQueue` has `queueLength() / queueAt() / getQueueEntry() /
getQueueEntryValue() / totalQueuedUsdc()` views; SVM clients read the
fields directly off the `RedemptionQueue` PDA.

## OkuMoney admin parity

| Aspect | EVM | SVM |
|---|---|---|
| `minterAllowance` shape | Per-minter `mapping(address => uint256)` (Circle FiatToken pattern) | Single global `u64` (Phase 8 confirmed: there's only one minter, the PSM PDA, so a mapping is moot) |
| `setMaxSupply` lower bound | `BelowCurrentSupply` revert | `BelowCurrentSupply` revert (Phase 8.1 added — was previously silent) |
| `okuMMultiplier()` getter | View on `OkuMoney` itself | Read `PsmConfig.oku_m_price` from the PDA |
| `TransferValue` per-transfer event | Emitted via `_update` override | Not emitted — SVM cannot intercept Token-2022 transfers without a transfer-hook program (intentionally not deployed). Indexers on the SVM side must derive transfer values from balance deltas. |
| `permit()` blacklist gating | EVM overrides `permit()` to revert on blacklisted owner/spender | N/A on SVM (no permit equivalent) |
| Per-call `setOkuMMultiplier` ceiling | None; only `>= current` | `MAX_OKU_M_PRICE = 1e15` ceiling (Phase 8.1 already covered above) |
| Same-chain bridge_mint reject | `CannotBridgeToSelf` | `WrongSourceChain` (Phase 8.1 added) when `request.source == bridge_config.source_chain_id` |
| `skipNonce` semantics | Increments by exactly 1 | Accepts arbitrary delta (more flexible) but bounded by `MAX_NONCE_SKIP = 10_000` (Phase 8.1) |

## Blacklist semantics asymmetry

EVM `OkuMoney._update` blocks BOTH inbound and outbound transfers for
blacklisted addresses (the `from` and `to` are checked).

SVM uses Token-2022's `freeze_account`/`thaw_account` which gate **debits
only**: a frozen ATA cannot send, but it can still receive. There is no
"don't transfer to address X" check on the credit side because Token-2022
freezes target ATAs (not owners).

Operational consequence: an SVM operator who wants EVM-equivalent
"blacklisted address gets no inbound transfers" must additionally freeze
every potential sender's ATA — typically not feasible in practice. This
is a documented limitation.

The blacklist also doesn't gate `mint_oku_m`/`bridge_mint`/`confirm_refund`
based on the destination wallet's blacklist status — SVM only knows the
destination ATA, and only that ATA's frozen state is checked. EVM minted
to a blacklisted owner reverts; SVM minted to a blacklisted owner's ATA
will succeed (the ATA itself isn't frozen unless explicitly done).

## Approval model

EVM uses `approve` + `transferFrom` for delegated transfers. The PSM and
Vault both rely on this for pulling USDC/OkuMoney from users.

SVM uses direct user-signed transfer authority (no separate approve
step). The user signs the entire tx and the PSM/Vault CPIs execute
transfers under the user's signature. More efficient (one tx, not two)
but precludes meta-tx / sponsor-pays-fees patterns where a relayer pulls
pre-approved tokens from a user who didn't sign the on-chain tx.

To approximate the EVM relayer pattern on SVM, clients would need
durable nonces + an off-chain signed message + a fee-payer relay tx
(deferred work; see "Bridge UX deltas" → permit row).

## Round-trip drift

EVM `LitePSM.mintOkuM` enforces a `RoundTripDriftTooLarge` revert: after
computing `okuMAmount`, EVM round-trips through `okuMToDollars` then
`dollarsToUsdc` and reverts if the round-trip USDC differs from the input
by more than 1 unit. This catches >1-wei dust loss when EVM USDC has
fewer decimals than OkuMoney (6 vs 18).

SVM omits the check because both sides are 6-decimal — the only drift
comes from `oku_m_price` truncation in `dollars_to_oku_m`, bounded to ≤1
atomic unit of OkuMoney (the `PRECISION` divisor). Phase 8 confirmed
this remains within the EVM tolerance.

Similarly, EVM `redeemOkuM` enforces an `OutputBelowMinimum` slippage
floor computed via `dollarsToUsdc(okuMToDollars(okuMFloor, mult))`. SVM
only requires `usdc_amount > 0` (Phase 8.1) because the matching-decimals
case can only truncate to zero, not to a meaningfully different non-zero.
For caller-controlled slippage on SVM, use the router's `min_*_out`
slippage parameters.

## set_bridge_authority privilege boundary

EVM `OkuBridge` exposes `setRoleAdmin` / `grantRole` / `revokeRole` for
all roles via `AccessControlUpgradeable`. SVM `set_bridge_authority`
covers the role-style fields (`bridge_admin`, `bridge_pauser`,
`refund_initiator`, etc.) but **rejects** the `OrchestratorSigner` and
`FeeRecipient` arms (Phase 8.1) because those config pubkeys must go
through the dedicated `update_orchestrator_signer` (signer_manager-gated)
and `update_fee_recipient` (fee_manager-gated) instructions. Routing
them through `bridge_admin` would let `bridge_admin` bypass the
per-config-pubkey gate.

EVM has the same logical boundary but expresses it via separate
`AccessControl` roles (`SIGNER_MANAGER_ROLE`, `FEE_MANAGER_ROLE`); SVM
encodes the boundary directly in `set_bridge_authority`'s match-arm
runtime check + a new `UseDedicatedRotation` error.

## Validator chain ID

The internal protocol u16 `BridgeConfig.source_chain_id` is set at deploy
time via `initialize_bridge`. Phase 8.0 added a network resolver
(`scripts/config/constants.ts::sourceChainIdForNetwork`) so a
`mainnet-beta` deploy automatically uses 101 (Solana Mainnet) rather
than 103 (Solana Devnet). A previous revision aliased
`SOLANA_CHAIN_ID = SOLANA_DEVNET_CHAIN_ID` and would have silently
misconfigured a mainnet bridge — fixed in P8.0.

EVM uses `block.chainid` directly (uint256), no manual resolution
required. The 32-byte EIP-712 chain-id encoding is a separate concern
covered by the bridge wire-format section above.

## Cross-chain rounding direction (18 ↔ 6 decimals)

The EVM-side bridge encoder lives outside this repo; when scaling an
18-decimal `OkuMoney.amount` down to the 6-decimal SVM `amount` field
embedded in a signed BridgeRequest, the encoder MUST round DOWN (favor
the protocol). The SVM side accepts the already-6-decimal value verbatim
and does no further scaling.

This rounding direction is not currently asserted on either side; verify
in any future EVM relayer audit and add a TS unit test in
`scripts/lib/bridge/` that exercises the rounding edge cases.

## Approval / one-tx UX deferred

EIP-2612 permit and the related EVM convenience functions
(`redeemOkuMWithPermit`, `redeemUsdOkuWithPermit`) have no SVM analog and
no concrete spec for a Solana-equivalent. Options for future work:

1. **Durable nonces + sponsored fee-payer relayer.** A user signs an
   off-chain message that a relayer wraps in a Solana tx (the user
   pays nothing on chain). Requires a relayer service and durable-nonce
   discipline.
2. **Squads-style multi-sig instructions.** The Squads program supports
   signed off-chain proposals that any party can execute on-chain.
3. **Wait for Solana protocol-level "signed message + execute" support.**
   No timeline.

Until one is wired, SVM's one-tx UX is provided by the router (which
batches PSM mint + vault wrap into one CPI tx but still requires the
user's full signature).

## Reentrancy guards

EVM uses `nonReentrant` modifiers everywhere. SVM relies on:

1. Anchor's deserialize-once-per-tx semantics (storage deltas commit
   atomically at end-of-instruction).
2. Effects-checks-interactions ordering enforced manually in code (e.g.
   `mint_oku_m` decrements `minter_allowance` BEFORE the mint CPI; same
   in `bridge_mint` and `confirm_refund`).
3. The **invariant that the OkuMoney mint has no Token-2022
   `TransferHook` extension**. This invariant is currently
   operational (deploy script doesn't add the hook) rather than
   on-chain-asserted. A future hardening is to assert at PSM init that
   the OkuMoney mint's extension list does not include `TransferHook`.

## Cross-chain operational requirements

The bridge orchestrator must hold TWO distinct signing keys (or sign
through two distinct schemes):

- **secp256k1** for EIP-712 signatures over EVM-bound mint requests
- **Ed25519** for raw 80-byte payload signatures over SVM-bound mint
  requests (verified via the Solana Ed25519 precompile + instruction
  introspection — see `lite_psm::helpers::ed25519`)

Key material MUST NOT be reused: secp256k1 and Ed25519 use different
elliptic curves and produce different addresses; even if both could be
derived from the same 256-bit seed, conflating them would weaken the
bridge's separation-of-concerns model.

The dual-key requirement is documented operationally in the deploy
runbook (`SVM/README.md` Runbook section).

## Chain ID width

EVM `BridgeRequest.{source,destination}ChainId` are `uint256`. SVM is
`u16`. Real EVM chain IDs (Ethereum=1, Polygon=137, Base=8453,
Avalanche=43114) all fit in u16, but this is a real ceiling — Linea
(59144), Arbitrum One (42161) overflow. The SVM `BridgeConfig` stores
*protocol-internal* u16 IDs (via `eip155ToInternalChainId` in
`scripts/config/constants.ts`), not raw EIP-155 values.

Cross-chain index implication: any indexer storing `chain_id` from both
chains must use INT64 or wider, and apply the EIP-155↔internal mapping
when joining.

## Events

SVM events generally include richer context (`actor` fields on admin events,
`old_*` and `new_*` for rotations) than the EVM equivalents. Indexers
parsing both chains must accept the superset and tolerate missing fields on
the EVM side.

Phase-8 event-shape deltas:

| Event | EVM fields | SVM fields | Notes |
|---|---|---|---|
| `BridgeMint` | `(requestId, recipient, sourceChainId, destChainId, amount)` | `(request_id, source_chain_id, recipient, amount, nonce, dollar_value)` | SVM omits `dest_chain_id` (current chain is implicit). SVM `recipient` is the wallet pubkey (Phase 8.1) — was previously the destination ATA. |
| `BridgeBurn` | `(requestId, sender, recipient, sourceChainId, destChainId, grossAmount, netAmount, feeAmount, nonce, deadline)` | `(request_id, user, recipient, source_chain_id, destination_chain, gross_amount, amount, nonce, deadline, dollar_value, fee_amount)` | Phase 8.1 added `gross_amount` for cross-chain reconciliation. SVM additionally emits `dollar_value`. |
| `RefundCancelled` | `(requestId, initiator, cancelledBy)` | `(request_id, initiator, canceller)` | Phase 8.1 added `initiator` so SVM event captures the full proposal-to-cancel audit trail. |
| `RefundConfirmed` | `(requestId, sender, amount)` | `(request_id, recipient, amount)` | EVM names the field `sender` (the original sender of the bridge tx); SVM names it `recipient` (since the refund mints back to the recipient ATA whose owner equals the original sender). Same value, different field name. |
| `RedemptionSkipped` | `(uint256 indexed index)` | `(queue_index: u32)` | Phase 1 added; EVM has the same shape. |
| `BufferRefilled` | `(newBufferBalance, processedCount, skippedCount)` | `(new_buffer_balance, processed_count, skipped_count)` | Phase 8.1 added; mirrors EVM. |
| `RedemptionRescued` | `(index, originalUser, recipient, okuMAmount, dollarValue)` | `(queue_index, original_user, recipient, oku_m_amount, dollar_value)` | `recipient` is the wallet (Phase 1), not the ATA. |

## Programs that exist on one side only

EVM-only:
- `OkuBridgeRouter.sweep` — unimplemented on SVM (the router never holds
  escrow because all CPI calls use the user as authority).
- `OkuBridgeRouter.bridgeWrappedVia` / `bridgeVia` (NTT/CCIP adapters) —
  unimplemented on SVM.
- `OkuDollar.surplus()` view, `OkuDollar.getStatus()` snapshot view —
  Solana has no view fns; clients reconstruct from the
  `OkuDollarConfig` PDA + a tiny off-chain helper.
- `OkuDollar.setUsdYieldRate` / `setNextUsdYieldRate` rate-staging
  instructions — SVM uses discrete `update_usd_multiplier` only.
- `LitePSM.redeemOkuMWithPermit` / `redeemUsdOkuWithPermit` — no permit
  on SVM.
- `OkuBridge.domainSeparator()` / `hashTypedDataV4()` views — N/A on
  SVM (raw 80-byte payload, no domain separator).

SVM-only:
- `set_pyth_program_owner` — Chainlink uses a fixed address at init on
  EVM; SVM allows rotating between Pyth deployments.
- `initialize_blacklist_exempt` — EVM uses `AccessControl` role-based
  exempt-list rather than a one-shot pubkey-pair.
- `BufferRefilledEvent` — Phase 8.1 batch-summary event for
  `process_queue` (also exists on EVM `OkuBridge` but as `BufferRefilled`).
- ALT setup script — no EVM equivalent (EVM has no transaction-size
  limit comparable to Solana's 1232-byte cap).
- `MAX_OKU_M_PRICE` / `MAX_USD_MULTIPLIER` ceilings — EVM has only
  `>= current` checks. SVM Phase 3+ added absolute ceilings as
  defense-in-depth against rebaser-key compromise.
- `MAX_NONCE_SKIP` — EVM `skipNonce` increments by 1 unconditionally;
  SVM allows arbitrary delta but bounds it.

## Where this is enforced in code

- `lite_psm::state::BridgeRequest::to_message_bytes` — EVM→SVM mint layout
- `lite_psm::instructions::bridge::bridge_burn` — SVM→EVM burn layout
- `lite_psm::helpers::yield_lock::check_yield_lock` — PSM-side slot fence
- `oku_dollar::helpers::check_vault_yield_lock` — vault-side slot fence
- `lite_psm::helpers::oracle::check_oracle_reserves` — Pyth V2 parser
  (Phase 8.0 corrected the `agg.status` width and `publish_time` offset
  — see file-level comments for the canonical layout)
- `lite_psm::instructions::psm_admin::set_max_supply` —
  `BelowCurrentSupply` guard
- `lite_psm::instructions::bridge::bridge_mint` — same-chain reject
  (`request.source_chain_id != self.source_chain_id`)
- `lite_psm::instructions::bridge_admin::set_bridge_authority` —
  rejects `OrchestratorSigner` / `FeeRecipient` arms
- `lite_psm::instructions::bridge_admin::skip_nonce` — `MAX_NONCE_SKIP`
  cap
- `oku_dollar::instructions::core::initialize` — cross-link assertion
  `psm_config.oku_money_mint == oku_money_mint`
- `oku_dollar::instructions::core::update_usd_multiplier` —
  `MAX_USD_MULTIPLIER` ceiling
- `oku_bridge_router::validation::*` — cross-program PDA + pause checks
- `scripts/config/constants.ts::sourceChainIdForNetwork` — network →
  protocol-internal Solana chain ID resolver
- `scripts/lib/bridge/message.ts` — TS canonical bridge encoder
- `scripts/lib/bridge/event.ts` — TS BridgeBurnEvent parser
- `scripts/admin/setup-router-alt.ts` — Address Lookup Table setup
