// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";

/**
 * @title OkuUSDTest
 * @notice Unit tests for OkuUSD rebasing token
 */
contract OkuUSDTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuUsd.name(), "OkuUSD");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuUsd.symbol(), "OKUSD");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuUsd.decimals(), 18);
    }

    function test_Initialize_SetsCorrectAdmin() public view {
        assertTrue(okuUsd.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Initialize_SetsCorrectMaxSupply() public view {
        assertEq(okuUsd.maxSupply(), MAX_SUPPLY);
    }

    function test_Initialize_SetsInitialMultiplier() public view {
        assertEq(okuUsd.rewardMultiplier(), PRECISION);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        okuUsd.initialize("OkuUSD2", "OKUSD2", admin, MAX_SUPPLY);
    }

    // ============ Minting Tests ============

    function test_Mint_OnlyMinterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
            )
        );
        okuUsd.mint(user1, 100e18);
    }

    function test_Mint_IncreasesBalance() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        assertEq(okuUsd.balanceOf(user1), amount);
    }

    function test_Mint_IncreasesShares() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        assertEq(okuUsd.sharesOf(user1), _tokensToShares(amount));
    }

    function test_Mint_IncreasesTotalSupply() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        assertEq(okuUsd.totalSupply(), amount);
    }

    function test_Mint_IncreasesTotalShares() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        assertEq(okuUsd.totalShares(), _tokensToShares(amount));
    }

    function test_Mint_DecrementsMinterAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuUsd.minterAllowance(minter);
        _mintOkuUsd(user1, amount);
        assertEq(okuUsd.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Mint_RevertsExceedingAllowance() public {
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, 50e18);

        vm.prank(minter);
        vm.expectRevert("Exceeds minter allowance");
        okuUsd.mint(user1, 100e18);
    }

    function test_Mint_RevertsExceedingMaxSupply() public {
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuUsd.mint(user1, MAX_SUPPLY + 1);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuUsd.mint(user1, 100e18);
    }

    function test_Mint_RevertsToBlacklistedAddress() public {
        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuUsd.mint(user1, 100e18);
    }

    function test_Mint_EmitsTransferEvent() public {
        uint256 amount = 100e18;
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, amount);

        vm.prank(minter);
        okuUsd.mint(user1, amount);
    }

    // ============ Burning Tests ============

    function test_Burn_OnlyMinterRole() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
            )
        );
        okuUsd.burn(50e18);
    }

    function test_Burn_DecreasesBalance() public {
        // Mint to minter so it can self-burn
        _mintOkuUsd(minter, 100e18);

        vm.prank(minter);
        okuUsd.burn(40e18);

        assertEq(okuUsd.balanceOf(minter), 60e18);
    }

    function test_Burn_DecreasesShares() public {
        _mintOkuUsd(minter, 100e18);
        uint256 sharesBefore = okuUsd.sharesOf(minter);

        vm.prank(minter);
        okuUsd.burn(40e18);

        assertEq(okuUsd.sharesOf(minter), sharesBefore - _tokensToShares(40e18));
    }

    function test_Burn_DecreasesTotalSupply() public {
        _mintOkuUsd(minter, 100e18);

        vm.prank(minter);
        okuUsd.burn(40e18);

        assertEq(okuUsd.totalSupply(), 60e18);
    }

    function test_Burn_DoesNotRestoreAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuUsd.minterAllowance(minter);

        _mintOkuUsd(minter, amount);
        uint256 allowanceAfterMint = okuUsd.minterAllowance(minter);

        vm.prank(minter);
        okuUsd.burn(amount);

        // Allowance should NOT be restored after burn
        assertEq(okuUsd.minterAllowance(minter), allowanceAfterMint);
        assertEq(okuUsd.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Burn_RevertsInsufficientBalance() public {
        _mintOkuUsd(minter, 100e18);

        vm.prank(minter);
        vm.expectRevert("Insufficient balance");
        okuUsd.burn(150e18);
    }

    function test_Burn_RevertsForBlacklistedAccount() public {
        _mintOkuUsd(minter, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(minter);

        vm.prank(minter);
        vm.expectRevert("Account blacklisted");
        okuUsd.burn(50e18);
    }

    function test_Burn_WorksWhenPaused() public {
        _mintOkuUsd(minter, 100e18);

        vm.prank(pauser);
        okuUsd.pause();

        // Burn should work when paused (no whenNotPaused modifier)
        vm.prank(minter);
        okuUsd.burn(50e18);

        assertEq(okuUsd.balanceOf(minter), 50e18);
    }

    function test_Burn_EmitsTransferEvent() public {
        _mintOkuUsd(minter, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(minter, address(0), 50e18);

        vm.prank(minter);
        okuUsd.burn(50e18);
    }

    // ============ Transfer Tests ============

    function test_Transfer_UpdatesBalances() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 30e18));

        assertEq(okuUsd.balanceOf(user1), 70e18);
        assertEq(okuUsd.balanceOf(user2), 30e18);
    }

    function test_Transfer_OperatesOnShares() public {
        _mintOkuUsd(user1, 100e18);
        uint256 user1SharesBefore = okuUsd.sharesOf(user1);
        uint256 totalSharesBefore = okuUsd.totalShares();

        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 30e18));

        // Total shares should be unchanged (internal transfer)
        assertEq(okuUsd.totalShares(), totalSharesBefore);

        // User shares should transfer correctly
        uint256 transferredShares = _tokensToShares(30e18);
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore - transferredShares);
        assertEq(okuUsd.sharesOf(user2), transferredShares);
    }

    function test_Transfer_RevertsWhenPaused() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsFromBlacklisted() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsToBlacklisted() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsInsufficientBalance() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 150e18);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Transfer to zero address");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(address(0), 30e18);
    }

    function test_Transfer_EmitsTransferEventWithTokenAmounts() public {
        _mintOkuUsd(user1, 100e18);

        // Event should emit token amount, not shares
        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 30e18);

        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 30e18));
    }

    function test_Transfer_ToSelf() public {
        _mintOkuUsd(user1, 100e18);
        uint256 balanceBefore = okuUsd.balanceOf(user1);

        vm.prank(user1);
        assertTrue(okuUsd.transfer(user1, 50e18));

        assertEq(okuUsd.balanceOf(user1), balanceBefore);
    }

    // ============ TransferFrom Tests ============

    function test_TransferFrom_UpdatesAllowance() public {
        _mintOkuUsd(user1, 100e18);
        _approveOkuUsd(user1, user2, 50e18);

        vm.prank(user2);
        assertTrue(okuUsd.transferFrom(user1, user3, 30e18));

        assertEq(okuUsd.allowance(user1, user2), 20e18);
    }

    function test_TransferFrom_RevertsInsufficientAllowance() public {
        _mintOkuUsd(user1, 100e18);
        _approveOkuUsd(user1, user2, 20e18);

        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, user2, 20e18, 30e18
            )
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transferFrom(user1, user3, 30e18);
    }

    function test_TransferFrom_RevertsWhenPaused() public {
        _mintOkuUsd(user1, 100e18);
        _approveOkuUsd(user1, user2, 50e18);

        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transferFrom(user1, user3, 30e18);
    }

    // ============ Rebasing Tests ============

    function test_UpdateRewardMultiplier_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, REBASER
            )
        );
        okuUsd.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_CannotDecrease() public {
        vm.prank(rebaser);
        vm.expectRevert("Multiplier cannot decrease");
        okuUsd.updateRewardMultiplier(PRECISION - 1);
    }

    function test_UpdateRewardMultiplier_UpdatesBalances() public {
        _mintOkuUsd(user1, 100e18);
        uint256 balanceBefore = okuUsd.balanceOf(user1);

        // Double the multiplier
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        uint256 balanceAfter = okuUsd.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore * 2);
    }

    function test_UpdateRewardMultiplier_UpdatesTotalSupply() public {
        _mintOkuUsd(user1, 100e18);
        uint256 supplyBefore = okuUsd.totalSupply();

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuUsd.totalSupply(), supplyBefore * 2);
    }

    function test_UpdateRewardMultiplier_SharesUnchanged() public {
        _mintOkuUsd(user1, 100e18);
        uint256 sharesBefore = okuUsd.sharesOf(user1);
        uint256 totalSharesBefore = okuUsd.totalShares();

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuUsd.sharesOf(user1), sharesBefore);
        assertEq(okuUsd.totalShares(), totalSharesBefore);
    }

    function test_UpdateRewardMultiplier_NoMaxSupplyCheck() public {
        // Mint close to max supply
        _mintOkuUsd(user1, MAX_SUPPLY);

        // Rebase should work even though it pushes supply above original maxSupply
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        // Supply is now 2x max, but this is allowed for rebase
        assertEq(okuUsd.totalSupply(), MAX_SUPPLY * 2);
    }

    function test_UpdateRewardMultiplier_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit RebaseEvent(PRECISION, PRECISION * 2);

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_SameMultiplier() public {
        uint256 currentMultiplier = okuUsd.rewardMultiplier();

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(currentMultiplier);

        assertEq(okuUsd.rewardMultiplier(), currentMultiplier);
    }

    // ============ Blacklisting Tests ============

    function test_Blacklist_OnlyBlacklisterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BLACKLISTER
            )
        );
        okuUsd.blacklist(user2);
    }

    function test_Blacklist_WorksWhilePaused() public {
        // Pause the contract
        vm.prank(pauser);
        okuUsd.pause();

        // Blacklist should still work (critical for front-run protection)
        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        assertTrue(okuUsd.isBlacklisted(user1));
    }

    function test_Blacklist_BlocksTransfersFrom() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransfersTo() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksMinting() public {
        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuUsd.mint(user1, 100e18);
    }

    function test_Blacklist_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Blacklisted(user1);

        vm.prank(blacklister);
        okuUsd.blacklist(user1);
    }

    function test_Unblacklist_RestoresTransferability() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.prank(unblacklister);
        okuUsd.unblacklist(user1);

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 50e18));

        assertEq(okuUsd.balanceOf(user2), 50e18);
    }

    function test_Unblacklist_EmitsEvent() public {
        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        vm.expectEmit(true, false, false, false);
        emit Unblacklisted(user1);

        vm.prank(unblacklister);
        okuUsd.unblacklist(user1);
    }

    // ============ Pause Tests ============

    function test_Pause_OnlyPauserRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUUSD_PAUSER
            )
        );
        okuUsd.pause();
    }

    function test_Pause_BlocksTransfers() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintOkuUsd(user1, 100e18);
        _approveOkuUsd(user1, user2, 100e18);

        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuUsd.transferFrom(user1, user3, 50e18);
    }

    function test_Pause_BlocksMinting() public {
        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuUsd.mint(user1, 100e18);
    }

    function test_Pause_AllowsBlacklisting() public {
        vm.prank(pauser);
        okuUsd.pause();

        // Should still be able to blacklist while paused
        vm.prank(blacklister);
        okuUsd.blacklist(user1);

        assertTrue(okuUsd.isBlacklisted(user1));
    }

    function test_Unpause_RestoresOperations() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(pauser);
        okuUsd.pause();

        vm.prank(unpauser);
        okuUsd.unpause();

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 50e18));

        assertEq(okuUsd.balanceOf(user2), 50e18);
    }

    // ============ Minter Allowance Tests ============

    function test_ConfigureMinterAllowance_OnlyAllowanceManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ALLOWANCE_MANAGER
            )
        );
        okuUsd.configureMinterAllowance(minter, 1000e18);
    }

    function test_ConfigureMinterAllowance_CanIncrease() public {
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, MAX_SUPPLY * 2);

        assertEq(okuUsd.minterAllowance(minter), MAX_SUPPLY * 2);
    }

    function test_ConfigureMinterAllowance_CanDecrease() public {
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, 100e18);

        assertEq(okuUsd.minterAllowance(minter), 100e18);
    }

    function test_ConfigureMinterAllowance_CanReset() public {
        // Use some allowance
        _mintOkuUsd(user1, 100e18);
        uint256 allowanceAfterMint = okuUsd.minterAllowance(minter);

        // Admin resets allowance
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, MAX_SUPPLY);

        assertEq(okuUsd.minterAllowance(minter), MAX_SUPPLY);
        assertGt(okuUsd.minterAllowance(minter), allowanceAfterMint);
    }

    function test_ConfigureMinterAllowance_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinterAllowanceUpdated(minter, MAX_SUPPLY, 1000e18);

        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, 1000e18);
    }

    // ============ Supply Cap Tests ============

    function test_SetMaxSupply_OnlyCapManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, CAP_MANAGER
            )
        );
        okuUsd.setMaxSupply(MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanIncrease() public {
        vm.prank(capManager);
        okuUsd.setMaxSupply(MAX_SUPPLY * 2);

        assertEq(okuUsd.maxSupply(), MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanDecrease() public {
        vm.prank(capManager);
        okuUsd.setMaxSupply(MAX_SUPPLY / 2);

        assertEq(okuUsd.maxSupply(), MAX_SUPPLY / 2);
    }

    function test_SetMaxSupply_DoesNotAffectExistingSupply() public {
        _mintOkuUsd(user1, 100e18);

        // Lower cap below existing supply
        vm.prank(capManager);
        okuUsd.setMaxSupply(50e18);

        // Existing tokens are not burned
        assertEq(okuUsd.balanceOf(user1), 100e18);
        assertEq(okuUsd.totalSupply(), 100e18);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MaxSupplyUpdated(MAX_SUPPLY, MAX_SUPPLY * 2);

        vm.prank(capManager);
        okuUsd.setMaxSupply(MAX_SUPPLY * 2);
    }

    // ============ Share/Token Conversion Tests ============

    function test_SharesToTokens_AtInitialMultiplier() public view {
        uint256 shares = 100e18;
        uint256 tokens = okuUsd.sharesToTokens(shares);
        assertEq(tokens, shares); // At 1x multiplier, shares == tokens
    }

    function test_TokensToShares_AtInitialMultiplier() public view {
        uint256 tokens = 100e18;
        uint256 shares = okuUsd.tokensToShares(tokens);
        assertEq(shares, tokens); // At 1x multiplier, shares == tokens
    }

    function test_SharesToTokens_AfterRebase() public {
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        uint256 shares = 100e18;
        uint256 tokens = okuUsd.sharesToTokens(shares);
        assertEq(tokens, shares * 2); // At 2x multiplier, tokens = shares * 2
    }

    function test_TokensToShares_AfterRebase() public {
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        uint256 tokens = 100e18;
        uint256 shares = okuUsd.tokensToShares(tokens);
        assertEq(shares, tokens / 2); // At 2x multiplier, shares = tokens / 2
    }

    // ============ Edge Case Tests ============

    function test_Mint_ZeroAmount() public {
        // Zero mint should technically work but results in no change
        vm.prank(minter);
        okuUsd.mint(user1, 0);

        assertEq(okuUsd.balanceOf(user1), 0);
    }

    function test_Transfer_ZeroAmount() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuUsd.transfer(user2, 0));

        assertEq(okuUsd.balanceOf(user2), 0);
    }

    function test_Mint_ExactMaxSupply() public {
        vm.prank(minter);
        okuUsd.mint(user1, MAX_SUPPLY);

        assertEq(okuUsd.totalSupply(), MAX_SUPPLY);
    }

    function test_ConversionAtHighMultiplier() public {
        // Set a high multiplier (100x)
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 100);

        uint256 tokens = 100e18;
        uint256 shares = okuUsd.tokensToShares(tokens);
        uint256 recovered = okuUsd.sharesToTokens(shares);

        // Should round-trip with minimal loss
        assertLe(recovered, tokens);
        assertGe(recovered, tokens - 100); // Allow some rounding
    }

    function test_MultipleRebases_SameBlock() public {
        _mintOkuUsd(user1, 100e18);

        vm.startPrank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);
        okuUsd.updateRewardMultiplier(PRECISION * 3);
        vm.stopPrank();

        assertEq(okuUsd.rewardMultiplier(), PRECISION * 3);
        assertEq(okuUsd.balanceOf(user1), 300e18);
    }

    // ============ EIP-2612 Permit Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuUsd.nonces(user);

        bytes32 domainSeparator = _getOkuUsdDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                user2,
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        okuUsd.permit(user, user2, amount, deadline, v, r, s);

        assertEq(okuUsd.allowance(user, user2), amount);
        assertEq(okuUsd.nonces(user), nonce + 1);
    }

    function test_Permit_RevertsExpired() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp - 1; // Expired

        bytes32 domainSeparator = _getOkuUsdDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                user2,
                amount,
                okuUsd.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.expectRevert(); // ERC2612ExpiredSignature
        okuUsd.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_RevertsInvalidSignature() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);
        uint256 wrongPk = 0xDEAD;

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 domainSeparator = _getOkuUsdDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                user2,
                amount,
                okuUsd.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest); // Wrong signer

        vm.expectRevert(); // ERC2612InvalidSigner
        okuUsd.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_NonceIncrementsOnSecondUse() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        // First permit
        _signAndPermit(userPk, user, user2, 50e18, block.timestamp + 1 hours);
        assertEq(okuUsd.nonces(user), 1);

        // Second permit (nonce=1 now)
        _signAndPermit(userPk, user, user2, 75e18, block.timestamp + 1 hours);
        assertEq(okuUsd.nonces(user), 2);
        assertEq(okuUsd.allowance(user, user2), 75e18);
    }

    function test_Permit_ReplayReverts() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuUsd.nonces(user);

        bytes32 domainSeparator = _getOkuUsdDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
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
        okuUsd.permit(user, user2, amount, deadline, v, r, s);

        // Replay with same nonce reverts
        vm.expectRevert(); // ERC2612InvalidSigner (nonce mismatch)
        okuUsd.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_AllowsTransferFrom() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        _mintOkuUsd(user, amount);

        // Sign permit for user2 to spend user's tokens
        _signAndPermit(userPk, user, user2, amount, block.timestamp + 1 hours);

        // user2 can now transferFrom
        vm.prank(user2);
        assertTrue(okuUsd.transferFrom(user, user3, amount));

        assertEq(okuUsd.balanceOf(user3), amount);
        assertEq(okuUsd.balanceOf(user), 0);
    }

    // ============ UUPS Upgrade Tests ============

    function test_UUPS_UpgradeOkuUSD() public {
        OkuUSD newImpl = new OkuUSD();

        vm.prank(admin);
        okuUsd.upgradeToAndCall(address(newImpl), "");

        // State preserved
        assertEq(okuUsd.name(), "OkuUSD");
        assertEq(okuUsd.rewardMultiplier(), PRECISION);
        assertEq(okuUsd.maxSupply(), MAX_SUPPLY);
    }

    function test_UUPS_UpgradeOkuUSD_RevertNotUpgrader() public {
        OkuUSD newImpl = new OkuUSD();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, UPGRADER
            )
        );
        okuUsd.upgradeToAndCall(address(newImpl), "");
    }

    // ============ Internal Helpers ============

    function _getOkuUsdDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OkuUSD")),
                keccak256(bytes("1")),
                block.chainid,
                address(okuUsd)
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
        bytes32 domainSeparator = _getOkuUsdDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                okuUsd.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        okuUsd.permit(owner, spender, value, deadline, v, r, s);
    }
}
