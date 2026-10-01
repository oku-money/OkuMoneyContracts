// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockCallbackUSDC
/// @notice Test-only collateral token that invokes a callback on `to` during
///         `transferFrom`, then optionally returns `false` WITHOUT reverting.
/// @dev Exists solely to exercise `RedemptionQueue`'s reentrancy surface against a
///      hypothetical callback-bearing collateral token — Circle USDC has no such
///      callback, so this scenario is not reachable with the token actually
///      configured today, but the collateral token is a deploy-time parameter
///      (`RedemptionQueue.initialize` / `LitePSM.initialize` validate only
///      `decimals() <= 18`), not a property either contract can itself enforce.
///      See `test/psm/Reentrancy.t.sol`'s `advanceHead` tests.
///
///      The critical property this mock relies on, confirmed against OpenZeppelin's
///      `SafeERC20._safeTransferFrom` assembly: when the inner call's return value
///      decodes to `false` WITHOUT the call itself reverting, `trySafeTransferFrom`
///      reports failure (`ok = false`) but every state change the inner call already
///      made (including a reentrant call it triggered) PERSISTS — nothing is unwound,
///      unlike an actual revert. A token that reverts on failure cannot strand
///      anything, because the revert unwinds the attacker's own reentrant call too;
///      a token that signals failure via a `false` return, as this mock does, can.
contract MockCallbackUSDC is ERC20 {
    /// @dev Calls `onTransferAttempt()` on `to` if it has code, ignoring the result —
    ///      real malicious/compromised tokens do not check whether their callback
    ///      reverted; they continue either way.
    mapping(address => bool) public failTransfersTo;

    constructor() ERC20("Callback USDC", "cbUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Addresses for which `transferFrom` fires the callback then returns
    ///         `false` (soft failure, no revert) instead of completing the transfer.
    function setFailTransfersTo(address account, bool fail) external {
        failTransfersTo[account] = fail;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (to.code.length > 0) {
            // Unchecked low-level call: a hostile token does not care whether its own
            // callback reverts, and (critically for what this mock demonstrates) a
            // revert inside this nested call does NOT propagate out of it — the
            // reentrant call's own failure is contained to its own frame, while any
            // state change IT made before reverting is independently unwound with it.
            // What is NOT unwound is this outer `transferFrom`'s own effect, which is
            // exactly why the `false`-return path (rather than a revert) is the one
            // that can strand a slot.
            to.call(abi.encodeWithSignature("onTransferAttempt()"));
        }
        if (failTransfersTo[to]) {
            return false;
        }
        return super.transferFrom(from, to, amount);
    }
}
