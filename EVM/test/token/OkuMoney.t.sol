// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
} from "../../src/interfaces/IScaledUIAmount.sol";

/**
 * @title OkuMoneyTest
 * @notice Unit tests for OkuMoney non-rebasing ERC-20 token with stored price ratio
 */
contract OkuMoneyTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    // Cycle 4 (EVM-01): both events now include `indexed blockNumber`.
    event OkuMMultiplierUpdated(
        uint256 oldMultiplier,
        uint256 newMultiplier,
        uint256 totalSupply,
        uint256 indexed blockNumber
    );
    // REMOVED (streaming-accrual refactor): local mirror of `YieldDistributed` —
    // the event and `distributeYield` were both deleted. New events are
    // OkuMYieldRateUpdated / NextOkuMYieldRateSet, mirrored below.
    event OkuMYieldRateUpdated(
        uint256 oldRate, uint256 newRate, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextOkuMYieldRateSet(uint256 newRate, uint256 activatesAt, uint256 expiresAt);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuMoney.name(), "OkuMoney");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuMoney.symbol(), "OkuM");
    }

    /// @dev Asserts against `Constants.OKU_M_DECIMALS`, not a bare 18: that constant is
    ///      the exponent the PSM/queue USDC conversion is built on, so pinning the
    ///      literal here would let `decimals()` and the conversion math drift apart
    ///      while both tests still passed.
    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuMoney.decimals(), Constants.OKU_M_DECIMALS);
        assertEq(okuMoney.decimals(), 18);
    }

    function test_Initialize_SetsCorrectAdmin() public view {
        assertTrue(okuMoney.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Initialize_SetsCorrectMaxSupply() public view {
        assertEq(okuMoney.maxSupply(), MAX_SUPPLY);
    }

    function test_Initialize_SetsInitialNotePrice() public view {
        assertEq(okuMoney.okuMMultiplier(), PRECISION);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        okuMoney.initialize("OkuMoney2", "OkuM2", admin, MAX_SUPPLY);
    }

    // ============ Minting Tests ============

    function test_Mint_OnlyMinterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_MINTER
            )
        );
        okuMoney.mint(user1, 100e18);
    }

    function test_Mint_IncreasesBalance() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);
        assertEq(okuMoney.balanceOf(user1), amount);
    }

    function test_Mint_BalanceUnaffectedByNotePrice() public {
        // Set okuMMultiplier to 2x before minting
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // balanceOf returns raw amount, NOT divided by okuMMultiplier
        assertEq(okuMoney.balanceOf(user1), amount);
    }

    function test_Mint_IncreasesTotalSupply() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);
        assertEq(okuMoney.totalSupply(), amount);
    }

    function test_Mint_TotalSupplyIsRawAmount() public {
        // Set okuMMultiplier to 2x before minting
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // totalSupply returns raw token count, NOT multiplied by okuMMultiplier
        assertEq(okuMoney.totalSupply(), amount);
    }

    function test_Mint_DecrementsMinterAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuMoney.minterAllowance(minter);
        _mintOkuMoney(user1, amount);
        assertEq(okuMoney.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Mint_RevertsExceedingAllowance() public {
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, 50e18);

        vm.prank(minter);
        vm.expectRevert(OkuMoney.ExceedsAllowance.selector);
        okuMoney.mint(user1, 100e18);
    }

    function test_Mint_RevertsExceedingMaxSupply() public {
        vm.prank(minter);
        vm.expectRevert(OkuMoney.ExceedsSupplyCap.selector);
        okuMoney.mint(user1, MAX_SUPPLY + 1);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.mint(user1, 100e18);
    }

    function test_Mint_RevertsToBlacklistedAddress() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        okuMoney.mint(user1, 100e18);
    }

    function test_Mint_EmitsTransferEvent() public {
        uint256 amount = 100e18;
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, amount);

        vm.prank(minter);
        okuMoney.mint(user1, amount);
    }

    // ============ Burning Tests ============

    function test_Burn_OnlyBurnerRole() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                // Cycle 4 (EVM-15): burn requires OKUM_BURNER (split
                // from OKUM_MINTER). user1 holds neither.
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                OKUM_BURNER
            )
        );
        okuMoney.burn(50e18);
    }

    function test_Burn_DecreasesBalance() public {
        // Mint to minter so it can self-burn
        _mintOkuMoney(minter, 100e18);

        vm.prank(minter);
        okuMoney.burn(40e18);

        assertEq(okuMoney.balanceOf(minter), 60e18);
    }

    function test_Burn_RemovesExactAmount() public {
        // Set okuMMultiplier to 2x, then mint and burn
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        _mintOkuMoney(minter, 100e18);

        vm.prank(minter);
        okuMoney.burn(40e18);

        // burn(40e18) removes exactly 40e18 from balanceOf regardless of okuMMultiplier
        assertEq(okuMoney.balanceOf(minter), 60e18);
    }

    function test_Burn_DecreasesTotalSupply() public {
        _mintOkuMoney(minter, 100e18);

        vm.prank(minter);
        okuMoney.burn(40e18);

        assertEq(okuMoney.totalSupply(), 60e18);
    }

    function test_Burn_DoesNotRestoreAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuMoney.minterAllowance(minter);

        _mintOkuMoney(minter, amount);
        uint256 allowanceAfterMint = okuMoney.minterAllowance(minter);

        vm.prank(minter);
        okuMoney.burn(amount);

        // Allowance should NOT be restored after burn
        assertEq(okuMoney.minterAllowance(minter), allowanceAfterMint);
        assertEq(okuMoney.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Burn_RevertsInsufficientBalance() public {
        _mintOkuMoney(minter, 100e18);

        vm.prank(minter);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, minter, 100e18, 150e18
            )
        );
        okuMoney.burn(150e18);
    }

    function test_Burn_RevertsForBlacklistedAccount() public {
        _mintOkuMoney(minter, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(minter);

        vm.prank(minter);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        okuMoney.burn(50e18);
    }

    function test_Burn_WorksWhenPaused() public {
        _mintOkuMoney(minter, 100e18);

        vm.prank(pauser);
        okuMoney.pause();

        // Burn should work when paused (no whenNotPaused modifier)
        vm.prank(minter);
        okuMoney.burn(50e18);

        assertEq(okuMoney.balanceOf(minter), 50e18);
    }

    function test_Burn_EmitsTransferEvent() public {
        _mintOkuMoney(minter, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(minter, address(0), 50e18);

        vm.prank(minter);
        okuMoney.burn(50e18);
    }

    // ============ Transfer Tests ============

    function test_Transfer_UpdatesBalances() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 30e18));

        assertEq(okuMoney.balanceOf(user1), 70e18);
        assertEq(okuMoney.balanceOf(user2), 30e18);
    }

    function test_Transfer_MovesExactAmount() public {
        // Set okuMMultiplier to 2x, then mint and transfer
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 50e18));

        // transfer(50e18) moves exactly 50e18 in balanceOf regardless of okuMMultiplier
        assertEq(okuMoney.balanceOf(user1), 50e18);
        assertEq(okuMoney.balanceOf(user2), 50e18);
    }

    function test_Transfer_TotalSupplyUnchanged() public {
        _mintOkuMoney(user1, 100e18);
        uint256 totalBefore = okuMoney.totalSupply();

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 30e18));

        // Total supply should be unchanged (internal transfer)
        assertEq(okuMoney.totalSupply(), totalBefore);
    }

    function test_Transfer_RevertsWhenPaused() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsFromBlacklisted() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsToBlacklisted() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsInsufficientBalance() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, user1, 100e18, 150e18
            )
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 150e18);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0))
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(address(0), 30e18);
    }

    function test_Transfer_EmitsTransferEvent() public {
        _mintOkuMoney(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 30e18);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 30e18));
    }

    function test_Transfer_ToSelf() public {
        _mintOkuMoney(user1, 100e18);
        uint256 balanceBefore = okuMoney.balanceOf(user1);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user1, 50e18));

        assertEq(okuMoney.balanceOf(user1), balanceBefore);
    }

    // ============ TransferFrom Tests ============

    function test_TransferFrom_UpdatesAllowance() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, user2, 50e18);

        vm.prank(user2);
        assertTrue(okuMoney.transferFrom(user1, user3, 30e18));

        assertEq(okuMoney.allowance(user1, user2), 20e18);
    }

    function test_TransferFrom_RevertsInsufficientAllowance() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, user2, 20e18);

        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, user2, 20e18, 30e18
            )
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transferFrom(user1, user3, 30e18);
    }

    function test_TransferFrom_RevertsWhenPaused() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, user2, 50e18);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transferFrom(user1, user3, 30e18);
    }

    // ============ setOkuMMultiplier Tests ============

    function test_SetOkuMMultiplier_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.setOkuMMultiplier(PRECISION * 2);
    }

    function test_SetOkuMMultiplier_CannotDecrease() public {
        vm.prank(rebaser);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        okuMoney.setOkuMMultiplier(PRECISION - 1);
    }

    function test_SetOkuMMultiplier_DoesNotAffectBalances() public {
        _mintOkuMoney(user1, 100e18);
        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Double the note price
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // balanceOf does NOT change with okuMMultiplier — standard ERC-20
        uint256 balanceAfter = okuMoney.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore);
    }

    function test_SetOkuMMultiplier_DoesNotAffectTotalSupply() public {
        _mintOkuMoney(user1, 100e18);
        uint256 supplyBefore = okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // totalSupply does NOT change with okuMMultiplier — standard ERC-20
        assertEq(okuMoney.totalSupply(), supplyBefore);
    }

    function test_SetOkuMMultiplier_UpdatesPrice() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.okuMMultiplier(), PRECISION * 2);
    }

    function test_SetOkuMMultiplier_EmitsEvent() public {
        // Cycle 4 (EVM-01): event payload now includes the indexed
        // `blockNumber` field for subgraph sharding.
        vm.expectEmit(true, false, false, true);
        emit OkuMMultiplierUpdated(PRECISION, PRECISION * 2, okuMoney.totalSupply(), block.number);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
    }

    function test_SetOkuMMultiplier_RevertsOnEqualValue() public {
        // Setting the multiplier to its current value is a no-op for the value but
        // would otherwise stamp `lastYieldDistributionBlock` and burn a sandwich-lock
        // slot for nothing. {setOkuMMultiplier} requires strict increase.
        uint256 currentPrice = okuMoney.okuMMultiplier();

        vm.prank(rebaser);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        okuMoney.setOkuMMultiplier(currentPrice);
    }

    /// @dev `setOkuMMultiplier` (the discrete override) must freeze with the rest
    ///      of the contract while paused — ANY change, not just increases. This is
    ///      stricter than `setOkuMYieldRate` / `setNextOkuMYieldRate` (OkuDollar has
    ///      no rate setters of its own — it delegates entirely to OkuMoney), which
    ///      remain callable for decreases only while paused so operators can zero
    ///      accrual mid-incident; see `test_SetOkuMYieldRate_PermitsDecreaseWhilePaused`.
    function test_SetOkuMMultiplier_RevertsWhenPaused() public {
        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(rebaser);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
    }

    /// @notice Regression: `setOkuMMultiplier` must collapse the rate schedule to
    ///         halted, not merely re-anchor. Prior behaviour left an active rate's
    ///         `okuMRateEnd` in place; if it had already elapsed, the next
    ///         `okuMMultiplier()` call underflowed in `MathLib.computeMultiplier`
    ///         (`rateEnd - anchor`) and reverted forever.
    function test_SetOkuMMultiplier_CollapsesExpiredSchedule() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 1 days);

        // Warp well past okuMRateEnd with no pending rate armed.
        vm.warp(block.timestamp + 90 days);
        uint256 current = okuMoney.okuMMultiplier();

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(current + 1);

        // Must not revert, and the schedule must be fully halted.
        assertEq(okuMoney.okuMMultiplier(), current + 1);
        assertEq(okuMoney.okuMRatePerSecond(), PRECISION, "rate collapsed to no-yield");
        assertEq(okuMoney.okuMRateEnd(), 0, "rate window cleared");
        assertEq(okuMoney.okuMPendingRatePerSecond(), PRECISION, "pending rate cleared");

        // Further arbitrary warps must not accrue or revert.
        vm.warp(block.timestamp + 365 days);
        assertEq(okuMoney.okuMMultiplier(), current + 1);
    }

    // ============ setOkuMYieldRate / setNextOkuMYieldRate Tests ============
    //
    // REMOVED (streaming-accrual refactor): the whole `distributeYield` test block
    // (test_DistributeYield_OnlyRebaser, _CorrectPriceMath, _ZeroSupplyReverts,
    // _RevertsWhenPaused, _EmitsEvent, _MonotonicallyIncreases, _DoesNotAffectBalances).
    // `distributeYield(uint256)` and the `YieldTooSmall` / `YieldDistributed` symbols
    // were deleted: the multiplier is no longer nudged by a supply-relative yield
    // amount, it is COMPUTED continuously from a rate schedule. The replacement
    // surface is tested below.

    function test_SetOkuMYieldRate_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.setOkuMYieldRate(PRECISION + 1e9, 0);
    }

    function test_SetNextOkuMYieldRate_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.setNextOkuMYieldRate(PRECISION + 1e9, block.timestamp + 60 days);
    }

    function test_SetOkuMYieldRate_RevertsOnRateBelowPrecision() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.InvalidRate.selector);
        okuMoney.setOkuMYieldRate(PRECISION - 1, 0);
    }

    /// @notice The successor setter carries its OWN sub-precision rail.
    /// @dev Not redundant with the active setter's. `_setNextOkuMYieldRate` is a
    ///      separate private body reached by both `setNextOkuMYieldRate` and
    ///      `setOkuMYieldRateWithSuccessor`, so a rate that would shrink the
    ///      multiplier has to be rejected there too. Without it an operator could
    ///      arm a sub-unity successor that activates at `okuMRateEnd` with no
    ///      transaction at the boundary — a monotonicity break that lands
    ///      unattended, which is strictly worse than one that reverts in-call.
    function test_SetNextOkuMYieldRate_RevertsOnRateBelowPrecision() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e9, block.timestamp + 30 days);

        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.InvalidRate.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION - 1, block.timestamp + 60 days);
    }

    function test_SetOkuMYieldRate_RevertsOnRateTooHigh() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateTooHigh.selector);
        okuMoney.setOkuMYieldRate(MAX_RATE + 1, 0);
    }

    function test_SetOkuMYieldRate_RevertsOnPastEndTimestamp() public {
        vm.warp(1000);
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.EndTimestampInPast.selector);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp - 1);
    }

    // ── MAX_RATE_WINDOW ──────────────────────────────────────────────────────
    //
    // `MathLib.compoundFor`'s NatSpec asserted "every caller bounds `elapsed`
    // via the mandatory rate-window timestamps", but the only check was
    // `endTimestamp > block.timestamp` — so the bound was whatever the operator
    // typed. `MAX_MULTIPLIER` clamps `compoundFor`'s OUTPUT, which cannot stop
    // `rpow` overflowing internally on a huge `elapsed`. If that ever fired,
    // `okuMMultiplier()` would revert and take EVERY recovery path with it
    // (both rate setters and the `setOkuMMultiplier` emergency override all
    // read the current multiplier to re-anchor), leaving a UUPS upgrade as the
    // only escape. These pin the bound that makes the invariant real.

    function test_SetOkuMYieldRate_AcceptsExactlyMaxRateWindow() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp + MAX_RATE_WINDOW);
        assertEq(okuMoney.okuMRateEnd(), block.timestamp + MAX_RATE_WINDOW);
    }

    function test_SetOkuMYieldRate_RevertsOneSecondBeyondMaxRateWindow() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateWindowTooLong.selector);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp + MAX_RATE_WINDOW + 1);
    }

    /// @dev Halting is exempt: it requires `endTimestamp == 0`, so there is no
    ///      window to bound and the length check must not fire.
    function test_SetOkuMYieldRate_HaltingIsExemptFromWindowBound() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION, 0);
        assertEq(okuMoney.okuMRateEnd(), 0);
    }

    /// @dev The SUCCESSOR's own window is `[rateEnd, pendingEnd]` — that is the
    ///      span a single `rpow` covers in branch 3 of `computeMultiplier`, so
    ///      it is bounded independently of the active window. Two chained
    ///      90-day windows are two bounded `rpow` calls, not one 180-day call.
    function test_SetNextOkuMYieldRate_BoundsTheSuccessorWindowIndependently() public {
        uint256 rateEnd = block.timestamp + MAX_RATE_WINDOW;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, rateEnd);

        // Successor window exactly at the bound: allowed, even though the total
        // span from now is 180 days.
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 634e6, rateEnd + MAX_RATE_WINDOW);
        assertEq(okuMoney.okuMPendingRateEnd(), rateEnd + MAX_RATE_WINDOW);

        // One second beyond it: rejected.
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateWindowTooLong.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION + 634e6, rateEnd + MAX_RATE_WINDOW + 1);
    }

    /// @dev Regression: halting (`newRate == PRECISION`) requires `endTimestamp == 0`;
    ///      a non-zero timestamp — even a valid future one — must revert.
    function test_SetOkuMYieldRate_RevertsOnNonZeroEndTimestampWhenHalting() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.EndTimestampNotAllowed.selector);
        okuMoney.setOkuMYieldRate(PRECISION, block.timestamp + 30 days);
    }

    // ============ Pause Gate Tests (M-3: decrease-only while paused) ============

    function test_SetOkuMYieldRate_RevertsOnIncreaseWhilePaused() public {
        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(rebaser);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, block.timestamp + 30 days);
    }

    function test_SetOkuMYieldRate_PermitsDecreaseWhilePaused() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 2e10, block.timestamp + 30 days);

        vm.prank(pauser);
        okuMoney.pause();

        // A strict decrease (including zeroing) must succeed even while paused.
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION, 0);

        assertEq(okuMoney.okuMRatePerSecond(), PRECISION);
    }

    /// @dev Regression (M-2): the pause gate must compare against the EFFECTIVE
    ///      rate, not stale storage. Arm a high active rate, let a LOWER pending
    ///      rate take over, then verify that re-setting to a value between the two
    ///      (higher than effective, lower than stale storage) still reverts while
    ///      paused — proving the comparison isn't against the stale `okuMRatePerSecond`.
    function test_SetOkuMYieldRate_PauseGateUsesEffectiveRateNotStaleStorage() public {
        uint256 highRate = PRECISION + 1e11; // MAX_RATE
        uint256 lowRate = PRECISION + 1e9;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(highRate, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(lowRate, endTime + 30 days);

        vm.warp(endTime + 1); // pending (lowRate) now effective; storage still says highRate
        assertEq(okuMoney.okuMRatePerSecond(), highRate, "stale storage still reports old rate");
        assertEq(okuMoney.okuMEffectiveRatePerSecond(), lowRate, "effective rate reflects handover");

        vm.prank(pauser);
        okuMoney.pause();

        // midRate is BELOW stale storage (highRate) but ABOVE the true effective
        // rate (lowRate) — a naive stale-storage comparison would incorrectly permit it.
        uint256 midRate = PRECISION + 5e10;
        vm.prank(rebaser);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.setOkuMYieldRate(midRate, block.timestamp + 30 days);
    }

    function test_SetNextOkuMYieldRate_RevertsOnIncreaseWhilePaused() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(rebaser);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);
    }

    function test_SetNextOkuMYieldRate_PermitsDecreaseWhilePaused() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 2e10, endTime);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION, endTime + 30 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), PRECISION);
    }

    function test_SetOkuMYieldRate_StoresSchedule() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        assertEq(okuMoney.okuMRatePerSecond(), PRECISION + 1393e6);
        assertEq(okuMoney.okuMRateEnd(), endTime);
        assertEq(okuMoney.okuMLastAccrualTime(), block.timestamp);
        // A fresh schedule clears any armed successor.
        assertEq(okuMoney.okuMPendingRatePerSecond(), PRECISION);
    }

    function test_SetOkuMYieldRate_SnapshotsMultiplier() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp + 30 days);

        vm.warp(block.timestamp + 1 days);
        uint256 multBefore = okuMoney.okuMMultiplier();
        assertGt(multBefore, PRECISION);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION, 0); // halt accrual

        assertEq(okuMoney.okuMBaseMultiplier(), multBefore, "base is snapshotted");
        assertEq(okuMoney.okuMMultiplier(), multBefore, "curve is continuous across the write");
    }

    /// @notice Continuous accrual does NOT stamp the sandwich-guard block: there is no
    ///         discrete step to sandwich. Only `setOkuMMultiplier` stamps.
    function test_SetOkuMYieldRate_DoesNotStampYieldBlock() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp + 30 days);

        assertEq(okuMoney.lastYieldDistributionBlock(), 0);
    }

    function test_SetOkuMYieldRate_DoesNotAffectBalances() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, block.timestamp + MAX_RATE_WINDOW);
        _accrueAtCurrentRate(365 days);

        assertGt(okuMoney.okuMMultiplier(), PRECISION, "multiplier accrued");
        assertEq(okuMoney.balanceOf(user1), supply, "balanceOf unchanged (non-rebasing)");
        assertEq(okuMoney.totalSupply(), supply, "totalSupply unchanged (non-rebasing)");
    }

    /// @notice The multiplier has no supply term, so a zero-supply rate change is fine.
    /// @dev Replaces test_DistributeYield_ZeroSupplyReverts — `ZeroSupply` is unreachable.
    function test_SetOkuMYieldRate_WorksWithZeroSupply() public {
        assertEq(okuMoney.totalSupply(), 0);
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(MAX_RATE, block.timestamp + 30 days);
        vm.warp(block.timestamp + 1 days);
        assertGt(okuMoney.okuMMultiplier(), PRECISION);
    }

    // ============ ERC-8056 (Scaled UI Amount) Tests ============

    function test_SupportsInterface_ERC8056() public view {
        // Pins the four interface IDs claimed in IScaledUIAmount's NatSpec against
        // accidental drift (e.g. a signature change on any of the four interfaces).
        assertTrue(okuMoney.supportsInterface(type(IScaledUIAmount).interfaceId));
        assertTrue(okuMoney.supportsInterface(type(IScaledUIAmountNewUIMultiplier).interfaceId));
        assertTrue(okuMoney.supportsInterface(type(IScaledUIAmountConversion).interfaceId));
        assertTrue(okuMoney.supportsInterface(type(IScaledUIAmountBalances).interfaceId));
    }

    /// @notice Pins the LITERAL hex values documented in IScaledUIAmount.sol's NatSpec
    ///         and EVM/README.md's ERC-8056 table against the compiler-computed IDs.
    /// @dev The test above only proves internal self-consistency: `supportsInterface`
    ///      is checked against `type(I).interfaceId`, so it passes trivially even if a
    ///      signature change silently moves the computed ID — it can never observe
    ///      doc drift. ERC-8056 is an explicitly-Draft standard (Accepted Risk #9) that
    ///      may itself change the reference signatures before Final; the moment either
    ///      that or a local edit shifts any of the four IDs, this test fails and names
    ///      exactly which of the three doc sites (this file's NatSpec, the README
    ///      table, Accepted Risk #9) needs updating — instead of three sites silently
    ///      going stale with every other test still green.
    function test_InterfaceIds_MatchDocumentedHexValues() public pure {
        assertEq(type(IScaledUIAmount).interfaceId, bytes4(0xa60bf13d), "IScaledUIAmount (core)");
        assertEq(
            type(IScaledUIAmountNewUIMultiplier).interfaceId,
            bytes4(0x4bd27648),
            "IScaledUIAmountNewUIMultiplier (required ext)"
        );
        assertEq(
            type(IScaledUIAmountConversion).interfaceId,
            bytes4(0x57854fc3),
            "IScaledUIAmountConversion (optional ext)"
        );
        assertEq(
            type(IScaledUIAmountBalances).interfaceId,
            bytes4(0xd890fd71),
            "IScaledUIAmountBalances (optional ext)"
        );
    }

    function test_UiMultiplier_MatchesOkuMMultiplier() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);
        vm.warp(block.timestamp + 30 days);

        assertEq(okuMoney.uiMultiplier(), okuMoney.okuMMultiplier());
    }

    // ============ ERC-8056 value surface (previously zero coverage) ============

    /// @notice REGRESSION: with a bounded active window but NO successor
    ///         armed, effectiveAt() must return 0 ("nothing scheduled") — not
    ///         okuMRateEnd. Before the fix, this returned the active window's
    ///         end timestamp even with nothing staged, falsely signaling a
    ///         scheduled change to any indexer/UI reading the ERC-8056 surface.
    function test_EffectiveAt_ReturnsZero_WhenNoSuccessorArmed() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);

        assertEq(okuMoney.effectiveAt(), 0, "no successor armed -> nothing scheduled");
    }

    /// @notice effectiveAt() returns the active window's end ONLY once a
    ///         successor is actually staged via setNextOkuMYieldRate.
    function test_EffectiveAt_ReturnsRateEnd_WhenSuccessorArmed() public {
        uint256 endTime = block.timestamp + 60 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        assertEq(
            okuMoney.effectiveAt(), endTime, "successor armed -> reports the activation timestamp"
        );
    }

    /// @notice effectiveAt() returns 0 when accrual is halted (rateEnd == 0).
    function test_EffectiveAt_ReturnsZero_WhenHalted() public view {
        assertEq(okuMoney.effectiveAt(), 0, "halted at init -> nothing scheduled");
    }

    /// @notice effectiveAt() returns 0 once the active window has already
    ///         elapsed, even if a successor WAS armed — the successor has
    ///         ACTIVATED by then (it's the current rate now), not "scheduled".
    function test_EffectiveAt_ReturnsZero_AfterWindowElapsed() public {
        uint256 endTime = block.timestamp + 60 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        vm.warp(endTime + 1);
        assertEq(okuMoney.effectiveAt(), 0, "successor already activated -> nothing PENDING");
    }

    /// @notice REGRESSION companion to effectiveAt(): newUIMultiplier() must
    ///         equal the current uiMultiplier() (not a fabricated projection)
    ///         whenever effectiveAt() reports nothing scheduled.
    function test_NewUIMultiplier_EqualsCurrent_WhenNoSuccessorArmed() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);
        vm.warp(block.timestamp + 10 days);

        assertEq(okuMoney.newUIMultiplier(), okuMoney.uiMultiplier());
    }

    /// @notice newUIMultiplier() projects the multiplier value AT the
    ///         successor's activation instant when one IS armed.
    function test_NewUIMultiplier_ProjectsValueAtActivation_WhenSuccessorArmed() public {
        uint256 endTime = block.timestamp + 60 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        uint256 projected = okuMoney.newUIMultiplier();
        vm.warp(endTime);
        assertEq(
            projected,
            okuMoney.okuMMultiplier(),
            "projection must match the value actually reached at activation"
        );
    }

    /// @notice toUIAmount / fromUIAmount are exact inverses at a non-trivial
    ///         multiplier, and both delegate to okuMMultiplier() correctly.
    function test_ToUIAmount_FromUIAmount_RoundTrip() public {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);
        vm.warp(block.timestamp + 30 days);

        uint256 rawAmount = 12_345e18;
        uint256 uiAmount = okuMoney.toUIAmount(rawAmount);
        assertEq(uiAmount, (rawAmount * okuMoney.okuMMultiplier()) / PRECISION);
        assertEq(
            okuMoney.fromUIAmount(uiAmount),
            rawAmount,
            "floor rounding round-trips exactly at these magnitudes"
        );
    }

    /// @notice toUIAmount(0) == 0 and fromUIAmount(0) == 0 (no division-by-zero
    ///         or off-by-one at the boundary).
    function test_ToUIAmount_FromUIAmount_ZeroAmount() public view {
        assertEq(okuMoney.toUIAmount(0), 0);
        assertEq(okuMoney.fromUIAmount(0), 0);
    }

    /// @notice balanceOfUI scales an account's raw balance() by the current
    ///         multiplier, exactly matching toUIAmount(balanceOf(account)).
    function test_BalanceOfUI_MatchesToUIAmountOfBalance() public {
        _mintOkuMoney(user1, 5000e18);
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);
        vm.warp(block.timestamp + 30 days);

        assertGt(
            okuMoney.balanceOf(user1),
            0,
            "test fixture must fund user1 for this assertion to be meaningful"
        );
        assertEq(okuMoney.balanceOfUI(user1), okuMoney.toUIAmount(okuMoney.balanceOf(user1)));
    }

    /// @notice totalSupplyUI scales totalSupply() by the current multiplier,
    ///         exactly matching toUIAmount(totalSupply()).
    function test_TotalSupplyUI_MatchesToUIAmountOfTotalSupply() public {
        _mintOkuMoney(user1, 5000e18);
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e11, block.timestamp + 60 days);
        vm.warp(block.timestamp + 30 days);

        assertGt(
            okuMoney.totalSupply(),
            0,
            "test fixture must have non-zero supply for this assertion to be meaningful"
        );
        assertEq(okuMoney.totalSupplyUI(), okuMoney.toUIAmount(okuMoney.totalSupply()));
    }

    /// @notice Regression: staging a successor via `setNextOkuMYieldRate`, then
    ///         overwriting the schedule with a fresh `setOkuMYieldRate` call, must
    ///         emit `UIMultiplierUpdateCancelled` for the superseded successor.
    function test_SetOkuMYieldRate_EmitsCancelledForSupersededPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);

        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        vm.expectEmit(false, false, false, false);
        emit IScaledUIAmount.UIMultiplierUpdateCancelled(0, 0);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 3e10, block.timestamp + 90 days);
    }

    /// @notice Regression: the discrete override also cancels an armed successor.
    function test_SetOkuMMultiplier_EmitsCancelledForArmedPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        vm.expectEmit(false, false, false, false);
        emit IScaledUIAmount.UIMultiplierUpdateCancelled(0, 0);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
    }

    /// @notice Regression: re-anchoring via `setOkuMYieldRate` AFTER the staged
    ///         successor's `rateEnd` has already elapsed must NOT emit
    ///         `UIMultiplierUpdateCancelled` — the successor has already ACTIVATED
    ///         by that point (see {MathLib.computeMultiplier} branch 2), so this is
    ///         a promotion/re-anchor, not a cancellation of a still-future rate.
    ///         Before the `block.timestamp < rateEnd` guard was added, this call
    ///         spuriously emitted the cancellation event every single epoch under a
    ///         fixed-epoch operating model — wrong ERC-8056 semantics and a false
    ///         signal to any indexer/monitor reading the event stream.
    function test_SetOkuMYieldRate_DoesNotEmitCancelledForAlreadyActivatedSuccessor() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        // Warp PAST rateEnd: the staged successor is now the active, accruing
        // rate (per computeMultiplier branch 2), not a pending future one.
        vm.warp(endTime + 1);

        vm.recordLogs();
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 3e10, block.timestamp + 90 days);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 cancelledTopic = keccak256("UIMultiplierUpdateCancelled(uint256,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            assertTrue(
                entries[i].topics[0] != cancelledTopic,
                "UIMultiplierUpdateCancelled must not fire for an already-activated successor"
            );
        }
    }

    // ============ setOkuMYieldRateWithSuccessor ============

    /// @notice Baseline: the combined call produces IDENTICAL state to calling
    ///         setOkuMYieldRate then setNextOkuMYieldRate as two transactions.
    function test_SetOkuMYieldRateWithSuccessor_MatchesTwoSeparateCalls() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 nextEnd = endTime + 30 days;

        // Reference: two separate calls, on a fork of state via snapshot.
        uint256 snapshotId = vm.snapshotState();
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, nextEnd);
        uint256 refRate = okuMoney.okuMRatePerSecond();
        uint256 refRateEnd = okuMoney.okuMRateEnd();
        uint256 refPending = okuMoney.okuMPendingRatePerSecond();
        uint256 refPendingEnd = okuMoney.okuMPendingRateEnd();
        uint256 refMultiplier = okuMoney.okuMMultiplier();
        vm.revertToState(snapshotId);

        // Combined call, from identical starting state.
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 1393e6, endTime, PRECISION + 2000e6, nextEnd
        );

        assertEq(okuMoney.okuMRatePerSecond(), refRate, "active rate matches");
        assertEq(okuMoney.okuMRateEnd(), refRateEnd, "rateEnd matches");
        assertEq(okuMoney.okuMPendingRatePerSecond(), refPending, "pending rate matches");
        assertEq(okuMoney.okuMPendingRateEnd(), refPendingEnd, "pendingRateEnd matches");
        assertEq(okuMoney.okuMMultiplier(), refMultiplier, "multiplier matches");
    }

    /// @notice The successor activates with no transaction, identically to the
    ///         two-call path — the combined function doesn't change that guarantee.
    function test_SetOkuMYieldRateWithSuccessor_SuccessorActivatesWithoutTransaction() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 nextEnd = endTime + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 1393e6, endTime, PRECISION + 2000e6, nextEnd
        );

        vm.warp(endTime);
        uint256 atBoundary = okuMoney.okuMMultiplier();
        vm.warp(endTime + 30 days);

        assertGt(okuMoney.okuMMultiplier(), atBoundary, "successor accrued with no tx");
    }

    /// @notice Regression: this is the atomicity hazard the function exists to close.
    ///         Calling setOkuMYieldRate alone (the first half of the old two-tx
    ///         pattern) leaves NO successor armed — accrual halts at endTime with
    ///         nothing staged, until a human notices. setOkuMYieldRateWithSuccessor
    ///         must never leave the schedule in this state after a successful call.
    function test_SetOkuMYieldRateWithSuccessor_NeverLeavesNoSuccessorArmed() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 nextEnd = endTime + 30 days;

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 1393e6, endTime, PRECISION + 2000e6, nextEnd
        );

        // Both halves landed: a successor IS armed (in contrast to the bare
        // setOkuMYieldRate path, where okuMPendingRatePerSecond would be PRECISION
        // / "none armed" until a second transaction lands).
        assertGt(okuMoney.okuMPendingRatePerSecond(), PRECISION, "successor is armed");
        assertEq(okuMoney.okuMPendingRateEnd(), nextEnd, "successor window recorded");
    }

    /// @notice Reverts propagate from the FIRST half (active-rate validation) exactly
    ///         as setOkuMYieldRate alone would, with the second half's writes never
    ///         applied (state fully reverts atomically on any failure).
    function test_SetOkuMYieldRateWithSuccessor_RevertsFromFirstHalfLeavesStateUnchanged() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 nextEnd = endTime + 30 days;

        uint256 rateBefore = okuMoney.okuMRatePerSecond();
        uint256 pendingBefore = okuMoney.okuMPendingRatePerSecond();

        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateTooHigh.selector);
        okuMoney.setOkuMYieldRateWithSuccessor(MAX_RATE + 1, endTime, PRECISION + 2000e6, nextEnd);

        assertEq(okuMoney.okuMRatePerSecond(), rateBefore, "active rate unchanged after revert");
        assertEq(
            okuMoney.okuMPendingRatePerSecond(),
            pendingBefore,
            "pending rate unchanged after revert"
        );
    }

    /// @notice Reverts propagate from the SECOND half (successor validation) too,
    ///         and roll back the FIRST half's writes — no partial application.
    function test_SetOkuMYieldRateWithSuccessor_RevertsFromSecondHalfRollsBackFirstHalf() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 rateBefore = okuMoney.okuMRatePerSecond();
        uint256 rateEndBefore = okuMoney.okuMRateEnd();

        // nextEndTimestamp <= endTimestamp violates PendingEndNotAfterRateEnd —
        // the FIRST half (setOkuMYieldRate's body) would otherwise have succeeded
        // in isolation.
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.PendingEndNotAfterRateEnd.selector);
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 1393e6, endTime, PRECISION + 2000e6, endTime
        );

        assertEq(okuMoney.okuMRatePerSecond(), rateBefore, "first half's rate write rolled back");
        assertEq(okuMoney.okuMRateEnd(), rateEndBefore, "first half's rateEnd write rolled back");
    }

    /// @notice A previously-armed successor is correctly reported cancelled when
    ///         superseded via the combined call, exactly as it would be via
    ///         setOkuMYieldRate alone — the shared _emitPendingRateCancelledIfArmed
    ///         path observes pre-mutation state regardless of which entry point
    ///         invoked it.
    function test_SetOkuMYieldRateWithSuccessor_EmitsCancelledForSupersededPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1e10, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2e10, endTime + 30 days);

        vm.expectEmit(false, false, false, false);
        emit IScaledUIAmount.UIMultiplierUpdateCancelled(0, 0);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 3e10,
            block.timestamp + 90 days,
            PRECISION + 4e10,
            block.timestamp + 120 days
        );
    }

    /// @notice Only OKUM_REBASER may call the combined function.
    function test_SetOkuMYieldRateWithSuccessor_RevertsIfNotRebaser() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(this),
                OKUM_REBASER
            )
        );
        okuMoney.setOkuMYieldRateWithSuccessor(
            PRECISION + 1e10, endTime, PRECISION + 2e10, endTime + 30 days
        );
    }

    /// @dev Reachable simply from the default (halted) post-initialize state — under
    ///      the mandatory-end-timestamp invariant, `okuMRateEnd == 0` if and only if
    ///      the active rate is halted, and a halted schedule was never given a
    ///      window to stage a successor against.
    function test_SetNextOkuMYieldRate_RevertsWhenNoRateEnd() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.NoRateEndSet.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, block.timestamp + 60 days);
    }

    function test_SetNextOkuMYieldRate_RevertsWhenAlreadyExpired() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        // `>=` boundary: exactly endTime already reverts.
        vm.warp(endTime);
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateAlreadyExpired.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, endTime + 60 days);
    }

    function test_SetNextOkuMYieldRate_SucceedsOneSecondBeforeEnd() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.warp(endTime - 1);
        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(nextRate, endTime + 60 days);

        assertEq(okuMoney.okuMPendingRatePerSecond(), nextRate);
    }

    function test_SetNextOkuMYieldRate_RevertsOnRateTooHigh() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.RateTooHigh.selector);
        okuMoney.setNextOkuMYieldRate(MAX_RATE + 1, endTime + 60 days);
    }

    /// @dev Regression: `pendingEndTimestamp` must be strictly after `okuMRateEnd`.
    function test_SetNextOkuMYieldRate_RevertsOnPendingEndNotAfterRateEnd() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.PendingEndNotAfterRateEnd.selector);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, endTime);
    }

    /// @notice The successor activates off the absolute `okuMRateEnd` with NO
    ///         transaction at the boundary — the cross-chain-safety primitive.
    function test_SetNextOkuMYieldRate_ActivatesWithoutTransaction() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, endTime + 60 days);

        vm.warp(endTime);
        uint256 atBoundary = okuMoney.okuMMultiplier();
        vm.warp(endTime + 30 days);

        assertGt(okuMoney.okuMMultiplier(), atBoundary, "successor accrued with no tx");
    }

    /// @notice The pending successor's own compounding halts at `pendingRateEnd`,
    ///         bounding the overhang instead of letting it run forever.
    function test_SetNextOkuMYieldRate_OverhangBoundedByPendingRateEnd() public {
        uint256 endTime = block.timestamp + 30 days;
        uint256 pendingEnd = endTime + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);
        vm.prank(rebaser);
        okuMoney.setNextOkuMYieldRate(PRECISION + 2000e6, pendingEnd);

        assertEq(okuMoney.okuMPendingRateEnd(), pendingEnd, "pendingRateEnd stored");

        vm.warp(endTime + 1);
        assertEq(
            okuMoney.okuMEffectiveRatePerSecond(),
            PRECISION + 2000e6,
            "effective rate reflects the activated successor"
        );

        vm.warp(pendingEnd);
        uint256 atPendingEnd = okuMoney.okuMMultiplier();
        vm.warp(pendingEnd + 365 days);

        assertEq(
            okuMoney.okuMMultiplier(),
            atPendingEnd,
            "accrual halts once the pending rate's own window elapses"
        );
        assertEq(
            okuMoney.okuMEffectiveRatePerSecond(),
            PRECISION,
            "effective rate reports halted once pendingRateEnd elapses too"
        );
    }

    /// @notice With no successor armed, accrual halts at `okuMRateEnd`.
    function test_RateExpiry_HaltsAccrualWhenNoPending() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION + 1393e6, endTime);

        vm.warp(endTime);
        uint256 atEnd = okuMoney.okuMMultiplier();
        vm.warp(endTime + 100 days);

        assertEq(okuMoney.okuMMultiplier(), atEnd, "no accrual past expiry without a successor");
    }

    // ============ okuMMultiplier Tests (Halted Schedule) ============
    //
    // These exercise `setOkuMMultiplier` (the discrete override) against the
    // default halted schedule (no active rate armed). `okuMMultiplier()` is
    // COMPUTED, not stored (see MathLib.computeMultiplier) — it only appears
    // constant here because there is no rate accruing; see the
    // `testFuzz_SetOkuMYieldRate_*` tests for the streaming/time-dependent case.

    function test_OkuMPrice_UnaffectedByTimeWhenScheduleHalted() public {
        assertEq(okuMoney.okuMMultiplier(), PRECISION);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 3);

        assertEq(okuMoney.okuMMultiplier(), PRECISION * 3);
    }

    function test_OkuMMultiplierConstantBetweenUpdates() public {
        // Price does not change without an explicit call while the schedule is halted
        uint256 price0 = okuMoney.okuMMultiplier();

        // No calls — price stays the same
        assertEq(okuMoney.okuMMultiplier(), price0);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
        uint256 price1 = okuMoney.okuMMultiplier();
        assertEq(price1, PRECISION * 2);

        // Still no automatic change
        assertEq(okuMoney.okuMMultiplier(), price1);
    }

    // ============ Yield Distribution Block Tests (Sandwich Attack Prevention) ============
    //
    // REMOVED (streaming-accrual refactor): the distributeYield-driven variants
    // (test_DistributeYield_SetsLastYieldDistributionBlock,
    // test_DistributeYield_UpdatesLastYieldDistributionBlock,
    // test_LastYieldDistributionBlock_UpdatesOnEachDistribution). `setOkuMMultiplier`
    // is now the SOLE function that stamps `lastYieldDistributionBlock` — continuous
    // accrual creates no step, so `setOkuMYieldRate` deliberately does not stamp
    // (see test_SetOkuMYieldRate_DoesNotStampYieldBlock).

    function test_LastYieldDistributionBlock_InitiallyZero() public view {
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);
    }

    function test_SetOkuMMultiplier_SetsLastYieldDistributionBlock() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_SetOkuMMultiplier_UpdatesLastYieldDistributionBlock() public {
        uint256 blockBefore = okuMoney.lastYieldDistributionBlock();
        assertEq(blockBefore, 0);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_LastYieldDistributionBlock_UpdatesOnEachOverride() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
        uint256 block1 = okuMoney.lastYieldDistributionBlock();

        vm.roll(block.number + 10);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 3);
        uint256 block2 = okuMoney.lastYieldDistributionBlock();

        assertEq(block2, block1 + 10);
    }

    // ============ Blacklisting Tests ============

    function test_Blacklist_OnlyBlacklisterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_BLACKLISTER
            )
        );
        okuMoney.blacklist(user2);
    }

    function test_Blacklist_WorksWhilePaused() public {
        // Pause the contract
        vm.prank(pauser);
        okuMoney.pause();

        // Blacklist should still work (critical for front-run protection)
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        assertTrue(okuMoney.isBlacklisted(user1));
    }

    function test_Blacklist_BlocksTransfersFrom() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransfersTo() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksMinting() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        okuMoney.mint(user1, 100e18);
    }

    function test_Blacklist_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Blacklisted(user1);

        vm.prank(blacklister);
        okuMoney.blacklist(user1);
    }

    function test_Unblacklist_RestoresTransferability() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(unblacklister);
        okuMoney.unblacklist(user1);

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 50e18));

        assertEq(okuMoney.balanceOf(user2), 50e18);
    }

    function test_Unblacklist_EmitsEvent() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.expectEmit(true, false, false, false);
        emit Unblacklisted(user1);

        vm.prank(unblacklister);
        okuMoney.unblacklist(user1);
    }

    // ============ Pause Tests ============

    function test_Pause_OnlyPauserRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_PAUSER
            )
        );
        okuMoney.pause();
    }

    function test_Pause_BlocksTransfers() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, user2, 100e18);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transferFrom(user1, user3, 50e18);
    }

    function test_Pause_BlocksMinting() public {
        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuMoney.mint(user1, 100e18);
    }

    function test_Pause_AllowsBlacklisting() public {
        vm.prank(pauser);
        okuMoney.pause();

        // Should still be able to blacklist while paused
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        assertTrue(okuMoney.isBlacklisted(user1));
    }

    function test_Unpause_RestoresOperations() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(pauser);
        okuMoney.pause();

        vm.prank(unpauser);
        okuMoney.unpause();

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 50e18));

        assertEq(okuMoney.balanceOf(user2), 50e18);
    }

    // ============ Minter Allowance Tests ============

    function test_ConfigureMinterAllowance_OnlyAllowanceManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                OKUM_ALLOWANCE_MANAGER
            )
        );
        okuMoney.configureMinterAllowance(minter, 1000e18);
    }

    function test_ConfigureMinterAllowance_CanIncrease() public {
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, MAX_SUPPLY * 2);

        assertEq(okuMoney.minterAllowance(minter), MAX_SUPPLY * 2);
    }

    function test_ConfigureMinterAllowance_CanDecrease() public {
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, 100e18);

        assertEq(okuMoney.minterAllowance(minter), 100e18);
    }

    function test_ConfigureMinterAllowance_CanReset() public {
        // Use some allowance
        _mintOkuMoney(user1, 100e18);
        uint256 allowanceAfterMint = okuMoney.minterAllowance(minter);

        // Admin resets allowance
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, MAX_SUPPLY);

        assertEq(okuMoney.minterAllowance(minter), MAX_SUPPLY);
        assertGt(okuMoney.minterAllowance(minter), allowanceAfterMint);
    }

    function test_ConfigureMinterAllowance_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinterAllowanceUpdated(minter, MAX_SUPPLY, 1000e18);

        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, 1000e18);
    }

    // ============ Supply Cap Tests ============

    function test_SetMaxSupply_OnlyCapManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_CAP_MANAGER
            )
        );
        okuMoney.setMaxSupply(MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanIncrease() public {
        vm.prank(capManager);
        okuMoney.setMaxSupply(MAX_SUPPLY * 2);

        assertEq(okuMoney.maxSupply(), MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanDecrease() public {
        vm.prank(capManager);
        okuMoney.setMaxSupply(MAX_SUPPLY / 2);

        assertEq(okuMoney.maxSupply(), MAX_SUPPLY / 2);
    }

    function test_SetMaxSupply_DoesNotAffectExistingSupply() public {
        _mintOkuMoney(user1, 100e18);

        // Cannot lower cap below existing supply (M-3 fix: floor guard)
        vm.prank(capManager);
        vm.expectRevert(OkuMoney.BelowCurrentSupply.selector);
        okuMoney.setMaxSupply(50e18);

        // Existing tokens are not burned — supply unchanged after revert
        assertEq(okuMoney.balanceOf(user1), 100e18);
        assertEq(okuMoney.totalSupply(), 100e18);
        // maxSupply also unchanged
        assertEq(okuMoney.maxSupply(), MAX_SUPPLY);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MaxSupplyUpdated(MAX_SUPPLY, MAX_SUPPLY * 2);

        vm.prank(capManager);
        okuMoney.setMaxSupply(MAX_SUPPLY * 2);
    }

    // ============ okuMMultiplier Computation Tests ============

    function test_OkuMMultiplier_AtInitialPrice() public view {
        uint256 price = okuMoney.okuMMultiplier();
        assertEq(price, PRECISION); // Starts at 1e18 ($1.00)
    }

    function test_OkuMMultiplier_AfterUpdate() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.okuMMultiplier(), PRECISION * 2);
    }

    // ============ Edge Case Tests ============

    function test_Mint_ZeroAmount_Succeeds() public {
        // The amount > 0 guard was intentionally removed — callers may waste gas if
        // they want. Validate the *observable* behaviour: a Transfer(0, user, 0) event
        // is emitted and minter allowance is not decremented.
        uint256 balanceBefore = okuMoney.balanceOf(user1);
        uint256 allowanceBefore = okuMoney.minterAllowance(minter);

        vm.expectEmit(true, true, false, true, address(okuMoney));
        emit IERC20.Transfer(address(0), user1, 0);
        vm.prank(minter);
        okuMoney.mint(user1, 0);

        assertEq(okuMoney.balanceOf(user1), balanceBefore);
        assertEq(okuMoney.minterAllowance(minter), allowanceBefore);
    }

    function test_Transfer_ZeroAmount() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 0));

        assertEq(okuMoney.balanceOf(user2), 0);
    }

    function test_Mint_ExactMaxSupply() public {
        vm.prank(minter);
        okuMoney.mint(user1, MAX_SUPPLY);

        assertEq(okuMoney.totalSupply(), MAX_SUPPLY);
    }

    function test_MultipleOkuMMultiplierUpdates_SameBlock() public {
        _mintOkuMoney(user1, 100e18);

        vm.startPrank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
        okuMoney.setOkuMMultiplier(PRECISION * 3);
        vm.stopPrank();

        // okuMMultiplier should be updated to 3x
        assertEq(okuMoney.okuMMultiplier(), PRECISION * 3);
        // balanceOf should NOT change — standard ERC-20
        assertEq(okuMoney.balanceOf(user1), 100e18);
    }

    // ============ EIP-2612 Permit Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuMoney.nonces(user);

        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        okuMoney.permit(user, user2, amount, deadline, v, r, s);

        assertEq(okuMoney.allowance(user, user2), amount);
        assertEq(okuMoney.nonces(user), nonce + 1);
    }

    function test_Permit_RevertsExpired() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp - 1; // Expired

        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                okuMoney.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.expectRevert(
            abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline)
        );
        okuMoney.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_RevertsInvalidSignature() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);
        uint256 wrongPk = 0xDEAD;

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                okuMoney.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest); // Wrong signer

        // The recovered signer is the WRONG key's address, and `owner` is `user`.
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20Permit.ERC2612InvalidSigner.selector, vm.addr(wrongPk), user
            )
        );
        okuMoney.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_NonceIncrementsOnSecondUse() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);

        // First permit
        _signAndPermit(userPk, user, user2, 50e18, block.timestamp + 1 hours);
        assertEq(okuMoney.nonces(user), 1);

        // Second permit (nonce=1 now)
        _signAndPermit(userPk, user, user2, 75e18, block.timestamp + 1 hours);
        assertEq(okuMoney.nonces(user), 2);
        assertEq(okuMoney.allowance(user, user2), 75e18);
    }

    function test_Permit_ReplayReverts() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuMoney.nonces(user);

        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        // First call succeeds
        okuMoney.permit(user, user2, amount, deadline, v, r, s);

        // Replay with same nonce reverts
        vm.expectRevert(); // ERC2612InvalidSigner (nonce mismatch)
        okuMoney.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_AllowsTransferFrom() public {
        uint256 userPk = user2Pk; // inherited from Actors / TestKeys
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        _mintOkuMoney(user, amount);

        // Sign permit for user2 to spend user's tokens
        _signAndPermit(userPk, user, user2, amount, block.timestamp + 1 hours);

        // user2 can now transferFrom
        vm.prank(user2);
        assertTrue(okuMoney.transferFrom(user, user3, amount));

        assertEq(okuMoney.balanceOf(user3), amount);
        assertEq(okuMoney.balanceOf(user), 0);
    }

    // ============ UUPS Upgrade Tests ============

    function test_UUPS_UpgradeOkuMoney() public {
        OkuMoney okuMoneyV2 = new OkuMoney();

        vm.prank(admin);
        okuMoney.upgradeToAndCall(address(okuMoneyV2), "");

        // State preserved
        assertEq(okuMoney.name(), "OkuMoney");
        assertEq(okuMoney.okuMMultiplier(), PRECISION);
        assertEq(okuMoney.maxSupply(), MAX_SUPPLY);
    }

    function test_UUPS_UpgradeOkuMoney_RevertNotUpgrader() public {
        OkuMoney okuMoneyV2 = new OkuMoney();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_UPGRADER
            )
        );
        okuMoney.upgradeToAndCall(address(okuMoneyV2), "");
    }

    // ============ Internal Helpers ============

    function _getOkuMoneyDomainSeparator() internal view returns (bytes32) {
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

    function _signAndPermit(
        uint256 ownerPk,
        address owner,
        address spender,
        uint256 value,
        uint256 deadline
    )
        internal
    {
        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                spender,
                value,
                okuMoney.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        okuMoney.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Permit Blacklist Guards ============
    //
    // OkuMoney.permit blocks blacklisted owners and spenders before delegating
    // to OZ's ERC20Permit. Both branches are exercised below.

    function test_Permit_RevertBlacklistedOwner() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        // Bogus signature is fine — call must revert before signature check.
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        okuMoney.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    function test_Permit_RevertBlacklistedSpender() public {
        // Owner is clean; blacklist the spender.
        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        okuMoney.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    /// @notice `approve` mirrors `permit`'s posture: a blacklisted spender cannot be approved.
    function test_Approve_RevertsOnBlacklistedSpender() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        okuMoney.approve(user2, 50e18);
    }

    /// @notice `approve` does not retroactively revoke a pre-existing allowance —
    ///         only new/updated approvals are blocked.
    function test_Approve_DoesNotRevokeExistingAllowanceOnBlacklist() public {
        vm.prank(user1);
        okuMoney.approve(user2, 50e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        assertEq(okuMoney.allowance(user1, user2), 50e18, "pre-existing allowance untouched");
    }

    /// @notice `approve` also blocks a blacklisted OWNER from creating a new
    ///         allowance, matching Circle FiatToken's `notBlacklisted(msg.sender)`.
    function test_Approve_RevertsOnBlacklistedOwner() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        okuMoney.approve(user2, 50e18);
    }

    // ============ Circle Parity: blacklisted spender cannot exercise a prior allowance ============

    /// @notice THE gap this parity pass closes. A blacklisted spender holding a
    ///         pre-existing allowance (deliberately not revoked by `blacklist()` —
    ///         see {test_Approve_DoesNotRevokeExistingAllowanceOnBlacklist}) must not
    ///         be able to move CLEAN funds between CLEAN addresses via
    ///         `transferFrom`. Before this fix, OkuMoney inherited OZ's
    ///         `transferFrom` unmodified — it only checked `from`/`to` (via
    ///         `_update`), never the third party in the call, the spender itself.
    function test_TransferFrom_RevertsOnBlacklistedSpender_EvenWithPriorAllowance() public {
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(user2, 50e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        // Allowance is still there -- this assertion documents the precondition the
        // revert below depends on, not a redundant re-check of the test above.
        assertEq(
            okuMoney.allowance(user1, user2), 50e18, "precondition: allowance survives blacklisting"
        );

        vm.prank(user2);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        okuMoney.transferFrom(user1, user3, 50e18);
    }

    /// @notice Sanity check in the other direction: an allowance-holder who is NOT
    ///         blacklisted can still exercise it normally. Isolates "the new check
    ///         blocks blacklisted spenders" from "the new check blocks all spenders."
    function test_TransferFrom_SucceedsForCleanSpender() public {
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(user2, 50e18);

        vm.prank(user2);
        okuMoney.transferFrom(user1, user3, 50e18);

        assertEq(okuMoney.balanceOf(user3), 50e18);
    }

    /// @notice Circle parity: the MINTER (not just the recipient) must not be
    ///         blacklisted. `OKUM_MINTER` is infra (`LitePSM`), not a partner EOA
    ///         the way Circle's minters are, so this is a self-brick vector that
    ///         should never fire in practice -- but it's what the cited reference
    ///         (FiatTokenV2.sol) actually does, and the check is one SLOAD.
    function test_Mint_RevertsOnBlacklistedMinter() public {
        vm.prank(blacklister);
        okuMoney.blacklist(minter);

        vm.prank(minter);
        vm.expectRevert(OkuMoney.SenderBlacklisted.selector);
        okuMoney.mint(user1, 100e18);
    }

    // ============ AlreadyBlacklisted Guard ============

    function test_Blacklist_RevertsOnDoubleBlacklist() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(blacklister);
        vm.expectRevert(OkuMoney.AlreadyBlacklisted.selector);
        okuMoney.blacklist(user1);
    }

    function test_Unblacklist_RevertsOnNotBlacklisted() public {
        vm.prank(unblacklister);
        vm.expectRevert(OkuMoney.NotBlacklisted.selector);
        okuMoney.unblacklist(user1);
    }

    // ============ Initialization rails ============
    //
    // Relocated from the former CoverageGaps.t.sol, which existed to move a
    // branch-coverage number rather than to verify behaviour. These belong with
    // the contract they test.

    function test_Initialize_RevertZeroAdmin() public {
        OkuMoney impl = new OkuMoney();
        bytes memory initData =
            abi.encodeCall(OkuMoney.initialize, ("OkuMoney", "OkuM", address(0), MAX_SUPPLY));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    /// @notice The discrete override is hard-capped; it reverts rather than clamping.
    /// @dev Deliberately asymmetric with streaming accrual, which SATURATES at the
    ///      same ceiling (see `test_UsdMultiplier_SaturatesAtMaxMultiplier`). An
    ///      operator typo must fail loudly; time passing must not brick the token.
    function test_SetOkuMMultiplier_RevertMultiplierTooHigh() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.MultiplierTooHigh.selector);
        okuMoney.setOkuMMultiplier(Constants.MAX_MULTIPLIER + 1);
    }

    function test_ConfigureMinterAllowance_RevertZeroAddress() public {
        vm.prank(allowanceManager);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuMoney.configureMinterAllowance(address(0), 1000e18);
    }
}
