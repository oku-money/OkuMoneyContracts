# Orchestrator Runbook — okuMoney noBridge v1

This document covers operational procedures for the off-chain orchestrator
that mediates cross-chain OkuMoney (OkuM) transfers in the v1 noBridge
model. It should be read alongside `EVM/README.md § Cross-Chain Transfers`
and `SVM/README.md § Cross-Chain (noBridge, v1)`.

---

## 1. Model Overview

There is **no on-chain bridge**. Cross-chain transfers are fully trust-delegated
to the orchestrator:

```
  Chain A (source)                    Chain B (destination)
  ─────────────────                   ──────────────────────
  User → orchestrator (approve+pull)
  Orchestrator → PSM redeemOkuM()     Orchestrator → PSM mintOkuM()
                                      PSM → recipient (transfer)
                   ↑
             off-chain custody
             (USDC held by orch)
```

Key property: **`mintOkuM` is permissionless** — any address with USDC can
mint OkuM. The orchestrator does NOT hold `OKUM_MINTER`. This means
orchestrator key compromise grants no mint privilege beyond the orchestrator's
USDC balance. The PSM contract itself holds `OKUM_MINTER`.

### USDC conservation invariant

For every completed bridge of N OkuM from chain A to chain B:

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit (6-decimal rounding)
```

Cumulative drift across N bridges ≤ N USDC-units. Tested by the
`WS3.3 cross-chain reconciliation invariant` in
`EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts`.

---

## 2. Pre-Flight Checklist

Before submitting any bridge transaction, verify all of the following on **both
source and destination chains**:

| Check | EVM | SVM |
|---|---|---|
| Destination PSM not paused | `LitePSM.paused()` | `psm.account.psmConfig.fetch(...).isPaused` |
| Destination supply headroom | `OkuMoney.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuMoney.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user OkuM balance | `OkuMoney.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMoneyAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` |
| Recipient ATA not frozen | `OkuMoney.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |
| Oracle not stale (if enabled) | `LitePSM.stalenessThreshold()` vs last `updatedAt` | `psmConfig.oracle != PublicKey.default && Pyth feed fresh` |

### Buffer vs queue path

If the source PSM buffer is insufficient to cover the redeem, the transaction
still succeeds: the OkuM is escrowed in the redemption queue. **The
orchestrator must wait for `processQueue` to pay out USDC before completing
the destination mint leg.** There is no on-chain notification; the orchestrator
must poll queue state:

```
EVM:  queue.queueHead() < queue.queueTail()  → entries pending
SVM:  redemptionQueue.head < redemptionQueue.tail  → entries pending
```

The orchestrator can accelerate payment by calling `depositBuffer` to fund
the queue, then `processQueue`.

---

## 3. Bridge Execution Steps

### EVM (hardhat scripts)

```bash
# Step 1: Source chain — redeem OkuM (user must approve first)
NETWORK=<src-chain> npx hardhat run scripts/operator/redeemOkuM.ts \
    --okuMAmount <18-dec-amount> --yes-mainnet

# Step 2 (if queue path): wait for queue entry to be paid out
NETWORK=<src-chain> npx hardhat run scripts/operator/processQueue.ts \
    --yes-mainnet

# Step 3: Destination chain — mint OkuM with received USDC
NETWORK=<dst-chain> npx hardhat run scripts/operator/mintOkuM.ts \
    --usdcAmount <6-dec-amount> --yes-mainnet
```

### SVM (admin scripts)

```bash
# Redeem on source chain
NETWORK=<src-net> tsx scripts/admin/redeem-okum.ts --amount=<6-dec-amount>

# Process queue if buffer insufficient
NETWORK=<src-net> tsx scripts/admin/process-queue.ts

# Mint on destination chain
NETWORK=<dst-net> tsx scripts/admin/mint-okum.ts --amount=<6-dec-usdc>
```

> **Note:** SVM standalone `mint-okum.ts` and `redeem-okum.ts` scripts are
> planned as a post-MVP addition (tracked in TRACKER.md). Until then, operators
> can invoke `mint_oku_m` / `redeem_oku_m` via the `test-devnet.ts` step
> runner on non-mainnet networks.

---

## 4. Mid-Flight Failure Recovery

### "Source redeem succeeded, dest mint failed"

The orchestrator holds USDC on the destination chain but the `mintOkuM` call
reverted (e.g. destination paused, max supply hit, or oracle stale).

1. Diagnose the failure reason via the revert message.
2. Wait for the blocking condition to resolve (unpause, allowance rotation, oracle refresh).
3. Retry `mintOkuM` with the same USDC amount. The orchestrator's USDC balance
   is the source of truth for how much to mint.
4. If the condition cannot be resolved within an agreed SLA, the orchestrator
   should hold the USDC on the destination chain and file an incident for manual
   review. The user's OkuM on the source chain has already been burned; they
   are owed the equivalent on the destination. Reconciliation requires an
   out-of-band OkuM issuance (governance action) or a refund of USDC to the
   original user's source-chain address.

### "Source redeem was queued"

The orchestrator's `redeemOkuM` enqueued the OkuM rather than immediately
paying USDC (buffer insufficient). The orchestrator must NOT mint on the
destination chain until the queue pays out:

1. Poll source queue state periodically (e.g. every 30 seconds).
2. When `head` advances past the entry, the orchestrator has USDC.
3. If waiting too long, call `depositBuffer` to fund the queue, then
   `processQueue`.
4. Proceed with destination mint once USDC is in hand.

### "Orchestrator process crashes between legs"

On restart, the orchestrator should check its own USDC balance on both chains:

- If source USDC > expected operational float → leg 1 (source redeem) may have
  completed but leg 2 (dest mint) has not. Complete the destination mint.
- If destination OkuM > 0 (orchestrator ATA is non-zero) → leg 2 completed but
  leg 3 (forward to recipient) did not. Transfer the OkuM to the recipient.
- If all balances are zero → both legs may have completed. Verify in on-chain
  event logs that the recipient received OkuM.

**The orchestrator OkuM float must be zero between completed bridges.** Any
non-zero OkuM balance on the orchestrator's ATA for more than one batch cycle
indicates a stuck bridge that requires investigation.

---

## 5. Multiplier-Tick Sequencing Across Chains

The OkuM price (`okuMMultiplier` on EVM, `oku_m_price` on SVM) is set
discretely by the `OKUM_REBASER` role. To prevent price divergence between
chains from causing accounting errors, the orchestrator should:

1. Fire `setOkuMMultiplier` / `set_oku_m_price` on **all chains in the same
   off-chain batch**, within one slot/block of each other.
2. If sequencing diverges (one chain updates before another), the **dollar
   value per bridge is still conserved** — the PSM uses the current multiplier
   at redemption time on the source chain and the current multiplier at mint
   time on the destination. The recipient may receive a slightly different
   raw OkuM amount depending on which chain's price is higher, but the dollar
   value is equivalent.
3. After a price tick, wait one slot (SVM) / one block (EVM) before bridging to
   avoid the `YieldDistributionInProgress` yield-lock error.

---

## 6. Minter Allowance Rotation Policy

The `minterAllowance` on `OkuMoney` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many OkuM the PSM can mint before an explicit refresh.

### Testnet default

On devnet/testnet, `minterAllowance == maxSupply == 1B OkuM`. This makes the
cap a no-op for development.

### Production recommendation

On mainnet, set `minterAllowance` to approximately **1% of expected weekly
bridging volume**, rotated on a **weekly cadence** by the `OKUM_ALLOWANCE_MANAGER`
(cold multisig). This provides meaningful safety: a compromised PSM contract
or orchestrator USDC custody can mint at most one week's worth of OkuM before
the allowance is exhausted.

Example rotation via EVM script:

```bash
# Rotate to 10M OkuM (18-decimal)
DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
    --network base --minter <psm-address> --allowance 10000000000000000000000000 --yes-mainnet

# Review output, then submit:
NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
    --network base --minter <psm-address> --allowance 10000000000000000000000000 --yes-mainnet
```

Example rotation via SVM script:

```bash
NETWORK=mainnet-beta tsx scripts/admin/set-minter-allowance.ts \
    --amount=10000000 --yes-i-mean-it-on-mainnet   # 10 OkuM (6-dec)
```

### Monitoring alert

Raise an alert when:
- `minterAllowance < 10%` of the weekly bridging volume.
- The allowance has not been rotated in >7 days.

---

## 7. Monitoring SLAs

| Metric | Alert threshold | Measurement |
|---|---|---|
| Orchestrator OkuM float | Non-zero for >1 h between batch cycles | `OkuMoney.balanceOf(orchestratorAddr)` on all chains |
| Queue depth | Oldest pending entry >24 h unfilled | `queue.queueHead()` vs. entry creation timestamp (off-chain) |
| Oracle staleness | `updatedAt` within 80% of `stalenessThreshold` | `LitePSM.stalenessThreshold()` vs `oracle.latestRoundData().updatedAt` |
| PSM buffer | < 2× expected daily redemption volume | `usdc.balanceOf(psm)` |
| Minter allowance | < 10% of weekly throughput estimate | `OkuMoney.minterAllowance(psm)` |
| Pause state | PSM paused for >15 min unexpectedly | `LitePSM.paused()` / `psmConfig.isPaused` |

All metrics should be scraped on a 1-minute cadence. PagerDuty or equivalent
alerting for the "OkuM float" and "queue > 24h" cases; Slack warning for the
others.

---

## 8. Security Notes

- The orchestrator key has **NO special minting authority**. Compromise of the
  orchestrator key does not allow minting beyond the key's USDC holdings.
- The orchestrator holds operational roles: `OKUM_REBASER`, `VAULT_REBASER`,
  `PSM_QUEUE_PROCESSOR`, `PSM_BUFFER_DEPOSITOR`. Compromise would allow a
  malicious actor to manipulate the OkuM price (via `setOkuMMultiplier`),
  drain the buffer, or skip queue entries. These are material but bounded
  risks. The cold multisig controls `UNPAUSER` (can pause cannot unpause) and
  `BUFFER_WITHDRAWER` (can drain the entire PSM USDC buffer), which are the
  more dangerous capabilities.
- Rotate the orchestrator key immediately on any suspected compromise.
  Pausing both PSMs (warm multisig) is the emergency lever if the key
  cannot be rotated immediately.
- **No two concurrent orchestrator instances** should process the same user
  bridge request. Off-chain deduplication (e.g. nonces, event ID tracking)
  is the orchestrator's responsibility; the protocol surface does not enforce
  idempotency.
