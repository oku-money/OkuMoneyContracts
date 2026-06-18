# Key Custody & Change-Management Runbook (DRAFT)

> **Status:** DRAFT — placeholders marked `<TBD>` require team input
> before this document is considered audit-ready. This file is the
> shell auditors will be asked to evaluate; the substantive content
> (where the keys live, who holds them, the exact ceremony steps) is
> withheld pending the operator team's review.

Audit-prep cycle established the on-chain primitives (3-tier
multisig topology, two-step `RoleAdmin` transfer, per-action role
gating). This document is the off-chain counterpart: the procedural
controls auditors evaluate when reviewing a centralized stablecoin.

The cross-chain authority model is documented in
[`../README.md` § RBAC](../README.md) and the per-role inventory in
[`../../audit/README.md` § Centralization inventory](../../audit/README.md).
This runbook is the procedural overlay on top of those role
mappings.

---

## 1. Key tiers and physical custody

### 1.1 Cold multisig

- **Threshold:** `<TBD: M of N>` (recommended ≥ 2 of 3).
- **Hardware:** `<TBD: Ledger Stax / Nano X / GridPlus Lattice / Trezor>` per signer; never shared across signers.
- **Storage:** `<TBD: physical locations per signer — bank SDB / personal safe / corporate vault>`.
- **Geographic distribution:** `<TBD: at least N cities to defeat localized loss events>`.
- **Backup:** seed phrases sharded via `<TBD: Shamir / paper-with-tamper-evident-seal / hardware key-vault>`; recovery threshold matches multisig threshold.
- **Air-gap discipline:** cold devices NEVER connect to a network-attached host between ceremonies. Pre-ceremony devices boot off a clean, network-isolated machine.

### 1.2 Warm multisig

- **Threshold:** `<TBD>`.
- **Hardware:** `<TBD>` per signer.
- **Storage:** `<TBD: signers' day-to-day office / personal hardware>` — assumes a higher loss risk than cold.
- **Geographic distribution:** `<TBD>`.

### 1.3 Orchestrator KMS

- **Provider:** `<TBD: AWS KMS / GCP KMS / HashiCorp Vault Enterprise>`.
- **Region(s):** `<TBD>` primary + `<TBD>` failover.
- **Access policy:** IAM principal scoped to the orchestrator service account only; no human standing access. Break-glass access requires `<TBD>` ticket + `<TBD>` reviewer sign-off.
- **Key rotation:** `<TBD: cadence>`. Each rotation produces a new orchestrator pubkey that must be granted the orchestrator role surface (see `EVM/scripts/operator/grantRolesMainnet.ts` + SVM equivalents).

---

## 2. Signer roster + off-boarding

| Tier | Role | Signer | Hardware ID | Joined | Off-boarding window |
|---|---|---|---|---|---|
| Cold | Signer 1 | `<TBD>` | `<TBD>` | `<TBD>` | `<TBD: 7d / 14d / 30d>` |
| Cold | Signer 2 | `<TBD>` | `<TBD>` | `<TBD>` | `<TBD>` |
| Cold | Signer 3 | `<TBD>` | `<TBD>` | `<TBD>` | `<TBD>` |
| Warm | Signer 1 | `<TBD>` | `<TBD>` | `<TBD>` | `<TBD>` |
| Warm | Signer 2 | `<TBD>` | `<TBD>` | `<TBD>` | `<TBD>` |

### 2.1 Off-boarding procedure (when a signer leaves)

1. Within `<TBD>` hours of departure notice: generate a replacement signer keypair on the new signer's hardware.
2. Within `<TBD>` business days: rotate the relevant multisig to swap the departing signer's pubkey for the replacement.
3. Confirm the departing signer's hardware is `<TBD: returned / wiped / verified-destroyed>`.
4. Audit-log entry recording the rotation tx hash on every chain.

### 2.2 Lost-device recovery

`<TBD: detailed procedure — seed-phrase recovery vs. signer rotation, depending on whether the device is unrecoverable or merely inaccessible>`

---

## 3. Segregation-of-duties statement

The on-chain RBAC layout in
[`../../audit/README.md` § Centralization inventory](../../audit/README.md)
assumes no individual holds keys in more than one tier. The
operator team commits to the following:

- **No individual is a signer on both the cold and warm multisigs.** This is the load-bearing SoD assumption.
- **The orchestrator KMS principal has no human escalation path** that would let a single individual sign cold-multisig actions via the KMS.
- **Per-tier minimum signer counts:** cold ≥ `<TBD: 3>` signers (so a single signer departing or being unavailable does not block ceremonies); warm ≥ `<TBD: 2>`.

Violation discovery procedure: `<TBD: any signer who discovers a SoD violation must immediately notify <TBD: incident response contact> and trigger the off-boarding flow for the offending role>`.

---

## 4. Change-management runbook per admin action class

Per-action procedural controls beyond on-chain role checks. The
shorter the table cell, the higher the urgency; "ceremony" rows
involve the cold multisig and benefit from formal review.

| Action | Tier | Proposer | Reviewer(s) | Dry-run requirement | Approval medium |
|---|---|---|---|---|---|
| `pause` (any) | Warm | `<TBD>` | n/a — emergency lever | none | Squads / Safe |
| `unpause` (any) | Cold | `<TBD>` | `<TBD: at least 1 other cold signer>` | fork-test of the next user action | Squads / Safe |
| `blacklist` / `unblacklist` (`blacklistBoth.ts` for EVM) | Warm | Compliance team | Legal sign-off | none | Squads / Safe |
| `setMaxSupply` | Cold | Treasury | `<TBD: 2 of N cold signers + treasurer>` | tenderly fork + supply-cap math review | Squads / Safe |
| `configureMinterAllowance` | Cold | Treasury | `<TBD>` | tenderly fork | Squads / Safe |
| `setUsdYieldRate` / `setNextUsdYieldRate` | Orchestrator (auto) + Cold (manual) | Rebalancer service / Treasury | `<TBD: rate must come from approved yield-source list>` | none for auto-rate; tenderly for manual | KMS-signed / Squads |
| `setMinCollateralRatio` | Cold | Risk | `<TBD>` | tenderly fork + ratio-math review | Squads / Safe |
| `setOracleRelay(addr)` (kill switch) | Cold | Incident commander | `<TBD>` | none — emergency only | Squads / Safe |
| `setPriceBand`, `setStalenessThreshold`, `setPriceFeed` | Cold | Risk | `<TBD>` | tenderly fork | Squads / Safe |
| `set_authority` / `setRole*` (rotation) | Cold | Departing-signer manager | `<TBD: 2 of N cold signers>` | fork-test of an action the new role unlocks | Squads / Safe |
| `accept_role_admin` (vault + PSM, two-step step 2) | Cold (the proposed new admin) | New role admin | n/a | none | Direct CLI signed by the new admin |
| `withdrawUsdc` (EVM buffer withdraw) / `withdraw_buffer` (SVM) | Cold | Treasury | `<TBD>` | tenderly fork (verify `WouldStrandQueue` doesn't fire) | Squads / Safe |
| `depositReserves` / `deposit_reserves` (vault) | Cold | Treasury | `<TBD>` | none | Squads / Safe |
| `withdrawSurplus` / `withdraw_reserves` (vault) | Cold | Treasury | `<TBD: ratio-math review>` | tenderly fork | Squads / Safe |
| Upgrade ceremony (`upgradeToAndCall` on any UUPS proxy / Anchor `bpf_loader_upgradeable::upgrade`) | Cold | Engineering | `<TBD: full code review + Mythril + Slither + Forge tests against new logic>` | mandatory fork against latest deployed state | Squads / Safe |

### 4.1 Universal pre-ceremony checklist

Before any cold-multisig action lands on mainnet:

- [ ] Tx data reviewed by `<TBD: at least 2 cold signers>` independently.
- [ ] Fork test (Tenderly / Hardhat fork / surfpool) reproduces the expected post-state.
- [ ] Off-chain monitoring (`<TBD: pagerduty / opsgenie>`) is acknowledged and ready to alert on side-effects.
- [ ] Pause state on the relevant contract is verified (pause-during-ceremony or pause-not-required, explicitly logged).

---

## 5. Incident response procedures

### 5.1 Compromised orchestrator key

**Detection signals:**
- KMS audit log shows a `sign` call from an unexpected source IP / principal.
- On-chain: unexpected `OkuMMultiplierUpdated` / `BufferDeposited` / `BufferRefilled` events.

**Response:**
1. Warm multisig calls `pause()` on every contract within `<TBD: target minutes>`.
2. Cold multisig calls `revokeRole(<orchestrator-role>, <compromised-pubkey>)` on every contract that grants the role.
3. Generate a new orchestrator keypair via KMS rotation.
4. Cold multisig grants the new pubkey the orchestrator role surface (`grantRolesMainnet.ts` / SVM equivalents).
5. Verify on-chain state has not been corrupted (run `<TBD: health-check scripts — see SVM/TRACKER.md>`).
6. Unpause.

### 5.2 Compromised warm multisig

**Detection signals:** unexpected `pause()` / `blacklist()` txs.

**Response:**
1. Cold multisig rotates the warm-pauser / warm-blacklister roles to a fresh warm key set.
2. Audit the blacklist for any spurious additions; if any are found, evaluate the affected accounts case-by-case before unblacklisting.
3. `<TBD: legal review of any blacklist actions that landed during the compromise>`.

### 5.3 Compromised cold multisig

Worst case. `<TBD: detailed procedure>`. Minimum:

1. Whatever cold signers remain uncompromised propose and accept a `set_authority(RoleAdmin, …)` rotation to a fresh cold multisig.
2. If the cold multisig is fully compromised: the contracts are at the attacker's mercy on-chain; off-chain coordination + token-holder communication only.
3. `<TBD: pre-arranged communication channels — Twitter, Discord, status page, key partner-of-record contacts>`.

### 5.4 Unexpected admin event detected by monitoring

`<TBD: the team's specific alerting → triage → escalation flow>`.

---

## 6. Periodic exercises

| Exercise | Cadence | Owner |
|---|---|---|
| Cold-multisig ceremony rehearsal on a testnet | `<TBD: quarterly>` | Cold-signer roster |
| Off-boarding-flow dry run | `<TBD: annually>` | Ops lead |
| Incident-response tabletop | `<TBD: semi-annually>` | Incident commander |
| KMS key rotation | `<TBD: annually>` | Platform team |

---

## 7. Open items (audit-prep)

This runbook is a draft pending team input on the `<TBD>` cells.
The on-chain primitives (RBAC, two-step transfer, role splits) are
shipped and tested; the procedural overlay above is what an auditor
will ask for next.

Tracked in `contracts/EVM/TRACKER.md` and `contracts/SVM/TRACKER.md`
under "Key custody + change-management documentation".
