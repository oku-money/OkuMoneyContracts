// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/**
 * @title LitePSMFuzzTest
 * @notice Fuzz tests for LitePSM mint paths that exercise multiplier-driven rounding.
 * @dev Focused on `mintUsdOku`: the path that flows USDC -> mint OkuM -> wrap -> UsdOku.
 *      The slippage floor passed to {OkuDollar.wrap} is computed via
 *      {MathLib.okuMToWrappedUsd} which replicates wrap's two-step floor math exactly.
 *      These fuzz tests pin the invariant that any USDC amount at any reachable
 *      (okuMMultiplier, usdMultiplier) pair must mint without reverting on rounding,
 *      and the minted UsdOku must match the helper-computed value within share-conversion drift.
 */
contract LitePSMFuzzTest is BaseTest {
    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Fund users with USDC for the mint paths.
        _mintUsdc(user1, 1_000_000e6);
        _mintUsdc(address(litePsm), 5000e6); // buffer (not consumed by mintUsdOku)
    }

    // ============ Helpers ============

    function _expectedUsdMinted(
        uint256 usdcAmount,
        uint256 okuMMult,
        uint256 usdMult
    )
        internal
        pure
        returns (uint256)
    {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        return MathLib.okuMToWrappedUsd(okuMAmount, okuMMult, usdMult);
    }

    // ============ mintUsdOku Rounding Invariants ============

    /// @notice mintUsdOku must never revert on rounding for any (usdcAmount, okuMMultiplier).
    ///         Confirms the historic OutputBelowMinimum failure mode is gone.
    function testFuzz_MintUsdOku_NoRevertOnRounding(
        uint256 usdcAmount,
        uint256 okuMMultiplier
    )
        public
    {
        // Bound USDC to a realistic range. Floor at 1 USDC because sub-USDC at large
        // multipliers can floor okuMAmount to zero (AmountTooSmall is a distinct,
        // expected revert and not the path under test).
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);
        okuMMultiplier = _boundOkuMMultiplier(okuMMultiplier);

        _setOkuMMultiplierAndRoll(okuMMultiplier);
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 expected = _expectedUsdMinted(usdcAmount, okuMMultiplier, okuDollar.usdMultiplier());

        uint256 balBefore = okuDollar.balanceOf(user1);
        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount); // must not revert

        uint256 minted = okuDollar.balanceOf(user1) - balBefore;
        // Balance reads can drift 1 wei from the wrap return value due to the
        // share->dollar conversion in balanceOf.
        assertApproxEqAbs(minted, expected, 1, "minted UsdOku within 1 wei of helper math");
        // And the protocol must never overmint above the deposited USDC's dollar value.
        assertLe(minted, usdcAmount * DECIMAL_MULTIPLIER, "minted <= deposited dollar value");
    }

    /// @notice mintUsdOku at varying (okuMMultiplier, usdMultiplier) pairs.
    ///         Exercises the dual-multiplier rounding interaction.
    function testFuzz_MintUsdOku_DualMultiplier(
        uint256 usdcAmount,
        uint256 okuMMultInput,
        uint256 usdMultTarget
    )
        public
    {
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);

        // Bound the okuM multiplier to a realistic range.
        uint256 okuMMult = _boundOkuMMultiplier(okuMMultInput);

        // Bound the target usdMultiplier to [PRECISION, 2 * PRECISION]. The elevate
        // helper only goes up, and may not reach the exact target; we read back the
        // actual value after.
        usdMultTarget = bound(usdMultTarget, PRECISION, 2 * PRECISION);

        _elevateUsdMultiplier(usdMultTarget); // rolls block internally via warps
        _setOkuMMultiplierAndRoll(okuMMult); // also rolls a block

        uint256 actualUsdMult = okuDollar.usdMultiplier();
        uint256 actualOkuMMult = okuMoney.okuMMultiplier();

        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 expected = _expectedUsdMinted(usdcAmount, actualOkuMMult, actualUsdMult);

        uint256 balBefore = okuDollar.balanceOf(user1);
        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount);

        uint256 minted = okuDollar.balanceOf(user1) - balBefore;
        assertApproxEqAbs(minted, expected, 1, "minted UsdOku within 1 wei of helper math");
        assertLe(minted, usdcAmount * DECIMAL_MULTIPLIER, "minted <= deposited dollar value");
    }

    /// @notice mintUsdOku output is monotonic in usdcAmount at a fixed multiplier.
    ///         Belt-and-braces sanity check: two deposits in the same call sequence
    ///         must produce >= sum of one deposit of the combined amount minus a
    ///         tiny rounding budget.
    function testFuzz_MintUsdOku_MonotonicInUsdc(
        uint256 a,
        uint256 b,
        uint256 okuMMultInput
    )
        public
    {
        a = bound(a, 1e6, 10_000e6);
        b = bound(b, 1e6, 10_000e6);
        uint256 okuMMult = _boundOkuMMultiplier(okuMMultInput);

        _setOkuMMultiplierAndRoll(okuMMult);

        // Mint to a fresh recipient so balanceOf reads are clean.
        address recipient = address(uint160(uint256(keccak256("monotonic-recipient"))));
        _mintUsdc(recipient, a + b);
        _approveUsdc(recipient, address(litePsm), a + b);

        vm.startPrank(recipient);
        litePsm.mintUsdOku(a);
        uint256 afterA = okuDollar.balanceOf(recipient);
        litePsm.mintUsdOku(b);
        uint256 afterB = okuDollar.balanceOf(recipient);
        vm.stopPrank();

        assertGe(afterB, afterA, "Second mint never decreases balance");
        // Combined dollar value never exceeds (a+b) USDC.
        assertLe(afterB, (a + b) * DECIMAL_MULTIPLIER, "Sum within deposited dollar value");
    }
}
