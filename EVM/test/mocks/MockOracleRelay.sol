// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracleRelay} from "../../src/oracle/IOracleRelay.sol";

/// @title MockOracleRelay
/// @notice Test-only `IOracleRelay` with a toggle.
/// @dev Defaults to PASSING: `checkUsdcPeg()` is a no-op and `getUsdcPrice()` returns
///      `1e18` (i.e. $1.00). Call {setPass}(false) to drive the depeg-revert branch.
///
///      NOT FOR PRODUCTION. The real `OracleRelay` wraps a Chainlink USDC/USD feed
///      with full round/staleness/in-band validation; this mock skips all of that to
///      keep the production test scaffolding minimal.
contract MockOracleRelay is IOracleRelay {
    error MockOracleRelayDepeg();

    bool public passCheck = true;

    function setPass(bool v) external {
        passCheck = v;
    }

    function checkUsdcPeg() external view override {
        if (!passCheck) revert MockOracleRelayDepeg();
    }

    function getUsdcPrice() external pure override returns (uint256) {
        return 1e18;
    }
}
