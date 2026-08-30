// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";

/**
 * @title ReentrancyGuardHarness
 * @notice Drives the reentrant-revert branch of ReentrancyGuardUpgradeable,
 *         which no production path can reach (that is the point of the guard).
 */
contract ReentrancyGuardHarness is ReentrancyGuardUpgradeable {
    uint256 public counter;

    /// @dev `__ReentrancyGuard_init` is `onlyInitializing`, so it must run inside
    ///      an initializer rather than a plain constructor.
    function initialize() external initializer {
        __ReentrancyGuard_init();
    }

    function safeCall() external nonReentrant {
        counter++;
    }

    /// @dev Re-enters itself through the guard; the second entry must revert.
    function reenter() external nonReentrant {
        ReentrancyGuardHarness(address(this)).reenter();
    }

    function entered() external view returns (bool) {
        return _reentrancyGuardEntered();
    }
}
