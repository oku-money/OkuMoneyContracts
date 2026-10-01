// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

/**
 * @title YieldSandwichGuard
 * @notice Shared guard blocking operations in the same block as, and after,
 *         OkuMoney.setOkuMMultiplier() — the discrete emergency override. Used by
 *         both OkuDollar and LitePSM to stop wrap()/mintOkuM() and
 *         unwrap()/redeemOkuM() from landing in that block, closing the
 *         same-block atomic round-trip and any operation ordered AFTER the
 *         override within it. Streaming accrual (setOkuMYieldRate) creates no
 *         discrete step and needs no such guard.
 *
 * @dev FORWARD-ONLY, NOT A FULL SANDWICH GUARD — read before reusing this pattern.
 *      The check is `block.number == lastYieldDistributionBlock()`, and that stamp
 *      is written INSIDE `setOkuMMultiplier` (`OkuMoney.sol`), not before it. A
 *      transaction ordered EARLIER in the same block — i.e. a genuine front-run,
 *      landing before the override's tx — reads the PRE-override stamp and is not
 *      blocked by this check at all. It is blocked only if it also happens to run
 *      in a later block than the override, which a front-run by definition does
 *      not. Nothing in this guard, or anywhere else in the protocol, closes a
 *      mint one block before the override followed by a redeem one block after —
 *      that combination captures the entire discrete step on one block of
 *      capital exposure, with no fee anywhere in the PSM to price it. See
 *      `OkuMoney.sol`'s NatSpec on `setOkuMMultiplier` (states the limitation
 *      correctly: "reverts for the rest of the block") and `EVM/README.md`
 *      Accepted Risk #12 for the full analysis and the recommended operational
 *      mitigation (pause the PSM/vault around the override) that closes it
 *      without a code change.
 *
 *      Stateless — relies entirely on `IOkuMoney.lastYieldDistributionBlock()`.
 *      Inheriting contracts should expose `IOkuMoney` to `_yieldSandwichOkuMoney()`.
 */
abstract contract YieldSandwichGuard {
    error YieldDistributionInProgress();

    modifier whenYieldNotDistributing() {
        if (block.number == _yieldSandwichOkuMoney().lastYieldDistributionBlock()) {
            revert YieldDistributionInProgress();
        }
        _;
    }

    /// @notice Hook overridden by inheriting contracts to provide the OkuMoney instance
    ///         whose distribution block is being tracked.
    function _yieldSandwichOkuMoney() internal view virtual returns (IOkuMoney);
}
