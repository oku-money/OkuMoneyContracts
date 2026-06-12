# EVM Dependencies — Pinned for Audit

All `^` ranges in `package.json` have been replaced with exact versions, and the
Foundry submodule pins in `foundry.lock` are aligned with the Node-side
OpenZeppelin packages so both compile paths (Foundry, Hardhat) produce
bytecode against identical sources.

## Solidity sources

| Library | Version | Source |
|---|---|---|
| `solc` (compiler) | `0.8.28` | `foundry.toml`, `hardhat.config.ts` |
| `@openzeppelin/contracts` | `5.6.1` | `package.json` (Hardhat path) |
| `@openzeppelin/contracts-upgradeable` | `5.6.1` | `package.json` (Hardhat path) |
| `lib/openzeppelin-contracts` | `v5.6.1` @ `5fd1781b1454fd1ef8e722282f86f9293cacf256` | `foundry.lock` (Foundry path) |
| `lib/openzeppelin-contracts-upgradeable` | `v5.6.1` @ `7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf` | `foundry.lock` (Foundry path) |
| `lib/forge-std` | `v1.12.0` @ `7117c90c8cf6c68e5acce4f09a6b24715cea4de6` | `foundry.lock` |

Both compile paths now build against **OpenZeppelin v5.6.1**. The prior drift
(Foundry on 5.5.0, Hardhat resolving to 5.4.0 from `^5.4.0`) is closed.

## Node tooling

Pinned exactly in `EVM/package.json`:

| Package | Version | Notes |
|---|---|---|
| `@nomicfoundation/hardhat-toolbox` | `6.1.2` | Bundles ethers v6 + typechain helpers |
| `@openzeppelin/hardhat-upgrades` | `3.9.0` | UUPS proxy deploy/upgrade plugin |
| `@typechain/ethers-v6` | `0.5.1` | TypeChain target |
| `@typechain/hardhat` | `9.1.0` | Hardhat plugin |
| `@types/bs58` | `4.0.4` | |
| `@types/chai` | `4.3.11` | |
| `@types/mocha` | `10.0.6` | |
| `@types/node` | `20.19.0` | |
| `bs58` | `6.0.0` | |
| `chai` | `4.5.0` | |
| `dotenv` | `17.2.3` | |
| `ethers` | `6.16.0` | |
| `hardhat` | `2.28.6` | Latest 2.x as of pin; cancun EVM target supported |
| `hardhat-deploy` | `0.12.4` | |
| `hardhat-deploy-ethers` | `0.4.2` | |
| `ts-node` | `10.9.2` | |
| `typechain` | `8.3.2` | |
| `typescript` | `5.6.3` | |

## OpenZeppelin 5.4 → 5.6.1 breaking-change review (audit-relevant)

The following 5.6.0 breaking changes were reviewed against the OkuMoney
contracts in this repo. None affect us:

- `Strings.escapeJSON` escape-range expansion — not used.
- `ERC1155` single-element batch transfer callback change — ERC1155 not used.
- `ERC1967Proxy` / `TransparentUpgradeableProxy` mandate initialization during
  construction — we deploy UUPS proxies via `@openzeppelin/hardhat-upgrades`,
  which always calls `initialize` as part of `deployProxy`. Verified via the
  Hardhat integration suite (`test/hardhat/happyPath`, `test/hardhat/fork`,
  `test/hardhat/scenarios`).
- `ERC721` / `ERC1155` operator allowance changes — neither standard is used.
- `RLP` `encode(bytes32)` fixed-size change — not used.
- `ERC4337Utils` / `WebAuthn` / `Memory` API changes — account-abstraction
  and webauthn modules are not used.
- `Math`, `SafeERC20`, `AccessControl`, `Pausable`, `ERC20*`, `UUPSUpgradeable`,
  `Initializable` — no behavioral changes between 5.4 and 5.6.1 affecting our
  call sites. Storage layouts within `5.x` are guaranteed compatible by the
  OpenZeppelin release process.

## Validation

After pinning all versions and bumping the Foundry submodules to v5.6.1:

```
forge test                       # 529 unit + fuzz tests, all green
forge test test/invariants       # 18 invariant tests, all green
npx hardhat test                 # 28 integration / fork / scenario tests, all green
```

Total: **575 tests, 0 failures.**

## `npm audit` posture

`npm audit` reports vulnerabilities in transitive dev dependencies pulled in by
`hardhat-deploy` and `@nomicfoundation/hardhat-toolbox`. These do NOT enter the
production bytecode — they are JavaScript dev tooling only — and have no impact
on the audited Solidity contracts. They are listed here for transparency:

- Run `npm audit` for the current vulnerability list.
- These will be tracked separately from the audit-scope contracts.
