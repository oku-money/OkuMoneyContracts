// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {YieldSandwichGuard} from "../../src/lib/YieldSandwichGuard.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/**
 * @title LitePSMTest
 * @notice Unit tests for LitePSM (Peg Stability Module)
 * @dev Tests verify multiplier-aware conversion between USDC (6 decimals) and OkuMoney (18 decimals).
 *      OkuMoney is a standard non-rebasing ERC-20. okuMMultiplier() tracks multiplier appreciation
 *      separately from balanceOf().
 *
 *      Mint:   okuMAmount = usdcValue18 × PRECISION / okuMMultiplier()
 *      Redeem: usdcAmount = okuMAmount × okuMMultiplier() / PRECISION  (scaled to 6 decimals)
 *
 *      At initial okuMMultiplier=1e18, behavior is identical to a 1:1 decimal-scaled swap.
 */
contract LitePSMTest is BaseTest {
    // Note: DECIMAL_MULTIPLIER is inherited from BaseTest
    // ============ Events ============

    event OkuMMinted(
        address indexed user, uint256 usdcAmount, uint256 okuMAmount, uint256 okuMMultiplier
    );
    event OkuMRedeemed(
        address indexed user, uint256 noteIn, uint256 usdcOut, uint256 okuMMultiplier
    );
    event UsdOkuMinted(
        address indexed user, uint256 usdcAmount, uint256 usdAmount, uint256 okuMMultiplier
    );
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 newBufferBalance, uint256 processedStart, uint256 processedEnd);
    event BufferDeposited(address indexed depositor, uint256 amount, uint256 newBufferBalance);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint USDC to users and PSM buffer
        _mintUsdc(user1, 10_000e6);
        _mintUsdc(user2, 10_000e6);
        _mintUsdc(address(litePsm), 5000e6); // Initial buffer
    }

    // ============ Helpers for multiplier-aware math ============

    /// @notice Calculate expected note amount from USDC deposit at current okuMMultiplier
    function _expectedNotesFromUsdc(uint256 usdcAmount) internal view returns (uint256) {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 price = okuMoney.okuMMultiplier();
        return (usdcValue18 * PRECISION) / price;
    }

    /// @notice Calculate expected USDC output from note redemption at current okuMMultiplier
    function _expectedUsdcFromNotes(uint256 okuMAmount) internal view returns (uint256) {
        uint256 price = okuMoney.okuMMultiplier();
        uint256 dollarValue18 = (okuMAmount * price) / PRECISION;
        return dollarValue18 / DECIMAL_MULTIPLIER;
    }

    // _setOkuMMultiplierAndRoll is inherited from BaseTest. The local _setNotePrice
    // helper that previously lived here was removed — use the shared helper instead.
    function _setNotePrice(uint256 newPrice) internal {
        _setOkuMMultiplierAndRoll(newPrice);
    }

    // ============ Mint Tests ============

    function test_Mint_TransfersUSDCIn() public {
        uint256 amount = 100e6;
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        uint256 psmBalanceBefore = usdc.balanceOf(address(litePsm));

        _approveUsdc(user1, address(litePsm), amount);

        vm.prank(user1);
        litePsm.mintOkuM(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePsm)), psmBalanceBefore + amount);
    }

    function test_Mint_MintsOkuMoneyOut() public {
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base okuMMultiplier=1e18: okuMAmount = 100e18 * 1e18 / 1e18 = 100e18
        uint256 expectedOkuMoney = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuMoney.balanceOf(user1), expectedOkuMoney);
        assertEq(okuMoney.balanceOf(user1), 100e18); // Explicit check: 100 OkuMoney at base price
    }

    function test_Mint_OneToOneRatioAtBasePrice() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base okuMMultiplier=1e18: 500 USDC → 500 OkuMoney (multiplier-aware, same as 1:1)
        assertEq(okuMoney.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
        assertEq(okuMoney.balanceOf(user1), 500e18); // 500 OkuMoney
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.mintOkuM(0);
    }

    function test_Mint_EmitsEvent() public {
        uint256 usdcAmount = 100e6;
        uint256 okuMAmount = _expectedNotesFromUsdc(usdcAmount);
        uint256 okuMMult = okuMoney.okuMMultiplier();

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit OkuMMinted(user1, usdcAmount, okuMAmount, okuMMult);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);
    }

    // ============ Price-Aware Mint Tests ============

    function test_Mint_PriceAware_ElevatedPrice() public {
        // Set okuMMultiplier to 2e18 ($2.00)
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 2e18 = 50e18
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuMoney.balanceOf(user1), expectedNotes);
        // At $2.00, 100 USDC buys 50 notes
        assertEq(okuMoney.balanceOf(user1), 50e18, "100 USDC at $2/note = 50 notes");
        assertLt(okuMoney.balanceOf(user1), 100e18, "Should receive fewer notes at elevated price");
    }

    function test_Mint_PriceAware_HighPrice() public {
        // Set okuMMultiplier to 2e18 ($2.00)
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 2e18 = 50e18
        assertEq(okuMoney.balanceOf(user1), 50e18, "100 USDC at $2/note = 50 notes");
    }

    /// @notice CRITICAL: Test that mint works at non-even prices (e.g., $1.05)
    /// @dev This test catches the slippage check bug where 18-decimal rounding
    ///      caused valid transactions to revert at prices that don't evenly divide.
    ///      The fix compares in USDC terms (6 decimals) to absorb the rounding.
    function test_Mint_PriceAware_NonEvenPrice() public {
        // Set okuMMultiplier to 1.05e18 ($1.05) - a typical post-yield price
        _setNotePrice(105e16);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        // This would revert with the old buggy slippage check
        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 1.05e18 ≈ 95.238e18
        uint256 expectedNotes = (100e18 * PRECISION) / 105e16;
        assertEq(okuMoney.balanceOf(user1), expectedNotes, "Should mint at non-even price");
        assertLt(okuMoney.balanceOf(user1), 100e18, "Should receive fewer notes at $1.05");
        assertGt(okuMoney.balanceOf(user1), 95e18, "Should receive ~95.24 notes");
    }

    /// @notice Test mint at various realistic post-yield prices
    function test_Mint_PriceAware_VariousPrices() public {
        uint256[] memory prices = new uint256[](5);
        prices[0] = 1_000_375e12; // $1.000375 (tiny yield)
        prices[1] = 10_025e14; // $1.0025 (small yield)
        prices[2] = 1015e15; // $1.015 (moderate yield)
        prices[3] = 105e16; // $1.05 (5% yield)
        prices[4] = 11e17; // $1.10 (10% yield)

        uint256 usdcAmount = 100e6;

        for (uint256 i = 0; i < prices.length; i++) {
            deal(address(okuMoney), user1, 0);

            _setNotePrice(prices[i]);
            _approveUsdc(user1, address(litePsm), usdcAmount);

            vm.prank(user1);
            litePsm.mintOkuM(usdcAmount);

            uint256 balance = okuMoney.balanceOf(user1);
            // Verify the exact multiplier-aware amount, not just "non-zero".
            // expected = usdcValue18 × PRECISION / okuMMultiplier
            uint256 expected = (usdcAmount * DECIMAL_MULTIPLIER * PRECISION) / prices[i];
            assertEq(balance, expected, "minted OkuM must match the multiplier formula");
        }
    }

    function test_Mint_PriceAware_EmitsCorrectAmounts() public {
        // Set okuMMultiplier to 2e18 ($2.00)
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6;
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);
        uint256 okuMMult = okuMoney.okuMMultiplier();

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit OkuMMinted(user1, usdcAmount, expectedNotes, okuMMult);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);
    }

    // ============ Price-Aware mintUsdOku Tests ============
    //
    // mintUsdOku flows USDC -> mint OkuM -> wrap -> UsdOku. The slippage floor passed
    // to `wrap` is computed via MathLib.okuMToWrappedUsd so non-even multipliers no
    // longer trigger spurious OutputBelowMinimum reverts. Tests below pin that
    // behavior at the multipliers most likely to expose rounding.

    /// @dev Helper: expected UsdOku minted for a given USDC deposit at current multipliers.
    function _expectedUsdMintedFromUsdc(uint256 usdcAmount) internal view returns (uint256) {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 usdMult = okuDollar.usdMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        return MathLib.okuMToWrappedUsd(okuMAmount, okuMMult, usdMult);
    }

    /// @notice Regression: the on-chain failure that motivated this fix.
    ///         okuMMultiplier ≈ 8/7 ($1.142857...), 1 USDC -> OutputBelowMinimum
    ///         (999999999999999999, 1000000000000000000) before the fix.
    function test_MintUsdOku_PriceAware_UserReportedCase() public {
        // 8e18 / 7 ≈ 1.142857142857142857e18, which truncates okuMAmount so the
        // wrap output falls 1 wei short of usdcValue18.
        uint256 mult = (8 * PRECISION) / 7;
        _setNotePrice(mult);

        uint256 usdcAmount = 1e6; // 1 USDC — the exact case from the revert
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 expectedUsd = _expectedUsdMintedFromUsdc(usdcAmount);

        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount); // must not revert

        // Balance reads via the rebasing share->dollar conversion can drift 1 wei
        // versus the wrap return value; assert within 1 wei of the expected mint.
        uint256 bal = okuDollar.balanceOf(user1);
        assertApproxEqAbs(bal, expectedUsd, 1, "balance within 1 wei of expected UsdOku");
        // And the protocol never overmints above the deposited USDC's dollar value.
        assertLe(bal, usdcAmount * DECIMAL_MULTIPLIER, "Cannot exceed deposited dollar value");
    }

    /// @notice CRITICAL: mintUsdOku must not revert at non-even okuMMultiplier values.
    ///         Mirrors `test_Mint_PriceAware_NonEvenPrice` but for the wrap path.
    function test_MintUsdOku_PriceAware_NonEvenPrice() public {
        _setNotePrice(105e16); // $1.05

        uint256 usdcAmount = 100e6; // 100 USDC
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 expectedUsd = _expectedUsdMintedFromUsdc(usdcAmount);

        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount);

        uint256 bal = okuDollar.balanceOf(user1);
        assertApproxEqAbs(bal, expectedUsd, 1, "UsdOku minted matches helper math");
        // 100 USDC at $1.05 OkuM and 1.0 UsdOku ≈ 100 UsdOku minus rounding.
        assertLe(bal, 100e18, "Cannot exceed deposited dollar value");
        assertGe(bal, 100e18 - 2, "Within 2 wei of 100 UsdOku");
    }

    /// @notice mintUsdOku at the realistic post-yield price set used by mintOkuM tests.
    function test_MintUsdOku_PriceAware_VariousPrices() public {
        uint256[] memory prices = new uint256[](5);
        prices[0] = 1_000_375e12; // $1.000375 (tiny yield)
        prices[1] = 10_025e14; // $1.0025 (small yield)
        prices[2] = 1015e15; // $1.015 (moderate yield)
        prices[3] = 105e16; // $1.05 (5% yield)
        prices[4] = 11e17; // $1.10 (10% yield)

        uint256 usdcAmount = 100e6;

        for (uint256 i = 0; i < prices.length; i++) {
            // Reset user OkuDollar balance between iterations by burning via transfer-out.
            // The vault doesn't expose a force-clear, so use a fresh recipient per case.
            address recipient =
                address(uint160(uint256(keccak256(abi.encode("usdoku-mint-recipient", i)))));
            _mintUsdc(recipient, usdcAmount);

            _setNotePrice(prices[i]);
            _approveUsdc(recipient, address(litePsm), usdcAmount);

            uint256 expectedUsd = _expectedUsdMintedFromUsdcFor(usdcAmount, prices[i]);

            vm.prank(recipient);
            litePsm.mintUsdOku(usdcAmount);

            uint256 bal = okuDollar.balanceOf(recipient);
            assertApproxEqAbs(bal, expectedUsd, 1, "UsdOku minted must match helper math");
            assertLe(bal, usdcAmount * DECIMAL_MULTIPLIER, "Cannot exceed deposited dollar value");
        }
    }

    /// @dev Variant of {_expectedUsdMintedFromUsdc} that lets the test pin the
    ///      okuMMultiplier explicitly (the storage helper has already set it, but
    ///      reading it back is fine — keeping the parameter makes intent clear).
    function _expectedUsdMintedFromUsdcFor(
        uint256 usdcAmount,
        uint256 okuMMult
    )
        internal
        view
        returns (uint256)
    {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 usdMult = okuDollar.usdMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        return MathLib.okuMToWrappedUsd(okuMAmount, okuMMult, usdMult);
    }

    /// @notice Exercise the dual-multiplier rounding path: both okuMMultiplier
    ///         and usdMultiplier elevated simultaneously.
    function test_MintUsdOku_PriceAware_AtElevatedUsdMultiplier() public {
        // Elevate UsdOku multiplier first (rolls block internally), then move
        // okuMMultiplier (also rolls a block), so neither yield-sandwich guard
        // is tripped by the subsequent mint.
        _elevateUsdMultiplier(11e17); // ~$1.10 per share, capped by compounded reachability
        _setNotePrice(105e16); // $1.05 per OkuM

        uint256 usdcAmount = 250e6; // 250 USDC
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 expectedUsd = _expectedUsdMintedFromUsdc(usdcAmount);

        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount);

        uint256 bal = okuDollar.balanceOf(user1);
        assertApproxEqAbs(bal, expectedUsd, 1, "UsdOku balance matches helper math");
        assertLe(bal, usdcAmount * DECIMAL_MULTIPLIER, "Cannot exceed deposited dollar value");
    }

    /// @notice mintUsdOku emits UsdOkuMinted carrying the helper-computed dollar amount.
    function test_MintUsdOku_PriceAware_EmitsCorrectAmounts() public {
        _setNotePrice(105e16); // $1.05

        uint256 usdcAmount = 100e6;
        uint256 expectedUsd = _expectedUsdMintedFromUsdc(usdcAmount);
        uint256 okuMMult = okuMoney.okuMMultiplier();

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit UsdOkuMinted(user1, usdcAmount, expectedUsd, okuMMult);

        vm.prank(user1);
        litePsm.mintUsdOku(usdcAmount);
    }

    // ============ Oracle Tests ============

    function test_Mint_ChecksOracleWhenEnabled() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report sufficient reserves
        oracle.setAnswer(int256(1_000_000_000e18));

        uint256 usdcAmount = 100e6;
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Should succeed
        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        uint256 expectedOkuMoney = _expectedNotesFromUsdc(usdcAmount);
        assertEq(
            okuMoney.balanceOf(user1), balanceBefore + expectedOkuMoney, "OkuMoney should be minted"
        );
    }

    function test_Mint_RevertsOnInsufficientReserves() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report LOW reserves
        oracle.setAnswer(int256(1)); // Only 1 wei of reserves

        _approveUsdc(user1, address(litePsm), 100e6);

        uint256 expectedOkuMAmount = _expectedNotesFromUsdc(100e6);
        uint256 newSupply = okuMoney.totalSupply() + expectedOkuMAmount;
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.ExceedsReserves.selector, newSupply, 1));
        litePsm.mintOkuM(100e6);
    }

    function test_Mint_RevertsOnStaleOracle() public {
        // Warp to a reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle with short staleness
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Make oracle stale by setting timestamp in the past
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(LitePSM.StaleOracleData.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_Mint_RevertsOnIncompleteRound() public {
        // Warp to a reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Simulate an incomplete round (answeredInRound < roundId)
        oracle.setRoundIncomplete();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(LitePSM.IncompleteOracleRound.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_Mint_SkipsOracleWhenDisabled() public {
        // Warp to reasonable timestamp to allow setStale to work without underflow
        vm.warp(1_000_000);

        // Oracle configured but disabled
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, false);

        // Set stale oracle data - should be ignored since oracle is disabled
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUsdc(user1, address(litePsm), 100e6);

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        uint256 expectedOkuMoney = _expectedNotesFromUsdc(100e6);
        assertEq(okuMoney.balanceOf(user1), balanceBefore + expectedOkuMoney);
    }

    function test_ConfigureOracle_OnlyOracleManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_ORACLE_MANAGER
            )
        );
        litePsm.configureOracle(address(oracle), 1 hours, true);
    }

    function test_ConfigureOracle_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(address(oracle), 2 hours, true);

        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 2 hours, true);
    }

    function test_Mint_RevertsOnNegativeOracleAnswer() public {
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);
        oracle.setAnswer(-1);

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(LitePSM.InvalidOracleResponse.selector);
        litePsm.mintOkuM(100e6);
    }

    // ============ Redeem Tests ============

    function test_Redeem_TransfersUSDCOut() public {
        // User needs OkuMoney first - mint 100 OkuMoney (18 decimals)
        uint256 okuMAmount = 100e18;
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount); // 100e6 at base price

        _mintOkuMoney(user1, okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 psmUsdcBefore = usdc.balanceOf(address(litePsm));

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
        assertEq(usdc.balanceOf(address(litePsm)), psmUsdcBefore - expectedUsdc);
    }

    function test_Redeem_BurnsOkuMoney() public {
        uint256 okuMAmount = 100e18; // 100 OkuMoney

        _mintOkuMoney(user1, okuMAmount);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(okuMoney.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatioAtBasePrice() public {
        uint256 okuMAmount = 500e18; // 500 OkuMoney
        uint256 expectedUsdc = 500e6; // At base price: 500 USDC

        _mintOkuMoney(user1, okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base okuMMultiplier=1e18: 500 OkuMoney → 500 USDC (multiplier-aware, same as 1:1)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney

        _mintOkuMoney(user1, okuMAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuMoney at base price)
        // User only needs to approve PSM — PSM handles the transfer to queue
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // Should be queued, not immediate redemption (buffer insufficient)
        // User still has their OkuMoney (transferred to queue contract)
        // Check queue has entry
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_Redeem_QueuesWithOnlyPSMApproval() public {
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney (buffer only has 5000 USDC worth)

        _mintOkuMoney(user1, okuMAmount);

        // Verify only PSM approval is needed — no queue approval at all
        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        // Deliberately do NOT approve the queue

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Must succeed with only PSM approval

        assertEq(redemptionQueue.queueLength(), 1);
        // OkuMoney is now held by the queue contract
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), okuMAmount);
    }

    function test_Redeem_NoOracleCheck() public {
        // Warp to reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        uint256 okuMAmount = 100e18; // 100 OkuMoney

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), 10_100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.redeemOkuM(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.redeemOkuM(okuMAmount);
    }

    function test_Redeem_EmitsEvent() public {
        uint256 okuMAmount = 100e18;
        uint256 usdcAmount = _expectedUsdcFromNotes(okuMAmount); // 100e6 at base price
        uint256 okuMMult = okuMoney.okuMMultiplier();

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.expectEmit(true, false, false, true);
        emit OkuMRedeemed(user1, okuMAmount, usdcAmount, okuMMult);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);
    }

    // ============ Price-Aware Redeem Tests ============

    function test_Redeem_PriceAware_ElevatedPrice() public {
        // Mint notes at base price, then raise price before redeeming
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);

        // Raise okuMMultiplier to 1.05e18 ($1.05)
        _setNotePrice(1.05e18);

        // Now each note is worth $1.05 → 100 notes = $105
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        // 100e18 * 1.05e18 / 1e18 = 105e18 dollarValue → 105e18 / 1e12 = 105e6
        assertEq(expectedUsdc, 105e6, "100 notes at $1.05 = 105 USDC");

        // Need extra buffer to cover elevated price
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 105e6, "Should receive 105 USDC");
        assertEq(okuMoney.balanceOf(user1), 0, "All notes burned");
    }

    function test_Redeem_PriceAware_HighPrice() public {
        uint256 okuMAmount = 50e18;

        _mintOkuMoney(user1, okuMAmount);

        // Raise okuMMultiplier to 2e18 ($2.00)
        _setNotePrice(2e18);

        // 50 notes at $2 = $100
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 100e6, "50 notes at $2.00 = 100 USDC");

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 100e6);
    }

    function test_Redeem_PriceAware_EmitsCorrectAmounts() public {
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);

        _setNotePrice(1.05e18);
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount); // 105e6
        uint256 okuMMult = okuMoney.okuMMultiplier();

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.expectEmit(true, false, false, true);
        emit OkuMRedeemed(user1, okuMAmount, expectedUsdc, okuMMult);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);
    }

    // ============ Price-Aware Round-Trip Tests ============

    function test_RoundTrip_PriceAware_MintThenRedeem() public {
        // Use $2.00 for exact round-trip math (no rounding loss)
        _setNotePrice(2e18);

        uint256 usdcDeposit = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mintOkuM(usdcDeposit);

        uint256 notesReceived = okuMoney.balanceOf(user1);
        // 100e18 * 1e18 / 2e18 = 50e18
        assertEq(notesReceived, 50e18, "50 notes at $2 price");
        assertLt(notesReceived, 100e18, "Fewer notes at elevated price");

        // Redeem all notes back
        _approveOkuMoney(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(notesReceived);

        uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;

        // Round-trip should return exactly 100 USDC at $2 price (no rounding)
        // At $2.00: 100 USDC → 50 notes → 50 * 2 = $100 → 100e6 USDC
        assertEq(usdcReceived, usdcDeposit, "Round-trip should be exact at even price");
    }

    function test_RoundTrip_PriceAware_SymmetricAtDoublePrice() public {
        _setNotePrice(2e18);

        uint256 usdcDeposit = 200e6; // 200 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mintOkuM(usdcDeposit);

        // 200 USDC at $2/note = 100 notes
        uint256 notesReceived = okuMoney.balanceOf(user1);
        assertEq(notesReceived, 100e18, "200 USDC at $2/note = 100 notes");

        _approveOkuMoney(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(notesReceived);

        // 100 notes at $2 = 200 USDC — clean round-trip
        assertEq(usdc.balanceOf(user1) - usdcBefore, 200e6, "Clean round-trip at $2");
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyQueueProcessor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_QUEUE_PROCESSOR
            )
        );
        litePsm.processQueue(0, 10, 0);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney each

        _mintOkuMoney(user1, okuMAmount);
        _mintOkuMoney(user2, okuMAmount);

        // Drain buffer first - redeem more than buffer (5000 USDC worth at base price)
        // Only PSM approval needed; PSM moves tokens to queue internally
        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued (buffer only 5000 USDC)

        _approveOkuMoney(user2, address(litePsm), okuMAmount);
        vm.prank(user2);
        litePsm.redeemOkuM(okuMAmount); // Also queued

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer
        _mintUsdc(address(litePsm), 15_000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // processQueue now handles approve-use-revoke internally
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, 12_000e6); // 6000 USDC * 2 entries

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);
    }

    function test_ProcessQueue_ApprovesAndRevokesAllowance() public {
        // Setup: create a queued redemption
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Refill buffer
        _mintUsdc(address(litePsm), 10_000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Verify allowance is 0 before processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Process queue
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, 6000e6);

        // Verify allowance is revoked back to 0 after processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);

        // User should have received USDC (original balance + 6000e6 from queue at base price)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 6000e6);
    }

    function test_ProcessQueue_PartialProcessingRevokesAllowance() public {
        // Setup: create multiple queued redemptions
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney each

        _mintOkuMoney(user1, okuMAmount);
        _mintOkuMoney(user2, okuMAmount);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        _approveOkuMoney(user2, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        vm.prank(user2);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer with only enough for one redemption
        _mintUsdc(address(litePsm), 7000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Process only 1 entry
        uint256 head = redemptionQueue.queueHead();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, head + 1, 6000e6);

        // Allowance should still be revoked even with partial processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Only 1 entry processed
        assertEq(redemptionQueue.queueLength(), 1);
    }

    // ============ Price-Aware Queue Tests ============

    function test_ProcessQueue_PriceAware_YieldAccruesWhileQueued() public {
        // Queue at base price, then process at elevated price
        uint256 okuMAmount = 6000e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued at base price (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Raise okuMMultiplier to 1.05e18 — queued notes now worth more USDC
        _setNotePrice(1.05e18);

        // Queue entry stores okuMAmount=6000e18. At $1.05: USDC = 6000 * 1.05 = 6300
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 6300e6, "6000 notes at $1.05 = 6300 USDC");

        // Refill buffer with enough for elevated price
        _mintUsdc(address(litePsm), 10_000e6);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();

        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, expectedUsdc);

        assertEq(redemptionQueue.queueLength(), 0);
        // User receives more USDC than at base price due to multiplier appreciation
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + 6300e6,
            "User earns yield via okuMMultiplier while queued"
        );
    }

    function test_Redeem_PriceAware_QueuesWhenBufferInsufficientDueToPrice() public {
        // Buffer has 5000 USDC. At base price, 4900 notes → 4900 USDC (sufficient).
        // But at $1.05, 4900 notes → 5145 USDC (exceeds buffer).
        _setNotePrice(1.05e18);

        uint256 okuMAmount = 4900e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 5145e6, "4900 notes at $1.05 = 5145 USDC");
        assertGt(expectedUsdc, usdc.balanceOf(address(litePsm)), "Should exceed buffer");

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // Should be queued because USDC needed (5145) exceeds buffer (5000)
        assertEq(redemptionQueue.queueLength(), 1, "Should be queued");
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), okuMAmount, "Notes held by queue");
    }

    // ============ Admin Tests ============

    function test_Pause_OnlyPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_PAUSER
            )
        );
        litePsm.pause();
    }

    function test_Unpause_OnlyUnpauser() public {
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_UNPAUSER
            )
        );
        litePsm.unpause();
    }

    function test_WithdrawUSDC_OnlyBufferWithdrawer() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                PSM_BUFFER_WITHDRAWER
            )
        );
        litePsm.withdrawUsdc(user1, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
    }

    function test_WithdrawUSDC_RevertsWhenWouldStrandQueue() public {
        // Queue a redemption to create an obligation
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney (needs 10,000 USDC at base price)
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Buffer (5000e6) < 10000e6 → queued

        // PSM buffer is still 5000e6 since no USDC was moved, only OkuMoney was queued
        // Trying to withdraw the full buffer would strand the obligation
        uint256 obligation = redemptionQueue.totalQueuedUsdc();
        assertGt(obligation, 0, "Queue should have obligation");

        // Withdrawing more than (balance - obligation) should revert
        uint256 balance = usdc.balanceOf(address(litePsm));
        uint256 safeWithdraw = balance > obligation ? balance - obligation : 0;
        uint256 unsafeAmount = safeWithdraw + 1e6;

        if (unsafeAmount <= balance) {
            uint256 remainingBalance = balance - unsafeAmount;
            vm.prank(bufferWithdrawer);
            vm.expectRevert(
                abi.encodeWithSelector(
                    LitePSM.WouldStrandQueue.selector, remainingBalance, obligation
                )
            );
            litePsm.withdrawUsdc(user1, unsafeAmount);
        }
    }

    // ============ Decimal Conversion Tests ============

    function test_DecimalConversion_MintConvertsCorrectly() public {
        uint256 usdcAmount = 1000e6; // 1000 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base okuMMultiplier=1e18: should mint exactly 1000 OkuMoney (18 decimals)
        assertEq(okuMoney.balanceOf(user1), 1000e18);

        // Verify the multiplier-aware conversion equals decimal multiplier at base price
        assertEq(okuMoney.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 okuMAmount = 1000e18; // 1000 OkuMoney (18 decimals)

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base okuMMultiplier=1e18: should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify via multiplier-aware helper
        assertEq(usdc.balanceOf(user1) - usdcBefore, _expectedUsdcFromNotes(okuMAmount));
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUsdc = 5000e6; // 5000 USDC

        // Mint OkuMoney
        _approveUsdc(user1, address(litePsm), startingUsdc);
        vm.prank(user1);
        litePsm.mintOkuM(startingUsdc);

        uint256 noteReceived = okuMoney.balanceOf(user1);
        assertEq(noteReceived, 5000e18); // 5000 OkuMoney at base price

        // Redeem back to USDC
        _approveOkuMoney(user1, address(litePsm), noteReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(noteReceived);

        // Should get back exactly what we started with at base price
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUsdc);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUsdc = 1e6; // 1 USDC (minimum realistic amount)

        _approveUsdc(user1, address(litePsm), smallUsdc);
        vm.prank(user1);
        litePsm.mintOkuM(smallUsdc);

        // At base price: should mint 1 OkuMoney
        assertEq(okuMoney.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUsdc = 1_000_000e6; // 1 million USDC

        _mintUsdc(user1, largeUsdc); // Mint more USDC to user
        _approveUsdc(user1, address(litePsm), largeUsdc);

        vm.prank(user1);
        litePsm.mintOkuM(largeUsdc);

        // At base price: should mint 1 million OkuMoney
        assertEq(okuMoney.balanceOf(user1), 1_000_000e18);
    }

    function test_DecimalConversion_RedeemTooSmall() public {
        // 1 wei of OkuMoney should fail since it rounds to 0 USDC
        uint256 tinyAmount = 1; // 1 wei of OkuMoney

        _mintOkuMoney(user1, tinyAmount);
        _approveOkuMoney(user1, address(litePsm), tinyAmount);

        vm.prank(user1);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        litePsm.redeemOkuM(tinyAmount);
    }

    function test_DecimalConversion_ExactConversionFactor() public {
        // Verify at base okuMMultiplier the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUsdc(user1, address(litePsm), usdcAmount);
        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base price: OkuMoney = USDC * 10^12
        assertEq(okuMoney.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuMoney.balanceOf(user1), 123e18);
    }

    // ============ Truncation Dust Retention Tests (Finding 7) ============

    function test_Redeem_TruncationDustBurnedWithNote() public {
        // Mint OkuMoney with sub-USDC dust: 100.0000005 OkuMoney
        uint256 okuMAmount = 100e18 + 5e11; // 100 OkuMoney + 0.0000005 OkuMoney dust

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base price: dollarValue18 = okuMAmount * 1e18 / 1e18 = okuMAmount
        // usdcAmount = okuMAmount / 1e12 = 100e6 (truncated down, dust lost)
        // PSM transfers and burns the FULL okuMAmount — user retains nothing.
        // The sub-USDC dust value is lost in the integer truncation.
        assertEq(okuMoney.balanceOf(user1), 0, "All notes transferred and burned");
        assertEq(
            usdc.balanceOf(user1) - usdcBefore,
            100e6,
            "User receives truncated USDC (dust value lost)"
        );
    }

    function test_Redeem_QueuePath_TruncationDustQueuedWithNote() public {
        // Amount that exceeds buffer AND has dust
        uint256 okuMAmount = 10_000e18 + 7e11;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // PSM transfers the full okuMAmount (including dust) to the queue.
        // User retains nothing — all notes are moved.
        assertEq(okuMoney.balanceOf(user1), 0, "All notes transferred to queue");

        // Queue holds the full amount including dust
        assertEq(
            okuMoney.balanceOf(address(redemptionQueue)),
            okuMAmount,
            "Queue holds full okuMAmount including dust"
        );
    }

    function test_Redeem_PriceAware_TruncationDustAtElevatedPrice() public {
        _setNotePrice(1.05e18);

        // 100 notes at $1.05: dollarValue18 = 100e18 * 1.05e18 / 1e18 = 105e18
        //                     usdcAmount    = 105e18 / 1e12           = 105e6 (clean)
        //
        // 100 notes + 1 wei OkuMoney at $1.05:
        //   dollarValue18 = (100e18 + 1) * 1.05e18 / 1e18 = 105e18 + 1
        //   usdcAmount    = (105e18 + 1) / 1e12           = 105e6  (sub-USDC dust dropped)
        //
        // Verify the user actually receives the expected USDC for both inputs and
        // that the truncation favours the protocol (user's OkuM is fully consumed).
        uint256 cleanOkuM = 100e18;
        uint256 dustyOkuM = 100e18 + 1;

        _mintOkuMoney(user1, cleanOkuM);
        _mintOkuMoney(user2, dustyOkuM);
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), cleanOkuM);
        _approveOkuMoney(user2, address(litePsm), dustyOkuM);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        vm.prank(user1);
        litePsm.redeemOkuM(cleanOkuM);
        vm.prank(user2);
        litePsm.redeemOkuM(dustyOkuM);

        uint256 cleanReceived = usdc.balanceOf(user1) - user1UsdcBefore;
        uint256 dustyReceived = usdc.balanceOf(user2) - user2UsdcBefore;

        // Both users receive identical USDC despite the 1-wei OkuM input difference.
        assertEq(cleanReceived, 105e6, "100 OkuM @ $1.05 -> 105 USDC");
        assertEq(dustyReceived, 105e6, "100 OkuM + 1 wei @ $1.05 -> 105 USDC (dust dropped)");

        // OkuM is fully consumed in both cases (truncation favours the protocol).
        assertEq(okuMoney.balanceOf(user1), 0);
        assertEq(okuMoney.balanceOf(user2), 0);
    }

    // ============ DepositBuffer Tests ============

    function test_DepositBuffer_OnlyBufferDepositor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                PSM_BUFFER_DEPOSITOR
            )
        );
        litePsm.depositBuffer(100e6);
    }

    function test_DepositBuffer_TransfersUSDC() public {
        uint256 amount = 1000e6;
        _mintUsdc(bufferDepositor, amount);
        _approveUsdc(bufferDepositor, address(litePsm), amount);

        uint256 psmBefore = usdc.balanceOf(address(litePsm));

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(amount);

        assertEq(usdc.balanceOf(address(litePsm)), psmBefore + amount);
        assertEq(usdc.balanceOf(bufferDepositor), 0);
    }

    function test_DepositBuffer_EmitsEvent() public {
        uint256 amount = 500e6;
        _mintUsdc(bufferDepositor, amount);
        _approveUsdc(bufferDepositor, address(litePsm), amount);

        uint256 expectedBalance = usdc.balanceOf(address(litePsm)) + amount;

        vm.expectEmit(true, false, false, true);
        emit BufferDeposited(bufferDepositor, amount, expectedBalance);

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(amount);
    }

    // ============ WithdrawUSDC Underflow Guard (Finding 8) ============

    function test_WithdrawUSDC_RevertInsufficientBalance() public {
        // PSM has 5000e6 buffer. Try to withdraw more than balance.
        uint256 balance = usdc.balanceOf(address(litePsm));

        vm.prank(bufferWithdrawer);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.InsufficientBuffer.selector, balance, balance + 1)
        );
        litePsm.withdrawUsdc(user1, balance + 1);
    }

    function test_WithdrawUSDC_RevertZeroAddress() public {
        vm.prank(bufferWithdrawer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        litePsm.withdrawUsdc(address(0), 1);
    }

    // ============ RedeemWithPermit Tests ============

    function test_RedeemWithPermit_Success() public {
        uint256 amount = 100e18;

        // The permit signer is derived from user1Pk — mint OkuMoney to that derived
        // address (NOT to the named `user1` actor, whose key is unrelated).
        address user1Addr = vm.addr(user1Pk);
        _mintOkuMoney(user1Addr, amount);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuMoney.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        uint256 usdcBefore = usdc.balanceOf(user1Addr);

        vm.prank(user1Addr);
        litePsm.redeemOkuMWithPermit(amount, deadline, v, r, s);

        // At base price: should redeem 100 USDC
        uint256 expectedUsdc = _expectedUsdcFromNotes(amount);
        assertEq(usdc.balanceOf(user1Addr), usdcBefore + expectedUsdc);
        assertEq(okuMoney.balanceOf(user1Addr), 0);
    }

    function test_RedeemWithPermit_RevertsExpiredDeadline() public {
        uint256 amount = 100e18;
        address user1Addr = vm.addr(user1Pk);
        _mintOkuMoney(user1Addr, amount);

        uint256 deadline = block.timestamp - 1; // Already expired
        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuMoney.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        vm.prank(user1Addr);
        vm.expectRevert(); // ERC2612ExpiredSignature
        litePsm.redeemOkuMWithPermit(amount, deadline, v, r, s);
    }

    // ============ RedeemOkuDollarWithPermit Tests ============

    function test_RedeemOkuDollarWithPermit_Success() public {
        address user1Addr = vm.addr(user1Pk);

        uint256 usdcAmount = 100e6;

        // First mint OkuDollar for this user via PSM
        _mintUsdc(user1Addr, usdcAmount);
        vm.startPrank(user1Addr);
        usdc.approve(address(litePsm), usdcAmount);
        litePsm.mintUsdOku(usdcAmount);
        vm.stopPrank();

        uint256 okuDollarBalance = okuDollar.balanceOf(user1Addr);
        assertGt(okuDollarBalance, 0, "User should have OkuDollar");

        // Now redeem with permit
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                okuDollarBalance,
                okuDollar.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        uint256 usdcBefore = usdc.balanceOf(user1Addr);

        vm.prank(user1Addr);
        litePsm.redeemUsdOkuWithPermit(okuDollarBalance, deadline, v, r, s);

        assertGt(usdc.balanceOf(user1Addr), usdcBefore, "User should receive USDC");
        assertEq(okuDollar.balanceOf(user1Addr), 0, "User should have no OkuDollar left");
    }

    function test_RedeemOkuDollarWithPermit_RevertsExpiredDeadline() public {
        address user1Addr = vm.addr(user1Pk);

        uint256 usdcAmount = 100e6;

        // Mint OkuDollar
        _mintUsdc(user1Addr, usdcAmount);
        vm.startPrank(user1Addr);
        usdc.approve(address(litePsm), usdcAmount);
        litePsm.mintUsdOku(usdcAmount);
        vm.stopPrank();

        uint256 okuDollarBalance = okuDollar.balanceOf(user1Addr);

        uint256 deadline = block.timestamp - 1; // Already expired
        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                okuDollarBalance,
                okuDollar.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        vm.prank(user1Addr);
        vm.expectRevert(); // ERC2612ExpiredSignature
        litePsm.redeemUsdOkuWithPermit(okuDollarBalance, deadline, v, r, s);
    }

    // ============ RedeemOkuDollar Failure Modes ============

    function test_RedeemOkuDollar_RevertsWhenVaultUndercollateralized() public {
        // Set up: user1 wraps OkuM into okuDollar at base prices.
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        // Now drain the vault's OkuMoney reserves so unwrap() will revert with
        // InsufficientReserves. Use a low-level transfer impersonating the vault.
        // (In production the vault should never lose reserves; this test exercises
        //  the revert path that would surface if it ever did.)
        vm.prank(address(okuDollar));
        okuMoney.transfer(address(0xDEAD), okuMAmount);

        _approveOkuDollar(user1, address(litePsm), usdBalance);

        vm.prank(user1);
        vm.expectRevert(); // OkuDollar.InsufficientReserves bubbles up through unwrap
        litePsm.redeemUsdOku(usdBalance);
    }

    // ============ UUPS Upgrade (Finding 24) ============

    function test_UUPS_UpgradePSM() public {
        LitePSM newImpl = new LitePSM();

        vm.prank(admin);
        litePsm.upgradeToAndCall(address(newImpl), "");

        // Verify state preserved (okuMoney address still set)
        assertEq(address(litePsm.okuMoney()), address(okuMoney));
    }

    function test_UUPS_UpgradePSM_RevertNotUpgrader() public {
        LitePSM newImpl = new LitePSM();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_UPGRADER
            )
        );
        litePsm.upgradeToAndCall(address(newImpl), "");
    }

    // ============ Internal Helpers ============

    function _getOkuMoneyDomainSeparator() internal view returns (bytes32) {
        // EIP-712 domain separator for OkuMoney
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OkuMoney")),
                keccak256(bytes("1")),
                block.chainid,
                address(okuMoney)
            )
        );
    }

    function _getOkuDollarDomainSeparator() internal view returns (bytes32) {
        // EIP-712 domain separator for OkuDollar
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OkuDollar")),
                keccak256(bytes("1")),
                block.chainid,
                address(okuDollar)
            )
        );
    }

    // ============ Oracle Edge Case Tests ============

    function test_ConfigureOracle_RevertsWhenEnabledButAddressZero() public {
        // Enabling the oracle with address(0) used to silently bypass reserve checks.
        // The new guard reverts so operators cannot create that misconfiguration.
        vm.prank(oracleManager);
        vm.expectRevert(Errors.ZeroAddress.selector);
        litePsm.configureOracle(address(0), 1 hours, true);
    }

    function test_ConfigureOracle_AllowsZeroAddressWhenDisabled() public {
        // Disabled oracle accepts a zero address — represents an unconfigured oracle slot.
        vm.prank(oracleManager);
        litePsm.configureOracle(address(0), 1 hours, false);
        assertEq(address(litePsm.porOracle()), address(0));
        assertFalse(litePsm.oracleEnabled());
    }

    function test_ConfigureOracle_RevertsOnStalenessBelowFloor() public {
        // ORACLE_MIN_STALENESS / ORACLE_MAX_STALENESS now live in src/lib/Constants.sol
        // rather than as redundant public constants on LitePSM.
        uint256 minStale = Constants.ORACLE_MIN_STALENESS;
        uint256 maxStale = Constants.ORACLE_MAX_STALENESS;

        vm.prank(oracleManager);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.InvalidStaleness.selector, 30, minStale, maxStale)
        );
        litePsm.configureOracle(address(oracle), 30, true);
    }

    function test_ConfigureOracle_RevertsOnStalenessAboveCeiling() public {
        uint256 minStale = Constants.ORACLE_MIN_STALENESS;
        uint256 maxStale = Constants.ORACLE_MAX_STALENESS;

        vm.prank(oracleManager);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.InvalidStaleness.selector, 8 days, minStale, maxStale)
        );
        litePsm.configureOracle(address(oracle), 8 days, true);
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_MintOkuM_RevertsInYieldDistributionBlock() public {
        // Distribute yield to set lastYieldDistributionBlock
        _mintOkuMoney(user2, 10_000e18); // Need supply for distributeYield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_MintOkuM_SucceedsInNextBlock() public {
        // Use setOkuMMultiplier instead of distributeYield to avoid slippage issues
        // (setOkuMMultiplier also sets lastYieldDistributionBlock)
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION); // No actual price change, just sets the block

        // Roll to next block
        vm.roll(block.number + 1);

        // Now mintOkuM should succeed
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        assertGt(okuMoney.balanceOf(user1), 0);
    }

    function test_RedeemOkuM_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — redeemOkuM should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        litePsm.redeemOkuM(50e18);
    }

    function test_RedeemOkuM_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now redeemOkuM should succeed
        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(50e18);

        assertGt(usdc.balanceOf(user1), usdcBefore);
    }

    function test_MintOkuDollar_RevertsInYieldDistributionBlock() public {
        // Distribute yield
        _mintOkuMoney(user2, 10_000e18);
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — mintUsdOku should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        litePsm.mintUsdOku(100e6);
    }

    function test_RedeemOkuDollar_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        okuDollar.approve(address(litePsm), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — redeemUsdOku should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        litePsm.redeemUsdOku(50e18);
    }

    function test_SetOkuMPrice_AlsoBlocksPSMOperations() public {
        // setOkuMMultiplier also sets lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastYieldDistributionBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);

        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        assertGt(okuMoney.balanceOf(user1), 0);
    }
}
