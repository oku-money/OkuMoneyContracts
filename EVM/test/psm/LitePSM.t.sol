// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Deploy} from "../shared/Deploy.sol";
import {OverrideBlockGuard} from "../../src/lib/OverrideBlockGuard.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {LitePSMEvents} from "../../src/lib/events/LitePSMEvents.sol";
import {MockHighDecimalToken} from "../mocks/MockHighDecimalToken.sol";
import {LitePSMErrors} from "../../src/lib/errors/LitePSMErrors.sol";
import {OkuDollarErrors} from "../../src/lib/errors/OkuDollarErrors.sol";
import {OkuMoneyErrors} from "../../src/lib/errors/OkuMoneyErrors.sol";

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
        return Math.mulDiv(usdcValue18, PRECISION, price, Math.Rounding.Floor);
    }

    /// @notice Calculate expected USDC output from note redemption at current okuMMultiplier
    function _expectedUsdcFromNotes(uint256 okuMAmount) internal view returns (uint256) {
        uint256 price = okuMoney.okuMMultiplier();
        uint256 dollarValue18 = Math.mulDiv(okuMAmount, price, PRECISION, Math.Rounding.Floor);
        return dollarValue18 / DECIMAL_MULTIPLIER;
    }

    /// @dev Alias for the inherited {_setOkuMMultiplierAndRoll}.
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

    /// @notice Mint must succeed at prices that don't evenly divide (e.g., $1.05).
    /// @dev Pins that 18-decimal rounding of the OkuM amount cannot trip a slippage
    ///      check; the comparison is in USDC terms (6 decimals), absorbing the dust.
    function test_Mint_PriceAware_NonEvenPrice() public {
        // Set okuMMultiplier to 1.05e18 ($1.05) - a typical post-yield price
        _setNotePrice(105e16);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 1.05e18 ≈ 95.238e18
        uint256 expectedNotes = Math.mulDiv(100e18, PRECISION, 105e16, Math.Rounding.Floor);
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
            uint256 expected = Math.mulDiv(
                usdcAmount * DECIMAL_MULTIPLIER, PRECISION, prices[i], Math.Rounding.Floor
            );
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
    // mintUsdOku flows USDC -> mint OkuM -> wrap -> UsdOku. Since
    // `usdMultiplier() == okuMMultiplier()`, the slippage floor passed to `wrap` is
    // exactly MathLib.okuMToDollars. Tests below pin that at multipliers most likely
    // to expose rounding.

    /// @dev Helper: expected UsdOku minted for a given USDC deposit at the current multiplier.
    function _expectedUsdMintedFromUsdc(uint256 usdcAmount) internal view returns (uint256) {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        return MathLib.okuMToDollars(okuMAmount, okuMMult);
    }

    /// @notice okuMMultiplier ≈ 8/7 ($1.142857...), 1 USDC: wrap output lands 1 wei
    ///         below usdcValue18, which must not trip `OutputBelowMinimum`.
    function test_MintUsdOku_PriceAware_UserReportedCase() public {
        // 8e18 / 7 ≈ 1.142857142857142857e18, which truncates okuMAmount so the
        // wrap output falls 1 wei short of usdcValue18.
        uint256 mult = (8 * PRECISION) / 7;
        _setNotePrice(mult);

        uint256 usdcAmount = 1e6; // 1 USDC
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

    /// @dev Variant of {_expectedUsdMintedFromUsdc} with an explicit multiplier.
    function _expectedUsdMintedFromUsdcFor(
        uint256 usdcAmount,
        uint256 okuMMult
    )
        internal
        view
        returns (uint256)
    {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        return MathLib.okuMToDollars(okuMAmount, okuMMult);
    }

    /// @notice Exercise the rounding path at a multiplier reached via rate accrual.
    function test_MintUsdOku_PriceAware_AtElevatedUsdMultiplier() public {
        _elevateUsdMultiplier(11e17); // ~$1.10, rolls block internally

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

    /// @notice A redemption the buffer cannot cover reverts; nothing is pulled or burned.
    function test_Redeem_RevertsWhenBufferInsufficient() public {
        uint256 okuMAmount = 10_000e18; // buffer only covers 5000e6 worth

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSMErrors.InsufficientBuffer.selector, 5000e6, 10_000e6)
        );
        litePsm.redeemOkuM(okuMAmount);
        assertEq(okuMoney.balanceOf(user1), okuMAmount);
    }

    /// @notice `redeemOkuM` returns the USDC actually paid.
    function test_Redeem_ReturnsUsdcAmountWhenBufferCovers() public {
        uint256 okuMAmount = 100e18;
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        uint256 usdcAmount = litePsm.redeemOkuM(okuMAmount);

        assertEq(usdcAmount, expectedUsdc, "return value must equal USDC actually paid");
        assertGt(usdcAmount, 0);
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

    function test_Redeem_RevertsWhenBlacklisted() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(litePsm), 100e18);
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSMErrors.UserBlacklisted.selector, user1));
        litePsm.redeemOkuM(100e18);
    }

    /// @notice An OkuMoney blacklist cannot be bypassed by redeeming through OkuDollar.
    function test_RedeemUsdOku_RevertsWhenOkuMBlacklisted() public {
        _approveUsdc(user1, address(litePsm), 1000e6);
        vm.prank(user1);
        litePsm.mintUsdOku(1000e6);
        _approveOkuDollar(user1, address(litePsm), 1000e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user1); // OkuMoney only; OkuDollar blacklist untouched

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSMErrors.UserBlacklisted.selector, user1));
        litePsm.redeemUsdOku(1000e18);
    }

    /// @notice OkuM is minted to the PSM, so the PSM itself must reject a blacklisted caller.
    function test_MintUsdOku_RevertsWhenOkuMBlacklisted() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSMErrors.UserBlacklisted.selector, user1));
        litePsm.mintUsdOku(100e6);
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

    function test_Redeem_PriceAware_RevertsWhenBufferInsufficientDueToPrice() public {
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
        vm.expectRevert(
            abi.encodeWithSelector(LitePSMErrors.InsufficientBuffer.selector, 5000e6, expectedUsdc)
        );
        litePsm.redeemOkuM(okuMAmount);
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

    function test_WithdrawUSDC_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(bufferWithdrawer);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.withdrawUsdc(treasury, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
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
        // At 6-decimal collateral anything below 1e12 OkuM (at multiplier 1) pays 0 USDC.
        uint256 tinyAmount = DECIMAL_MULTIPLIER - 1;

        _mintOkuMoney(user1, tinyAmount);
        _approveOkuMoney(user1, address(litePsm), tinyAmount);

        vm.prank(user1);
        vm.expectRevert(Errors.AmountTooSmall.selector);
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

    function test_DepositBuffer_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();
        _mintUsdc(bufferDepositor, 100e6);
        _approveUsdc(bufferDepositor, address(litePsm), 100e6);

        vm.prank(bufferDepositor);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.depositBuffer(100e6);
    }

    function test_DepositBuffer_RevertsInOverrideBlock() public {
        _mintUsdc(bufferDepositor, 100e6);
        _approveUsdc(bufferDepositor, address(litePsm), 100e6);
        _stampYieldLockBlock();

        vm.prank(bufferDepositor);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.depositBuffer(100e6);
    }

    // ============ WithdrawUSDC Underflow Guard (Finding 8) ============

    function test_WithdrawUSDC_RevertInsufficientBalance() public {
        // PSM has 5000e6 buffer. Try to withdraw more than balance.
        uint256 balance = usdc.balanceOf(address(litePsm));

        vm.prank(bufferWithdrawer);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSMErrors.InsufficientBuffer.selector, balance, balance + 1)
        );
        litePsm.withdrawUsdc(user1, balance + 1);
    }

    function test_WithdrawUSDC_RevertZeroAddress() public {
        vm.prank(bufferWithdrawer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        litePsm.withdrawUsdc(address(0), 1);
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
        // Named, not a comment: a bare expectRevert would also accept an
        // allowance or pause failure, i.e. it would pass without ever reaching
        // the reserves check this test exists for.
        vm.expectRevert(OkuDollarErrors.InsufficientReserves.selector);
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

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_MintOkuM_RevertsInOverrideBlock() public {
        // Distribute yield to set lastOverrideBlock
        _mintOkuMoney(user2, 10_000e18);
        _stampYieldLockBlock();

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_MintOkuM_SucceedsInNextBlock() public {
        // Use setOkuMMultiplier (the only remaining discrete-stamp path) to avoid
        // slippage issues.
        // (setOkuMMultiplier also sets lastOverrideBlock). A strict
        // increase of 1 wei is sufficient to trip the sandwich-lock stamp without
        // moving math materially.
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION + 1);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now mintOkuM should succeed
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        // 100 USDC at the live multiplier. `> 0` would have passed on one wei.
        assertEq(
            okuMoney.balanceOf(user1),
            (100e6 * 1e12 * PRECISION) / okuMoney.okuMMultiplier(),
            "mint credits the exact converted amount"
        );
    }

    function test_RedeemOkuM_RevertsInOverrideBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield to set lastOverrideBlock
        _stampYieldLockBlock();

        // Same block — redeemOkuM should revert
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.redeemOkuM(50e18);
    }

    function test_RedeemOkuM_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield
        _stampYieldLockBlock();

        // Roll to next block
        vm.roll(block.number + 1);

        // Now redeemOkuM should succeed
        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(50e18);

        assertGt(usdc.balanceOf(user1), usdcBefore);
    }

    function test_MintOkuDollar_RevertsInOverrideBlock() public {
        // Distribute yield
        _mintOkuMoney(user2, 10_000e18);
        _stampYieldLockBlock();

        // Same block — mintUsdOku should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.mintUsdOku(100e6);
    }

    function test_RedeemOkuDollar_RevertsInOverrideBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        okuDollar.approve(address(litePsm), 100e18);

        // Distribute yield
        _stampYieldLockBlock();

        // Same block — redeemUsdOku should revert
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.redeemUsdOku(50e18);
    }

    function test_SetOkuMPrice_AlsoBlocksPSMOperations() public {
        // setOkuMMultiplier also sets lastOverrideBlock
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastOverrideBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastOverrideBlock(), 0);

        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        // 100 USDC at the live multiplier. `> 0` would have passed on one wei.
        assertEq(
            okuMoney.balanceOf(user1),
            (100e6 * 1e12 * PRECISION) / okuMoney.okuMMultiplier(),
            "mint credits the exact converted amount"
        );
    }

    /// @notice PINS THE DOCUMENTED LIMITATION, end to end: `OverrideBlockGuard` is
    ///         forward-only. A mint ordered BEFORE `setOkuMMultiplier` in the same
    ///         block is not blocked — it reads `lastOverrideBlock` before
    ///         the override writes it — and a redeem one block later is not blocked
    ///         either (the guard has already released). Together they capture the
    ///         entire discrete jump for one block of capital exposure.
    /// @dev This is NOT a reentrancy or ordering trick — forge executes top-level
    ///      calls in the order written, so simply not `vm.roll`-ing between the mint
    ///      and the override IS "same block, mint ordered first." See
    ///      `OverrideBlockGuard.sol`'s NatSpec and `EVM/README.md` Accepted Risk #11.
    ///      If this test ever starts reverting on the mint or the redeem, the
    ///      guard's scope changed and Accepted Risk #11 needs re-examination, not
    ///      this test weakened to match.
    function test_FrontRunOverride_MintBeforeThenRedeemAfter_CapturesDiscreteStep() public {
        uint256 mintUsdc = 100e6;

        // 1. Front-run: mint BEFORE the override, same block. Guard not yet armed.
        _approveUsdc(user1, address(litePsm), mintUsdc);
        vm.prank(user1);
        litePsm.mintOkuM(mintUsdc);
        uint256 okuMReceived = okuMoney.balanceOf(user1);
        assertGt(okuMReceived, 0, "front-run mint must succeed -- this is the documented gap");

        // 2. The discrete jump itself, same block as the front-run mint.
        uint256 preMultiplier = okuMoney.okuMMultiplier();
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(preMultiplier * 2);

        // Confirm the guard IS armed for the rest of this block -- a same-block
        // back-run attempt reverts.
        vm.prank(user1);
        okuMoney.approve(address(litePsm), okuMReceived);
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.redeemOkuM(okuMReceived);

        // 3. Back-run: roll one block, THEN redeem -- the guard has released.
        vm.roll(block.number + 1);
        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(okuMReceived);
        uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;

        // 4. The attack's actual payoff: redeemed strictly more USDC than was put
        //    in, for one block of exposure -- the entire discrete step, captured.
        assertGt(
            usdcReceived,
            mintUsdc,
            "front-run+delayed-redeem must capture the discrete jump -- this is Accepted Risk #11's unmitigated residual"
        );
    }

    /// @notice The operational mitigation Accepted Risk #11 recommends: pause the
    ///         PSM and vault around `setOkuMMultiplier`, independent of OkuMoney's
    ///         own pause state. Proves the ceremony actually closes BOTH legs the
    ///         on-chain guard alone does not -- the front-run mint before the
    ///         override, and the back-run redeem a block after it -- not just the
    ///         same-block round-trip `OverrideBlockGuard` already blocks.
    function test_SetOkuMMultiplier_PauseCeremony_ClosesFrontRunWindow() public {
        // Seed user1 with OkuM from BEFORE the ceremony starts, so "the PSM is
        // paused" is the only thing stopping the attack on the mint side -- not
        // merely an empty wallet.
        _mintOkuMoney(user1, 1000e18);

        // 1. Pause both surfaces OkuMoney's own pause state does not cover.
        vm.prank(pauser);
        litePsm.pause();
        vm.prank(vaultPauser);
        okuDollar.pause();

        // 2. Attempted front-run mint now reverts on LitePSM's OWN pause, before it
        //    would even reach the yield-sandwich guard.
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintOkuM(100e6);

        // 3. The override itself is UNAFFECTED -- OkuMoney has its own pause state
        //    and is not paused here. This is the property that makes the ceremony
        //    workable at all: the emergency lever stays live while user-facing
        //    surfaces are frozen around it.
        uint256 preMultiplier = okuMoney.okuMMultiplier();
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(preMultiplier * 2);
        assertEq(
            okuMoney.okuMMultiplier(),
            preMultiplier * 2,
            "override must succeed while only PSM/vault are paused"
        );

        // 4. Attempted back-run redeem, next block, STILL reverts -- PSM remains
        //    paused until the operator explicitly unpauses, closing the window
        //    the on-chain guard alone would have already released by now.
        vm.roll(block.number + 1);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 1000e18);
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.redeemOkuM(500e18);

        // 5. Unpause: normal operation resumes, at the NEW multiplier, with no
        //    front-run or back-run window having existed at any point.
        vm.prank(unpauser);
        litePsm.unpause();
        vm.prank(vaultUnpauser);
        okuDollar.unpause();

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(500e18);
        assertGt(usdc.balanceOf(user1), usdcBefore, "redemption succeeds normally once unpaused");
    }

    function test_WithdrawUSDC_RevertsInOverrideBlock() public {
        _stampYieldLockBlock();

        vm.prank(bufferWithdrawer);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.withdrawUsdc(user1, 1e6);
    }

    function test_WithdrawUSDC_SucceedsInNextBlockAfterYield() public {
        _mintOkuMoney(user2, 10_000e18);
        _stampYieldLockBlock();

        vm.roll(block.number + 1);

        uint256 before = usdc.balanceOf(user1);
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(user1, 100e6);
        assertEq(usdc.balanceOf(user1), before + 100e6);
    }

    // ============ Role, Reinit, and Multi-Decimal Tests ============

    // ---- revokeRole / renounceRole ----

    function test_RevokeRole_OkumMinterRevokesFromPsm() public {
        assertTrue(okuMoney.hasRole(OKUM_MINTER, address(litePsm)));
        vm.prank(admin);
        okuMoney.revokeRole(OKUM_MINTER, address(litePsm));
        assertFalse(okuMoney.hasRole(OKUM_MINTER, address(litePsm)));

        // PSM can no longer mint
        _mintUsdc(user1, 100e6);
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(litePsm),
                OKUM_MINTER
            )
        );
        litePsm.mintOkuM(100e6);
    }

    function test_RenounceRole_OkumMinterRenounced() public {
        vm.prank(address(litePsm));
        okuMoney.renounceRole(OKUM_MINTER, address(litePsm));
        assertFalse(okuMoney.hasRole(OKUM_MINTER, address(litePsm)));
    }

    // ---- reinit guard ----

    function test_LitePSM_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        litePsm.initialize(address(okuMoney), address(okuDollar), address(usdc), admin);
    }

    // ---- multi-decimal USDC mock ----

    function test_MultiDecimal_8DecimalUsdcPsmInit() public {
        // Deploy an 8-decimal "USDC" mock
        MockUSDC8Dec usdc8 = new MockUSDC8Dec();

        // Deploy a fresh PSM against it
        (LitePSM psm8,) =
            Deploy.deployLitePSM(address(okuMoney), address(okuDollar), address(usdc8), admin);

        // decimalMultiplier should be 10^(18-8) = 1e10
        assertEq(psm8.usdcDecimalMultiplier(), 1e10);

        // Mint/redeem round-trip
        uint256 usdcAmount = 100e8; // 100 USDC at 8 decimals
        usdc8.mint(user1, usdcAmount);
        // The PSM needs OKUM_MINTER (USDC deposits) and OKUM_BURNER (redemptions).
        vm.startPrank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(psm8));
        okuMoney.grantRole(OKUM_BURNER, address(psm8));
        vm.stopPrank();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(psm8), MAX_SUPPLY);

        vm.prank(user1);
        usdc8.approve(address(psm8), usdcAmount);
        vm.prank(user1);
        psm8.mintOkuM(usdcAmount);

        assertGt(okuMoney.balanceOf(user1), 0);
    }

    function test_MultiDecimal_18DecimalUsdcPsmInit() public {
        // Deploy an 18-decimal stable mock
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();

        // Deploy a fresh PSM against it
        (LitePSM psm18,) =
            Deploy.deployLitePSM(address(okuMoney), address(okuDollar), address(usdc18), admin);

        // decimalMultiplier should be 10^(18-18) = 1
        assertEq(psm18.usdcDecimalMultiplier(), 1);
    }

    // ---- 18-decimal collateral: mint/redeem MATH (not just init) ----
    //
    // BSC's canonical Binance-Peg USDC carries 18 decimals, not 6
    // (`scripts/config/chains.ts`). At `decimalMultiplier == 1` the collateral unit
    // stops absorbing sub-unit truncation, so it is the one configuration where the
    // conversion rounding is observable at all.

    /// @dev Wire a fresh PSM against an arbitrary-decimal collateral, granting every
    ///      role the mint/redeem paths need.
    function _deployPsmForCollateral(address collateral) internal returns (LitePSM psmX) {
        (psmX,) = Deploy.deployLitePSM(address(okuMoney), address(okuDollar), collateral, admin);
        vm.startPrank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(psmX));
        okuMoney.grantRole(OKUM_BURNER, address(psmX));
        vm.stopPrank();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(psmX), MAX_SUPPLY);
    }

    /// @notice Minting an amount too small to buy one OkuM wei reverts rather
    ///         than minting zero.
    /// @dev Only reachable at 18-decimal collateral. `okuMAmount = dollars * 1e18 / m`,
    ///      and at 6 decimals one collateral unit is already 1e12 dollar-wei, so the
    ///      quotient cannot floor to zero for any `m <= MAX_MULTIPLIER`. At 18 decimals
    ///      the collateral unit IS the dollar wei, so any `m > 1e18` makes a 1-wei
    ///      deposit round to nothing. Without the guard the caller would pay collateral
    ///      and receive zero tokens, with the deposit kept by the PSM.
    function test_MultiDecimal_18Dec_MintRevertsWhenAmountRoundsToZeroOkuM() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));

        _setOkuMMultiplierAndRoll(3e18);

        usdc18.mint(user1, 1);
        vm.startPrank(user1);
        usdc18.approve(address(psm18), 1);
        vm.expectRevert(Errors.AmountTooSmall.selector);
        psm18.mintOkuM(1);
        vm.stopPrank();
    }

    /// @notice The same rail on the vault-wrapping mint path, which has its own copy.
    function test_MultiDecimal_18Dec_MintUsdOkuRevertsWhenAmountRoundsToZeroOkuM() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));

        _setOkuMMultiplierAndRoll(3e18);

        usdc18.mint(user1, 1);
        vm.startPrank(user1);
        usdc18.approve(address(psm18), 1);
        vm.expectRevert(Errors.AmountTooSmall.selector);
        psm18.mintUsdOku(1);
        vm.stopPrank();
    }

    /// @notice At 18-decimal collateral there is no dust floor: 1 wei OkuM pays 1 wei.
    function test_MultiDecimal_18Dec_RedeemOneWeiSucceeds() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));
        usdc18.mint(address(psm18), 1_000_000e18); // buffer, 18-decimal collateral

        _mintOkuMoney(user1, 1);
        _approveOkuMoney(user1, address(psm18), 1);

        vm.prank(user1);
        assertEq(psm18.redeemOkuM(1), 1);
        assertEq(usdc18.balanceOf(user1), 1);
        assertEq(okuMoney.balanceOf(user1), 0);
    }

    /// @notice A mint whose dollar value does not divide evenly by the multiplier
    ///         must still succeed at 18-decimal collateral.
    /// @dev At 18 decimals the collateral unit IS the dollar wei, so `dollarsToOkuM`'s
    ///      truncation is visible: at `m = 3.0` the round trip `3 * floor(V/3)` drifts
    ///      by `V mod 3` units. Pins that mint accepts the worst-case drift of 2 units
    ///      (`100e18 + 1` has `V mod 3 == 2`) rather than gating on round-trip loss.
    function test_MultiDecimal_18Dec_MintSucceedsOnTruncatingAmount() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));

        _setOkuMMultiplierAndRoll(3e18);

        uint256 amount = 100e18 + 1;
        assertEq(amount % 3, 2, "fixture must hit the worst-case residue");

        usdc18.mint(user1, amount);
        vm.prank(user1);
        usdc18.approve(address(psm18), amount);

        uint256 balanceBefore = okuMoney.balanceOf(user1);
        vm.prank(user1);
        psm18.mintOkuM(amount);

        // floor((100e18 + 1) * 1e18 / 3e18)
        assertEq(okuMoney.balanceOf(user1) - balanceBefore, 33_333_333_333_333_333_333);
    }

    /// @notice Every residue class mints successfully — not just two in three.
    /// @dev Walking consecutive amounts covers every residue of `amount % 3`; a
    ///      round-number fixture would only ever hit one.
    function test_MultiDecimal_18Dec_MintSucceedsAcrossAllResidues() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));

        _setOkuMMultiplierAndRoll(3e18);

        for (uint256 i = 0; i < 30; i++) {
            address u = address(uint160(uint256(0xBEEF0000) + i));
            uint256 amount = 1e18 + i;

            usdc18.mint(u, amount);
            vm.prank(u);
            usdc18.approve(address(psm18), amount);
            vm.prank(u);
            psm18.mintOkuM(amount);

            assertEq(
                okuMoney.balanceOf(u),
                (amount * Constants.PRECISION) / 3e18,
                "minted OkuM must equal the floored conversion"
            );
        }
    }

    /// @notice The same property at 8 decimals, where each collateral unit is 1e10
    ///         dollar-wei and absorbs the truncation.
    function test_MultiDecimal_8Dec_MintSucceedsAcrossAllResidues() public {
        MockUSDC8Dec usdc8 = new MockUSDC8Dec();
        LitePSM psm8 = _deployPsmForCollateral(address(usdc8));

        _setOkuMMultiplierAndRoll(3e18);

        for (uint256 i = 0; i < 10; i++) {
            address u = address(uint160(uint256(0xCAFE0000) + i));
            uint256 amount = 100e8 + i;

            usdc8.mint(u, amount);
            vm.prank(u);
            usdc8.approve(address(psm8), amount);
            vm.prank(u);
            psm8.mintOkuM(amount);

            assertEq(okuMoney.balanceOf(u), (amount * 1e10 * Constants.PRECISION) / 3e18);
        }
    }

    /// @notice Redeeming at 18-decimal collateral returns exactly the floored
    ///         conversion, with no minimum-output gate rejecting it.
    /// @dev Pins the redeem OUTPUT directly: `(okuMAmount * m) / PRECISION` with no
    ///      decimal truncation at `decimalMultiplier == 1`.
    function test_MultiDecimal_18Dec_RedeemReturnsExactFlooredConversion() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        LitePSM psm18 = _deployPsmForCollateral(address(usdc18));

        _setOkuMMultiplierAndRoll(3e18);

        uint256 okuMAmount = 33_333_333_333_333_333_333;
        _mintOkuMoney(user1, okuMAmount);

        // Fund the buffer so the redemption does not revert InsufficientBuffer.
        usdc18.mint(address(psm18), 1000e18);

        vm.prank(user1);
        okuMoney.approve(address(psm18), okuMAmount);

        uint256 before = usdc18.balanceOf(user1);
        vm.prank(user1);
        psm18.redeemOkuM(okuMAmount);

        uint256 expected = (okuMAmount * 3e18) / Constants.PRECISION; // D == 1
        assertEq(usdc18.balanceOf(user1) - before, expected);
    }

    /// @notice Redemption output is non-decreasing in the multiplier — the property
    ///         that makes a user-supplied slippage bound unnecessary on EVM.
    /// @dev This is the load-bearing justification for `mintOkuM`/`redeemOkuM` taking
    ///      no `minOut` parameter, so it is pinned rather than left as prose. The
    ///      multiplier cannot decrease: `_setOkuMYieldRate` rejects `newRate <
    ///      PRECISION` and `setOkuMMultiplier` requires a strict increase. A delayed
    ///      or reordered redemption therefore pays the user MORE, never less, and
    ///      there is no adverse price movement for a bound to protect against.
    ///
    ///      SVM keeps `min_usdc_out` anyway as client-side defence-in-depth; see
    ///      `instructions/psm.rs`'s `redeem_oku_m` NatSpec, which documents the
    ///      divergence from this side.
    function test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _mintOkuMoney(user2, okuMAmount);

        vm.prank(user1);
        okuMoney.approve(address(litePsm), okuMAmount);
        uint256 user1Before = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);
        uint256 payoutAtLowMultiplier = usdc.balanceOf(user1) - user1Before;

        _setOkuMMultiplierAndRoll(okuMoney.okuMMultiplier() * 2);

        vm.prank(user2);
        okuMoney.approve(address(litePsm), okuMAmount);
        uint256 user2Before = usdc.balanceOf(user2);
        vm.prank(user2);
        litePsm.redeemOkuM(okuMAmount);
        uint256 payoutAtHighMultiplier = usdc.balanceOf(user2) - user2Before;

        assertGt(
            payoutAtHighMultiplier,
            payoutAtLowMultiplier,
            "a rising multiplier must pay the redeemer more, never less"
        );
    }

    // ---- setMaxSupply edge case ----

    function test_SetMaxSupply_AllowsDecreaseToCurrentSupply() public {
        // Mint half the supply
        _mintOkuMoney(user1, MAX_SUPPLY / 2);
        // Decrease cap to exactly current supply — should succeed
        uint256 newCap = MAX_SUPPLY / 2;
        vm.prank(capManager);
        okuMoney.setMaxSupply(newCap);
        assertEq(okuMoney.maxSupply(), newCap);

        // totalSupply == maxSupply: any new mint must revert with ExceedsSupplyCap
        vm.prank(minter);
        vm.expectRevert(OkuMoneyErrors.ExceedsSupplyCap.selector);
        okuMoney.mint(user2, 1);
    }

    function test_SetMaxSupply_RevertsBelowCurrentTotalSupply() public {
        _mintOkuMoney(user1, 1000e18);
        // Try to set cap below current supply
        vm.prank(capManager);
        vm.expectRevert(OkuMoneyErrors.BelowCurrentSupply.selector);
        okuMoney.setMaxSupply(999e18);
    }

    // ============ Unpause Success Test ============

    function test_Unpause_Succeeds() public {
        vm.prank(pauser);
        litePsm.pause();
        assertTrue(litePsm.paused());

        vm.prank(unpauser);
        litePsm.unpause();
        assertFalse(litePsm.paused());
    }

    // ============ View Getter Tests ============
    //
    // The LitePSM storage-accessor views are the public read-API auditors and
    // integrators rely on. Tests below pin each accessor against the value set
    // by `initialize` in BaseTest.

    function test_View_OkuMoney() public view {
        assertEq(address(litePsm.okuMoney()), address(okuMoney));
    }

    function test_View_OkuDollar() public view {
        assertEq(address(litePsm.okuDollar()), address(okuDollar));
    }

    function test_View_Usdc() public view {
        assertEq(address(litePsm.usdc()), address(usdc));
    }

    function test_View_UsdcDecimalMultiplier_Litepsm() public view {
        assertEq(litePsm.usdcDecimalMultiplier(), DECIMAL_MULTIPLIER);
    }

    // ============ redeemUsdOku Tests ============

    /// @notice A usdOku redemption too small to move one share reverts rather
    ///         than unwinding a zero-value redemption.
    /// @dev `redeemUsdOku` works from the post-transfer BALANCE DELTA, not the
    ///      requested `usdAmount`, because `OkuDollar.transferFrom` floors the share
    ///      conversion while `unwrap` ceils the share burn. At `m > 1e18` a 1-wei
    ///      request floors to zero shares, so the transfer succeeds while moving
    ///      nothing; the explicit zero check rejects it before `unwrap`.
    function test_RedeemUsdOku_RevertsWhenTransferRoundsToZeroShares() public {
        _mintUsdOku(user1, 100e18);
        _approveOkuDollar(user1, address(litePsm), 100e18);

        // m > 1e18 makes floor(1 * 1e18 / m) == 0 shares.
        _setOkuMMultiplierAndRoll(3e18);

        vm.prank(user1);
        vm.expectRevert(Errors.AmountTooSmall.selector);
        litePsm.redeemUsdOku(1);
    }

    /// @notice redeemUsdOku emits only UsdOkuRedeemed, not OkuMRedeemed.
    function test_RedeemUsdOku_OkuMAtPsmInstant_NoOkuMRedeemedEvent() public {
        // Setup: user1 holds UsdOku; PSM buffer covers the redemption.
        _mintUsdOku(user1, 100e18);
        _approveOkuDollar(user1, address(litePsm), 50e18);

        // Buffer is 5000e6 from setUp — plenty to cover ~50 USDC.
        bytes32 okuMRedeemedSig = keccak256("OkuMRedeemed(address,uint256,uint256,uint256)");
        bytes32 usdOkuRedeemedSig = keccak256("UsdOkuRedeemed(address,uint256,uint256,uint256)");

        vm.recordLogs();
        vm.prank(user1);
        litePsm.redeemUsdOku(50e18);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawOkuMRedeemed = false;
        bool sawUsdOkuRedeemed = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == okuMRedeemedSig) sawOkuMRedeemed = true;
            if (logs[i].topics[0] == usdOkuRedeemedSig) sawUsdOkuRedeemed = true;
        }
        assertFalse(sawOkuMRedeemed, "OkuMRedeemed must not fire on redeemUsdOku");
        assertTrue(sawUsdOkuRedeemed, "UsdOkuRedeemed must fire on the wrapping caller");

        // User received USDC.
        assertGt(usdc.balanceOf(user1), 0);
    }

    /// @notice `redeemUsdOku` returns the USDC actually paid.
    function test_RedeemUsdOku_ReturnsUsdcAmountWhenBufferCovers() public {
        _mintUsdOku(user1, 100e18);
        _approveOkuDollar(user1, address(litePsm), 50e18);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        uint256 usdcOut = litePsm.redeemUsdOku(50e18);

        assertEq(
            usdcOut,
            usdc.balanceOf(user1) - user1UsdcBefore,
            "return value must equal USDC actually paid"
        );
        assertGt(usdcOut, 0);
    }

    /// @notice A redemption the buffer cannot cover reverts.
    function test_RedeemUsdOku_RevertsWhenBufferInsufficient() public {
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(bufferWithdrawer, 5000e6);

        _mintUsdOku(user1, 100e18);
        _approveOkuDollar(user1, address(litePsm), 100e18);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSMErrors.InsufficientBuffer.selector, 0, 100e6));
        litePsm.redeemUsdOku(100e18);
    }

    // ============ Initialization rails ============

    function test_Initialize_RevertZeroOkuMoney() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(0), address(okuDollar), address(usdc), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroOkuDollar() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(0), address(usdc), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroUsdc() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(0), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroAdmin() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(usdc), address(0))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertUsdcDecimalsTooLarge() public {
        MockHighDecimalToken hd = new MockHighDecimalToken(19);
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(hd), admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(LitePSMErrors.UsdcDecimalsTooLarge.selector, uint8(19))
        );
        new ERC1967Proxy(address(impl), initData);
    }

    /// @notice LitePSM must reject an OkuDollar wired to a DIFFERENT OkuMoney than
    ///         the one passed as `_okuMoney`.
    /// @dev Every PSM price computation assumes a single shared multiplier; a
    ///      mismatched pair would silently price both sides off the wrong token.
    function test_Initialize_RevertAssetMismatch() public {
        OkuMoney otherImpl = new OkuMoney();
        bytes memory otherInit =
            abi.encodeCall(OkuMoney.initialize, ("Other", "OTH", admin, MAX_SUPPLY));
        OkuMoney other = OkuMoney(address(new ERC1967Proxy(address(otherImpl), otherInit)));

        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(other), address(okuDollar), address(usdc), admin)
        );
        vm.expectRevert(LitePSMErrors.AssetMismatch.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ Zero-amount rails ============

    function test_MintUsdOku_RevertZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.mintUsdOku(0);
    }

    function test_RedeemUsdOku_RevertZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.redeemUsdOku(0);
    }

    function test_DepositBuffer_RevertZeroAmount() public {
        vm.prank(bufferDepositor);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.depositBuffer(0);
    }
}

// ---- Helper mock contracts (test-only, not for production) ----

/// @notice 8-decimal stable mock for multi-decimal tests
contract MockUSDC8Dec is ERC20("USD8", "USD8") {
    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice 18-decimal stable mock for multi-decimal tests
contract MockUSDC18Dec is ERC20("USD18", "USD18") {
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
