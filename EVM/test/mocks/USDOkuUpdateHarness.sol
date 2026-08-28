// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {USDOku} from "../../src/token/USDOku.sol";

/**
 * @title USDOkuUpdateHarness
 * @notice Reaches USDOku's defensive `_update` guard.
 *
 * `USDOku._update` reverts `UsePrivilegedMintBurn` unconditionally. Every supply
 * change goes through {mint}/{burn}, which manage `usdShares` directly, and
 * `transfer`/`transferFrom`/`approve` are all overridden, so no production path
 * reaches the inherited hook. That is the point of the guard: it converts a
 * future refactor that accidentally routes through `ERC20Upgradeable._mint`,
 * `_burn` or `_transfer` from a silent double-accounting bug — the share ledger
 * and the ERC-20 balance mapping diverging — into an immediate revert.
 *
 * Because it is unreachable by design it is also unreachable by test, which
 * leaves the guard unverified and the file short of its 100% line gate. This
 * harness calls the hook directly so the revert is asserted rather than assumed.
 *
 * Test-only. Must never be imported from a production path.
 */
contract USDOkuUpdateHarness is USDOku {
    /// @notice Invoke the inherited `_update` hook directly.
    function exposedUpdate(address from, address to, uint256 value) external pure {
        _update(from, to, value);
    }
}
