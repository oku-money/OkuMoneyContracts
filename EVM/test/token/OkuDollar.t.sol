// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuDollarEvents} from "../../src/lib/events/OkuDollarEvents.sol";
import {YieldSandwichGuard} from "../../src/lib/YieldSandwichGuard.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @title OkuDollarTest
 * @notice Unit tests for OkuDollar rebasing stablecoin vault (NOT ERC-4626)
 * @dev OkuMoney is a non-rebasing ERC-20 with okuMMultiplier() for price tracking.
 *      Wrap/unwrap are multiplier-aware: they convert between note tokens and OkuDollar
 *      using okuMMultiplier() and usdMultiplier(). When okuMMultiplier = 1e18 (initial state),
 *      the math is identical to old 1:1 behavior.
 */
contract OkuDollarTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    // REMOVED (single-multiplier refactor): local mirrors of UsdYieldRateUpdated,
    // NextUsdYieldRateSet, MinCollateralRatioUpdated, ReservesDeposited and
    // SurplusWithdrawn — all deleted from OkuDollarEvents.

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuDollar.name(), "OkuDollar");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuDollar.symbol(), "usdOku");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuDollar.decimals(), 18);
    }

    function test_Initialize_SetsOkuMoneyReference() public view {
        assertEq(address(okuDollar.okuMoney()), address(okuMoney));
    }

    // REMOVED (single-multiplier refactor): test_Initialize_SetsMinCollateralRatio —
    // `initialize` no longer takes a min-ratio and `minCollateralRatio()` is gone.

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
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.wrap(0, user1, 0);
    }

    function test_Wrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAddress.selector);
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
        // because it drives the value via setUsdYieldRate + warp.
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

        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        assertGt(sharesBefore, 0);

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
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.unwrap(0, user1);
    }

    function test_Unwrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuDollar.unwrap(okuMAmount, address(0));
    }

    /// @dev Post-cycle-4 D2 fix: `unwrap` now mirrors `wrap`'s receiver check
    ///      so a user blacklisted only on OkuDollar cannot route OkuMoney to
    ///      a third-party recipient via `unwrap(amount, victimAddr)`. The
    ///      OkuMoney-side `_update` blacklist check is still independent;
    ///      this assertion closes the cross-token consistency hole.
    function test_Unwrap_RevertsOnBlacklistedReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Blacklist user2 only on OkuDollar (not on OkuMoney).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
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
    /// @dev Under the single-multiplier design this is UNREACHABLE through any public
    ///      path (shares track raw OkuM 1:1, and `rescueDonation` cannot dip into
    ///      backing). We therefore force the state with `vm.store`-free surgery: drain
    ///      the vault's OkuM by pranking the vault itself. The branch is defensive code
    ///      and this test exists solely to keep it covered.
    function test_Unwrap_RevertsOnInsufficientReserves() public {
        _mintUsdOku(user1, 100e18);

        // Move 10 OkuM out of the vault from the vault's own account, breaking the
        // 1:1 backing that no production path can break.
        vm.prank(address(okuDollar));
        okuMoney.transfer(treasury, 10e18);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.InsufficientReserves.selector);
        okuDollar.unwrap(100e18, user1);
    }

    // ============ ERC-4626 Surface Tests ============
    //
    // Regression coverage for the `_redeemShares` floor-vs-ceil mismatch: prior to
    // the fix, a third-party `withdraw`/`redeem` acting on an owner's exact balance
    // at an elevated `usdMultiplier` could revert with `InsufficientBalance` because
    // the internal-share move floored while `unwrap`'s burn ceiled. `_unwrap` now
    // burns directly from `owner` using a single ceil computation, so this must
    // succeed and leave a zero balance.

    function test_Redeem_ThirdParty_ExactBalance_AtElevatedMultiplier_Succeeds() public {
        _mintUsdOku(user1, 1000e18);
        _setOkuMMultiplierAndRoll(PRECISION + PRECISION / 3); // ~$1.33, forces ceil-vs-floor daylight

        uint256 ownerShares = okuDollar.balanceOf(user1);
        assertGt(ownerShares, 0);

        vm.prank(user1);
        okuDollar.approve(user2, ownerShares);

        vm.prank(user2);
        uint256 assetsOut = okuDollar.redeem(ownerShares, user2, user1);

        assertEq(okuDollar.balanceOf(user1), 0, "owner balance must be fully drained");
        assertGt(assetsOut, 0);
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
        okuDollar.withdraw(assets, user2, user1);

        // Withdraw(sender, receiver, owner, assets, shares) — sender is the spender
        // (user2), NOT the owner whose shares were burned (user1). Prior to the fix,
        // `Withdraw` always reported `msg.sender` as the owner.
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

        // Prior bug: maxWithdraw returned balanceOf(owner) (dollars/shares) instead
        // of the OkuM asset equivalent.
        assertEq(
            okuDollar.maxWithdraw(user1),
            okuDollar.convertToAssets(okuDollar.balanceOf(user1)),
            "maxWithdraw must report assets, not shares"
        );
    }

    function test_MaxDeposit_ZeroWhenPaused() public {
        assertEq(okuDollar.maxDeposit(user1), type(uint256).max);

        vm.prank(vaultPauser);
        okuDollar.pause();

        assertEq(okuDollar.maxDeposit(user1), 0);
        assertEq(okuDollar.maxMint(user1), 0);
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

    function test_SupportsInterface_ERC8056() public view {
        // OkuDollar itself does not implement ERC-8056 (OkuMoney does); this pins
        // the ERC-165 surface OkuDollar DOES advertise so a future accidental
        // removal is caught.
        assertTrue(okuDollar.supportsInterface(type(IERC165).interfaceId));
    }

    // ============ Price-Aware Wrap/Unwrap Behavior Tests ============

    function test_PriceAware_OneNoteWrapsToOneOkuDollar_AtBasePrice() public {
        // At okuMMultiplier=1e18 (initial), 1 note = 1 OkuDollar (identical to old 1:1 behavior)
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
        vm.prank(rebaser);
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

    // REMOVED (single-multiplier refactor): test_WrapUnwrap_RoundTrip_AfterUsdMultiplierChange.
    // Its premise was a pure USD-side rebase leaving okuMMultiplier at 1e18 —
    // impossible now that usdMultiplier() delegates to okuMMultiplier() exactly.
    // It had become a duplicate of test_WrapUnwrap_RoundTrip_AfterNotePriceChange
    // below (moving "the" multiplier via `_elevateUsdMultiplier` vs.
    // `_setOkuMMultiplierAndRoll` is now the same operation on the same storage).

    function test_WrapUnwrap_RoundTrip_AfterNotePriceChange() public {
        // Wrap at okuMMultiplier=1e18
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);
        // user1 has 100 OkuDollar (100 USD shares), vault has 100 notes

        // Increase okuMMultiplier to 1.5e18
        // Vault still has 100 note tokens, but each is worth $1.50 → $150 backing
        // Obligations: 100 OkuDollar → overcollateralized
        _setOkuMMultiplierAndRoll((PRECISION * 3) / 2);

        // Unwrap 100 OkuDollar: okuMReturned = 100e18 * 1e18 / 1.5e18 ≈ 66.67e18
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(100e18, user1);

        uint256 expected = Math.mulDiv(100e18, PRECISION, (PRECISION * 3) / 2, Math.Rounding.Floor);
        assertEq(notesBack, expected);
        // Fewer notes returned, but each note is worth more dollars
        assertLt(notesBack, 100e18, "Should return fewer notes at higher note price");
    }

    /// @notice CRITICAL: Test that caught the original okuMReturned formula bug.
    /// @dev Historically this elevated OkuM's and OkuDollar's multipliers
    ///      independently to the SAME value and asserted a round trip returned
    ///      exactly the original deposit. Under the single-multiplier design
    ///      "elevate both to the same value" is not a distinct scenario — there is
    ///      only one multiplier, so every elevated round trip already exercises
    ///      this. This keeps the regression as a direct single-multiplier version.
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

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 30 days);

        uint256 multBefore = okuDollar.usdMultiplier();

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        uint256 multAfter = okuDollar.usdMultiplier();
        assertGt(multAfter, multBefore, "Multiplier should grow over time");
    }

    function test_UsdMultiplier_AccruesContinuously() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(rebaser);
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
    // SINGLE MULTIPLIER: OkuDollar has no rate state. These tests now drive
    // `okuMoney.setOkuMYieldRate` / `setNextOkuMYieldRate` and assert that
    // `okuDollar.usdMultiplier()` tracks it exactly — that delegation is the
    // property worth testing here.
    //
    // REMOVED (single-multiplier refactor):
    //   * test_SetUsdYieldRate_OnlyUsdRebaser / test_SetNextUsdYieldRate_OnlyUsdRebaser
    //     — VAULT_REBASER and both setters are gone; OKUM_REBASER gating on OkuMoney is
    //     covered in OkuMoney.t.sol.
    //   * test_SetUsdYieldRate_RevertsOnNegativeRate / _RevertsOnRateTooHigh /
    //     _RevertsOnPastEndTimestamp, test_SetNextUsdYieldRate_RevertsWhenNoEnd /
    //     _RevertsOnNegativeRate / _RevertAtExactEndBoundary /
    //     _RevertOneSecondPastEnd / _SucceedsOneSecondBeforeEnd / _RevertsOnRateTooHigh
    //     — OkuDollar.InvalidRate / RateTooHigh / EndTimestampInPast / NoRateEndSet /
    //     RateAlreadyExpired no longer exist. The identical bounds now live on
    //     OkuMoney and are tested in OkuMoney.t.sol.
    //   * test_UsdMultiplier_IndependentOfNotePrice — the multipliers are the same
    //     value by construction; independence is no longer a property.

    function test_UsdMultiplier_TracksOkuMYieldRate_SnapshotsMultiplier() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 30 days);

        vm.warp(block.timestamp + 1 days);

        uint256 multBefore = okuDollar.usdMultiplier();
        assertGt(multBefore, PRECISION);

        // Set a new rate -- should snapshot current multiplier
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION, 0); // zero yield

        uint256 baseAfter = okuMoney.okuMBaseMultiplier();
        assertEq(baseAfter, multBefore, "Base multiplier should be snapshotted");
    }

    function test_UsdMultiplier_TracksOkuMYieldRate_WithEndTimestamp() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        assertEq(okuMoney.okuMRateEnd(), endTime);
    }

    function test_UsdMultiplier_TracksOkuMYieldRate_ClearsPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, endTime + 60 days);

        // Setting a new rate should clear pending
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1000e6, block.timestamp + 90 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), PRECISION);
    }

    // ============ setNextOkuMYieldRate delegation tests ============

    function test_UsdMultiplier_TracksOkuMPendingYieldRate_SchedulesNextRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(nextRate, endTime + 60 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), nextRate);
    }

    function test_UsdMultiplier_TracksOkuMPendingYieldRate_HeadToTailTransition() public {
        uint256 rate1 = PRECISION + 1393e6;
        uint256 rate2 = PRECISION + 2000e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate1, endTime);

        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(rate2, endTime + 60 days);

        // Warp past end time -- pending rate should take over
        vm.warp(endTime + 1 days);

        uint256 mult = okuDollar.usdMultiplier();
        // Should be greater than what rate1 alone would have produced at endTime
        assertGt(mult, PRECISION, "Multiplier should have grown through both rate periods");
    }

    // ============ Reserve management ============
    //
    // REMOVED (single-multiplier refactor): the whole depositReserves /
    // withdrawSurplus / setMinCollateralRatio / collateralizationRatio / surplus
    // test blocks (test_DepositReserves_*, test_WithdrawSurplus_*,
    // test_SetMinCollateralRatio_*, test_CollateralizationRatio_*, test_Surplus_*).
    //
    // Rationale: those functions, the `minCollateralRatio` config, the
    // `BelowMinimumCollateral` / `RatioExceedsMax` / `RatioBelowFloor` errors, and the
    // `ReservesDeposited` / `SurplusWithdrawn` / `MinCollateralRatioUpdated` events were
    // all deleted. Collateralization is exactly 1.0 by construction: `usdMultiplier()`
    // IS `okuMoney.okuMMultiplier()`, and shares are only ever minted/burned 1:1 against
    // real OkuM at the same multiplier, so there is no over- or under-collateralized
    // state to reach and therefore no surplus to withdraw and no floor to enforce.
    //
    // The surviving properties are kept below.

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
        vm.expectRevert(OkuDollar.NoDonationAvailable.selector);
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
        vm.expectRevert(OkuDollar.NoDonationAvailable.selector);
        okuDollar.rescueDonation(50e18 + 1, treasury);

        vm.prank(vaultRescuer);
        okuDollar.rescueDonation(50e18, treasury);

        assertEq(okuMoney.balanceOf(treasury), 50e18);
        assertEq(okuDollar.totalOkuMReserves(), backing, "share backing untouched");
    }

    function test_RescueDonation_RevertsOnZeroAmount() public {
        vm.prank(vaultRescuer);
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.rescueDonation(0, treasury);
    }

    function test_RescueDonation_RevertsOnZeroReceiver() public {
        _mintOkuMoney(user2, 50e18);
        vm.prank(user2);
        okuMoney.transfer(address(okuDollar), 50e18);

        vm.prank(vaultRescuer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuDollar.rescueDonation(1e18, address(0));
    }

    // ============ Pause Tests ============

    function test_Pause_BlocksTransfer() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user1);
        vm.expectRevert();
        okuDollar.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user2);
        vm.expectRevert();
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Pause_BlocksWrap() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // M-4 fix: wrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
        okuDollar.wrap(okuMAmount, user1, 0);
    }

    function test_Pause_BlocksUnwrap() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        // M-4 fix: unwrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
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
        vm.expectRevert();
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mintUsdOku(user1, 100e18);

        // _transferUsdShares should revert with InsufficientBalance — the share
        // balance check is unrelated to vault collateralization (which has its own
        // distinct InsufficientCollateral error).
        vm.prank(user1);
        vm.expectRevert(Errors.InsufficientBalance.selector);
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
    //
    // REMOVED (single-multiplier refactor):
    // test_RoleEnforcement_NoteRebaserCannotSetUsdRate (there is no separate USD rate
    // to gate — `rebaser` legitimately controls the one schedule),
    // test_RoleEnforcement_NonReserveManagerCannotDeposit / ...CannotWithdraw
    // (`depositReserves` / `withdrawSurplus` and VAULT_RESERVE_MANAGER deleted), and
    // test_RoleEnforcement_NonVaultAdminCannotSetCollateralRatio
    // (`setMinCollateralRatio` and VAULT_ADMIN deleted).
    //
    // The replacement gate is VAULT_RESCUER on `rescueDonation`, covered by
    // test_RescueDonation_OnlyVaultRescuer above.

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
        // Set okuMMultiplier to elevated value but keep multiplier at base
        // This tests the overcollateralized scenario (price > mult)
        uint256 elevatedPrice = 15e17; // 1.5e18

        _setOkuMMultiplierAndRoll(elevatedPrice);
        // usdMultiplier stays at default PRECISION

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

        vm.prank(rebaser);
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

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate1, endTime);

        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(rate2, endTime + 400 days);

        // Warp past end + 365 days: should have 30d of rate1 + 365d of rate2
        vm.warp(endTime + 365 days);

        uint256 mult = okuDollar.usdMultiplier();
        assertGt(mult, PRECISION, "Must have accrued yield through both periods");

        // Compare against just rate1 for 30 days (rate2 adds more)
        // Approximate: 30 days of ~4.5% + 365 days of ~2% => well above PRECISION
        assertGt(mult, PRECISION + 1e16, "Should have meaningful accrual");
    }

    // ============ APY Accuracy Tests ============

    function test_APYAccuracy_FourPointFivePercent() public {
        // ~4.5% APY compounding per second
        // rate = e^(ln(1.045) / 31536000) * 1e18 ~= 1000000001395766281
        uint256 rate = 1_000_000_001_395_766_281;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 400 days);

        uint256 startMult = okuDollar.usdMultiplier();

        vm.warp(block.timestamp + 365 days);

        uint256 endMult = okuDollar.usdMultiplier();
        uint256 expectedMult = 1045e15; // 1.045e18

        // Within 0.1% tolerance
        assertApproxEqRel(endMult, expectedMult, 1e15);
        assertGt(endMult, startMult);
    }

    // ============ Single Multiplier Delegation Tests ============
    //
    // REPLACES test_UsdMultiplier_IndependentOfNotePrice (removed): under the
    // pre-refactor dual-multiplier design, OkuM's discrete price and OkuDollar's
    // independent USD rate could diverge over time. Under the single-multiplier
    // design that's no longer a property to test — `usdMultiplier()` delegates to
    // `okuMoney.okuMMultiplier()` exactly, by construction, always. This asserts
    // that identity holds across both a discrete override AND a streaming rate.

    function test_UsdMultiplier_AlwaysEqualsOkuMMultiplier() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 1045 / 1000); // discrete override
        assertEq(okuDollar.usdMultiplier(), okuMoney.okuMMultiplier());

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 634e6, block.timestamp + 400 days); // streaming rate
        vm.warp(block.timestamp + 365 days);

        assertEq(
            okuDollar.usdMultiplier(),
            okuMoney.okuMMultiplier(),
            "usdMultiplier must always equal okuMMultiplier under the single-multiplier design"
        );
    }

    // ============ Continuous Yield + Balance/Supply Tests ============

    function test_ContinuousYield_BalanceGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(rebaser);
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
        vm.prank(rebaser);
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
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + 400 days);

        vm.warp(block.timestamp + 365 days);

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
        // Test wrap/unwrap at base multiplier=1e18 but varying okuMMultiplier.
        // `setOkuMMultiplier` requires strict increase, so bound starts above PRECISION.
        mult = bound(mult, PRECISION + 1, 5e18);

        // Only set okuMMultiplier (not multiplier) to avoid collateralization issues
        _setOkuMMultiplierAndRoll(mult);
        // usdMultiplier stays at default 1e18

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

    function testFuzz_WrapUnwrap_RoundTrip_BothPriceAndMult(uint256 price) public {
        // Test wrap/unwrap when price varies but multiplier stays at base (1e18).
        // Strict increase required by setOkuMMultiplier.
        price = bound(price, PRECISION + 1, 3e18);
        // Keep mult at base - this ensures vault stays solvent (price >= mult means overcollateralized)
        uint256 mult = PRECISION;

        _setOkuMMultiplierAndRoll(price);

        // usdMultiplier stays at default PRECISION

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
        // When price >= mult, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by combined rounding effects
        uint256 maxLoss = Math.mulDiv(5, mult, PRECISION, Math.Rounding.Ceil)
            + Math.mulDiv(5, price, PRECISION, Math.Rounding.Ceil) + 10;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_Wrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        _stampYieldLockBlock();

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
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

        assertGt(okuDollar.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        _stampYieldLockBlock();

        // Same block — unwrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
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

        // setOkuMMultiplier also sets lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        okuDollar.wrap(50e18, user1, 0);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastYieldDistributionBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);

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

    // ============ WS3 Additional Tests ============

    // ---- WS3.1.a: zero-supply rate change ----

    /// @notice Setting the rate when totalUsdShares == 0 should succeed. The multiplier
    ///         has no supply term, so it accrues regardless and any later `wrap()`
    ///         prices in at the accrued value.
    function test_UsdMultiplier_TracksOkuMYieldRate_WorksWithZeroSupply() public {
        assertEq(okuDollar.totalSupply(), 0);
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(MAX_RATE, block.timestamp + 30 days);
        assertGt(okuMoney.okuMRatePerSecond(), PRECISION);
    }

    /// @notice Verify that a non-zero rate accrues correctly after supply is added.
    function test_UsdMultiplier_TracksOkuMYieldRate_AccruesAfterSubsequentWrap() public {
        vm.prank(rebaser);
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

    // ---- WS3.1.c: reinit guard on OkuDollar ----

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert();
        okuDollar.initialize(address(okuMoney), "OkuDollar", "usdOku", admin);
    }

    // ---- WS3.1.d: OkuDollar UUPS upgrade authorization ----

    function test_UUPS_Upgrade_RevertsForNonUpgrader() public {
        OkuDollar newImpl = new OkuDollar();
        vm.expectRevert();
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

    // ---- WS3.1.f: pause coverage ----
    //
    // REMOVED (single-multiplier refactor): test_Pause_BlocksDepositReserves,
    // test_Pause_BlocksWithdrawSurplus, test_Unpause_AllowsDepositReservesAgain —
    // `depositReserves` / `withdrawSurplus` no longer exist. Pause coverage for the
    // surviving state-changing surface (wrap / unwrap / transfer / transferFrom) is in
    // the Pause Tests section above.

    // ---- WS3.1.j: OkuDollar blacklist ----

    function test_Blacklist_BlocksWrapSender() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);
    }

    function test_Blacklist_BlocksWrapReceiver() public {
        _mintOkuMoney(user2, 100e18);
        _approveOkuMoney(user2, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1); // blacklist receiver, not sender

        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        vm.prank(user2);
        okuDollar.wrap(100e18, user1, 0); // receiver is blacklisted
    }

    function test_Blacklist_BlocksUnwrapSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);
    }

    function test_Blacklist_BlocksTransferSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransferReceiver() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_PermitBlocksBlacklistedOwner() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        // Permit with blacklisted owner should revert
        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
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

    function test_Blacklist_RevertAlreadyBlacklisted() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        vm.expectRevert(OkuDollar.AlreadyBlacklisted.selector);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
    }

    function test_Blacklist_RevertNotBlacklisted() public {
        vm.expectRevert(OkuDollar.NotBlacklisted.selector);
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);
    }

    // REMOVED (single-multiplier refactor): the withdrawSurplus yield-lock and
    // boundary/postRatio blocks (test_WithdrawSurplus_BlockedDuringYieldDistribution,
    // test_WithdrawSurplus_OneWeiBelowFloor_Reverts,
    // test_WithdrawSurplus_ZeroObligations_UsesInfiniteRatio,
    // test_WithdrawSurplus_EventPostRatioMatchesView). `withdrawSurplus`,
    // `collateralizationRatio()` and the min-ratio floor no longer exist, so there is
    // no postRatio arithmetic left to bound. The yield-sandwich guard itself is still
    // covered on wrap/unwrap in the "Yield Distribution Lock Tests" section above.
    //
    // REMOVED: the setNextUsdYieldRate boundary block
    // (test_SetNextUsdYieldRate_RevertAtExactEndBoundary, _RevertOneSecondPastEnd,
    // _SucceedsOneSecondBeforeEnd, _RevertsOnRateTooHigh). Those bounds moved to
    // OkuMoney.setNextOkuMYieldRate along with the RateAlreadyExpired / RateTooHigh
    // errors, and are tested in OkuMoney.t.sol.

    // ============ Permit Blacklist Spender Branch ============

    function test_Permit_RevertBlacklistedSpender() public {
        _mintUsdOku(user1, 100e18);
        // user1 is the (clean) owner; blacklist the spender (user2).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        // Permit signature is bogus — call must revert before signature check.
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        okuDollar.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    /// @notice `approve` mirrors `permit`'s posture: a blacklisted spender cannot be approved.
    function test_Approve_RevertsOnBlacklistedSpender() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        okuDollar.approve(user2, 50e18);
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

    /// @dev REMOVED (single-multiplier refactor): OkuDollar no longer exposes
    ///      `usdLastAccrualTime` — the accrual clock lives on OkuMoney. Retained here as
    ///      a delegation check.
    function test_UsdMultiplier_DelegatesLastAccrualTime() public {
        // Calling setOkuMYieldRate stamps okuMLastAccrualTime = block.timestamp.
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e9, block.timestamp + 30 days);
        assertEq(okuMoney.okuMLastAccrualTime(), block.timestamp);
        assertEq(okuDollar.usdMultiplier(), okuMoney.okuMMultiplier());
    }
}
