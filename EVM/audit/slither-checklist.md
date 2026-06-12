# Slither Findings — Pre-Audit Triage

Tool: `slither 0.11.4`
Command: `slither . --filter-paths "test/|lib/|script/|node_modules/"`

All 21 findings are **Informational** severity. None are actionable.

## Triage summary

| Detector | Count | Disposition |
|---|---:|---|
| `assembly` | 5 | Accepted — all five are ERC-7201 namespaced storage helpers (`_getXStorage()`) on OkuMoney, OkuDollar, LitePSM, RedemptionQueue, and OracleRelay. Inline assembly is required by the EIP-7201 pattern. |
| `dead-code` | 4 | False positives. The four hits are: `LitePSM._pegCheck` (called from every mint/redeem path via internal-helper invocation Slither's call-graph misses), `LitePSM._redeemOkuMFromSelf` (called from `_redeemUsdOku`), `OkuDollar._update` (ERC-20 inheritance hook used by `super._update`), and `OracleRelay._readAndValidateFeedDecimals` (called from `initialize` and `setPriceFeed`). Confirmed via manual grep. |
| `naming-convention` | 5 | Accepted convention. Leading-underscore parameter names on constructor / function init args (standard OpenZeppelin style; used across the codebase). |
| `timestamp` | 3 | Accepted. All three are in `OkuDollar` and gate yield-rate windowing on `block.timestamp` comparisons. The values being compared are operator-controlled `rateEnd` timestamps measured in seconds and the protocol tolerates miner timestamp drift up to the configured rate window. No MEV path. |
| `calls-loop` | 1 | Accepted. `RedemptionQueue.processQueue` calls `$.okuMoney.burn(...)` inside the loop body. The burn is intrinsic to processing each entry (the queued OkuM tokens are burned when their USDC redemption is paid). Batch size is operator-controlled via `startIndex`/`endIndex`; gas accounting is the operator's responsibility. |
| `unindexed-event-address` | 3 | Out of scope. All three events (`IERC1967.AdminChanged`, `Pausable.Paused`, `Pausable.Unpaused`) live in OpenZeppelin libraries pinned via `package.json` / `foundry.lock`. The OkuMoney contracts cannot redeclare them with `indexed` flags. |

Net actionable items: **0**.

---

## Original Slither output

**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [assembly](#assembly) (5 results) (Informational)
 - [dead-code](#dead-code) (4 results) (Informational)
 - [naming-convention](#naming-convention) (5 results) (Informational)
 - [unindexed-event-address](#unindexed-event-address) (3 results) (Informational)
## assembly
Impact: Informational
Confidence: High
 - [ ] ID-0
[OkuDollar._getOkuDollarStorage()](src/token/OkuDollar.sol#L86-L90) uses assembly
	- [INLINE ASM](src/token/OkuDollar.sol#L87-L89)

src/token/OkuDollar.sol#L86-L90


 - [ ] ID-1
[OracleRelay._getOracleRelayStorage()](src/oracle/OracleRelay.sol#L63-L67) uses assembly
	- [INLINE ASM](src/oracle/OracleRelay.sol#L64-L66)

src/oracle/OracleRelay.sol#L63-L67


 - [ ] ID-2
[OkuMoney._getOkuMoneyStorage()](src/token/OkuMoney.sol#L78-L82) uses assembly
	- [INLINE ASM](src/token/OkuMoney.sol#L79-L81)

src/token/OkuMoney.sol#L78-L82


 - [ ] ID-3
[LitePSM._getLitePSMStorage()](src/psm/LitePSM.sol#L86-L90) uses assembly
	- [INLINE ASM](src/psm/LitePSM.sol#L87-L89)

src/psm/LitePSM.sol#L86-L90


 - [ ] ID-4
[RedemptionQueue._getRedemptionQueueStorage()](src/psm/RedemptionQueue.sol#L85-L89) uses assembly
	- [INLINE ASM](src/psm/RedemptionQueue.sol#L86-L88)

src/psm/RedemptionQueue.sol#L85-L89


## dead-code
Impact: Informational
Confidence: Medium
 - [ ] ID-5
[LitePSM._redeemOkuMFromSelf(address,uint256)](src/psm/LitePSM.sol#L274-L282) is never used and should be removed

src/psm/LitePSM.sol#L274-L282


 - [ ] ID-6
[OkuDollar._update(address,address,uint256)](src/token/OkuDollar.sol#L405-L409) is never used and should be removed

src/token/OkuDollar.sol#L405-L409


 - [ ] ID-7
[LitePSM._pegCheck(LitePSM.LitePSMStorage)](src/psm/LitePSM.sol#L495-L500) is never used and should be removed

src/psm/LitePSM.sol#L495-L500


 - [ ] ID-8
[OracleRelay._readAndValidateFeedDecimals(address)](src/oracle/OracleRelay.sol#L250-L253) is never used and should be removed

src/oracle/OracleRelay.sol#L250-L253


## naming-convention
Impact: Informational
Confidence: High
 - [ ] ID-9
Parameter [LitePSM.initialize(address,address,address,address,address)._okuMoney](src/psm/LitePSM.sol#L122) is not in mixedCase

src/psm/LitePSM.sol#L122


 - [ ] ID-10
Parameter [OkuMoney.initialize(string,string,address,uint256)._admin](src/token/OkuMoney.sol#L124) is not in mixedCase

src/token/OkuMoney.sol#L124


 - [ ] ID-11
Parameter [OkuDollar.initialize(address,string,string,address,uint256)._okuMoney](src/token/OkuDollar.sol#L136) is not in mixedCase

src/token/OkuDollar.sol#L136


 - [ ] ID-12
Parameter [RedemptionQueue.initialize(address,address,address)._okuMoney](src/psm/RedemptionQueue.sol#L114) is not in mixedCase

src/psm/RedemptionQueue.sol#L114


 - [ ] ID-13
Parameter [OracleRelay.initialize(address,uint256,uint256,uint256,address)._priceFeed](src/oracle/OracleRelay.sol#L104) is not in mixedCase

src/oracle/OracleRelay.sol#L104


## unindexed-event-address
Impact: Informational
Confidence: High
 - [ ] ID-14
Event [IERC1967.AdminChanged(address,address)](lib/openzeppelin-contracts/contracts/interfaces/IERC1967.sol#L18) has address parameters but no indexed parameters

 - [ ] ID-15
Event [PausableUpgradeable.Unpaused(address)](lib/openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol#L41) has address parameters but no indexed parameters

 - [ ] ID-16
Event [PausableUpgradeable.Paused(address)](lib/openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol#L36) has address parameters but no indexed parameters

