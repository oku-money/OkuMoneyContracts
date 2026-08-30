// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {USDOku} from "../../src/token/USDOku.sol";

/**
 * @title USDOkuUpdateHarness
 * @notice Reaches USDOku's defensive `_update` guard.
 *
 * `USDOku._update` reverts unconditionally. Every supply change routes through
 * wrap/unwrap/mint/burn, which manage `shares` directly, and the ERC-20 write paths
 * are all overridden, so no production path reaches the inherited hook. That is the
 * point of the guard: it converts a future refactor that accidentally routes through
 * `ERC20Upgradeable._mint`/`_burn`/`_transfer` from a silent double-accounting bug —
 * the share ledger and the balance mapping diverging — into an immediate revert.
 *
 * Being unreachable by design makes it unreachable by test, which would leave the
 * guard unverified. This harness calls the hook directly so the revert is asserted
 * rather than assumed.
 *
 * Test-only. Must never be imported from a production path.
 */
contract USDOkuUpdateHarness is USDOku {
    function exposedUpdate(address from, address to, uint256 value) external pure {
        _update(from, to, value);
    }
}
