// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockCallbackUSDC} from "./MockCallbackUSDC.sol";

/// @title QueueFundsTopper
/// @notice Test-only contract: a `RedemptionQueue` entry's `user` which, when
///         {MockCallbackUSDC} calls it back during its OWN `transferFrom`, mints
///         additional USDC balance to a third party (the `processQueue` caller).
/// @dev Exists to construct the scenario `RedemptionQueue.processQueue`'s lazy
///      re-validation (`RedemptionQueue.sol`, the `usdcAvailable < usdcAmount` branch)
///      guards against: a transfer-callback collateral token topping up the caller's
///      real funds MID-BATCH, which the pre-loop-cached, locally-decremented
///      `usdcAvailable` bound cannot see. Without the re-check, a later entry that
///      the live funds now cover gets skipped anyway (`InsufficientFunds`) on a stale
///      read — liveness-only (the entry stays live and claimable next batch), never a
///      fund-loss. See `test/psm/ProcessQueueCallbackTopUp.t.sol`.
contract QueueFundsTopper {
    MockCallbackUSDC public immutable usdc;
    address public immutable beneficiary;
    uint256 public immutable topUpAmount;
    bool public callbackFired;

    constructor(address _usdc, address _beneficiary, uint256 _topUpAmount) {
        usdc = MockCallbackUSDC(_usdc);
        beneficiary = _beneficiary;
        topUpAmount = _topUpAmount;
    }

    /// @dev Invoked by {MockCallbackUSDC} on a `transferFrom` targeting this contract,
    ///      BEFORE that transfer's own balance movement completes.
    function onTransferAttempt() external {
        callbackFired = true;
        usdc.mint(beneficiary, topUpAmount);
    }
}
