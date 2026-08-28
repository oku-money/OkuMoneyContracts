# ERC-7730 clear-signing descriptors

Clear-signing metadata for the OkuDollar contract suite, targeting the
[ERC-7730](https://eips.ethereum.org/EIPS/eip-7730) **v2** schema and the
registry at
[`ethereum/clear-signing-erc7730-registry`](https://github.com/ethereum/clear-signing-erc7730-registry).

Hardware-wallet signing is a launch blocker: Ledger and Trezor render raw
calldata, so without these files a signer sees an opaque hex blob for every
subscription, wrap and role grant.

## Layout

```
common-oku-definitions.json          shared field defs + the role-hash enum
calldata-OkuM.json                   20 formats
calldata-USDOku.json                 19 formats
calldata-USDOkuWrapper.json           9 formats
calldata-SubscriptionModule.json     16 formats
eip712-OkuM-permit.json              ERC-2612, raw-OkuM denominated
eip712-USDOku-permit.json            ERC-2612, dollar denominated
testsv2/*.tests.json                 reference fixtures (registry-mandatory)
deployed/                            per-chain output of `metadata:sync`
```

**These files are generated.** Do not hand-edit them; edit
[`../../scripts/metadata/descriptorSpec.ts`](../../scripts/metadata/descriptorSpec.ts)
and re-run `npm run metadata:build`. The generator derives every format key from
the compiled ABI, which is what stops a renamed parameter from silently
producing a descriptor that no longer matches.

## Commands

```bash
npm run metadata:build                  # regenerate from the ABI
npm run metadata:validate               # local gate (placeholders allowed)
npm run metadata:validate -- --strict   # pre-submission gate
npm run metadata:fixtures               # regenerate test fixtures
npm run metadata:lint                   # official erc7730 linter

NETWORK=base OWNER="…" OWNER_URL="https://…" npm run metadata:sync
```

## Why there is a local validator as well as the official linter

The official `erc7730 lint` fetches a reference ABI and checks display fields
against it — **but it has a proxy heuristic that skips that check entirely**.
All four of our contracts are UUPS proxies, so the registry will very likely
validate nothing about our field paths. The registry's own `REVIEWING.md` tells
reviewers to watch for the resulting *"Could not fetch ABI"* warning.

`scripts/metadata/validateDescriptors.ts` therefore does it against the ABI we
actually compiled: selector existence, byte-exact fragments, field-path
correspondence, full parameter coverage, and a hard failure if any value-bearing
parameter is hidden. It is wired into CI.

## Design notes worth knowing before editing

- **Labels name the token on purpose.** `OkuM Amount`, `USDOku Amount`,
  `USDOku Shares`. ERC-7730 cannot express a display multiplier, so a device
  shows raw OkuM while the app shows dollars — the label is the only thing
  preventing a signer from reading one as the other. USDC keeps a bare `Amount`.
- **`USDOku.mint`/`burn` use `unit`, not `tokenAmount`.** They take *shares*; a
  token binding would be wrong by `M_usd / 1e18` and drift every second.
- **`sweepToken.amount` binds `tokenPath` to its sibling `token` parameter**,
  which is the only way a polymorphic-decimals amount is displayable at all.
- **The role enum shows the literal constant** (`OKU_RATE_SETTER`, not "Rate
  setter") so a cold-multisig signer can match the device against the runbook
  verbatim.
- **Every state-changing function is covered**, including governance. An
  uncovered function is a blind-signed function, and `upgradeToAndCall` is the
  highest-consequence signature in the system.

## Measured Ledger limits

From `erc7730 lint` warnings, not guesswork:

| Field | Limit |
|---|---|
| Enum entry | 20 chars — `OKU_ALLOWANCE_MANAGER` (21) is abbreviated to `OKU_ALLOWANCE_MGR` |
| Owner URL | 26 chars — pick a short canonical domain |

All current labels and intents are within limits; the longest is
`Min USDOku Amount` (17).

## Submission

Blocked until the contracts are deployed **and verified on Sourcify** — the
linter tries Sourcify before Etherscan, and a reviewer will ask for it.

1. Deploy, then `npm run verify:sourcify:<network>`
2. `NETWORK=… OWNER=… OWNER_URL=… npm run metadata:sync`
3. `npm run metadata:fixtures && npm run metadata:validate -- --strict`
4. `npm run metadata:lint` — must be error-free
5. Fork the registry; copy `deployed/*` into `registry/<entity>/`, fixtures into
   `registry/<entity>/testsv2/`
6. Open a PR. **One entity per PR.** Do not edit `index.*.json` — CI regenerates
   those.

Post-merge, auditors may publish EAS attestations under `sigs/`; that is the
trust layer and is separate from PR review.
