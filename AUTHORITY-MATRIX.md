# Authority Matrix — EVM + SVM

Every on-chain path that **moves value** or **changes authority**, with its guard, blast
radius, and reversibility. Rows describe the code, not other docs; where they disagree,
the code wins. Function names are unique within their contract — grep the symbol rather
than trusting a line number.

Reversibility means *can the effect be undone on-chain* — not whether the role can be
revoked afterwards.

Constants: `PRECISION = 1e18` · `MAX_MULTIPLIER = 1e24` (1,000,000× ceiling) ·
`MAX_RATE = 1e18 + 1e11` (≈ +0.8677 %/day, ≈ 2.18× over one 90-day window) ·
`MAX_RATE_WINDOW = 90 days`. Source: `EVM/src/lib/Constants.sol` and
`SVM/oku-programs/crates/oku-shared/src/constants.rs`; the two must agree.

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
| Pause gate on rate *increases*, against the **effective** rate | (b) | Prevents inflating the multiplier while users cannot exit. Subtle and load-bearing: comparing against the raw stored rate instead of the effective one lets a stale higher rate through |
| `max_supply` / `minter_allowance` caps | (a) | Bound the blast radius of a compromised minter key |
| Role separation on `PsmConfig` / EVM `AccessControl` | (a) | Cold / warm / orchestrator separation is key-compromise defence |
| `set_okum_multiplier` emergency override | (c) | The backend needs an atomic re-anchor lever |
| Sandwich lock on the override | (c) | The override is the one remaining discrete jump |
| Computed multiplier (`rpow` on the hot path) | (c) | The PSM must price atomically inside the user's transaction; a Solana instruction cannot call out mid-execution. See `SVM/README.md` § Compute budget |

**The distinction to apply generally:** maths invariants and key-compromise
bounds stay on-chain; business policy moves to the backend.

---

## 1. EVM — role-gated paths

| # | Path | Contract | Role | Blast radius | Guards | Rev? |
|---|---|---|---|---|---|---|
| E1 | `setOkuMMultiplier` | `OkuMoney` | `OKUM_RATE_MANAGER` | **Raise multiplier up to 1e24 — a 1,000,000× inflation of every balance, redeemable against the PSM buffer** | `whenNotPaused`, strictly-increasing, ≤ `MAX_MULTIPLIER` | **No** |
| E2 | `setOkuMYieldRate` | `OkuMoney` | `OKUM_RATE_MANAGER` | Stream ≤ `MAX_RATE` for ≤ 90 d (≈ 2.18× per window) | rate + window bounds; pause-gated **only** on increase vs *effective* rate | **No** |
| E3 | `setNextOkuMYieldRate` | `OkuMoney` | `OKUM_RATE_MANAGER` | Arm successor, same bounds | as above, successor window bounded independently | **No** |
| E4 | `setOkuMYieldRateWithSuccessor` | `OkuMoney` | `OKUM_RATE_MANAGER` | E2 + E3 atomically | as above | **No** |
| E5 | `mint` | `OkuMoney` | `OKUM_MINTER` | Mint to `min(maxSupply − supply, minterAllowance)` | `whenNotPaused`, supply cap, per-minter allowance, sender + recipient blacklist | **No** |
| E6 | `burn` | `OkuMoney` | `OKUM_BURNER` | Burn caller's own balance only | sender blacklist; **no pause gate — works while paused, deliberately** | No |
| E7 | `configureMinterAllowance` | `OkuMoney` | `OKUM_ALLOWANCE_MANAGER` | Set **any** minter's allowance, incl. its own, to `type(uint256).max` | none beyond the role | Yes |
| E8 | `setMaxSupply` | `OkuMoney` | `OKUM_CAP_MANAGER` | Raise/lower the global cap | `≥ totalSupply` | Yes |
| E9 | `blacklist` | `OkuMoney` | `OKUM_BLACKLISTER` | Freeze an address as sender, recipient, **or approved spender** (incl. `approve`/`permit`/`transferFrom`/`mint`-as-minter — matched to Circle FiatToken's scope, see `EVM/README.md` Accepted Risk #12) | works while paused; does NOT retroactively revoke allowances already granted | Yes (E10) |
| E10 | `unblacklist` | `OkuMoney` | `OKUM_UNBLACKLISTER` | Unfreeze | — | — |
| E11 | `pause` / `unpause` | `OkuMoney` | `OKUM_PAUSER` / `OKUM_UNPAUSER` | Halt mint + transfers, `setOkuMMultiplier`, and any rate write that would raise the projected multiplier (higher than the effective rate, or extending its window or the successor's) | — | Yes |
| E12 | `_authorizeUpgrade` | `OkuMoney` | `OKUM_UPGRADER` | **Replace all token logic** | **none — no timelock, no two-step** | **No** |
| E13 | `rescueDonation` | `OkuDollar` | `VAULT_RESCUER` | Withdraw OkuM held above `totalUsdShares` | `nonReentrant`, `held > totalUsdShares`; **≈1 wei/unwrap is permanently classifiable as donation** | **No** |
| E14 | `blacklist` / `unblacklist` | `OkuDollar` | `OKUM_(UN)BLACKLISTER` | Freeze on the vault — **same role hash as E9/E10, but a separate grant per contract**; same sender/recipient/spender scope as E9 (incl. `transferFrom` and the ERC-4626 `redeem`/`withdraw` spender path). OkuDollar blocks an address if it is on **either** its own list **or** OkuMoney's (E9); the reverse does not hold | works while paused; does NOT retroactively revoke allowances | Yes |
| E15 | `pause` / `unpause` | `OkuDollar` | `VAULT_PAUSER` / `VAULT_UNPAUSER` | Halt wrap/unwrap/4626 + transfers | — | Yes |
| E16 | `_authorizeUpgrade` | `OkuDollar` | `VAULT_UPGRADER` | **Replace all vault logic** | **none** | **No** |
| E17 | `pause` / `unpause` | `LitePSM` | `PSM_PAUSER` / `PSM_UNPAUSER` | Halt all PSM user paths | — | Yes |
| E18 | `withdrawUsdc` | `LitePSM` | `PSM_BUFFER_WITHDRAWER` | **Drain the entire buffer — no solvency check against circulating OkuM/UsdOku** | `whenNotPaused`, `whenNoOverrideThisBlock`, `amount <= balance`; no solvency check | **No** |
| E19 | `depositBuffer(amount)` | `LitePSM` | `PSM_BUFFER_DEPOSITOR` | Add USDC (pull from caller) | `nonReentrant`, `whenNotPaused`, `whenNoOverrideThisBlock` | No |
| E20 | `_authorizeUpgrade` | `LitePSM` | `PSM_UPGRADER` | **Replace all PSM logic** | **none** | **No** |
| E21 | `grantRole` / `revokeRole` | OZ `AccessControl`, each contract | `DEFAULT_ADMIN_ROLE` | **Grant or revoke every role above, on that contract** | none — immediate, no two-step | Yes |
| E22 | `initialize` | each contract | deployer | Grants **every** role to one `_admin`; protocol is single-key until roles are redistributed **and the deployer's own are revoked** (`README.md` § Mainnet ceremony) | `initializer` | — |

**EVM permissionless (for completeness):** `LitePSM.mintOkuM`/`redeemOkuM`/`mintUsdOku`/
`redeemUsdOku` and `OkuDollar.wrap`/`unwrap`/`redeem`/`withdraw` — all
carry `nonReentrant + whenNotPaused + whenNoOverrideThisBlock`. `OkuDollar.deposit`/`mint`
appear unguarded but delegate to `wrap`, inheriting its guards.

---

## 2. SVM — role-gated instructions

Roles are **pubkeys stored on `PsmConfig`**, enforced by Anchor `has_one`, not a role mapping.

| # | Instruction | Role | Blast radius | Guards | Rev? |
|---|---|---|---|---|---|
| S1 | `set_okum_multiplier` | `rate_manager` | **Same 1,000,000× ceiling as E1** — plus a **mandatory Token-2022 CPI**: the emergency lever aborts if `ScaledUiAmount::update_multiplier` fails | pause, yield-lock, strictly-increasing, ≤ `MAX_MULTIPLIER` | **No** |
| S2 | `set_okum_yield_rate` | `rate_manager` | As E2 | rate + window bounds; while paused may only lower the projected curve (no increase vs effective rate, no extension) | **No** |
| S3 | `set_next_okum_yield_rate` | `rate_manager` | As E3 | as above | **No** |
| S4 | `set_okum_yield_rate_with_successor` | `rate_manager` | As E4 | as above | **No** |
| S5 | `mint_oku_m_direct` | `direct_minter` | **Mint with NO collateral** — bounded only by `max_supply` and `direct_minter_allowance`. No EVM equivalent. | pause, yield-lock, cap, allowance | **No** |
| S6 | `burn_oku_m_direct` | `direct_burner` | Burn from own ATA | pause, yield-lock, allowance | **No** |
| S7 | `withdraw_buffer` | `buffer_withdrawer` | **Drain the vault. Only check is `vault_balance >= amount`** — no solvency test. Same blast radius as E18. | pause **and** yield-lock; destination must be the withdrawer's own USDC account | **No** |
| S8 | `deposit_buffer` | `buffer_depositor` | Add USDC | pause **and** yield-lock (same as E19) | No |
| S9 | `set_max_supply` | `cap_manager` | Raise/lower cap | new cap `>=` current supply (`BelowCurrentSupply`; as E8) | Yes |
| S10 | `set_minter_allowance` | `allowance_manager` | **Single global** PSM mint allowance (EVM's is per-address) | — | Yes |
| S11 | `set_direct_minter_allowance` | `allowance_manager` | Bound/starve S5 — **the only off-switch for S5** | — | Yes |
| S12 | `set_direct_burner_allowance` | `allowance_manager` | Bound S6 | — | Yes |
| S13 | `freeze_account` | `freezer` | Freeze **one** OkuM token account (any, not only the ATA) via Token-2022: blocks send **and** receive on that account. The owner's other OkuM accounts are unaffected | not pause-gated, by design | Yes (S14) |
| S14 | `thaw_account` | `unfreezer` | Unfreeze | — | — |
| S15 | `pause` / `unpause` | `pauser` / `unpauser` | Halt user paths | — | Yes |
| S16 | `set_authority` | `role_admin` | Rotate any other role — **commits immediately**; only `RoleAdmin` is two-step | rejects `Pubkey::default()`; forbids assigning a granular role to `role_admin` | Yes |
| S17 | `accept_role_admin` | `pending_role_admin` | Complete the two-step handover | Ownable2Step-equivalent | — |
| S18 | `cancel_role_admin_transfer` | `role_admin` | Abort a pending handover | — | — |
| S19 | `initialize` | `role_admin` = **BPF upgrade authority** | Creates `PsmConfig`, the single OkuM mint and the USDC vault ATA | ties `role_admin` to `ProgramData` upgrade authority — **good, non-obvious anti-land-grab control** | — |
| S20 | Program upgrade | BPF upgrade authority | **Replace all program logic** | none | **No** |

**SVM permissionless:** `mint_oku_m`, `redeem_oku_m` (pause + yield-lock + slippage
`min_usdc_out`), and `sync_display_multiplier` — correctly permissionless, since its
output is a pure function of existing state.

---

## 3. Findings, ordered by severity

**A. A single `OKUM_RATE_MANAGER` / `rate_manager` key can inflate the multiplier 1,000,000× (E1, S1).**
Only constraints are "strictly greater", the `1e24` ceiling, and `whenNotPaused`. **No
timelock, no rate-of-change limit, no multisig requirement in code.** Any holder can then
redeem the inflated value against the PSM. This is the single largest unguarded lever on
either stack.

**B. Buffer withdrawal has no solvency check on either stack (E18, S7).**
`withdrawUsdc` / `withdraw_buffer` check only that the balance covers `amount`. The
withdrawer can drain the buffer while circulating OkuM/UsdOku remains outstanding, after
which redemptions revert `InsufficientBuffer`.

**C. `direct_minter` / `direct_burner` can never be disabled (S5, S16).**
`set_authority` rejects `Pubkey::default()` unconditionally, but that value *is* the
"disabled" sentinel these two roles use. Once enabled, the uncollateralised mint path can
only be reassigned, never switched off. Its only off-switch is the allowance — which lives
on a **different role** (`allowance_manager`).

**D. Role compounding is unconstrained.**
`OKUM_MINTER` + `OKUM_ALLOWANCE_MANAGER` = mint to `maxSupply` (the allowance is
self-settable). Add `OKUM_CAP_MANAGER` and the cap is self-settable too — **mint is then
unbounded**. Nothing on-chain prevents one key holding all three. SVM `set_authority`
forbids assigning a granular role to `role_admin`, but does **not** prevent collapsing
several granular roles onto one key.

**E. Three UUPS upgrade paths with no timelock and no two-step (E12, E16, E20).**
SVM is *stronger* here: it has two-step `role_admin` rotation and binds `role_admin`
to the BPF upgrade authority at init.

**F. Pause enforcement on `OkuMoney` is split across three places, by design.**
`OkuMoney._update` calls `_requireNotPaused()` **only when both `from` and `to` are
non-zero** — so it gates *transfers* only. Mint is gated by `whenNotPaused` on the function
itself (E5); **burn is gated nowhere** and works while paused (E6). `blacklist`/`unblacklist`
also work while paused (E9, E14). Each is defensible — confirm all four are intended
together, since the rule is not stated in one place.

---

## 4. Asymmetries a reviewer should not mistake for bugs

| | EVM | SVM |
|---|---|---|
| Compliance freeze | `isBlacklisted` mapping, one per token; OkuDollar also honours OkuMoney's list. `operator/blacklistBoth.ts` is a convenience that writes both. **Address-scoped**: covers everything the address holds | Token-2022 freeze authority. **Account-scoped**: freezes one token account, not the wallet. A frozen owner can still hold and receive OkuM in any other OkuM token account (a new ATA-like account costs nothing to create), and PSM pause does not stop Token-2022 transfers. Immobilising a wallet means freezing every account it owns, found off-chain (`getTokenAccountsByOwner`), and re-checking for new ones; an owner-wide block would need a transfer hook or registry, which v1 does not have |
| Uncollateralised mint | none (equivalent = granting `OKUM_MINTER` to an EOA) | `direct_mint` / `direct_burn` |
| Role rotation | OZ `AccessControl`, immediate | every role immediate except `role_admin`, which is two-step |
| Upgrade | UUPS ×3, per-contract role | BPF loader, single authority |
| Minter allowance | per-address mapping | single global value |
| Redeem slippage | none — monotonic multiplier + zero PSM fee make it structurally unreachable. `LitePSM` contract NatSpec header; invariant in `TRACKER.md` | user-supplied `min_usdc_out`, defence-in-depth; see `SVM/README.md § PSM` |

---

## 5. Who holds what

Role holders are recorded, not enumerable on-chain (the EVM contracts use
`AccessControlUpgradeable`, which has no holder enumeration):

- **EVM:** `EVM/scripts/config/roleGrants.json` — append-only ledger of every grant and revoke
  (tracked in git).
- **SVM:** the `authorities` block of `SVM/oku-programs/deployments/devnet.json`; the live
  source of truth is `PsmConfig` on-chain.

Testnet vs mainnet shape, per §3-D:

- **Testnet:** one operator key holds the operational roles, including `OKUM_MINTER` +
  `OKUM_ALLOWANCE_MANAGER` + `OKUM_CAP_MANAGER`, so **its mint capability is unbounded by
  design**. The deployer retains `DEFAULT_ADMIN_ROLE` and all `*_UPGRADER` roles. This is a
  deliberate waiver for internal testing; `grantRoles.ts` refuses mainnet.
- **Mainnet:** `grantRolesMainnet.ts` splits the same powers across cold / warm / orchestrator
  keys, has the deployer renounce every granular role, revokes its `DEFAULT_ADMIN_ROLE`
  last, and asserts it holds nothing (`README.md` § Mainnet ceremony). On SVM the
  granular roles are set to their final holders at `initialize`, while `role_admin` starts
  on the deployer and moves by the two-step handover (S16–S18).
