// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";

/// @title ReentrancyGuardHarness
/// @notice Test-only contract that exposes the `nonReentrant` modifier from
///         {ReentrancyGuardUpgradeable}. Used by `test/lib/ReentrancyGuard.t.sol`
///         to assert the reentrant-revert path (line 62 of the production
///         contract) which is otherwise observable only indirectly through
///         the OkuM / SubscriptionModule / RedemptionQueue happy paths.
/// @dev NOT FOR PRODUCTION DEPLOYMENT.
contract ReentrancyGuardHarness is ReentrancyGuardUpgradeable {
    uint256 public counter;

    /// @dev `initializer` modifier is enforced by OZ's `Initializable` base;
    ///      calling `init` twice will revert (validating our wire compatibility).
    function init() external initializer {
        __ReentrancyGuard_init();
    }

    /// @notice Increment a counter under nonReentrant. If `reenter` is true,
    ///         re-call the same function — must revert with
    ///         `ReentrancyGuardReentrantCall`.
    function enter(bool reenter) external nonReentrant {
        counter += 1;
        if (reenter) {
            // Re-enter via `this.enter(false)`: external call routes through
            // the function dispatcher and re-acquires the guard.
            this.enter(false);
        }
    }

    /// @notice Plain entry that does not re-enter — used to verify the guard
    ///         releases between calls.
    function noReenter() external nonReentrant {
        counter += 1;
    }

    function entered() external view returns (bool) {
        return _reentrancyGuardEntered();
    }
}
