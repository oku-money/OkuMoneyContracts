// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OkuDollar} from "../../src/token/OkuDollar.sol";

/// @notice Test-only: exposes `_transferUsdShares` so its `from == address(0)` guard,
///         unreachable through `transfer` / `transferFrom`, can be exercised directly.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract OkuDollarHarness is OkuDollar {
    function exposedTransferUsdShares(
        address from,
        address to,
        uint256 shares,
        uint256 multiplier
    )
        external
    {
        _transferUsdShares(from, to, shares, multiplier);
    }
}
