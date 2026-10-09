// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {SharedErrors} from "../../src/lib/errors/SharedErrors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuDollarEvents} from "../../src/lib/events/OkuDollarEvents.sol";
import {OverrideBlockGuard} from "../../src/lib/OverrideBlockGuard.sol";
import {Vm} from "forge-std/Vm.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuDollarErrors} from "../../src/lib/errors/OkuDollarErrors.sol";
import {OkuDollarHarness} from "../mocks/OkuDollarHarness.sol";

/**
 * @title OkuDollarTest
 * @notice Unit tests for OkuDollar rebasing stablecoin vault (NOT ERC-4626)
 * @dev OkuMoney is a non-rebasing ERC-20 with okuMMultiplier() for price tracking.
 *      Wrap/unwrap are multiplier-aware: they convert between note tokens and OkuDollar
 *      using okuMMultiplier() and usdMultiplier(). At okuMMultiplier = 1e18 (initial state),
 *      wrap/unwrap are 1:1.
 */
contract OkuDollarTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuDollar.name(), "OkuDollar");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuDollar.symbol(), "usdOku");
    }

    /// @dev Asserts against `Constants.OKU_M_DECIMALS` (see the OkuMoney twin) and pins
    ///      the two tokens to each other: the vault quotes dollars in the same scale as
    ///      `Constants.PRECISION`, and unlike OZ's ERC4626 there is no decimals offset
    ///      against the underlying to absorb a mismatch.
    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuDollar.decimals(), Constants.OKU_M_DECIMALS);
        assertEq(okuDollar.decimals(), 18);
        assertEq(okuDollar.decimals(), okuMoney.decimals());
    }

    function test_Initialize_SetsOkuMoneyReference() public view {
        assertEq(address(okuDollar.okuMoney()), address(okuMoney));
    }

    function test_Initialize_UsdMultiplierStartsAtPrecision() public view {
        assertEq(okuDollar.usdMultiplier(), PRECISION);
    }

    /// @notice SINGLE MULTIPLIER: `usdMultiplier()` is exactly `okuMMultiplier()`.
    function test_Initialize_UsdMultiplierDelegatesToOkuMoney() public view {
        assertEq(okuDollar.usdMultiplier(), okuMoney.okuMMultiplier());
    }

    function test_Initialize_SetsAsset() public view {
        assertEq(okuDollar.asset(), address(okuMoney));
    }

    function test_Initialize_SetsAdminRoles() public view {
        assertTrue(okuDollar.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(okuDollar.hasRole(VAULT_UPGRADER, admin));
    }

    // ============ Wrap Tests ============

    function test_Wrap_MintsCorrectUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // At okuMMultiplier=1e18 and usdMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(usdMinted, okuMAmount);
        assertEq(okuDollar.balanceOf(user1), okuMAmount);
        assertEq(okuDollar.usdSharesOf(user1), okuMAmount);
    }

    /// @notice `wrap`'s `minAmountOut` is the vault's ONE reachable slippage rail.
    /// @dev It guards the OkuM -> usdOku leg, where the caller supplies the bound, so
    ///      (unlike the PSM) there IS a user-specified expectation that can be missed.
    function test_Wrap_RevertsWhenOutputBelowMinimum() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // At m == 1e18, 100 OkuM wraps to exactly 100 usdOku. Demand one wei more.
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                OkuDollarErrors.OutputBelowMinimum.selector, okuMAmount, okuMAmount + 1
            )
        );
        okuDollar.wrap(okuMAmount, user1, okuMAmount + 1);
    }

    /// @notice Zero-address rails on the share-transfer path.
    /// @dev `_transferUsdShares` is the only place the pair is checked (OkuDollar overrides
    ///      every public mover, so OZ's zero-address guards are not in the path). Without it
    ///      `transfer(0, x)` would destroy shares while leaving `totalUsdShares` untouched.
    ///      Only `to` is asserted: `from == 0` is unreachable behind the allowance check.
    function test_Transfer_RevertsOnZeroRecipient() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);
        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        okuDollar.transfer(address(0), 1e18);
    }

    function test_Wrap_TransfersNotesToVault() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        uint256 vaultBefore = okuMoney.balanceOf(address(okuDollar));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(okuMoney.balanceOf(user1), 0);
        assertEq(okuMoney.balanceOf(address(okuDollar)), vaultBefore + okuMAmount);
    }

    function test_Wrap_EmitsTransferFromZero() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // At okuMMultiplier=1e18, usdMultiplier=1e18: usdMinted = okuMAmount
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, okuMAmount);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);
    }

    function test_Wrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user2, 0);

        // At okuMMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(okuDollar.balanceOf(user2), okuMAmount);
        assertEq(okuDollar.balanceOf(user1), 0);
    }

    function test_Wrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAmount.selector);
        okuDollar.wrap(0, user1, 0);
    }

    function test_Wrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        okuDollar.wrap(okuMAmount, address(0), 0);
    }

    // ============ Wrap Rounding Tests ============

    function test_Wrap_SharesRoundDown_FavorsVault() public {
        // Wrap some so vault is non-empty
        _mintUsdOku(user1, 1000e18);

        // Increase USD multiplier to 3x
        _elevateUsdMultiplier(PRECISION * 3);

        // Wrap an odd amount at okuMMultiplier=1e18, usdMult=3e18
        // shares = 10e18 * 1e18 / 3e18 = 3333333333333333333 (rounds down)
        // usdMinted (balanceOf) = shares * 3e18 / 1e18 = 9999999999999999999 (rounds down)
        uint256 okuMAmount = 10e18;
        _mintOkuMoney(user2, okuMAmount);
        _approveOkuMoney(user2, address(okuDollar), okuMAmount);

        vm.prank(user2);
        okuDollar.wrap(okuMAmount, user2, 0);

        // Shares calculation rounds down (favors vault)
        // sharesToMint = okuMAmount * okuMMultiplier / usdMultiplier
        uint256 expectedShares =
            (okuMAmount * okuMoney.okuMMultiplier()) / okuDollar.usdMultiplier();
        assertEq(okuDollar.usdSharesOf(user2), expectedShares, "Shares should round down");

        // Dollar value from shares <= noteValue of tokens deposited (rounding favors vault)
        uint256 depositedNoteValue =
            Math.mulDiv(okuMAmount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor);
        assertLe(
            okuDollar.balanceOf(user2),
            depositedNoteValue,
            "USD balance should not exceed deposited note value"
        );
    }

    // ============ Price-Aware Wrap Tests ============

    function test_Wrap_PriceAware_NotePriceIncrease() public {
        // Increase okuMMultiplier to 1.05e18 ($1.05 per note token)
        _setOkuMMultiplierAndRoll(105e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18, "100 notes at $1.05 should produce 105 OkuDollar");
        assertEq(okuDollar.balanceOf(user1), 105e18);
    }

    function test_Wrap_PriceAware_HighNotePrice() public {
        // okuMMultiplier = 2e18 ($2.00 per note token)
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 50e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 50e18 * 2e18 / 1e18 = 100e18
        assertEq(usdMinted, 100e18, "50 notes at $2.00 should produce 100 OkuDollar");
    }

    function test_Wrap_PriceAware_BothMultipliersElevated() public {
        // okuMMultiplier = 1.05e18, usdMultiplier targeted at 1.02e18
        _setOkuMMultiplierAndRoll(105e16);
        _elevateUsdMultiplier(102e16);

        // Read achieved multipliers — `_elevateUsdMultiplier` may overshoot the target
        // because it drives the value via setOkuMYieldRate + warp.
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 usdMult = okuDollar.usdMultiplier();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // sharesToMint = okuMAmount * okuMMult / usdMult; usdMinted = shares * usdMult / PRECISION
        uint256 sharesToMint = Math.mulDiv(okuMAmount, okuMMult, usdMult, Math.Rounding.Floor);
        uint256 expected = Math.mulDiv(sharesToMint, usdMult, PRECISION, Math.Rounding.Floor);
        assertEq(usdMinted, expected);
    }

    // ============ Unwrap Tests ============

    function test_Unwrap_ReturnsCorrectNotes() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 userNotesBefore = okuMoney.balanceOf(user1);

        vm.prank(user1);
        uint256 okuMReturned = okuDollar.unwrap(okuMAmount, user1);

        // At okuMMultiplier=1e18: okuMReturned = 100e18 * 1e18 / 1e18 = 100e18
        assertEq(okuMReturned, okuMAmount);
        assertEq(okuMoney.balanceOf(user1), userNotesBefore + okuMAmount);
        assertEq(okuDollar.balanceOf(user1), 0);
    }

    function test_Unwrap_BurnsUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // _mintUsdOku wraps `okuMAmount` at the live multiplier; at base the
        // share count IS the OkuM count.
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        assertEq(sharesBefore, okuMAmount, "wrap mints one share per OkuM at m = 1.0");

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user1);

        assertEq(okuDollar.usdSharesOf(user1), 0);
        assertEq(okuDollar.totalUsdShares(), 0);
    }

    function test_Unwrap_EmitsTransferToZero() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), okuMAmount);

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user1);
    }

    function test_Unwrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user2);

        // At okuMMultiplier=1e18: 100 OkuDollar → 100 notes
        assertEq(okuMoney.balanceOf(user2), okuMAmount);
        assertEq(okuMoney.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAmount.selector);
        okuDollar.unwrap(0, user1);
    }

    /// @notice At m = 1.9e18, `unwrap(1)` floors to 0 OkuM while the share burn ceils to 1:
    ///         it must revert, not burn a share for nothing.
    function test_Unwrap_RevertsWhenOutputRoundsToZero() public {
        _mintUsdOku(user1, 100e18);
        _setOkuMMultiplierAndRoll(19e17);
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        okuDollar.unwrap(1, user1);
        assertEq(okuDollar.usdSharesOf(user1), sharesBefore);

        // The smallest amount worth one OkuM wei goes through.
        uint256 one = Math.mulDiv(1, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Ceil);
        vm.prank(user1);
        assertEq(okuDollar.unwrap(one, user1), 1);
    }

    /// @notice Same guard on the ERC-4626 path: a spender's dust `redeem` cannot burn the
    ///         owner's shares (beyond its allowance) for zero OkuM.
    function test_Redeem_RevertsWhenOutputRoundsToZero() public {
        _mintUsdOku(user1, 100e18);
        _setOkuMMultiplierAndRoll(19e17);
        _approveOkuDollar(user1, user2, 10);
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);

        vm.prank(user2);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        okuDollar.redeem(1, user2, user1);
        assertEq(okuDollar.usdSharesOf(user1), sharesBefore);
        assertEq(okuDollar.allowance(user1, user2), 10);
    }

    function test_Unwrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        okuDollar.unwrap(okuMAmount, address(0));
    }

    /// @dev `unwrap` mirrors `wrap`'s receiver check, so an address blacklisted only on
    ///      OkuDollar cannot receive OkuMoney via `unwrap(amount, addr)`, independent of
    ///      OkuMoney's own `_update` blacklist check.
    function test_Unwrap_RevertsOnBlacklistedReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Blacklist user2 only on OkuDollar (not on OkuMoney).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        okuDollar.unwrap(okuMAmount, user2);
    }

    // ============ Unwrap Rounding Tests ============

    function test_Unwrap_SharesBurnedRoundUp_FavorsVault() public {
        // Wrap at 1x, then bump usdMultiplier so the unwrap math has a non-trivial
        // fractional part (1/3) and we can directly assert ceil-division semantics.
        _mintUsdOku(user1, 1000e18);

        _elevateUsdMultiplier(PRECISION * 3);

        // user1 shares = 1000e18, balance = 1000e18 * 3 / 1e18 = 3000e18
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        uint256 mult = okuDollar.usdMultiplier(); // = 3e18

        uint256 usdAmount = 1e18;

        vm.prank(user1);
        okuDollar.unwrap(usdAmount, user1);

        uint256 sharesAfter = okuDollar.usdSharesOf(user1);
        uint256 sharesBurned = sharesBefore - sharesAfter;

        // Direct ceiling-division assertion — this is the actual invariant the vault
        // relies on (vault always rounds shares burned UP to favour itself).
        uint256 expectedSharesCeil = Math.mulDiv(usdAmount, PRECISION, mult, Math.Rounding.Ceil);
        assertEq(sharesBurned, expectedSharesCeil, "must burn ceil(usdAmount * 1e18 / mult) shares");

        // The dollar value of the shares burned must equal-or-exceed the requested
        // usdAmount. This is what "favors the vault" actually means — the user can
        // never extract more dollars than they burn shares for.
        uint256 dollarValueBurned = Math.mulDiv(sharesBurned, mult, PRECISION, Math.Rounding.Floor);
        assertGe(dollarValueBurned, usdAmount, "vault must not be drained by rounding");
    }

    // ============ Price-Aware Unwrap Tests ============

    function test_Unwrap_PriceAware_NotePriceIncrease() public {
        // Wrap at okuMMultiplier=1e18: 100 notes → 100 OkuDollar
        _mintUsdOku(user1, 100e18);

        // Increase okuMMultiplier to 1.05e18
        _setOkuMMultiplierAndRoll(105e16);

        // Unwrap 105 OkuDollar at okuMMultiplier=1.05e18
        // okuMReturned = 105e18 * 1e18 / 1.05e18 = 100e18
        // But user only has 100 OkuDollar, so unwrap 100 OkuDollar:
        // okuMReturned = 100e18 * 1e18 / 1.05e18 ≈ 95.238e18
        vm.prank(user1);
        uint256 okuMReturned = okuDollar.unwrap(100e18, user1);

        uint256 expected = Math.mulDiv(100e18, PRECISION, 105e16, Math.Rounding.Floor);
        assertEq(okuMReturned, expected);
        // Notes returned should be less than 100 (each note is worth more now)
        assertLt(okuMReturned, 100e18, "Should return fewer notes since each note is worth more");
    }

    function test_Unwrap_PriceAware_RoundTrip_AtHighPrice() public {
        // Set okuMMultiplier to 1.05e18 BEFORE wrapping
        _setOkuMMultiplierAndRoll(105e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18);

        // Unwrap all: notesBack = 105e18 * 1e18 / 1.05e18 = 100e18
        uint256 notesBack = okuDollar.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, okuMAmount, "Round trip should not gain tokens");
    }

    // ============ Insufficient Reserves ============

    /// @notice The `InsufficientReserves` branch on `unwrap`.
    /// @dev Unreachable through any public path (shares track raw OkuM 1:1, and
    ///      `rescueDonation` cannot dip into backing), so the state is forced by pranking
    ///      the vault to transfer its own OkuM out. Keeps the defensive branch covered.
    function test_Unwrap_RevertsOnInsufficientReserves() public {
        _mintUsdOku(user1, 100e18);

        // Move 10 OkuM out of the vault from the vault's own account, breaking the
        // 1:1 backing that no production path can break.
        vm.prank(address(okuDollar));
        okuMoney.transfer(treasury, 10e18);

        vm.prank(user1);
        vm.expectRevert(OkuDollarErrors.InsufficientReserves.selector);
        okuDollar.unwrap(100e18, user1);
    }

    // ============ ERC-4626 Surface Tests ============

    /// @notice Pins that a third-party `redeem` of an owner's exact balance at an elevated
    ///         multiplier succeeds and drains it: `_unwrap` burns from `owner` with a single
    ///         ceil computation, so no floor-vs-ceil gap can trigger `InsufficientBalance`.
    function test_Redeem_ThirdParty_ExactBalance_AtElevatedMultiplier_Succeeds() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3); // ~$1.33, forces ceil-vs-floor daylight

        // 1000 OkuM wrapped at m = 1.0, then the multiplier moved to ~1.333.
        // A usdOku BALANCE is shares priced at the current multiplier, so it
        // grew with it -- that is the rebasing property under test.
        uint256 ownerShares = okuDollar.balanceOf(user1);
        assertEq(
            ownerShares,
            (1000e18 * okuDollar.usdMultiplier()) / PRECISION,
            "balance is shares priced at the live multiplier"
        );

        vm.prank(user1);
        okuDollar.approve(user2, ownerShares);

        vm.prank(user2);
        uint256 assetsOut = okuDollar.redeem(ownerShares, user2, user1);

        assertEq(okuDollar.balanceOf(user1), 0, "owner balance must be fully drained");
        // The owner wrapped 1000 OkuM; a full exit returns them, less at most a
        // wei to the ceil-vs-floor asymmetry that favours the vault.
        assertApproxEqAbs(assetsOut, 1000e18, 1, "full redeem returns the wrapped OkuM");
        assertEq(okuMoney.balanceOf(user2), assetsOut);
    }

    function test_Withdraw_ThirdParty_EmitsTransferAndCorrectWithdrawOwner() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3);

        uint256 assets = okuMoney.balanceOf(address(okuDollar)) / 2;
        uint256 sharesQuote = okuDollar.previewWithdraw(assets);

        vm.prank(user1);
        okuDollar.approve(user2, sharesQuote);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), sharesQuote);

        vm.recordLogs();
        vm.prank(user2);
        uint256 sharesReturned = okuDollar.withdraw(assets, user2, user1);
        assertEq(sharesReturned, sharesQuote, "withdraw must return the shares burned");

        // Withdraw(sender, receiver, owner, assets, shares) — sender is the spender
        // (user2), NOT the owner whose shares were burned (user1).
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("Withdraw(address,address,address,uint256,uint256)"))
            {
                address loggedSender = address(uint160(uint256(logs[i].topics[1])));
                address loggedOwner = address(uint160(uint256(logs[i].topics[3])));
                assertEq(loggedSender, user2, "Withdraw.sender must be the spender");
                assertEq(loggedOwner, user1, "Withdraw.owner must be the share source");
                found = true;
            }
        }
        assertTrue(found, "Withdraw event must be emitted");
    }

    function test_MaxWithdraw_ReturnsAssetsNotShares() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        // At m = 2.0 the dollar balance and its OkuM equivalent differ ~2x.
        assertEq(
            okuDollar.maxWithdraw(user1),
            okuDollar.convertToAssets(okuDollar.balanceOf(user1)),
            "maxWithdraw must report assets, not shares"
        );
    }

    // ── EIP-4626 return-value contract ──────────────────────────────────────
    //
    // Pins the return value of all four entry points. Runs at a non-unit multiplier so
    // assets and shares diverge — at 1.0 the two coincide and a swap would be invisible.

    function test_Withdraw_ReturnsSharesNotAssets() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION * 2); // assets and shares differ ~2x

        uint256 assets = okuMoney.balanceOf(address(okuDollar)) / 2;
        uint256 expectedShares = okuDollar.previewWithdraw(assets);
        assertTrue(expectedShares != assets, "test is meaningless unless the two diverge");

        vm.prank(user1);
        uint256 returned = okuDollar.withdraw(assets, user1, user1);

        assertEq(returned, expectedShares, "withdraw must return SHARES burned (EIP-4626)");
        assertTrue(returned != assets, "withdraw must NOT return the assets it was given");
    }

    function test_Redeem_ReturnsAssetsNotShares() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 shares = okuDollar.balanceOf(user1) / 2;
        uint256 expectedAssets = okuDollar.previewRedeem(shares);
        assertTrue(expectedAssets != shares, "test is meaningless unless the two diverge");

        vm.prank(user1);
        uint256 returned = okuDollar.redeem(shares, user1, user1);

        assertEq(returned, expectedAssets, "redeem must return ASSETS delivered (EIP-4626)");
    }

    function test_Deposit_ReturnsSharesMinted() public {
        _setOkuMMultiplierAndRoll(PRECISION * 2);
        _mintOkuMoney(user1, 1000e18);

        uint256 assets = 100e18;
        uint256 expectedShares = okuDollar.previewDeposit(assets);
        assertTrue(expectedShares != assets, "test is meaningless unless the two diverge");

        vm.startPrank(user1);
        okuMoney.approve(address(okuDollar), assets);
        uint256 returned = okuDollar.deposit(assets, user1);
        vm.stopPrank();

        assertEq(returned, expectedShares, "deposit must return SHARES minted (EIP-4626)");
    }

    function test_Mint_ReturnsAssetsConsumed() public {
        _setOkuMMultiplierAndRoll(PRECISION * 2);
        _mintOkuMoney(user1, 1000e18);

        uint256 shares = 100e18;
        uint256 expectedAssets = okuDollar.previewMint(shares);
        assertTrue(expectedAssets != shares, "test is meaningless unless the two diverge");

        vm.startPrank(user1);
        okuMoney.approve(address(okuDollar), expectedAssets);
        uint256 returned = okuDollar.mint(shares, user1);
        vm.stopPrank();

        assertEq(returned, expectedAssets, "mint must return ASSETS consumed (EIP-4626)");
    }

    function test_MaxDeposit_ZeroWhenPaused() public {
        assertEq(okuDollar.maxDeposit(user1), type(uint256).max);

        vm.prank(vaultPauser);
        okuDollar.pause();

        assertEq(okuDollar.maxDeposit(user1), 0);
        assertEq(okuDollar.maxMint(user1), 0);
    }

    /// @notice OkuMoney's pause blocks the OkuM transfer leg of wrap/unwrap, so the
    ///         ERC-4626 limits must report zero even with the vault itself unpaused.
    function test_MaxLimits_ZeroWhenOkuMoneyPaused() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(50e18, user1, 0);

        vm.prank(pauser);
        okuMoney.pause();
        assertFalse(okuDollar.paused());

        assertEq(okuDollar.maxDeposit(user1), 0);
        assertEq(okuDollar.maxMint(user1), 0);
        assertEq(okuDollar.maxWithdraw(user1), 0);
        assertEq(okuDollar.maxRedeem(user1), 0);

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuDollar.wrap(1e18, user1, 0);
    }

    function test_MaxDeposit_ZeroWhenReceiverBlacklisted() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        assertEq(okuDollar.maxDeposit(user1), 0);
        assertEq(okuDollar.maxMint(user1), 0);
    }

    function test_Deposit_MintRoundTrip() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        vm.prank(user1);
        uint256 shares = okuDollar.deposit(100e18, user1);

        assertEq(shares, okuDollar.balanceOf(user1));
    }

    /// @notice The ERC-4626 `mint(shares, receiver)` entry point — distinct from
    ///         `deposit`: caller specifies
    ///         the desired SHARE output, and `mint` derives the asset input via
    ///         `previewMint` (ceil-rounded) before routing through `wrap`.
    function test_Mint_SharesEntryPoint() public {
        _mintOkuMoney(user1, 1000e18);
        _approveOkuMoney(user1, address(okuDollar), 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3); // non-trivial multiplier

        uint256 desiredShares = 500e18;
        uint256 expectedAssets = okuDollar.previewMint(desiredShares);

        vm.prank(user1);
        uint256 assetsSpent = okuDollar.mint(desiredShares, user1);

        assertEq(assetsSpent, expectedAssets, "mint must spend exactly previewMint's quote");
        // `balanceOf` is DOLLAR-denominated (not raw OkuM), so minting
        // `desiredShares` dollars of UsdOku must produce (up to the ceil
        // rounding baked into previewMint's asset quote) exactly
        // `desiredShares` in the receiver's balance — NOT `assetsSpent`,
        // which is the raw OkuM amount, a different unit at this multiplier.
        assertEq(okuDollar.balanceOf(user1), desiredShares);
    }

    /// @notice totalAssets() reports the vault's OkuM reserves, matching
    ///         totalOkuMReserves() exactly — the two must never diverge since
    ///         totalAssets is defined as a thin alias.
    function test_TotalAssets_MatchesOkuMReserves() public {
        _mintUsdOku(user1, 1000e18);
        assertEq(okuDollar.totalAssets(), okuDollar.totalOkuMReserves());
        assertGt(
            okuDollar.totalAssets(), 0, "must be non-trivial for this assertion to be meaningful"
        );
    }

    /// @notice convertToShares / convertToAssets are inverses at the base
    ///         multiplier (single-multiplier design: 1:1), and convertToShares
    ///         rounds DOWN per spec.
    function test_ConvertToShares_ConvertToAssets_Inverse() public view {
        uint256 assets = 12_345e17;
        uint256 shares = okuDollar.convertToShares(assets);
        assertEq(shares, assets, "at base multiplier (1e18), conversion is the identity");
        assertEq(okuDollar.convertToAssets(shares), assets);
    }

    /// @notice At a non-trivial multiplier, convertToShares rounds down and
    ///         previewMint (its up-rounding counterpart for the mint path)
    ///         never returns LESS than the floor-rounded equivalent.
    function test_ConvertToShares_RoundsDown_AtElevatedMultiplier() public {
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3);
        uint256 assets = 1000e18 + 1; // deliberately non-round to expose rounding
        uint256 shares = okuDollar.convertToShares(assets);
        uint256 mult = okuDollar.usdMultiplier();
        // Manual floor computation must match exactly.
        assertEq(shares, Math.mulDiv(assets, mult, PRECISION, Math.Rounding.Floor));
    }

    /// @notice previewDeposit is a pure alias for convertToShares (spec
    ///         requires them to agree when no fees are charged, as here).
    function test_PreviewDeposit_MatchesConvertToShares() public {
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3);
        uint256 assets = 777e18;
        assertEq(okuDollar.previewDeposit(assets), okuDollar.convertToShares(assets));
    }

    /// @notice previewRedeem is a pure alias for convertToAssets.
    function test_PreviewRedeem_MatchesConvertToAssets() public {
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3);
        uint256 shares = 777e18;
        assertEq(okuDollar.previewRedeem(shares), okuDollar.convertToAssets(shares));
    }

    /// @notice previewMint rounds UP — the caller must never be quoted less
    ///         than the true asset cost of minting `shares`.
    function test_PreviewMint_RoundsUp() public {
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3);
        uint256 shares = 1000e18 + 1; // non-round, to expose rounding direction
        uint256 mult = okuDollar.usdMultiplier();
        uint256 expectedCeil = Math.mulDiv(shares, PRECISION, mult, Math.Rounding.Ceil);
        assertEq(okuDollar.previewMint(shares), expectedCeil);
    }

    /// @notice maxRedeem(owner) returns the owner's raw UsdOku balance
    ///         (shares), NOT the OkuM asset equivalent — mirroring
    ///         maxWithdraw's asset-vs-shares distinction from the other side.
    function test_MaxRedeem_ReturnsSharesNotAssets() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        assertEq(okuDollar.maxRedeem(user1), okuDollar.balanceOf(user1));
    }

    function test_SupportsInterface_ERC8056() public view {
        // OkuDollar itself does not implement ERC-8056 (OkuMoney does); this pins
        // the ERC-165 surface OkuDollar DOES advertise so a future accidental
        // removal is caught.
        assertTrue(okuDollar.supportsInterface(type(IERC165).interfaceId));
    }

    // ============ Price-Aware Wrap/Unwrap Behavior Tests ============

    function test_PriceAware_OneNoteWrapsToOneOkuDollar_AtBasePrice() public {
        // At okuMMultiplier=1e18 (initial), 1 note = 1 OkuDollar
        uint256 okuMAmount = 1e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(usdMinted, 1e18, "1 note at $1.00 should produce exactly 1 OkuDollar");
        assertEq(okuDollar.balanceOf(user1), 1e18);
    }

    function test_PriceAware_AfterNotePriceIncrease_MoreOkuDollarMinted() public {
        // okuMMultiplier increases to 2x — each note token is worth $2.00
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // 100 note tokens × $2.00/token / $1.00 usdMultiplier = 200 OkuDollar
        assertEq(usdMinted, 200e18, "100 notes at $2.00 should produce 200 OkuDollar");
    }

    function test_PriceAware_NotePriceDoesNotChangeVaultBalance() public {
        // Wrap 100 notes at okuMMultiplier=1e18
        _mintUsdOku(user1, 100e18);

        uint256 vaultBalBefore = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultBalBefore, 100e18);

        // Increase okuMMultiplier — vault token balance is unchanged (non-rebasing)
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        uint256 vaultBalAfter = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultBalAfter, vaultBalBefore, "Note rebase should not change vault token count");
    }

    // ============ Wrap/Unwrap Round Trip ============

    function test_WrapUnwrap_RoundTrip_MaxOneWeiLoss() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 balance = okuDollar.balanceOf(user1);
        uint256 notesBack = okuDollar.unwrap(balance, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, okuMAmount, "Round trip should not gain tokens");
    }

    function test_WrapUnwrap_RoundTrip_AfterNotePriceChange() public {
        // Wrap at okuMMultiplier=1e18
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);
        // user1 has 100 OkuDollar (100 USD shares), vault has 100 notes

        // Increase okuMMultiplier to 1.5e18
        // Vault still has 100 note tokens, but each is worth $1.50 → $150 backing
        _setOkuMMultiplierAndRoll((PRECISION * 3) / 2);

        // Unwrap 100 OkuDollar: okuMReturned = 100e18 * 1e18 / 1.5e18 ≈ 66.67e18
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(100e18, user1);

        uint256 expected = Math.mulDiv(100e18, PRECISION, (PRECISION * 3) / 2, Math.Rounding.Floor);
        assertEq(notesBack, expected);
        // Fewer notes returned, but each note is worth more dollars
        assertLt(notesBack, 100e18, "Should return fewer notes at higher note price");
    }

    /// @notice Pins that unwrapping the full elevated balance returns exactly the OkuM
    ///         deposited: `okuMReturned` divides by the same multiplier `balanceOf` scaled by.
    function test_WrapUnwrap_RoundTrip_MatchedPriceAndMultiplier() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        _elevateUsdMultiplier((PRECISION * 104) / 100);
        vm.roll(block.number + 1); // Roll past yield lock

        // Vault still has exactly 100 OkuMoney tokens (no extra reserves added).
        uint256 vaultReserves = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultReserves, 100e18, "Vault should have 100 OkuMoney");

        // Unwrap full elevated balance — should return original deposited amount.
        uint256 usdBalance = okuDollar.balanceOf(user1);
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(usdBalance, user1);

        assertEq(notesBack, okuMAmount, "Round trip at matched rates should return original amount");
    }

    // ============ USD Multiplier Tests ============

    function test_UsdMultiplier_GrowsOverTime() public {
        // ~4.5% APY = 1e18 + ~1.393e9 per second
        uint256 rate = PRECISION + 1393e6;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 30 days);

        uint256 multBefore = okuDollar.usdMultiplier();

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        uint256 multAfter = okuDollar.usdMultiplier();
        assertGt(multAfter, multBefore, "Multiplier should grow over time");
    }

    function test_UsdMultiplier_AccruesContinuously() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 30 days);

        uint256 start = block.timestamp;

        // Warp 100 seconds
        vm.warp(start + 100);
        uint256 multAt100 = okuDollar.usdMultiplier();

        // The multiplier is a pure function of elapsed time, always deterministic
        assertGt(multAt100, PRECISION);
        assertEq(okuDollar.usdMultiplier(), multAt100);
    }

    function test_UsdMultiplier_AffectsBalances() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.balanceOf(user1), 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // _elevateUsdMultiplier may overshoot the target slightly; compute expected
        // balance from the achieved multiplier and the user's share count.
        uint256 expected = Math.mulDiv(
            okuDollar.usdSharesOf(user1), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.balanceOf(user1), expected);
        assertGe(okuDollar.balanceOf(user1), 200e18);
    }

    function test_UsdMultiplier_AffectsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalSupply(), 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        uint256 expected = Math.mulDiv(
            okuDollar.totalUsdShares(), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.totalSupply(), expected);
        assertGe(okuDollar.totalSupply(), 200e18);
    }

    // ============ Yield-rate delegation tests ============
    //
    // OkuDollar has no rate state. These tests drive `okuMoney.setOkuMYieldRate` /
    // `setNextOkuMYieldRate` and assert that `okuDollar.usdMultiplier()` tracks it.
    // Rate bounds and OKUM_RATE_MANAGER gating are tested in OkuMoney.t.sol.

    function test_UsdMultiplier_TracksOkuMYieldRate_SnapshotsMultiplier() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 30 days);

        vm.warp(block.timestamp + 1 days);

        uint256 multBefore = okuDollar.usdMultiplier();
        assertGt(multBefore, PRECISION);

        // Set a new rate -- should snapshot current multiplier
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION, 0); // zero yield

        uint256 baseAfter = okuMoney.okuMBaseMultiplier();
        assertEq(baseAfter, multBefore, "Base multiplier should be snapshotted");
    }

    function test_UsdMultiplier_TracksOkuMYieldRate_WithEndTimestamp() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        assertEq(okuMoney.okuMRateEnd(), endTime);
    }

    function test_UsdMultiplier_TracksOkuMYieldRate_ClearsPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(rateManager);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, endTime + 60 days);

        // Setting a new rate should clear pending
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 1000e6, block.timestamp + 90 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), PRECISION);
    }

    // ============ setNextOkuMYieldRate delegation tests ============

    function test_UsdMultiplier_TracksOkuMPendingYieldRate_SchedulesNextRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(rateManager);
        okuMoney.setNextOkuMYieldRate(nextRate, endTime + 60 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), nextRate);
    }

    function test_UsdMultiplier_TracksOkuMPendingYieldRate_HeadToTailTransition() public {
        uint256 rate1 = PRECISION + 1393e6;
        uint256 rate2 = PRECISION + 2000e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate1, endTime);

        vm.prank(rateManager);
        okuMoney.setNextOkuMYieldRate(rate2, endTime + 60 days);

        // Warp past end time -- pending rate should take over
        vm.warp(endTime + 1 days);

        uint256 mult = okuDollar.usdMultiplier();
        // Should be greater than what rate1 alone would have produced at endTime
        assertGt(mult, PRECISION, "Multiplier should have grown through both rate periods");
    }

    // ============ Reserve management ============
    //
    // Collateralization is exactly 1.0 by construction: `usdMultiplier()` IS
    // `okuMoney.okuMMultiplier()`, and shares are only minted/burned 1:1 against real OkuM.

    function test_TotalOkuMReserves_EqualsOkuMBalance() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalOkuMReserves(), okuMoney.balanceOf(address(okuDollar)));
    }

    function test_TotalUsdObligations_EqualsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalUsdObligations(), okuDollar.totalSupply());
    }

    /// @notice Collateralization is exactly 1.0, computed manually from
    ///         `totalOkuMReserves()` / `totalSupply()`.
    function test_Collateralization_IsExactlyOne() public {
        _mintUsdOku(user1, 100e18);

        uint256 reserves = okuDollar.totalOkuMReserves();
        uint256 mult = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = Math.mulDiv(reserves, mult, PRECISION, Math.Rounding.Floor);

        assertEq(reservesDollarValue, okuDollar.totalSupply(), "collateralization == 1.0");
        assertEq(okuDollar.totalUsdShares(), reserves, "shares track raw OkuM 1:1");
    }

    /// @notice A multiplier increase scales reserves' dollar value and obligations by the
    ///         same factor, so collateralization stays pinned at 1.0.
    function test_Collateralization_UnchangedByMultiplierIncrease() public {
        _mintUsdOku(user1, 100e18);

        _elevateUsdMultiplier((PRECISION * 3) / 2);

        uint256 reserves = okuDollar.totalOkuMReserves();
        uint256 mult = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = Math.mulDiv(reserves, mult, PRECISION, Math.Rounding.Floor);

        assertEq(reservesDollarValue, okuDollar.totalSupply(), "still exactly 1.0");
    }

    // ============ rescueDonation Tests ============

    function test_RescueDonation_OnlyVaultRescuer() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_RESCUER
            )
        );
        okuDollar.rescueDonation(1e18, user1);
    }

    function test_RescueDonation_RevertsWhenNoDonation() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultRescuer);
        vm.expectRevert(OkuDollarErrors.NoDonationAvailable.selector);
        okuDollar.rescueDonation(1, treasury);
    }

    function test_RescueDonation_RecoversDonatedOkuM() public {
        _mintUsdOku(user1, 100e18);
        uint256 backing = okuDollar.totalUsdShares();

        // Donate 50 OkuM straight into the vault — accrues to nobody.
        _mintOkuMoney(user2, 50e18);
        vm.prank(user2);
        okuMoney.transfer(address(okuDollar), 50e18);

        // Cannot exceed the donation.
        vm.prank(vaultRescuer);
        vm.expectRevert(OkuDollarErrors.NoDonationAvailable.selector);
        okuDollar.rescueDonation(50e18 + 1, treasury);

        vm.prank(vaultRescuer);
        okuDollar.rescueDonation(50e18, treasury);

        assertEq(okuMoney.balanceOf(treasury), 50e18);
        assertEq(okuDollar.totalOkuMReserves(), backing, "share backing untouched");
    }

    function test_RescueDonation_RevertsOnZeroAmount() public {
        vm.prank(vaultRescuer);
        vm.expectRevert(SharedErrors.ZeroAmount.selector);
        okuDollar.rescueDonation(0, treasury);
    }

    function test_RescueDonation_RevertsOnZeroReceiver() public {
        _mintOkuMoney(user2, 50e18);
        vm.prank(user2);
        okuMoney.transfer(address(okuDollar), 50e18);

        vm.prank(vaultRescuer);
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        okuDollar.rescueDonation(1e18, address(0));
    }

    // ============ Pause Tests ============

    function test_Pause_BlocksTransfer() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Pause_BlocksWrap() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // Pause is a full freeze: wrap is blocked
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuDollar.wrap(okuMAmount, user1, 0);
    }

    function test_Pause_BlocksUnwrap() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        // Pause is a full freeze: unwrap is blocked
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuDollar.unwrap(100e18, user1);
    }

    function test_Pause_OnlyVaultPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_PAUSER
            )
        );
        okuDollar.pause();

        // Note pauser cannot pause OkuDollar vault
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, VAULT_PAUSER
            )
        );
        okuDollar.pause();
    }

    function test_Unpause_OnlyVaultUnpauser() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        // user1 cannot unpause
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_UNPAUSER
            )
        );
        okuDollar.unpause();

        // Separate roles: pauser cannot unpause
        vm.prank(vaultPauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                vaultPauser,
                VAULT_UNPAUSER
            )
        );
        okuDollar.unpause();

        // Vault unpauser can unpause
        vm.prank(vaultUnpauser);
        okuDollar.unpause();
    }

    function test_Pause_TransfersResumeAfterUnpause() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(vaultUnpauser);
        okuDollar.unpause();

        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);

        assertEq(okuDollar.balanceOf(user2), 50e18);
    }

    // ============ ERC-20 Compliance Tests ============

    function test_Transfer_MovesSharesInternally() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.transfer(user2, 40e18);

        assertEq(okuDollar.balanceOf(user1), 60e18);
        assertEq(okuDollar.balanceOf(user2), 40e18);
    }

    function test_Transfer_EmitsTokenAmounts() public {
        _mintUsdOku(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 40e18);

        vm.prank(user1);
        okuDollar.transfer(user2, 40e18);
    }

    function test_TransferFrom_WithApproval() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(user2);
        okuDollar.transferFrom(user1, user2, 50e18);

        assertEq(okuDollar.balanceOf(user2), 50e18);
        assertEq(okuDollar.balanceOf(user1), 50e18);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, user2, 0, 50e18
            )
        );
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.InsufficientBalance.selector);
        okuDollar.transfer(user2, 101e18);
    }

    function test_Approve_SetsAllowance() public {
        vm.prank(user1);
        okuDollar.approve(user2, 100e18);

        assertEq(okuDollar.allowance(user1, user2), 100e18);
    }

    function test_TotalSupply_ReflectsAllShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        assertEq(okuDollar.totalSupply(), 300e18);
    }

    function test_Transfer_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // Transfer half of user1's balance.
        uint256 user1Before = okuDollar.balanceOf(user1);
        uint256 transferAmt = user1Before / 2;
        vm.prank(user1);
        okuDollar.transfer(user2, transferAmt);

        // Both sides should hold ~half of the original balance (shares-based; rounding
        // can shift 1 wei).
        assertApproxEqAbs(okuDollar.balanceOf(user1), user1Before - transferAmt, 1);
        assertApproxEqAbs(okuDollar.balanceOf(user2), transferAmt, 1);
    }

    /// @notice `amount = 1` (dollar-wei) floors to `floor(1 * 1e18 / m) = 0` shares at
    ///         any `m > 1e18`, which `_elevateUsdMultiplier` guarantees. The guard
    ///         reverts rather than moving nothing while emitting `Transfer` and
    ///         returning `true` — see Accepted Risk #4.
    function test_Transfer_RevertsOnDustAmountBelowOneShare() public {
        _mintUsdOku(user1, 100e18);
        _elevateUsdMultiplier(PRECISION * 2);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        okuDollar.transfer(user2, 1);
    }

    /// @notice Same dust floor as `transfer` above, but via `transferFrom` — so no
    ///         allowance is debited for a transfer that would move zero shares.
    function test_TransferFrom_RevertsOnDustAmountBelowOneShare() public {
        _mintUsdOku(user1, 100e18);
        _elevateUsdMultiplier(PRECISION * 2);

        vm.prank(user1);
        okuDollar.approve(user2, 1);

        vm.prank(user2);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        okuDollar.transferFrom(user1, user2, 1);
    }

    /// @notice Boundary check for the guard above: the smallest `amount` that floors
    ///         to exactly 1 share (nonzero) must succeed — confirms the gate is
    ///         `shares == 0`, not merely "amount small". `_elevateUsdMultiplier` can
    ///         overshoot its target (it compounds in discrete `MAX_RATE` windows), so
    ///         the threshold is computed from the achieved multiplier rather than
    ///         assumed to be exactly `PRECISION * 2`.
    function test_Transfer_ExactlyOneShareSucceeds() public {
        _mintUsdOku(user1, 100e18);
        _elevateUsdMultiplier(PRECISION * 2);

        uint256 m = okuDollar.usdMultiplier();
        // Smallest `amount` with `floor(amount * PRECISION / m) >= 1`, i.e.
        // `amount >= ceil(m / PRECISION)`.
        uint256 amount = Math.mulDiv(m, 1, PRECISION, Math.Rounding.Ceil);
        assertEq(
            Math.mulDiv(amount, PRECISION, m, Math.Rounding.Floor),
            1,
            "fixture: amount must floor to exactly 1 share"
        );

        uint256 user1SharesBefore = okuDollar.usdSharesOf(user1);
        uint256 user2SharesBefore = okuDollar.usdSharesOf(user2);

        vm.prank(user1);
        okuDollar.transfer(user2, amount);

        assertEq(okuDollar.usdSharesOf(user1), user1SharesBefore - 1);
        assertEq(okuDollar.usdSharesOf(user2), user2SharesBefore + 1);
    }

    /// @notice `amount == 0` is the genuine EIP-20-required no-op and must NOT trip
    ///         the dust-floor guard (which only fires on `amount != 0 && shares == 0`).
    function test_Transfer_ZeroAmountIsNoOpNotRevert() public {
        _mintUsdOku(user1, 100e18);
        _elevateUsdMultiplier(PRECISION * 2);

        vm.prank(user1);
        assertTrue(okuDollar.transfer(user2, 0));
    }

    function test_BalanceOf_ReflectsMultiplier() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.balanceOf(user1), 100e18);
        assertEq(okuDollar.usdSharesOf(user1), 100e18);

        // Multiplier elevated -> balanceOf grows, shares unchanged.
        _elevateUsdMultiplier(PRECISION * 2);

        uint256 expected = Math.mulDiv(
            okuDollar.usdSharesOf(user1), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.balanceOf(user1), expected);
        assertGe(okuDollar.balanceOf(user1), 200e18);
        assertEq(okuDollar.usdSharesOf(user1), 100e18);
    }

    // ============ Role Enforcement Tests ============

    function test_RoleEnforcement_NonPauserCannotPause() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_PAUSER
            )
        );
        okuDollar.pause();
    }

    // ============ Repeated Wrap/Unwrap (rUSDY H-01 Mitigation) ============

    function test_RepeatedWrapUnwrap_NoShareInflation() public {
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        // Must not gain tokens (no free share accumulation)
        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        // Max 1 wei loss per cycle
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_ElevatedPrice() public {
        uint256 elevatedPrice = 15e17; // 1.5e18

        _setOkuMMultiplierAndRoll(elevatedPrice);

        // Create some existing vault state at elevated price
        _mintOkuMoney(user2, 5000e18);
        _approveOkuMoney(user2, address(okuDollar), 5000e18);
        vm.prank(user2);
        okuDollar.wrap(5000e18, user2, 0);

        // Now user1 does repeated wrap/unwrap at elevated okuMMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_AfterNotePriceChange() public {
        // Create some existing vault state
        _mintUsdOku(user2, 5000e18);

        // Bump okuMMultiplier to 1.5e18
        _setOkuMMultiplierAndRoll((PRECISION * 3) / 2);

        // Now user1 does repeated wrap/unwrap at non-1.0 okuMMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    // ============ Rate Expiry Tests ============

    function test_RateExpiry_StopsYieldWhenNoPending() public {
        uint256 rate = PRECISION + 1393e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, endTime);

        // Warp to 1 second before end
        vm.warp(endTime - 1);
        uint256 multBeforeEnd = okuDollar.usdMultiplier();

        // Warp 100 days past end -- no pending rate, so yield should stop
        vm.warp(endTime + 100 days);
        uint256 multLongAfterEnd = okuDollar.usdMultiplier();

        // The multiplier should only accrue 1 more second of yield (from endTime-1 to endTime)
        // After that, no growth (pending rate is PRECISION = no yield)
        assertGt(multLongAfterEnd, multBeforeEnd, "Should accrue the final second");
        // The difference should be tiny (1 second of a ~4.5% APY rate)
        assertApproxEqRel(multLongAfterEnd, multBeforeEnd, 1e14); // within 0.01%
    }

    function test_RateExpiry_PendingRateTakesOver() public {
        uint256 rate1 = PRECISION + 1393e6; // ~4.5% APY
        uint256 rate2 = PRECISION + 634e6; // ~2% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate1, endTime);

        // The successor's own window is [endTime, pendingEnd] and is subject to
        // MAX_RATE_WINDOW (90 days).
        vm.prank(rateManager);
        okuMoney.setNextOkuMYieldRate(rate2, endTime + MAX_RATE_WINDOW);

        // Snapshot at the handover instant so the successor's contribution can
        // be isolated, rather than inferred from a total-magnitude threshold.
        vm.warp(endTime);
        uint256 multAtHandover = okuDollar.usdMultiplier();
        assertGt(multAtHandover, PRECISION, "rate1 must have accrued over its 30-day window");

        // Run the successor to its own expiry.
        vm.warp(endTime + MAX_RATE_WINDOW);
        uint256 multAfterSuccessor = okuDollar.usdMultiplier();
        assertGt(
            multAfterSuccessor,
            multAtHandover,
            "pending rate must take over and keep accruing past the active window's end"
        );

        // ...and then stop: with no further successor armed, accrual halts at
        // pendingRateEnd rather than compounding forever.
        vm.warp(endTime + MAX_RATE_WINDOW + 365 days);
        assertEq(
            okuDollar.usdMultiplier(),
            multAfterSuccessor,
            "accrual must halt at pendingRateEnd when no further successor is armed"
        );
    }

    // ============ APY Accuracy Tests ============

    function test_APYAccuracy_FourPointFivePercent() public {
        // ~4.5% APY compounding per second
        // rate = e^(ln(1.045) / 31536000) * 1e18 ~= 1000000001395766281
        uint256 rate = 1_000_000_001_395_766_281;

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + MAX_RATE_WINDOW);

        uint256 startMult = okuDollar.usdMultiplier();

        // A window may not exceed MAX_RATE_WINDOW (90 days), so a 1-year
        // horizon is walked as chained re-anchors — see `_accrueAtCurrentRate`.
        _accrueAtCurrentRate(365 days);

        uint256 endMult = okuDollar.usdMultiplier();
        uint256 expectedMult = 1045e15; // 1.045e18

        // Within 0.1% tolerance
        assertApproxEqRel(endMult, expectedMult, 1e15);
        assertGt(endMult, startMult);
    }

    // ============ Single Multiplier Delegation Tests ============

    /// @notice `usdMultiplier()` equals `okuMoney.okuMMultiplier()` across both a discrete
    ///         override and a streaming rate.
    function test_UsdMultiplier_AlwaysEqualsOkuMMultiplier() public {
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 1045 / 1000); // discrete override
        assertEq(okuDollar.usdMultiplier(), okuMoney.okuMMultiplier());

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 634e6, block.timestamp + MAX_RATE_WINDOW); // streaming rate
        _accrueAtCurrentRate(365 days);

        assertEq(
            okuDollar.usdMultiplier(),
            okuMoney.okuMMultiplier(),
            "usdMultiplier must always equal okuMMultiplier under the single-multiplier design"
        );
    }

    /// @notice ERC-8056's `toUIAmount` and ERC-4626's `convertToShares` are the SAME
    ///         function under two standards' names: both reduce to
    ///         `MathLib.okuMToDollars(x, okuMMultiplier())`. Pins the two public surfaces
    ///         against each other so neither can read the multiplier via a divergent path.
    function test_ToUIAmount_EqualsConvertToShares_AcrossMultiplierChanges() public {
        uint256 rawAmount = 12_345e18;

        // At initial multiplier (PRECISION, no yield yet).
        assertEq(
            okuMoney.toUIAmount(rawAmount),
            okuDollar.convertToShares(rawAmount),
            "must agree at PRECISION"
        );

        // After a discrete override.
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 1045 / 1000);
        assertEq(
            okuMoney.toUIAmount(rawAmount),
            okuDollar.convertToShares(rawAmount),
            "must agree after setOkuMMultiplier"
        );

        // After streaming accrual.
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 634e6, block.timestamp + MAX_RATE_WINDOW);
        _accrueAtCurrentRate(365 days);
        assertGt(okuMoney.okuMMultiplier(), PRECISION * 1045 / 1000, "sanity: multiplier advanced");
        assertEq(
            okuMoney.toUIAmount(rawAmount),
            okuDollar.convertToShares(rawAmount),
            "must agree after streaming accrual"
        );

        // The inverse direction too: ERC-8056 has no fromUIAmount-equivalent on the
        // 4626 side other than convertToAssets, but fromUIAmount IS convertToAssets
        // under the same construction — pin that too.
        assertEq(
            okuMoney.fromUIAmount(rawAmount),
            okuDollar.convertToAssets(rawAmount),
            "fromUIAmount must equal convertToAssets after streaming accrual"
        );
    }

    // ============ Continuous Yield + Balance/Supply Tests ============

    function test_ContinuousYield_BalanceGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 60 days);

        uint256 balBefore = okuDollar.balanceOf(user1);

        vm.warp(block.timestamp + 30 days);

        uint256 balAfter = okuDollar.balanceOf(user1);
        assertGt(balAfter, balBefore, "Balance must grow via continuous yield");
    }

    function test_ContinuousYield_TotalSupplyGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 60 days);

        uint256 supplyBefore = okuDollar.totalSupply();

        vm.warp(block.timestamp + 30 days);

        uint256 supplyAfter = okuDollar.totalSupply();
        assertGt(supplyAfter, supplyBefore, "Total supply must grow via continuous yield");
    }

    // ============ TransferFrom Share-Based with Multiplier ============

    function test_TransferFrom_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // Transfer half of user1's elevated balance.
        uint256 transferAmt = okuDollar.balanceOf(user1) / 2;
        vm.prank(user1);
        okuDollar.approve(user2, transferAmt);

        vm.prank(user2);
        okuDollar.transferFrom(user1, user2, transferAmt);

        // Share movement should be `transferAmt * PRECISION / multiplier`; per-side
        // balances should approximate `transferAmt` (1 wei tolerance for share rounding).
        uint256 expectedShares =
            Math.mulDiv(transferAmt, PRECISION, okuDollar.usdMultiplier(), Math.Rounding.Floor);
        assertEq(okuDollar.usdSharesOf(user1), 100e18 - expectedShares);
        assertEq(okuDollar.usdSharesOf(user2), expectedShares);
        assertApproxEqAbs(okuDollar.balanceOf(user2), transferAmt, 1);
    }

    // ============ Multi-User Tests ============

    function test_MultiUser_IndependentAccounting() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        // Unwrap user1 should not affect user2
        vm.prank(user1);
        okuDollar.unwrap(100e18, user1);

        assertEq(okuDollar.balanceOf(user1), 0);
        assertEq(okuDollar.balanceOf(user2), 200e18);
    }

    function test_MultiUser_ProportionalYield() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // After elevation, balances should be in the same 1:3 ratio (shares unchanged).
        uint256 b1 = okuDollar.balanceOf(user1);
        uint256 b2 = okuDollar.balanceOf(user2);
        assertApproxEqAbs(b2, b1 * 3, 1);
        assertGe(b1, 200e18);
        assertGe(b2, 600e18);
    }

    function test_MultiUser_ProportionalShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        // user2 should have 3x the shares of user1
        assertEq(okuDollar.usdSharesOf(user2), okuDollar.usdSharesOf(user1) * 3);
        assertEq(
            okuDollar.totalUsdShares(), okuDollar.usdSharesOf(user1) + okuDollar.usdSharesOf(user2)
        );
    }

    function test_MultiUser_YieldAccruesProportionally() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        uint256 rate = 1_000_000_001_395_766_281; // ~4.5% APY
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + MAX_RATE_WINDOW);

        _accrueAtCurrentRate(365 days);

        uint256 bal1 = okuDollar.balanceOf(user1);
        uint256 bal2 = okuDollar.balanceOf(user2);

        // Both accrue ~4.5%
        assertApproxEqRel(bal1, 104.5e18, 1e15); // within 0.1%
        assertApproxEqRel(bal2, 313.5e18, 1e15);

        // Proportions preserved (1:3 ratio)
        assertApproxEqRel(bal2, bal1 * 3, 1e15);
    }

    function test_MultiUser_WrapUnwrapDoesNotAffectOthers() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 user2BalBefore = okuDollar.balanceOf(user2);
        uint256 user2SharesBefore = okuDollar.usdSharesOf(user2);

        // User1 unwraps half
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);

        // User2's balance and shares should be unchanged
        assertEq(okuDollar.balanceOf(user2), user2BalBefore);
        assertEq(okuDollar.usdSharesOf(user2), user2SharesBefore);

        // User3 wraps new notes
        _mintUsdOku(user3, 500e18);

        // User2 still unchanged
        assertEq(okuDollar.balanceOf(user2), user2BalBefore);
        assertEq(okuDollar.usdSharesOf(user2), user2SharesBefore);
    }

    // ============ Fuzz Round-Trip Tests ============

    function testFuzz_WrapUnwrap_RoundTrip(uint256 mult) public {
        // `setOkuMMultiplier` requires strict increase, so bound starts above PRECISION.
        mult = bound(mult, PRECISION + 1, 5e18);

        _setOkuMMultiplierAndRoll(mult);

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // Wrap
        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        // Unwrap full balance
        uint256 bal = okuDollar.balanceOf(user1);
        vm.prank(user1);
        okuDollar.unwrap(bal, user1);

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // Price-aware wrap/unwrap has multiple division steps, each losing up to 1 wei
        uint256 maxLoss = Math.mulDiv(5, mult, PRECISION, Math.Rounding.Ceil) + 5;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    function testFuzz_WrapUnwrap_RoundTrip_WithNotePrice(uint256 price) public {
        // Strict increase required by setOkuMMultiplier.
        price = bound(price, PRECISION + 1, 3e18);

        _setOkuMMultiplierAndRoll(price);

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 bal = okuDollar.balanceOf(user1);
        okuDollar.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // At any okuMMultiplier, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by price/PRECISION * multiplier rounding chain
        assertApproxEqAbs(finalNotes, okuMAmount, 5, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_Wrap_RevertsInOverrideBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // Distribute yield to set lastOverrideBlock
        _stampYieldLockBlock();

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuDollar.wrap(50e18, user1, 0);
    }

    function test_Wrap_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // Distribute yield
        _stampYieldLockBlock();

        // Roll to next block
        vm.roll(block.number + 1);

        // Now wrap should succeed
        vm.prank(user1);
        okuDollar.wrap(50e18, user1, 0);

        // 50 OkuM at the live multiplier.
        assertEq(
            okuDollar.balanceOf(user1),
            (50e18 * okuDollar.usdMultiplier()) / PRECISION,
            "wrap credits the exact dollar value"
        );
    }

    function test_Unwrap_RevertsInOverrideBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield to set lastOverrideBlock
        _stampYieldLockBlock();

        // Same block — unwrap should revert
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuDollar.unwrap(50e18, user1);
    }

    function test_Unwrap_SucceedsInNextBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        _stampYieldLockBlock();

        // Roll to next block
        vm.roll(block.number + 1);

        // Now unwrap should succeed
        uint256 okuMBefore = okuMoney.balanceOf(user1);
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);

        assertGt(okuMoney.balanceOf(user1), okuMBefore);
    }

    function test_SetOkuMPrice_AlsoBlocksWrapUnwrap() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // setOkuMMultiplier also sets lastOverrideBlock
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuDollar.wrap(50e18, user1, 0);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastOverrideBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastOverrideBlock(), 0);

        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        assertGt(okuDollar.balanceOf(user1), 0);
    }

    function test_YieldLock_TransfersStillWorkDuringLock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        _stampYieldLockBlock();

        // Same block — transfers should still work (only wrap/unwrap are blocked)
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);

        assertGt(okuDollar.balanceOf(user2), 0);
    }

    // ============ Zero-supply rate change ============

    /// @notice Setting the rate when totalUsdShares == 0 should succeed. The multiplier
    ///         has no supply term, so it accrues regardless and any later `wrap()`
    ///         prices in at the accrued value.
    function test_UsdMultiplier_TracksOkuMYieldRate_WorksWithZeroSupply() public {
        assertEq(okuDollar.totalSupply(), 0);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(MAX_RATE, block.timestamp + 30 days);
        assertGt(okuMoney.okuMRatePerSecond(), PRECISION);
    }

    /// @notice Verify that a non-zero rate accrues correctly after supply is added.
    function test_UsdMultiplier_TracksOkuMYieldRate_AccruesAfterSubsequentWrap() public {
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(MAX_RATE, block.timestamp + 30 days);
        vm.warp(block.timestamp + 1 days);

        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(100e18, user1, 0);

        // Rate accrued before wrap — usdMultiplier > 1e18
        assertGt(okuDollar.usdMultiplier(), PRECISION);
        // Dollar-adjusted balance > raw wrap amount
        assertGt(okuDollar.balanceOf(user1), 0);
        assertEq(usdMinted, okuDollar.balanceOf(user1));
    }

    // ============ Reinitialization guard ============

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        okuDollar.initialize(address(okuMoney), "OkuDollar", "usdOku", admin);
    }

    // ============ UUPS upgrade authorization ============

    function test_UUPS_Upgrade_RevertsForNonUpgrader() public {
        OkuDollar newImpl = new OkuDollar();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_UPGRADER
            )
        );
        vm.prank(user1);
        okuDollar.upgradeToAndCall(address(newImpl), "");
    }

    function test_UUPS_Upgrade_SucceedsForUpgrader() public {
        OkuDollar newImpl = new OkuDollar();
        vm.prank(admin);
        okuDollar.upgradeToAndCall(address(newImpl), "");
        // State preserved through upgrade
        assertEq(address(okuDollar.okuMoney()), address(okuMoney));
    }

    // ============ Blacklist ============

    function test_Blacklist_BlocksWrapSender() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);
    }

    function test_Blacklist_BlocksWrapReceiver() public {
        _mintOkuMoney(user2, 100e18);
        _approveOkuMoney(user2, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1); // blacklist receiver, not sender

        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        vm.prank(user2);
        okuDollar.wrap(100e18, user1, 0); // receiver is blacklisted
    }

    function test_Blacklist_BlocksUnwrapSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);
    }

    function test_Blacklist_BlocksTransferSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransferReceiver() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_PermitBlocksBlacklistedOwner() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        // Permit with blacklisted owner should revert
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    function test_Blacklist_UnblacklistRestoresAccess() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);

        // Should work again after unblacklist
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
        assertGt(okuDollar.balanceOf(user2), 0);
    }

    function test_Blacklist_IsBlacklistedView() public {
        assertFalse(okuDollar.isBlacklisted(user1));
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        assertTrue(okuDollar.isBlacklisted(user1));
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);
        assertFalse(okuDollar.isBlacklisted(user1));
    }

    // ---- OkuMoney's blacklist applies to OkuDollar too ----

    function _blacklistOnOkuMoneyOnly(address account) internal {
        vm.prank(blacklister);
        okuMoney.blacklist(account);
        assertFalse(_ownListContains(account), "fixture: OkuDollar's own list untouched");
    }

    /// @dev OkuDollar's own mapping is only reachable through its `blacklist`, so probe it
    ///      by checking that un-blacklisting there reverts NotBlacklisted.
    function _ownListContains(address account) internal returns (bool) {
        vm.prank(unblacklister);
        try okuDollar.unblacklist(account) {
            return true;
        } catch {
            return false;
        }
    }

    function test_OkuMBlacklist_BlocksTransferBothWays() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 100e18);
        _blacklistOnOkuMoneyOnly(user1);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.transfer(user3, 10e18);

        vm.prank(user2);
        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        okuDollar.transfer(user1, 10e18);
    }

    function test_OkuMBlacklist_BlocksUnwrapToCleanAddress() public {
        _mintUsdOku(user1, 100e18);
        _blacklistOnOkuMoneyOnly(user1);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.unwrap(50e18, user3);
    }

    function test_OkuMBlacklist_BlocksWrapAndApprove() public {
        _mintOkuMoney(user2, 100e18);
        _approveOkuMoney(user2, address(okuDollar), 100e18);
        _blacklistOnOkuMoneyOnly(user1);

        vm.prank(user2);
        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        okuDollar.wrap(100e18, user1, 0);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.approve(user2, 1);
    }

    function test_OkuMBlacklist_ViewsAndLimitsReflectIt() public {
        _mintUsdOku(user1, 100e18);
        _blacklistOnOkuMoneyOnly(user1);

        assertTrue(okuDollar.isBlacklisted(user1));
        assertEq(okuDollar.maxDeposit(user1), 0);
        assertEq(okuDollar.maxWithdraw(user1), 0);
        assertEq(okuDollar.maxRedeem(user1), 0);
    }

    function test_OkuMBlacklist_UnblacklistOnOkuMoneyRestoresAccess() public {
        _mintUsdOku(user1, 100e18);
        _blacklistOnOkuMoneyOnly(user1);
        vm.prank(unblacklister);
        okuMoney.unblacklist(user1);

        assertFalse(okuDollar.isBlacklisted(user1));
        vm.prank(user1);
        okuDollar.transfer(user2, 10e18);
    }

    function test_Blacklist_RevertAlreadyBlacklisted() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        vm.expectRevert(SharedErrors.AlreadyBlacklisted.selector);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
    }

    function test_Blacklist_RevertNotBlacklisted() public {
        vm.expectRevert(SharedErrors.NotBlacklisted.selector);
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);
    }

    // ============ Permit Blacklist Spender Branch ============

    function test_Permit_RevertBlacklistedSpender() public {
        _mintUsdOku(user1, 100e18);
        // user1 is the (clean) owner; blacklist the spender (user2).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        // Permit signature is bogus — call must revert before signature check.
        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        okuDollar.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    /// @notice `approve` mirrors `permit`'s posture: a blacklisted spender cannot be approved.
    function test_Approve_RevertsOnBlacklistedSpender() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.RecipientBlacklisted.selector);
        okuDollar.approve(user2, 50e18);
    }

    /// @notice `approve` also blocks a blacklisted OWNER, matching Circle FiatToken's
    ///         `notBlacklisted(msg.sender)` on `approve`.
    function test_Approve_RevertsOnBlacklistedOwner() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.approve(user2, 50e18);
    }

    /// @notice Blacklisting a spender does not revoke an existing allowance (mirrors the
    ///         OkuMoney test of the same name); exercising it is blocked separately.
    function test_Approve_DoesNotRevokeExistingAllowanceOnBlacklist() public {
        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        assertEq(okuDollar.allowance(user1, user2), 50e18, "pre-existing allowance untouched");
    }

    // ============ Circle Parity: blacklisted spender cannot exercise a prior allowance ============

    /// @notice A blacklisted spender holding a pre-existing allowance must not be able
    ///         to move clean funds between clean addresses: `transferFrom` checks the
    ///         spender itself, not just `from`/`to` via `_transferUsdShares`.
    function test_TransferFrom_RevertsOnBlacklistedSpender_EvenWithPriorAllowance() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        assertEq(
            okuDollar.allowance(user1, user2),
            50e18,
            "precondition: allowance survives blacklisting"
        );

        vm.prank(user2);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.transferFrom(user1, user3, 50e18);
    }

    /// @notice Sanity check: a clean allowance-holder is unaffected by the spender check.
    function test_TransferFrom_SucceedsForCleanSpender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(user2);
        okuDollar.transferFrom(user1, user3, 50e18);

        assertEq(okuDollar.balanceOf(user3), 50e18);
    }

    /// @notice Same property on the ERC-4626 surface: `redeem()` called by a blacklisted
    ///         THIRD-PARTY spender (not the owner) against a pre-existing allowance.
    /// @dev Receiver is deliberately user3, NOT the spender (user2), so the revert must
    ///      come from the spender check (SenderBlacklisted) rather than `_unwrap`'s
    ///      receiver check (RecipientBlacklisted).
    function test_Redeem_RevertsOnBlacklistedSpender_EvenWithPriorAllowance() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user2);
        vm.expectRevert(SharedErrors.SenderBlacklisted.selector);
        okuDollar.redeem(50e18, user3, user1);
    }

    /// @notice Sanity check: the owner redeeming their OWN shares is unaffected —
    ///         the third-party-spender check only fires in the allowance branch.
    function test_Redeem_SucceedsForOwnerActingAsOwnSpender() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.redeem(50e18, user1, user1);

        assertGt(okuMoney.balanceOf(user1), 0, "owner-initiated redeem must still work");
    }

    /// @notice `maxWithdraw`/`maxRedeem` must report `0` for a blacklisted owner —
    ///         mirrors `maxDeposit`'s pause/blacklist gating, since that owner's
    ///         `withdraw`/`redeem` would unconditionally revert in `_unwrap`.
    function test_MaxWithdrawRedeem_ZeroForBlacklistedOwner() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        assertEq(okuDollar.maxWithdraw(user1), 0, "maxWithdraw must be 0 for blacklisted owner");
        assertEq(okuDollar.maxRedeem(user1), 0, "maxRedeem must be 0 for blacklisted owner");
    }

    /// @notice Sanity check: a clean owner's max views are unaffected by blacklist gating.
    function test_MaxWithdrawRedeem_NonZeroForCleanOwner() public {
        _mintUsdOku(user1, 100e18);

        assertGt(okuDollar.maxWithdraw(user1), 0);
        assertGt(okuDollar.maxRedeem(user1), 0);
    }

    // ============ Permit Positive-Path Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 ownerPk = user2Pk;
        address owner = vm.addr(ownerPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuDollar.nonces(owner);

        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                user1,
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        okuDollar.permit(owner, user1, amount, deadline, v, r, s);

        assertEq(okuDollar.allowance(owner, user1), amount);
        assertEq(okuDollar.nonces(owner), nonce + 1);
    }

    function test_Permit_AllowsTransferFrom() public {
        uint256 ownerPk = user2Pk;
        address owner = vm.addr(ownerPk);

        uint256 okuMAmount = 100e18;
        _mintUsdOku(owner, okuMAmount);
        uint256 ownerBalance = okuDollar.balanceOf(owner);
        assertTrue(ownerBalance > 0);

        // Sign permit for user1 to spend owner's OkuDollar
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                user1,
                ownerBalance,
                okuDollar.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        okuDollar.permit(owner, user1, ownerBalance, deadline, v, r, s);

        // user1 can now transferFrom
        vm.prank(user1);
        assertTrue(okuDollar.transferFrom(owner, user3, ownerBalance));

        assertEq(okuDollar.balanceOf(user3), ownerBalance);
        assertEq(okuDollar.balanceOf(owner), 0);
    }

    // ============ Internal Helpers ============

    function _getOkuDollarDomainSeparator() internal view returns (bytes32) {
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

    // ============ View Getter Tests ============

    /// @dev The accrual clock lives on OkuMoney; OkuDollar's multiplier delegates to it.
    function test_UsdMultiplier_DelegatesLastAccrualTime() public {
        // Calling setOkuMYieldRate stamps okuMLastAccrualTime = block.timestamp.
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION + 1e9, block.timestamp + 30 days);
        assertEq(okuMoney.okuMLastAccrualTime(), block.timestamp);
        assertEq(okuDollar.usdMultiplier(), okuMoney.okuMMultiplier());
    }

    // ============ Initialization rails ============

    function test_Initialize_RevertZeroOkuMoney() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData =
            abi.encodeCall(OkuDollar.initialize, (address(0), "OkuDollar", "usdOku", admin));
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroAdmin() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData = abi.encodeCall(
            OkuDollar.initialize, (address(okuMoney), "OkuDollar", "usdOku", address(0))
        );
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ Rescue / unwrap rails ============

    function test_RescueDonation_RevertNoDonation() public {
        vm.prank(vaultRescuer);
        vm.expectRevert(OkuDollarErrors.NoDonationAvailable.selector);
        okuDollar.rescueDonation(1e18, admin);
    }

    function test_Unwrap_RevertInsufficientBalance() public {
        vm.prank(user1);
        vm.expectRevert(SharedErrors.InsufficientBalance.selector);
        okuDollar.unwrap(1e18, user1);
    }

    function test_Unwrap_RevertZeroReceiver() public {
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        okuDollar.unwrap(1e18, address(0));
    }

    /// @notice A peer-to-peer transfer moves shares, not the inherited ERC-20 balance.
    /// @dev OkuDollar overrides `transfer` entirely (it never reaches `_update`), so this
    ///      pins that the override moves the exact amount and conserves the share total.
    function test_Transfer_MovesSharesNotInheritedBalance() public {
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        uint256 totalBefore = okuDollar.totalUsdShares();
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        uint256 half = okuDollar.balanceOf(user1) / 2;

        vm.prank(user1);
        okuDollar.transfer(user2, half);

        // At m == PRECISION a dollar is a share, so the split is exact.
        assertEq(okuDollar.usdMultiplier(), Constants.PRECISION, "fixture: unrebased");
        assertEq(okuDollar.usdSharesOf(user2), half, "receiver gets exactly the sent amount");
        assertEq(okuDollar.usdSharesOf(user1), sharesBefore - half, "sender debited exactly");
        assertEq(okuDollar.totalUsdShares(), totalBefore, "transfers conserve total shares");
    }

    /// @notice Streaming accrual SATURATES at MAX_MULTIPLIER; it must not wrap or revert.
    /// @dev The counterpart to `OkuMoney.setOkuMMultiplier`'s hard rejection of values
    ///      above MAX_MULTIPLIER. The asymmetry is deliberate: an operator typo should fail loudly, but mere
    ///      passage of time must never brick `balanceOf` -- every downstream read goes
    ///      through the multiplier, so a revert here would freeze the whole vault.
    function test_UsdMultiplier_SaturatesAtMaxMultiplier() public {
        _mintOkuMoney(user1, 1e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 1e18);
        vm.prank(user1);
        okuDollar.wrap(1e18, user1, 0);

        // At MAX_RATE the unbounded multiplier crosses MAX_MULTIPLIER after roughly
        // ln(1e6)/ln(1 + 1e-7) seconds (~4.4 years); 10 years lands well past it while
        // staying inside rpow's safe input region.
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(Constants.MAX_RATE, block.timestamp + MAX_RATE_WINDOW);
        _accrueAtCurrentRate(10 * 365 days);

        assertEq(
            okuDollar.usdMultiplier(),
            Constants.MAX_MULTIPLIER,
            "usdMultiplier must saturate exactly at MAX_MULTIPLIER"
        );

        // The follow-on that matters: downstream reads keep working at the cap.
        // One share at m == MAX_MULTIPLIER is worth exactly MAX_MULTIPLIER wei.
        assertEq(
            okuDollar.balanceOf(user1),
            Constants.MAX_MULTIPLIER,
            "balanceOf must price at the saturated multiplier, not revert"
        );
    }

    /// `transfer` passes `msg.sender` and `transferFrom` spends an allowance first, so
    /// neither can reach the zero-sender guard; drive it through a harness.
    function test_TransferUsdShares_RevertsOnZeroSender() public {
        OkuDollarHarness impl = new OkuDollarHarness();
        OkuDollarHarness h = OkuDollarHarness(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        impl.initialize, (address(okuMoney), "OkuDollar", "usdOku", admin)
                    )
                )
            )
        );
        vm.expectRevert(SharedErrors.ZeroAddress.selector);
        h.exposedTransferUsdShares(address(0), user1, 1, PRECISION);
    }
}
