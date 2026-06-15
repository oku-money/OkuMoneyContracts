# Deprecated SVM deployments — orphaned PDAs & closed programs

This file tracks Solana accounts (PDAs, mints, programs) that have been deprecated
across upgrade cycles but cannot be immediately closed (typically because no
`close` instruction exists in the program that owns them, or the close path
would require a multi-step ceremony that hasn't been written yet).

**Purpose:**
1. Audit trail — every byte of SOL "stuck" in deprecated accounts is documented.
2. Rent-recovery target list — when an `admin_close_*` instruction is added to a
   program (post-launch enhancement), this file is the canonical list of accounts
   to close in order to reclaim the rent SOL.
3. Avoid accidental references — clients reading old docs should be able to verify
   "yes, this address is dead" instead of debugging mysterious failures.

**Format:** Per-deprecation block with: cause, affected accounts, on-chain
addresses, rent locked, owner program, and a TODO indicating the recovery
mechanism (when known).

---

## 2026-06-05 — noBridge PDA seed rotation (devnet)

**Cause.** The lite-psm `PsmConfig` storage layout shrank from 722 → 658 bytes
in the noBridge phase C change (commit `59950c4`), which removed the
`blacklist_exempt_bridge` and `blacklist_exempt_router` fields. An in-place
BPF upgrade would have left the on-chain 722-byte account intact, causing
new code to interpret old `blacklist_exempt_*` slots as `pyth_program_owner`
and `pending_role_admin` — a security-relevant corruption (the latter would
have spuriously enabled a `role_admin` rotation to an attacker-controlled
account, though in this specific devnet case the slot held a BPF-loader-
owned closed-program account, which is unsignable).

To force a clean PDA layout, the four interlinked seed constants were rotated
to `*_v2`:

| Seed (Rust constant)                          | Old                  | New                     |
| --------------------------------------------- | -------------------- | ----------------------- |
| `lite_psm::PsmConfig::SEED`                   | `b"psm_config"`      | `b"psm_config_v2"`      |
| `lite_psm::RedemptionQueue::SEED`             | `b"redemption_queue"`| `b"redemption_queue_v2"`|
| `oku_dollar::OkuDollarConfig::SEED`           | `b"oku_dollar_config"` | `b"oku_dollar_config_v2"` |
| `oku_dollar::OkuDollarConfig::USD_OKU_MINT_SEED` | `b"usd_oku_mint"` | `b"usd_oku_mint_v2"`    |

**Side effects.** The pre-rotation PDAs and the SPL mints they controlled
are now orphaned: their `owner` field still references the (same) program
ID, but the program no longer derives those addresses for any instruction.

### Orphaned accounts on devnet

| Account | Address | Length | Rent (SOL) | Owner (now-orphan) |
| ------- | ------- | -----: | ---------: | ------------------ |
| Old `PsmConfig` PDA | `EkCYunihwmNasBEnNXoJx8sb3CdZnDYKLpPvLyY6Hm3u` | 722 | 0.005916 | lite_psm program |
| Old `RedemptionQueue` PDA | `5FWTuuF67sUNca3w8cqHta4Q5xF6jAiFhGYunuFrSUBz` | 9 640 | 0.06798528 | lite_psm program |
| Old `psmVaultUsdc` ATA | `HrnfYJM4a3QprfmUCpzXg2L94CF2ym8GooqquqSsmVT2` | 165 | 0.00203928 | SPL Token program |
| Old `psmOkuMoneyEscrow` ATA | `7HrzaCMWzjQ3HGa5fhQP2NFTaxsaTJGeKvLWd46HURxP` | 170 | 0.00207408 | Token-2022 program |
| Old `OkuDollarConfig` PDA | `93tqPwYQfFtmuU5SxL4xuzi3PMbjZWKmuiHt2FBe8qaK` | 362 | 0.0034104 | oku_dollar program |
| Old `usdOku` mint PDA | `C4D88J3d5pTtLcJeWEHkRb7pxngBsM9v8R48oRM2N1bF` | 82 | 0.0014616 | Token-2022 program (mint authority = orphan OkuDollarConfig PDA) |
| Old OkuMoney mint | `8F7oEy9dhanAyHDDCTcnoexiNGW8BH9AhiFJwU5DeEQY` | 222 | 0.002436 | Token-2022 program (mint authority = orphan PsmConfig PDA) |
| Old reserve_vault ATA | `4e9a8SNTc1sWke5F4r2AkRWtq1miV52KanGxncJYLk6i` | 170 | 0.00207408 | Token-2022 program |
| Old USDC mock mint | `AGwA2n1bgTt969wSbhnoyjVsDENaCoyR1W46uEf7LFQA` | 82 | 0.0014616 | SPL Token program (authority = deployer EOA — closable today) |

**Total rent locked**: ~0.0853 SOL across 9 accounts. Not material; tracked for completeness, not urgency.

### Why we cannot close these today

- **PsmConfig, RedemptionQueue, OkuDollarConfig PDAs**: program-owned PDAs.
  Solana's runtime model means only their owner program can authorize
  changes to them — and the owner program (lite-psm / oku-dollar) has no
  `close_dead_*` instruction in the current source tree. Closing requires
  one of:
    1. A new `admin_close_legacy_pda` ix gated by `role_admin` that the
       deployer can call once and then have removed in a follow-up upgrade.
    2. Closing the entire program (which destroys ALL PDAs but also requires
       a fresh keypair on next deploy — not desired).
- **Old OkuMoney / usdOku mints**: SPL/Token-2022 mints can only be closed
  if their supply is 0 AND the close authority is set. Token-2022 mints
  created with `mintAuthority = <old PsmConfig PDA>` would need the orphan
  PDA to sign the close — which the live program can't reach.
- **Old ATAs**: Can be closed today via `spl-token close-account` from the
  ATA owner. The owner is the orphan PsmConfig PDA, so we hit the same
  problem.
- **Old MockUSDC**: authority is the deployer EOA (line 117 of
  `scripts/deploy/lib/tokens.ts`). **Closable immediately** via
  `spl-token close-mint --owner <deployer>` if supply == 0. Verify supply
  before closing.

### Recovery plan (post-launch enhancement)

When telemetry / cost pressure justifies, add a single one-shot ix to each
program:

```rust
// In lite_psm:
pub fn admin_close_legacy_pda(
    ctx: Context<AdminCloseLegacyPda>,
    seed_str: String,  // "psm_config" or "redemption_queue"
) -> Result<()> {
    // role_admin signer required
    // PDA address derived from old seed
    // Reads bump, signs the close, returns lamports to role_admin
}
```

After running once per orphan PDA, remove the ix in a follow-up upgrade.

---

## 2026-06-12 — Audit-prep PsmConfig seed rotation (PoR → peg circuit-breaker)

**Cause.** The lite-psm `PsmConfig` storage layout changed in the audit-prep
cycle: the Proof-of-Reserves fields (`oracle`, `staleness_threshold`,
`pyth_program_owner`) were removed and the USDC peg circuit-breaker fields
(`oracle_relay_feed`, `oracle_relay_pyth_program_owner`,
`oracle_relay_staleness`, `oracle_relay_min_price_e9`,
`oracle_relay_max_price_e9`) were added. Net layout delta: 658 → 674 bytes.

Rationale for the change: okuMoney is a centralized US-regulated MSB.
The operator is already responsible for backing USDC; the on-chain PoR
check did not detect operator-side reserve fraud — only oracle
malfunction. The redesigned relay is a strict USDC peg circuit-breaker
that defends against the *one* threat the trust model doesn't cover
(USDC depeg events), which matches the EVM-side cycle that landed first.

The PSM config seed was rotated:

| Seed (Rust constant)        | Old                 | New                 |
| --------------------------- | ------------------- | ------------------- |
| `lite_psm::PsmConfig::SEED` | `b"psm_config_v2"`  | `b"psm_config_v3"`  |

The three other seeds (`redemption_queue_v2`, `oku_dollar_config_v2`,
`usd_oku_mint_v2`) are unchanged because their storage layouts did not
change. The oku-dollar vault's `OkuDollarConfig::psm_config` field
already stores a literal pubkey, so the new `psm_config_v3` PDA will be
referenced naturally on a fresh deploy without any client changes.

### Newly orphaned accounts on devnet

| Account | Address | Length | Rent (SOL) | Owner (now-orphan) |
| ------- | ------- | -----: | ---------: | ------------------ |
| `_v2` `PsmConfig` PDA | (per-network — see `deployments/devnet.json` snapshot tag `noBridge-mvp-deployed`) | 658 | ~0.00542 | lite_psm program |

Cross-program impact: the existing `_v2`-era `OkuDollarConfig` PDA stores
its `psm_config` field as the address of the old `_v2` `PsmConfig` PDA.
A fresh deploy will re-initialise both PDAs against the new `_v3` PSM
PDA; the legacy vault config is orphaned along with the legacy PSM
config (already enumerated above).

### Why we cannot close it today

Same as the prior rotation entry: no `admin_close_legacy_pda` ix exists
in lite-psm. Recoverable via the same one-shot ix pattern when telemetry
justifies.

---

## (Reserved for future deprecation entries)

When the next round of breaking changes lands, append a new dated section above.
