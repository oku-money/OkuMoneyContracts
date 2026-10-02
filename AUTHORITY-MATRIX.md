# Authority Matrix — EVM + SVM

Every on-chain path that **moves value** or **changes authority**, with its guard, blast
radius, and reversibility. Built for internal review; every row was verified against the
source, not transcribed from docs.

Reversibility means *can the effect be undone on-chain* — not whether the role can be
revoked afterwards.

Constants: `PRECISION = 1e18` · `MAX_MULTIPLIER = 1e24` (1,000,000× ceiling) ·
`MAX_RATE = 1e18 + 1e11` (≈ +0.8677 %/day, ≈ 2.18× over one 90-day window) ·
`MAX_RATE_WINDOW = 90 days`.

---

## 0. Why these levers are on-chain at all

The protocol's default is that business policy lives in the backend. A control
is kept on-chain only if it satisfies one of three rules: **(a)** it bounds the
blast radius of a key compromise, **(b)** it enforces a maths invariant the
model rests on, or **(c)** it must execute atomically inside a user's own
transaction. Listed explicitly so each is read as a decision rather than an
omission — none of them is there for decentralisation.

| Control | Rule | Why it survives |
|---|---|---|
| Rate rails (`rate >= PRECISION`, `<= MAX_RATE`) | (b) | Monotonicity is the invariant the entire multiplier model rests on. A backend bug writing a sub-unity rate would corrupt accounting, not merely misbehave. Cost ≈ 0 |
| Bounded-window requirement on yielding rates | (b) | An open-ended rate ends at a transaction-dependent, per-chain moment — reintroducing the cross-chain divergence the design eliminates |
| Pause gate on rate *increases*, against the **effective** rate | (b) | Prevents inflating the multiplier while users cannot exit. Subtle and load-bearing — a divergence was found here during audit |
| `max_supply` / `minter_allowance` caps | (a) | Bound the blast radius of a compromised minter key |
| Role separation on `PsmConfig` / EVM `AccessControl` | (a) | Cold / warm / orchestrator separation is key-compromise defence |
| `set_okum_multiplier` emergency override | (c) | The backend needs an atomic re-anchor lever |
| Sandwich lock on the override | (c) | The override is the one remaining discrete jump |
| Computed multiplier (`rpow` on the hot path) | (c) | The PSM must price atomically inside the user's transaction; a Solana instruction cannot call out mid-execution. See `SVM/README.md` § Compute budget |

**The distinction to apply generally:** maths invariants and key-compromise
bounds stay on-chain; business policy moves to the backend.

---

## 1. EVM — role-gated paths (29)

| # | Path | File:line | Role | Blast radius | Guards | Rev? |
|---|---|---|---|---|---|---|
| E1 | `setOkuMMultiplier` | `OkuMoney:510` | `OKUM_REBASER` | **Raise multiplier up to 1e24 — a 1,000,000× inflation of every balance, redeemable against the PSM buffer** | `whenNotPaused`, strictly-increasing, ≤ `MAX_MULTIPLIER` | **No** |
| E2 | `setOkuMYieldRate` | `OkuMoney:324` | `OKUM_REBASER` | Stream ≤ `MAX_RATE` for ≤ 90 d (≈ 2.18× per window) | rate + window bounds; pause-gated **only** on increase vs *effective* rate | **No** |
| E3 | `setNextOkuMYieldRate` | `OkuMoney:423` | `OKUM_REBASER` | Arm successor, same bounds | as above, successor window bounded independently | **No** |
| E4 | `setOkuMYieldRateWithSuccessor` | `OkuMoney:482` | `OKUM_REBASER` | E2 + E3 atomically | as above | **No** |
| E5 | `mint` | `OkuMoney:686` | `OKUM_MINTER` | Mint to `min(maxSupply − supply, minterAllowance)` | `whenNotPaused`, supply cap, per-minter allowance, recipient blacklist | **No** |
| E6 | `burn` | `OkuMoney:702` | `OKUM_BURNER` | Burn caller's own balance only | sender blacklist; **no pause gate — works while paused, deliberately** (`test_Burn_WorksWhenPaused`) | No |
| E7 | `configureMinterAllowance` | `OkuMoney:713` | `OKUM_ALLOWANCE_MANAGER` | Set **any** minter's allowance, incl. its own, to `type(uint256).max` | none beyond the role | Yes |
| E8 | `setMaxSupply` | `OkuMoney:731` | `OKUM_CAP_MANAGER` | Raise/lower the global cap | `≥ totalSupply` | Yes |
| E9 | `blacklist` | `OkuMoney:798` | `OKUM_BLACKLISTER` | Freeze an address as sender, recipient, **or approved spender** (incl. `approve`/`permit`/`transferFrom`/`mint`-as-minter — matched to Circle FiatToken's scope, see `EVM/README.md` Accepted Risk #13) | works while paused; does NOT retroactively revoke allowances already granted | Yes (E10) |
| E10 | `unblacklist` | `OkuMoney:752` | `OKUM_UNBLACKLISTER` | Unfreeze | — | — |
| E11 | `pause` / `unpause` | `OkuMoney:762/767` | `OKUM_PAUSER` / `OKUM_UNPAUSER` | Halt mint + transfers | — | Yes |
| E12 | `_authorizeUpgrade` | `OkuMoney:773` | `OKUM_UPGRADER` | **Replace all token logic** | **none — no timelock, no two-step** | **No** |
| E13 | `rescueDonation` | `OkuDollar:659` | `VAULT_RESCUER` | Withdraw OkuM held above `totalUsdShares` | `nonReentrant`, `held > totalUsdShares`; **≈1 wei/unwrap is permanently classifiable as donation** | **No** |
| E14 | `blacklist` / `unblacklist` | `OkuDollar:774/782` | `OKUM_(UN)BLACKLISTER` | Freeze on the vault — **same role hash as E9/E10, but a separate grant per contract**; same sender/recipient/spender scope as E9 (incl. `transferFrom` and the ERC-4626 `redeem`/`withdraw` spender path) | works while paused; does NOT retroactively revoke allowances | Yes |
| E15 | `pause` / `unpause` | `OkuDollar:712/717` | `VAULT_PAUSER` / `VAULT_UNPAUSER` | Halt wrap/unwrap/4626 | — | Yes |
| E16 | `_authorizeUpgrade` | `OkuDollar:723` | `VAULT_UPGRADER` | **Replace all vault logic** | **none** | **No** |
| E17 | `processQueue` | `LitePSM:392` | `PSM_QUEUE_PROCESSOR` | Spend up to caller-chosen `approveAmount` of buffer USDC | `nonReentrant`, `whenNotPaused`, yield-lock; **`approveAmount` itself unvalidated** | **No** |
| E18 | `pause` / `unpause` | `LitePSM:415/420` | `PSM_PAUSER` / `PSM_UNPAUSER` | Halt all PSM user paths | — | Yes |
| E19 | `withdrawUsdc` | `LitePSM:435` | `PSM_BUFFER_WITHDRAWER` | **Drain the buffer down to the *queued* obligation — circulating OkuM/UsdOku is not counted** | yield-lock + `WouldStrandQueue`; **deliberately NOT pause-gated** | **No** |
| E20 | `depositBuffer` | `LitePSM:458` | `PSM_BUFFER_DEPOSITOR` | Add USDC (pull from caller) | **none of the three modifiers** | No |
| E21 | `_authorizeUpgrade` | `LitePSM:467` | `PSM_UPGRADER` | **Replace all PSM logic** | **none** | **No** |
| E22 | `enqueue` | `RedemptionQueue:163` | `QUEUE_PSM` | Add an obligation; inflates `totalQueuedOkuM` | zero-user guard | **No** |
| E23 | `processQueue` | `RedemptionQueue:205` | `QUEUE_PSM` | Pay + burn queued entries | `nonReentrant` | **No** |
| E24 | `rescueQueueEntry` | `RedemptionQueue:376` | `QUEUE_RESCUER` | **Send any queued user's escrowed OkuM to an arbitrary address** | `nonReentrant`, index range, `!= address(0)` — **recipient NOT checked against `entry.user`** | **No** |
| E25 | `_authorizeUpgrade` | `RedemptionQueue:489` | `QUEUE_UPGRADER` | **Replace all queue logic** | **none** | **No** |
| E26 | `grantRole` / `revokeRole` ×4 | OZ `AccessControl` | `DEFAULT_ADMIN_ROLE` | **Grant or revoke every role above, on that contract** | none — immediate, no two-step | Yes |
| E27 | `initialize` ×4 | each contract | deployer | Grants **every** role to one `_admin`; protocol is single-key until scripts redistribute | `initializer` | — |

**EVM permissionless (for completeness):** `LitePSM.mintOkuM/redeemOkuM/mintUsdOku/redeemUsdOku`
(`:190/224/303/351`) and `OkuDollar.wrap/unwrap/redeem/withdraw` (`:371/423/600/583`) — all
carry `nonReentrant + whenNotPaused + whenYieldNotDistributing`. `OkuDollar.deposit/mint`
(`:565/571`) appear unguarded but delegate to `wrap`, inheriting its guards.
`RedemptionQueue.advanceHead` (`:432`) is permissionless and safe — monotone, and only
advances past already-cleared slots — but **only because it now carries `nonReentrant`**.
`processQueue` transiently clears a live slot across its external transfer call (delete,
then restore-on-failure); a reentrant `advanceHead` fired from a transfer-callback
collateral token during that window could previously have stranded the entry permanently
below `queueHead`. Not reachable with the Circle USDC configured today (no transfer
callback), but the collateral token is a deploy parameter this contract cannot itself
enforce. See `EVM/README.md` Accepted Risk #6 and `test/psm/Reentrancy.t.sol`.

---

## 2. SVM — role-gated instructions (25)

Roles are **pubkeys stored on `PsmConfig`**, enforced by Anchor `has_one`, not a role mapping.

| # | Instruction | Role | Blast radius | Guards | Rev? |
|---|---|---|---|---|---|
| S1 | `set_okum_multiplier` | `rebaser` | **Same 1,000,000× ceiling as E1** — plus a **mandatory Token-2022 CPI**: the emergency lever aborts if `ScaledUiAmount::update_multiplier` fails | pause, yield-lock, strictly-increasing, ≤ `MAX_MULTIPLIER` | **No** |
| S2 | `set_okum_yield_rate` | `rebaser` | As E2 | rate + window bounds, pause gate | **No** |
| S3 | `set_next_okum_yield_rate` | `rebaser` | As E3 | as above | **No** |
| S4 | `set_okum_yield_rate_with_successor` | `rebaser` | As E4 | as above | **No** |
| S5 | `mint_oku_m_direct` | `direct_minter` | **Mint with NO collateral** — bounded only by `max_supply` and `direct_minter_allowance`. No EVM equivalent. | pause, yield-lock, cap, allowance | **No** |
| S6 | `burn_oku_m_direct` | `direct_burner` | Burn from own ATA | pause, yield-lock, allowance | **No** |
| S7 | `withdraw_buffer` | `buffer_withdrawer` | **Drain the vault. Only check is `vault_balance >= amount`** — no queue exists and no solvency test at all. Strictly weaker than E19. | yield-lock; **NOT pause-gated** | **No** |
| S8 | `deposit_buffer` | `buffer_depositor` | Add USDC | pause **and** yield-lock (stronger than E20) | No |
| S9 | `set_max_supply` | `cap_manager` | Raise/lower cap | — | Yes |
| S10 | `set_minter_allowance` | `allowance_manager` | **Single global** PSM mint allowance (EVM's is per-address) | — | Yes |
| S11 | `set_direct_minter_allowance` | `allowance_manager` | Bound/starve S5 — **the only off-switch for S5** | — | Yes |
| S12 | `set_direct_burner_allowance` | `allowance_manager` | Bound S6 | — | Yes |
| S13 | `freeze_account` | `freezer` | Freeze an ATA via Token-2022 (blocks send **and** receive) | not pause-gated, by design | Yes (S14) |
| S14 | `thaw_account` | `unfreezer` | Unfreeze | — | — |
| S15 | `pause` / `unpause` | `pauser` / `unpauser` | Halt user paths | — | Yes |
| S16 | `set_authority` | `role_admin` | Rotate any of 11 roles — **commits immediately**; only `RoleAdmin` is two-step | rejects `Pubkey::default()`; forbids assigning a granular role to `role_admin` | Yes |
| S17 | `accept_role_admin` | `pending_role_admin` | Complete the two-step handover | Ownable2Step-equivalent | — |
| S18 | `cancel_role_admin_transfer` | `role_admin` | Abort a pending handover | — | — |
| S19 | `update_token_metadata` | `role_admin` | Rename the live token (two raw `invoke_signed`) | — | Yes |
| S21 | `initialize` | `role_admin` = **BPF upgrade authority** | Creates config, mints, vault | ties `role_admin` to `ProgramData` upgrade authority — **good, non-obvious anti-land-grab control** | — |
| S22 | Program upgrade | BPF upgrade authority | **Replace all program logic** | none | **No** |

**S20 is intentionally vacant.** It was `migrate_config_space` — a `role_admin`-gated
resize of the config PDA that authenticated by reading `role_admin` from a hardcoded
byte offset on an `UncheckedAccount`. Removed: its target set was empty (no account of
the layout it resized has ever been deployed) and it had zero tests. Numbering is left
unshifted so existing citations of S21/S22 stay valid.

**SVM permissionless:** `mint_oku_m`, `redeem_oku_m` (pause + yield-lock + slippage
`min_usdc_out`), and `sync_display_multiplier` — correctly permissionless, since its
output is a pure function of existing state.

---

## 3. Findings — verified, ordered by severity

**A. A single `OKUM_REBASER` / `rebaser` key can inflate the multiplier 1,000,000× (E1, S1).**
Only constraints are "strictly greater", the `1e24` ceiling, and `whenNotPaused`. **No
timelock, no rate-of-change limit, no multisig requirement in code.** Any holder can then
redeem the inflated value against the PSM. This is the single largest unguarded lever on
either stack.

**B. Buffer-drain solvency checks don't cover circulating supply (E19, S7).**
`withdrawUsdc` tests `remainingBalance >= totalQueuedUsdc()` — **queued obligations only**.
The buffer can be drained to exactly the queued amount while 100 % of circulating
OkuM/UsdOku remains unbacked. SVM's `withdraw_buffer` has no solvency check whatsoever.
Neither is pause-gated.

**C. `rescueQueueEntry` can redirect user funds to an arbitrary address (E24).**
`alternateRecipient` is checked only for `address(0)` — **never against `entry.user`**.
Single signature, irreversible. Deliberate, not an oversight: the escape hatch it exists
for (an OkuM-**blacklisted** `entry.user`, whose self-return would revert
`RecipientBlacklisted`) requires exactly this freedom. Docs previously misattributed the
trigger to USDC-blacklisting — wrong: OkuM's blacklist is independent, so a
USDC-blacklisted user can still self-receive via `alternateRecipient == entry.user`.
**Mitigation is conditional, not structural:** on the mainnet topology
(`grantRolesMainnet.ts`) `QUEUE_RESCUER` is co-held with `QUEUE_UPGRADER` (E25, no
guards) by the Cold Multisig, so the redirect adds no marginal power over a key that can
already replace the contract outright — but that argument evaporates the moment
`QUEUE_RESCUER` is granted to any key that does *not* also hold `QUEUE_UPGRADER` (e.g. a
testnet operator key). Verify co-location before relying on this row as "covered."

**D. `direct_minter` / `direct_burner` can never be disabled (S5, S16).**
`set_authority` rejects `Pubkey::default()` unconditionally, but that value *is* the
"disabled" sentinel these two roles use. Once enabled, the uncollateralised mint path can
only be reassigned, never switched off. Its only off-switch is the allowance — which lives
on a **different role** (`allowance_manager`).

**E. Role compounding is unconstrained.**
`OKUM_MINTER` + `OKUM_ALLOWANCE_MANAGER` = mint to `maxSupply` (the allowance is
self-settable). Add `OKUM_CAP_MANAGER` and the cap is self-settable too — **mint is then
unbounded**. Nothing on-chain prevents one key holding all three. SVM `set_authority`
forbids assigning a granular role to `role_admin`, but does **not** prevent collapsing
several granular roles onto one key.

**F. Four UUPS upgrade paths with no timelock and no two-step (E12, E16, E21, E25).**
Note SVM is *stronger* here: it has two-step `role_admin` rotation and binds `role_admin`
to the BPF upgrade authority at init.

**G. `approveAmount` is unvalidated and its semantics are contested (E17).**
`LitePSM.processQueue` forwards a caller-chosen allowance, but `RedemptionQueue` meters the
loop against the PSM's **balance**. If `approveAmount` is smaller than the batch needs,
healthy entries fail on allowance and are reported as `TransferFailed` — the skip reason
reserved for blacklisted recipients — so the operator gets the wrong diagnostic. Masked
today only because the sole caller passes the full balance, contradicting the NatSpec.

**H. Pause enforcement on `OkuMoney` is split across three places, by design.**
`_update` (`:663`) calls `_requireNotPaused()` **only when both `from` and `to` are
non-zero** — so it gates *transfers* only. Mint is gated by `whenNotPaused` on the function
itself (E5); **burn is gated nowhere** and works while paused (E6), which
`test_Burn_WorksWhenPaused` pins as intentional. `blacklist`/`unblacklist` also work while
paused (E9, E14). Each is defensible — confirm all four are intended together, since the
rule is not stated in one place.

---

## 4. Asymmetries a reviewer should not mistake for bugs

| | EVM | SVM |
|---|---|---|
| Compliance freeze | `isBlacklisted` mapping | Token-2022 freeze authority |
| Uncollateralised mint | none (equivalent = granting `OKUM_MINTER` to an EOA) | `direct_mint` / `direct_burn` |
| Role rotation | OZ `AccessControl`, immediate | 11 immediate + `role_admin` two-step |
| Upgrade | UUPS ×4, per-contract role | BPF loader, single authority |
| Minter allowance | per-address mapping | single global value |
| Redeem slippage | none (protocol-side floor only) — monotonic multiplier + zero PSM fee make it structurally unreachable; see `EVM/README.md § LitePSM.sol` | user-supplied `min_usdc_out`, defense-in-depth (same monotonicity holds); doubles as a live Rust-vs-TS differential probe in `test-devnet.ts` since Solana has no view functions — see `SVM/README.md § PSM` |
| Buffer withdraw | partial solvency check | none |

---

## 5. Current testnet holders (4 EVM chains, verified on-chain)

- **Deployer `0x3CB68a…79A0`** — `DEFAULT_ADMIN_ROLE` on all four contracts + all four
  `*_UPGRADER`. This is the intended retained set.
- **Operator `0x971A3e…dae00`** — the 20 operational roles (everything except ownership and
  upgrade). Per §3-E it holds `OKUM_MINTER` + `OKUM_ALLOWANCE_MANAGER` + `OKUM_CAP_MANAGER`
  simultaneously, so **its mint capability is unbounded by design** on testnet. This is a
  documented, deliberate waiver for internal testing and is refused on mainnet by
  `grantRoles.ts`; `grantRolesMainnet.ts` splits the same powers across cold/warm/orchestrator.
- **SVM** — `role_admin` = `5WSQGab…Qeej` (also BPF upgrade authority); the 9 granular
  operational roles on `2oYAfHz…wiCz`.

Durable record of every grant: `EVM/scripts/config/roleGrants.json` (tracked in git — the
contracts use `AccessControlUpgradeable`, which has no on-chain holder enumeration).
