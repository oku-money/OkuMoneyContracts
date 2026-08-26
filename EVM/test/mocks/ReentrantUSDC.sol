// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockUSDC} from "./MockUSDC.sol";

/**
 * @title ReentrantUSDC
 * @notice `MockUSDC` plus a configurable reentrant callback fired on the
 *         OUTBOUND transfer, used to verify that `nonReentrant` on
 *         `SubscriptionModule`, `RedemptionQueue` and `USDOkuWrapper` actually
 *         blocks cross-function reentrancy.
 *
 * @dev NOT FOR PRODUCTION.
 *
 *      WHY THE ASSET AND NOT THE SHARE TOKEN. The reentrancy vector worth
 *      testing is the external call a protocol makes to a token it does not
 *      control. `SubscriptionModule` makes exactly one class of such call —
 *      `usdc.safeTransfer` on the payout paths — and `RedemptionQueue` makes the
 *      same call when processing entries.
 *
 *      The pre-refactor suite this replaces swapped in a hostile `OkuM` with a
 *      reentrant `burn()`. That tests a contract the protocol deploys and
 *      controls, against a threat model in which it cannot be hostile, and it
 *      requires a mock implementing the whole `IOkuM` surface well enough to
 *      pass the module's `asset()` / `usdcDecimalMultiplier()` cross-assertions.
 *      Swapping the asset instead keeps every production contract in the test
 *      unmodified — real `OkuM`, real module, real queue, real wrapper — and
 *      makes the untrusted party the one that actually is untrusted.
 *
 *      It also reaches strictly more paths: `sweepToken` and `sweepExcess` take
 *      an arbitrary caller-supplied token, where a hostile ERC-20 is not a
 *      hypothetical at all.
 *
 *      MECHANISM. When armed, the first outbound transfer calls
 *      `reentrantTarget.call(reentrantCalldata)` before returning. It fires once
 *      per arming (`_armed` self-clears) so a blocked attempt cannot recurse
 *      into an infinite loop and surface as an out-of-gas instead of an
 *      assertion.
 *
 *      The callback's outcome is RECORDED, not propagated. A reverting reentrant
 *      call must not revert the outer transaction, or a test could not
 *      distinguish "the guard fired" from "the operation failed for some other
 *      reason". Assert on `lastCallSucceeded`, and on `callbackCount` to prove
 *      the hook ran at all — without that second assertion the suite would pass
 *      vacuously if the callback silently never fired.
 */
contract ReentrantUSDC is MockUSDC {
    address public reentrantTarget;
    bytes public reentrantCalldata;

    bool private _armed;
    bool private _inCallback;

    /// @notice Whether the most recent reentrant attempt returned successfully.
    /// @dev `false` after a fired-and-rejected attempt — the pass condition.
    bool public lastCallSucceeded;
    /// @notice Raw revert data from the most recent reentrant attempt.
    bytes public lastRevertData;
    /// @notice How many times the callback actually fired.
    uint256 public callbackCount;

    /// @notice Arm a single reentrant callback on the next outbound transfer.
    function armReentrancy(address target, bytes calldata data) external {
        reentrantTarget = target;
        reentrantCalldata = data;
        _armed = true;
        lastCallSucceeded = false;
        lastRevertData = "";
        callbackCount = 0;
    }

    function disarm() external {
        _armed = false;
        reentrantTarget = address(0);
    }

    /// @dev `_update` rather than `transfer`/`transferFrom` so the hook fires
    ///      however the payout is routed (`SafeERC20` uses `transfer` on the
    ///      module's payout path and `transferFrom` on the queue's).
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        // Outbound moves only (a real payout, not a mint), and never from
        // inside the callback.
        if (_armed && !_inCallback && from != address(0) && reentrantTarget != address(0)) {
            _armed = false;
            _inCallback = true;
            callbackCount++;
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory ret) = reentrantTarget.call(reentrantCalldata);
            lastCallSucceeded = ok;
            lastRevertData = ret;
            _inCallback = false;
        }
    }
}
