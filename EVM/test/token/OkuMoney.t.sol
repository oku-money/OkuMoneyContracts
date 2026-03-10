// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";

/**
 * @title OkuMoneyTest
 * @notice Unit tests for OkuMoney non-rebasing ERC-20 token with price accrual
 */
contract OkuMoneyTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event OkuMPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event YieldRateUpdated(uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotPrice);
    event NextYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
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

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuMoney.decimals(), 18);
    }

    function test_Initialize_SetsCorrectAdmin() public view {
        assertTrue(okuMoney.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Initialize_SetsCorrectMaxSupply() public view {
        assertEq(okuMoney.maxSupply(), MAX_SUPPLY);
    }

    function test_Initialize_SetsInitialNotePrice() public view {
        assertEq(okuMoney.okuMPrice(), PRECISION);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        okuMoney.initialize("OkuMoney2", "OKUNOTE2", admin, MAX_SUPPLY);
    }

    // ============ Minting Tests ============

    function test_Mint_OnlyMinterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
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
        // Set notePrice to 2x before minting
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // balanceOf returns raw amount, NOT divided by notePrice
        assertEq(okuMoney.balanceOf(user1), amount);
    }

    function test_Mint_IncreasesTotalSupply() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);
        assertEq(okuMoney.totalSupply(), amount);
    }

    function test_Mint_TotalSupplyIsRawAmount() public {
        // Set notePrice to 2x before minting
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // totalSupply returns raw token count, NOT multiplied by notePrice
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
        vm.expectRevert("Exceeds minter allowance");
        okuMoney.mint(user1, 100e18);
    }

    function test_Mint_RevertsExceedingMaxSupply() public {
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
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
        vm.expectRevert("Recipient blacklisted");
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

    function test_Burn_OnlyMinterRole() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
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
        // Set notePrice to 2x, then mint and burn
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        _mintOkuMoney(minter, 100e18);

        vm.prank(minter);
        okuMoney.burn(40e18);

        // burn(40e18) removes exactly 40e18 from balanceOf regardless of notePrice
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
        vm.expectRevert();
        okuMoney.burn(150e18);
    }

    function test_Burn_RevertsForBlacklistedAccount() public {
        _mintOkuMoney(minter, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(minter);

        vm.prank(minter);
        vm.expectRevert("Account blacklisted");
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
        // Set notePrice to 2x, then mint and transfer
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, 50e18));

        // transfer(50e18) moves exactly 50e18 in balanceOf regardless of notePrice
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
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsToBlacklisted() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsInsufficientBalance() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 150e18);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert();
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

    // ============ Note Price Tests ============

    function test_UpdateNotePrice_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.updateOkuMPrice(PRECISION * 2);
    }

    function test_UpdateNotePrice_CannotDecrease() public {
        vm.prank(rebaser);
        vm.expectRevert("Price cannot decrease");
        okuMoney.updateOkuMPrice(PRECISION - 1);
    }

    function test_UpdateNotePrice_DoesNotAffectBalances() public {
        _mintOkuMoney(user1, 100e18);
        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Double the note price
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        // balanceOf does NOT change with notePrice — standard ERC-20
        uint256 balanceAfter = okuMoney.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore);
    }

    function test_UpdateNotePrice_DoesNotAffectTotalSupply() public {
        _mintOkuMoney(user1, 100e18);
        uint256 supplyBefore = okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        // totalSupply does NOT change with notePrice — standard ERC-20
        assertEq(okuMoney.totalSupply(), supplyBefore);
    }

    function test_UpdateNotePrice_UpdatesNotePrice() public {
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        assertEq(okuMoney.okuMPrice(), PRECISION * 2);
    }

    function test_UpdateNotePrice_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit OkuMPriceUpdated(PRECISION, PRECISION * 2);

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);
    }

    function test_UpdateNotePrice_SamePrice() public {
        uint256 currentPrice = okuMoney.okuMPrice();

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(currentPrice);

        assertEq(okuMoney.okuMPrice(), currentPrice);
    }

    // ============ Blacklisting Tests ============

    function test_Blacklist_OnlyBlacklisterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BLACKLISTER
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
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransfersTo() public {
        _mintOkuMoney(user1, 100e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuMoney.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksMinting() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
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
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ALLOWANCE_MANAGER
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
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, CAP_MANAGER
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

        // Lower cap below existing supply
        vm.prank(capManager);
        okuMoney.setMaxSupply(50e18);

        // Existing tokens are not burned
        assertEq(okuMoney.balanceOf(user1), 100e18);
        assertEq(okuMoney.totalSupply(), 100e18);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MaxSupplyUpdated(MAX_SUPPLY, MAX_SUPPLY * 2);

        vm.prank(capManager);
        okuMoney.setMaxSupply(MAX_SUPPLY * 2);
    }

    // ============ Note Price Computation Tests ============

    function test_NotePrice_AtInitialPrice() public view {
        uint256 price = okuMoney.okuMPrice();
        assertEq(price, PRECISION); // Starts at 1e18 ($1.00)
    }

    function test_NotePrice_AfterUpdate() public {
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);

        assertEq(okuMoney.okuMPrice(), PRECISION * 2);
    }

    function test_NotePrice_GrowsWithYieldRate() public {
        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY per second

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        uint256 priceBefore = okuMoney.okuMPrice();

        vm.warp(block.timestamp + 1 days);

        uint256 priceAfter = okuMoney.okuMPrice();
        assertGt(priceAfter, priceBefore);
    }

    // ============ Edge Case Tests ============

    function test_Mint_ZeroAmount_RevertsAmountTooSmall() public {
        vm.prank(minter);
        vm.expectRevert("Amount too small");
        okuMoney.mint(user1, 0);
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

    function test_MultipleNotePriceUpdates_SameBlock() public {
        _mintOkuMoney(user1, 100e18);

        vm.startPrank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);
        okuMoney.updateOkuMPrice(PRECISION * 3);
        vm.stopPrank();

        // notePrice should be updated to 3x
        assertEq(okuMoney.okuMPrice(), PRECISION * 3);
        // balanceOf should NOT change — standard ERC-20
        assertEq(okuMoney.balanceOf(user1), 100e18);
    }

    // ============ Continuous Yield Accrual Tests ============

    function test_SetYieldRate_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.setYieldRate(PRECISION + 1, 0);
    }

    function test_SetYieldRate_NotePriceGrowsOverTime() public {
        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY per second

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        uint256 priceBefore = okuMoney.okuMPrice();

        vm.warp(block.timestamp + 1 days);

        uint256 priceAfter = okuMoney.okuMPrice();
        assertGt(priceAfter, priceBefore);
    }

    function test_SetYieldRate_BalancesDoNotGrow() public {
        _mintOkuMoney(user1, 1000e18);
        uint256 balanceBefore = okuMoney.balanceOf(user1);

        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 1 days);

        // balanceOf does NOT change — notePrice grows, not balances
        uint256 balanceAfter = okuMoney.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore);
    }

    function test_SetYieldRate_SnapshotPreservesValue() public {
        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        uint256 priceBefore = okuMoney.okuMPrice();

        // Set a new rate — should snapshot accrued price, not lose it
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        uint256 priceAfter = okuMoney.okuMPrice();
        assertEq(priceAfter, priceBefore);
    }

    function test_SetYieldRate_RateCannotBeNegative() public {
        vm.prank(rebaser);
        vm.expectRevert("Rate cannot be negative");
        okuMoney.setYieldRate(PRECISION - 1, 0);
    }

    function test_SetYieldRate_EndMustBeInFuture() public {
        // Warp to a realistic timestamp so block.timestamp - 1 != 0
        vm.warp(1000);

        vm.prank(rebaser);
        vm.expectRevert("End must be in the future");
        okuMoney.setYieldRate(PRECISION + 1, block.timestamp - 1);
    }

    function test_SetYieldRate_EmitsEvent() public {
        uint256 rate = 1_000_000_001_547_125_957;

        vm.expectEmit(false, false, false, true);
        emit YieldRateUpdated(rate, 0, PRECISION);

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);
    }

    function test_SetYieldRate_ZeroRateStopsAccrual() public {
        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);
        uint256 priceMid = okuMoney.okuMPrice();

        // Set rate to PRECISION (no yield)
        vm.prank(rebaser);
        okuMoney.setYieldRate(PRECISION, 0);

        vm.warp(block.timestamp + 30 days);
        uint256 priceEnd = okuMoney.okuMPrice();

        // Price should not change after stopping accrual
        assertEq(priceEnd, priceMid);
    }

    function test_SetNextYieldRate_ActivatesAtRateEnd() public {
        uint256 rate1 = 1_000_000_001_547_125_957; // ~5% APY
        uint256 rate2 = 1_000_000_002_877_801_985; // ~9.5% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.startPrank(rebaser);
        okuMoney.setYieldRate(rate1, endTime);
        okuMoney.setNextYieldRate(rate2);
        vm.stopPrank();

        // Before rateEnd — rate1 applies
        vm.warp(endTime - 1);
        uint256 priceBeforeEnd = okuMoney.okuMPrice();

        // After rateEnd — rate2 takes over
        vm.warp(endTime + 30 days);
        uint256 priceAfterEnd = okuMoney.okuMPrice();
        assertGt(priceAfterEnd, priceBeforeEnd);
    }

    function test_SetNextYieldRate_RequiresRateEnd() public {
        vm.prank(rebaser);
        okuMoney.setYieldRate(PRECISION + 1, 0); // no end time

        vm.prank(rebaser);
        vm.expectRevert("Current rate has no end");
        okuMoney.setNextYieldRate(PRECISION + 1);
    }

    function test_SetNextYieldRate_HeadToTail() public {
        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.startPrank(rebaser);
        okuMoney.setYieldRate(rate, endTime);
        okuMoney.setNextYieldRate(rate); // same rate continues
        vm.stopPrank();

        // Warp to just before boundary
        vm.warp(endTime - 1);
        uint256 priceBefore = okuMoney.okuMPrice();

        // Warp to just after boundary
        vm.warp(endTime + 1);
        uint256 priceAfter = okuMoney.okuMPrice();

        // Should have grown by ~2 seconds worth of yield — no gap, no jump
        assertGt(priceAfter, priceBefore);
        // The difference should be small (just 2 seconds of yield on base price)
        uint256 diff = priceAfter - priceBefore;
        assertLt(diff, 1e10); // tiny price increase for 2 seconds
    }

    function test_SetNextYieldRate_EmitsEvent() public {
        uint256 rate = 1_000_000_001_547_125_957;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, endTime);

        uint256 nextRate = 1_000_000_002_877_801_985;
        vm.expectEmit(false, false, false, true);
        emit NextYieldRateSet(nextRate, endTime);

        vm.prank(rebaser);
        okuMoney.setNextYieldRate(nextRate);
    }

    function test_SetNextYieldRate_OnlyRebaser() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuMoney.setYieldRate(PRECISION + 1, endTime);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.setNextYieldRate(PRECISION + 1);
    }

    function test_ContinuousAccrual_FrontRunUnprofitable() public {
        // Set up a realistic 4.5% APY rate
        // rate = (1.045)^(1/31536000) ≈ 1.000000001395766... × 1e18
        uint256 rate = 1_000_000_001_395_766_300;

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        uint256 usdcAttackAmount = 1_000_000e6; // $1M in USDC (6 decimals)

        // Fund buffer via bufferDepositor so redemption works
        _mintUsdc(bufferDepositor, usdcAttackAmount);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(litePsm), usdcAttackAmount);
        litePsm.depositBuffer(usdcAttackAmount);
        vm.stopPrank();

        // Attacker mints via PSM (PSM takes USDC amount in 6 decimals)
        _mintUsdc(user1, usdcAttackAmount);
        vm.startPrank(user1);
        usdc.approve(address(litePsm), usdcAttackAmount);
        litePsm.mint_OkuM(usdcAttackAmount);
        vm.stopPrank();

        uint256 balanceAfterMint = okuMoney.balanceOf(user1);

        // Advance 2 seconds (L2 block time)
        vm.warp(block.timestamp + 2);

        // balanceOf does NOT change (no rebasing) — attacker gains nothing from balance
        uint256 balanceAfterWarp = okuMoney.balanceOf(user1);
        assertEq(balanceAfterWarp, balanceAfterMint);

        // notePrice grows, but attacker's token count is unchanged
        // Any profit would only be realized through the PSM at the new notePrice
        // which is trivially small for 2 seconds
        uint256 priceBefore = okuMoney.okuMPrice();
        vm.warp(block.timestamp + 2);
        uint256 priceAfter = okuMoney.okuMPrice();
        uint256 priceDiff = priceAfter - priceBefore;
        assertLt(priceDiff, 1e10); // less than 1e-8 price change for 2 seconds
    }

    function test_ContinuousAccrual_MatchesExpectedAPY() public {
        // 4.5% APY: rate = (1.045)^(1/31536000) ≈ 1.000000001395766... × 1e18
        uint256 rate = 1_000_000_001_395_766_300;

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        // Warp 365 days
        vm.warp(block.timestamp + 365 days);

        uint256 price = okuMoney.okuMPrice();

        // Expected: PRECISION * 1.045 = 1.045e18 (within rounding tolerance)
        // Allow 0.1% tolerance for compounding approximation
        assertGt(price, 1044e15); // at least 4.4%
        assertLt(price, 1046e15); // at most 4.6%
    }

    function test_UpdateNotePrice_EmergencyOverride() public {
        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        uint256 computedPrice = okuMoney.okuMPrice();

        // Emergency override — set exact price, stops accrual
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(computedPrice);

        // Price should now be the exact snapshot
        assertEq(okuMoney.okuMPrice(), computedPrice);
        // Rate should be reset
        assertEq(okuMoney.ratePerSecond(), PRECISION);

        // Warp more — price should not grow (rate is zero)
        vm.warp(block.timestamp + 30 days);
        assertEq(okuMoney.okuMPrice(), computedPrice);
    }

    function test_BasePrice_ReturnsSnapshotValue() public {
        assertEq(okuMoney.basePrice(), PRECISION);

        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        // basePrice should still be PRECISION (snapshot hasn't been updated)
        assertEq(okuMoney.basePrice(), PRECISION);
        // notePrice should be higher
        assertGt(okuMoney.okuMPrice(), PRECISION);
    }

    function test_RateExpiry_StopsYieldWhenNoPendingRate() public {
        uint256 rate = 1_000_000_001_547_125_957;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, endTime);

        // Warp past end with no pending rate
        vm.warp(endTime + 30 days);
        uint256 priceAtExpiry = okuMoney.okuMPrice();

        // Warp more — price should not grow
        vm.warp(endTime + 60 days);
        assertEq(okuMoney.okuMPrice(), priceAtExpiry);
    }

    // ============ EIP-2612 Permit Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 userPk = 0xBEEF;
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
        uint256 userPk = 0xBEEF;
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

        vm.expectRevert(); // ERC2612ExpiredSignature
        okuMoney.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_RevertsInvalidSignature() public {
        uint256 userPk = 0xBEEF;
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

        vm.expectRevert(); // ERC2612InvalidSigner
        okuMoney.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_NonceIncrementsOnSecondUse() public {
        uint256 userPk = 0xBEEF;
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
        uint256 userPk = 0xBEEF;
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
        uint256 userPk = 0xBEEF;
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
        assertEq(okuMoney.okuMPrice(), PRECISION);
        assertEq(okuMoney.maxSupply(), MAX_SUPPLY);
    }

    function test_UUPS_UpgradeOkuMoney_RevertNotUpgrader() public {
        OkuMoney okuMoneyV2 = new OkuMoney();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, UPGRADER
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

    // ============ MAX_RATE Tests ============

    function test_SetYieldRate_RevertsAboveMaxRate() public {
        uint256 maxRate = okuMoney.MAX_RATE();

        vm.prank(rebaser);
        vm.expectRevert("Rate too high");
        okuMoney.setYieldRate(maxRate + 1, 0);
    }

    function test_SetYieldRate_AcceptsMaxRate() public {
        uint256 maxRate = okuMoney.MAX_RATE();

        vm.prank(rebaser);
        okuMoney.setYieldRate(maxRate, 0);

        assertEq(okuMoney.ratePerSecond(), maxRate);
    }

    function test_SetNextYieldRate_RevertsAboveMaxRate() public {
        uint256 maxRate = okuMoney.MAX_RATE();
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setYieldRate(PRECISION + 1, endTime);

        vm.prank(rebaser);
        vm.expectRevert("Rate too high");
        okuMoney.setNextYieldRate(maxRate + 1);
    }

    function test_SetNextYieldRate_AcceptsMaxRate() public {
        uint256 maxRate = okuMoney.MAX_RATE();
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuMoney.setYieldRate(PRECISION + 1, endTime);

        vm.prank(rebaser);
        okuMoney.setNextYieldRate(maxRate);

        assertEq(okuMoney.pendingRatePerSecond(), maxRate);
    }
}
