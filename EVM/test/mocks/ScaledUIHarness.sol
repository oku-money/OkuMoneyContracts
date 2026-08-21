// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/// @title ScaledUIHarness
/// @notice Test-only harness over the ERC-8056 display layer.
/// @dev NOT FOR PRODUCTION DEPLOYMENT.
///
///      Two jobs:
///
///      1. Reach the defensive bounds in `_setYieldRate` that legitimate rates
///         cannot. `MAX_MULTIPLIER` is ~135,000x above where ten years at the APR
///         cap lands, so the `MultiplierAboveMaximum` branch is unreachable
///         without poking the anchor directly.
///
///      2. Act as a hostile-but-standard-conformant ERC-8056 counterparty.
///         ERC-8056 permits any positive multiplier and permits decreases
///         (reverse splits); this token forbids both. Anything reading a
///         third-party scaled-UI token — notably `OkuMultiplierAdapter` and the
///         shared `MathLib` conversions — must behave against the full legal
///         range, not just ours.
contract ScaledUIHarness is ScaledUIAmountUpgradeable {
    /// @custom:storage-location erc7201-unsafe:test.harness
    struct HarnessStorage {
        uint256 rawSupply;
        mapping(address => uint256) rawBalance;
    }

    bytes32 private constant HARNESS_SLOT = keccak256("test.harness.ScaledUIHarness");

    function _h() private pure returns (HarnessStorage storage $) {
        bytes32 slot = HARNESS_SLOT;
        assembly {
            $.slot := slot
        }
    }

    function init() external {
        __ScaledUIAmount_init();
    }

    // ============ Bound-reaching pokes ============

    /// @notice Overwrite the anchor directly, bypassing every guard.
    /// @dev The only way to reach the `MultiplierAboveMaximum` branch.
    function pokeBase(uint256 newBase) external {
        _pokeStorage(newBase, type(uint256).max, type(uint256).max);
    }

    /// @notice Set an arbitrary multiplier state, including states this token forbids
    ///         (below `PRECISION`, above `MAX_MULTIPLIER`, decreasing).
    function pokeMultiplier(uint256 value) external {
        _pokeStorage(value, block.timestamp, block.timestamp);
    }

    function _pokeStorage(uint256 base, uint256 last, uint256 end) private {
        // The display-layer struct is the first four words of its namespace.
        bytes32 slot = 0x3cb9c1d6aa88f069eb5ba8341839db9b5d23817fee13933ec1221e36b8fe7800;
        assembly {
            sstore(slot, base)
            if iszero(eq(last, not(0))) { sstore(add(slot, 2), last) }
            if iszero(eq(end, not(0))) { sstore(add(slot, 3), end) }
        }
    }

    // ============ Exposed authority path (ungated) ============

    function setYieldRate(uint256 rate, uint256 end) external {
        _setYieldRate(rate, end);
    }

    function haltAccrual() external {
        _haltAccrual();
    }

    // ============ Minimal raw ledger for the balances extension ============

    function mintRaw(address to, uint256 amount) external {
        HarnessStorage storage $ = _h();
        $.rawBalance[to] += amount;
        $.rawSupply += amount;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return MathLib.toUiAmount(_h().rawBalance[account], uiMultiplier());
    }

    function totalSupplyUI() external view returns (uint256) {
        return MathLib.toUiAmount(_h().rawSupply, uiMultiplier());
    }
}
