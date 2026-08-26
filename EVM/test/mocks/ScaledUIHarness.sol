// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/// @title ScaledUIHarness
/// @notice Test-only harness over the stepwise ERC-8056 display layer.
/// @dev NOT FOR PRODUCTION DEPLOYMENT.
///
///      Two jobs:
///
///      1. Reach the defensive bounds in `_stepMultiplier` that legitimate steps
///         cannot. `MAX_MULTIPLIER` (1e24) is unreachable from genesis without
///         ~1,390 maximum steps, so `forceMultiplier` writes the namespaced slot
///         directly (vm-free assembly) to park the state next to any bound.
///
///      2. Act as a hostile-but-standard-conformant ERC-8056 counterparty.
///         ERC-8056 permits any positive multiplier and permits decreases
///         (reverse splits); this token forbids both. Anything reading a
///         third-party scaled-UI token — notably `OkuMultiplierAdapter` and the
///         shared `MathLib` conversions — must behave against the full legal
///         range (below 1e18, above MAX_MULTIPLIER, decreasing), not just ours.
contract ScaledUIHarness is ScaledUIAmountUpgradeable {
    /// @custom:storage-location erc7201-unsafe:test.harness
    struct HarnessStorage {
        uint256 rawSupply;
        mapping(address => uint256) rawBalance;
    }

    bytes32 private constant HARNESS_SLOT = keccak256("test.harness.ScaledUIHarness");

    /// @dev Must match `SCALED_UI_AMOUNT_STORAGE_LOCATION` in the base contract.
    ///      Pinned by `ERC7201SlotsTest`. Layout: word 0 = multiplier,
    ///      word 1 = lastSteppedAt, word 2 = stepHighWaterMark.
    bytes32 private constant SCALED_UI_SLOT =
        0x3cb9c1d6aa88f069eb5ba8341839db9b5d23817fee13933ec1221e36b8fe7800;

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

    /// @notice Overwrite the multiplier directly, bypassing every guard.
    /// @dev Reaches standard-legal-but-forbidden-here values: below `PRECISION`,
    ///      above `MAX_MULTIPLIER`, or lower than the current value. vm-free so
    ///      non-Test contracts can use it too.
    function forceMultiplier(uint256 value) external {
        bytes32 slot = SCALED_UI_SLOT;
        assembly {
            sstore(slot, value)
        }
    }

    /// @notice Overwrite `lastSteppedAt` directly (staleness scenarios).
    function forceLastSteppedAt(uint256 value) external {
        bytes32 slot = SCALED_UI_SLOT;
        assembly {
            sstore(add(slot, 1), value)
        }
    }

    // ============ Exposed authority path (ungated) ============

    /// @notice Raw `_stepMultiplier`, with none of the token's policy layered on
    ///         (no role gate, no halt flag, no step-coverage check, no window).
    function step(uint256 newMultiplier) external returns (uint256 stepBps) {
        return _stepMultiplier(newMultiplier);
    }

    function resetHighWaterMark() external {
        _resetStepHighWaterMark();
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
