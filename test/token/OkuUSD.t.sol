// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title OkuUSDTest
 * @notice Unit tests for OkuUSD rebasing token
 */
contract OkuUSDTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event RewardMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
    event MinterAllowanceConfigured(address indexed minter, uint256 allowance);
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuUSD.name(), "OkuUSD");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuUSD.symbol(), "OKUSD");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuUSD.decimals(), 18);
    }

    function test_Initialize_SetsCorrectAdmin() public view {
        assertTrue(okuUSD.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Initialize_SetsCorrectMaxSupply() public view {
        assertEq(okuUSD.maxSupply(), MAX_SUPPLY);
    }

    function test_Initialize_SetsInitialMultiplier() public view {
        assertEq(okuUSD.rewardMultiplier(), PRECISION);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert();
        okuUSD.initialize("OkuUSD2", "OKUSD2", admin, MAX_SUPPLY);
    }

    // ============ Minting Tests ============

    function test_Mint_OnlyMinterRole() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.mint(user1, 100e18);
    }

    function test_Mint_IncreasesBalance() public {
        uint256 amount = 100e18;
        _mintOkuUSD(user1, amount);
        assertEq(okuUSD.balanceOf(user1), amount);
    }

    function test_Mint_IncreasesShares() public {
        uint256 amount = 100e18;
        _mintOkuUSD(user1, amount);
        assertEq(okuUSD.sharesOf(user1), _tokensToShares(amount));
    }

    function test_Mint_IncreasesTotalSupply() public {
        uint256 amount = 100e18;
        _mintOkuUSD(user1, amount);
        assertEq(okuUSD.totalSupply(), amount);
    }

    function test_Mint_IncreasesTotalShares() public {
        uint256 amount = 100e18;
        _mintOkuUSD(user1, amount);
        assertEq(okuUSD.totalShares(), _tokensToShares(amount));
    }

    function test_Mint_DecrementsMinterAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuUSD.minterAllowance(minter);
        _mintOkuUSD(user1, amount);
        assertEq(okuUSD.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Mint_RevertsExceedingAllowance() public {
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, 50e18);

        vm.prank(minter);
        vm.expectRevert("Exceeds minter allowance");
        okuUSD.mint(user1, 100e18);
    }

    function test_Mint_RevertsExceedingMaxSupply() public {
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuUSD.mint(user1, MAX_SUPPLY + 1);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(minter);
        vm.expectRevert();
        okuUSD.mint(user1, 100e18);
    }

    function test_Mint_RevertsToBlacklistedAddress() public {
        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuUSD.mint(user1, 100e18);
    }

    function test_Mint_EmitsTransferEvent() public {
        uint256 amount = 100e18;
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, amount);

        vm.prank(minter);
        okuUSD.mint(user1, amount);
    }

    // ============ Burning Tests ============

    function test_Burn_OnlyMinterRole() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert();
        okuUSD.burn(user1, 50e18);
    }

    function test_Burn_DecreasesBalance() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(minter);
        okuUSD.burn(user1, 40e18);

        assertEq(okuUSD.balanceOf(user1), 60e18);
    }

    function test_Burn_DecreasesShares() public {
        _mintOkuUSD(user1, 100e18);
        uint256 sharesBefore = okuUSD.sharesOf(user1);

        vm.prank(minter);
        okuUSD.burn(user1, 40e18);

        assertEq(okuUSD.sharesOf(user1), sharesBefore - _tokensToShares(40e18));
    }

    function test_Burn_DecreasesTotalSupply() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(minter);
        okuUSD.burn(user1, 40e18);

        assertEq(okuUSD.totalSupply(), 60e18);
    }

    function test_Burn_DoesNotRestoreAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuUSD.minterAllowance(minter);

        _mintOkuUSD(user1, amount);
        uint256 allowanceAfterMint = okuUSD.minterAllowance(minter);

        vm.prank(minter);
        okuUSD.burn(user1, amount);

        // Allowance should NOT be restored after burn
        assertEq(okuUSD.minterAllowance(minter), allowanceAfterMint);
        assertEq(okuUSD.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Burn_RevertsInsufficientBalance() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(minter);
        vm.expectRevert("Insufficient balance");
        okuUSD.burn(user1, 150e18);
    }

    function test_Burn_RevertsForBlacklistedAccount() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Account blacklisted");
        okuUSD.burn(user1, 50e18);
    }

    function test_Burn_WorksWhenPaused() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.pause();

        // Burn should work when paused (no whenNotPaused modifier)
        vm.prank(minter);
        okuUSD.burn(user1, 50e18);

        assertEq(okuUSD.balanceOf(user1), 50e18);
    }

    function test_Burn_EmitsTransferEvent() public {
        _mintOkuUSD(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), 50e18);

        vm.prank(minter);
        okuUSD.burn(user1, 50e18);
    }

    // ============ Transfer Tests ============

    function test_Transfer_UpdatesBalances() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(user1);
        okuUSD.transfer(user2, 30e18);

        assertEq(okuUSD.balanceOf(user1), 70e18);
        assertEq(okuUSD.balanceOf(user2), 30e18);
    }

    function test_Transfer_OperatesOnShares() public {
        _mintOkuUSD(user1, 100e18);
        uint256 user1SharesBefore = okuUSD.sharesOf(user1);
        uint256 totalSharesBefore = okuUSD.totalShares();

        vm.prank(user1);
        okuUSD.transfer(user2, 30e18);

        // Total shares should be unchanged (internal transfer)
        assertEq(okuUSD.totalShares(), totalSharesBefore);

        // User shares should transfer correctly
        uint256 transferredShares = _tokensToShares(30e18);
        assertEq(okuUSD.sharesOf(user1), user1SharesBefore - transferredShares);
        assertEq(okuUSD.sharesOf(user2), transferredShares);
    }

    function test_Transfer_RevertsWhenPaused() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(user1);
        vm.expectRevert();
        okuUSD.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsFromBlacklisted() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        okuUSD.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsToBlacklisted() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        okuUSD.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsInsufficientBalance() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        okuUSD.transfer(user2, 150e18);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Transfer to zero address");
        okuUSD.transfer(address(0), 30e18);
    }

    function test_Transfer_EmitsTransferEventWithTokenAmounts() public {
        _mintOkuUSD(user1, 100e18);

        // Event should emit token amount, not shares
        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 30e18);

        vm.prank(user1);
        okuUSD.transfer(user2, 30e18);
    }

    function test_Transfer_ToSelf() public {
        _mintOkuUSD(user1, 100e18);
        uint256 balanceBefore = okuUSD.balanceOf(user1);

        vm.prank(user1);
        okuUSD.transfer(user1, 50e18);

        assertEq(okuUSD.balanceOf(user1), balanceBefore);
    }

    // ============ TransferFrom Tests ============

    function test_TransferFrom_UpdatesAllowance() public {
        _mintOkuUSD(user1, 100e18);
        _approveOkuUSD(user1, user2, 50e18);

        vm.prank(user2);
        okuUSD.transferFrom(user1, user3, 30e18);

        assertEq(okuUSD.allowance(user1, user2), 20e18);
    }

    function test_TransferFrom_RevertsInsufficientAllowance() public {
        _mintOkuUSD(user1, 100e18);
        _approveOkuUSD(user1, user2, 20e18);

        vm.prank(user2);
        vm.expectRevert();
        okuUSD.transferFrom(user1, user3, 30e18);
    }

    function test_TransferFrom_RevertsWhenPaused() public {
        _mintOkuUSD(user1, 100e18);
        _approveOkuUSD(user1, user2, 50e18);

        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(user2);
        vm.expectRevert();
        okuUSD.transferFrom(user1, user3, 30e18);
    }

    // ============ Rebasing Tests ============

    function test_UpdateRewardMultiplier_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_CannotDecrease() public {
        vm.prank(admin);
        vm.expectRevert("Multiplier cannot decrease");
        okuUSD.updateRewardMultiplier(PRECISION - 1);
    }

    function test_UpdateRewardMultiplier_UpdatesBalances() public {
        _mintOkuUSD(user1, 100e18);
        uint256 balanceBefore = okuUSD.balanceOf(user1);

        // Double the multiplier
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 balanceAfter = okuUSD.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore * 2);
    }

    function test_UpdateRewardMultiplier_UpdatesTotalSupply() public {
        _mintOkuUSD(user1, 100e18);
        uint256 supplyBefore = okuUSD.totalSupply();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuUSD.totalSupply(), supplyBefore * 2);
    }

    function test_UpdateRewardMultiplier_SharesUnchanged() public {
        _mintOkuUSD(user1, 100e18);
        uint256 sharesBefore = okuUSD.sharesOf(user1);
        uint256 totalSharesBefore = okuUSD.totalShares();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuUSD.sharesOf(user1), sharesBefore);
        assertEq(okuUSD.totalShares(), totalSharesBefore);
    }

    function test_UpdateRewardMultiplier_NoMaxSupplyCheck() public {
        // Mint close to max supply
        _mintOkuUSD(user1, MAX_SUPPLY);

        // Rebase should work even though it pushes supply above original maxSupply
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        // Supply is now 2x max, but this is allowed for rebase
        assertEq(okuUSD.totalSupply(), MAX_SUPPLY * 2);
    }

    function test_UpdateRewardMultiplier_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit RewardMultiplierUpdated(PRECISION, PRECISION * 2);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_SameMultiplier() public {
        uint256 currentMultiplier = okuUSD.rewardMultiplier();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(currentMultiplier);

        assertEq(okuUSD.rewardMultiplier(), currentMultiplier);
    }

    // ============ Blacklisting Tests ============

    function test_Blacklist_OnlyPauserRole() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.blacklist(user2);
    }

    function test_Blacklist_WorksWhilePaused() public {
        // Pause the contract
        vm.prank(pauser);
        okuUSD.pause();

        // Blacklist should still work (critical for front-run protection)
        vm.prank(pauser);
        okuUSD.blacklist(user1);

        assertTrue(okuUSD.isBlacklisted(user1));
    }

    function test_Blacklist_BlocksTransfersFrom() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        okuUSD.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransfersTo() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        okuUSD.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksMinting() public {
        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuUSD.mint(user1, 100e18);
    }

    function test_Blacklist_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Blacklisted(user1);

        vm.prank(pauser);
        okuUSD.blacklist(user1);
    }

    function test_Unblacklist_RestoresTransferability() public {
        _mintOkuUSD(user1, 100e18);

        vm.startPrank(pauser);
        okuUSD.blacklist(user1);
        okuUSD.unblacklist(user1);
        vm.stopPrank();

        // Should be able to transfer again
        vm.prank(user1);
        okuUSD.transfer(user2, 50e18);

        assertEq(okuUSD.balanceOf(user2), 50e18);
    }

    function test_Unblacklist_EmitsEvent() public {
        vm.prank(pauser);
        okuUSD.blacklist(user1);

        vm.expectEmit(true, false, false, false);
        emit Unblacklisted(user1);

        vm.prank(pauser);
        okuUSD.unblacklist(user1);
    }

    // ============ Pause Tests ============

    function test_Pause_OnlyPauserRole() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.pause();
    }

    function test_Pause_BlocksTransfers() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(user1);
        vm.expectRevert();
        okuUSD.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintOkuUSD(user1, 100e18);
        _approveOkuUSD(user1, user2, 100e18);

        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(user2);
        vm.expectRevert();
        okuUSD.transferFrom(user1, user3, 50e18);
    }

    function test_Pause_BlocksMinting() public {
        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(minter);
        vm.expectRevert();
        okuUSD.mint(user1, 100e18);
    }

    function test_Pause_AllowsBlacklisting() public {
        vm.prank(pauser);
        okuUSD.pause();

        // Should still be able to blacklist while paused
        vm.prank(pauser);
        okuUSD.blacklist(user1);

        assertTrue(okuUSD.isBlacklisted(user1));
    }

    function test_Unpause_RestoresOperations() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(pauser);
        okuUSD.pause();

        vm.prank(pauser);
        okuUSD.unpause();

        // Should be able to transfer again
        vm.prank(user1);
        okuUSD.transfer(user2, 50e18);

        assertEq(okuUSD.balanceOf(user2), 50e18);
    }

    // ============ Minter Allowance Tests ============

    function test_ConfigureMinterAllowance_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.configureMinterAllowance(minter, 1000e18);
    }

    function test_ConfigureMinterAllowance_CanIncrease() public {
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, MAX_SUPPLY * 2);

        assertEq(okuUSD.minterAllowance(minter), MAX_SUPPLY * 2);
    }

    function test_ConfigureMinterAllowance_CanDecrease() public {
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, 100e18);

        assertEq(okuUSD.minterAllowance(minter), 100e18);
    }

    function test_ConfigureMinterAllowance_CanReset() public {
        // Use some allowance
        _mintOkuUSD(user1, 100e18);
        uint256 allowanceAfterMint = okuUSD.minterAllowance(minter);

        // Admin resets allowance
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, MAX_SUPPLY);

        assertEq(okuUSD.minterAllowance(minter), MAX_SUPPLY);
        assertGt(okuUSD.minterAllowance(minter), allowanceAfterMint);
    }

    function test_ConfigureMinterAllowance_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinterAllowanceConfigured(minter, 1000e18);

        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, 1000e18);
    }

    // ============ Supply Cap Tests ============

    function test_SetMaxSupply_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        okuUSD.setMaxSupply(MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanIncrease() public {
        vm.prank(admin);
        okuUSD.setMaxSupply(MAX_SUPPLY * 2);

        assertEq(okuUSD.maxSupply(), MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanDecrease() public {
        vm.prank(admin);
        okuUSD.setMaxSupply(MAX_SUPPLY / 2);

        assertEq(okuUSD.maxSupply(), MAX_SUPPLY / 2);
    }

    function test_SetMaxSupply_DoesNotAffectExistingSupply() public {
        _mintOkuUSD(user1, 100e18);

        // Lower cap below existing supply
        vm.prank(admin);
        okuUSD.setMaxSupply(50e18);

        // Existing tokens are not burned
        assertEq(okuUSD.balanceOf(user1), 100e18);
        assertEq(okuUSD.totalSupply(), 100e18);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MaxSupplyUpdated(MAX_SUPPLY, MAX_SUPPLY * 2);

        vm.prank(admin);
        okuUSD.setMaxSupply(MAX_SUPPLY * 2);
    }

    // ============ Share/Token Conversion Tests ============

    function test_SharesToTokens_AtInitialMultiplier() public view {
        uint256 shares = 100e18;
        uint256 tokens = okuUSD.sharesToTokens(shares);
        assertEq(tokens, shares); // At 1x multiplier, shares == tokens
    }

    function test_TokensToShares_AtInitialMultiplier() public view {
        uint256 tokens = 100e18;
        uint256 shares = okuUSD.tokensToShares(tokens);
        assertEq(shares, tokens); // At 1x multiplier, shares == tokens
    }

    function test_SharesToTokens_AfterRebase() public {
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 shares = 100e18;
        uint256 tokens = okuUSD.sharesToTokens(shares);
        assertEq(tokens, shares * 2); // At 2x multiplier, tokens = shares * 2
    }

    function test_TokensToShares_AfterRebase() public {
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 tokens = 100e18;
        uint256 shares = okuUSD.tokensToShares(tokens);
        assertEq(shares, tokens / 2); // At 2x multiplier, shares = tokens / 2
    }

    // ============ Edge Case Tests ============

    function test_Mint_ZeroAmount() public {
        // Zero mint should technically work but results in no change
        vm.prank(minter);
        okuUSD.mint(user1, 0);

        assertEq(okuUSD.balanceOf(user1), 0);
    }

    function test_Transfer_ZeroAmount() public {
        _mintOkuUSD(user1, 100e18);

        vm.prank(user1);
        okuUSD.transfer(user2, 0);

        assertEq(okuUSD.balanceOf(user2), 0);
    }

    function test_Mint_ExactMaxSupply() public {
        vm.prank(minter);
        okuUSD.mint(user1, MAX_SUPPLY);

        assertEq(okuUSD.totalSupply(), MAX_SUPPLY);
    }

    function test_ConversionAtHighMultiplier() public {
        // Set a high multiplier (100x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 100);

        uint256 tokens = 100e18;
        uint256 shares = okuUSD.tokensToShares(tokens);
        uint256 recovered = okuUSD.sharesToTokens(shares);

        // Should round-trip with minimal loss
        assertLe(recovered, tokens);
        assertGe(recovered, tokens - 100); // Allow some rounding
    }

    function test_MultipleRebases_SameBlock() public {
        _mintOkuUSD(user1, 100e18);

        vm.startPrank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);
        okuUSD.updateRewardMultiplier(PRECISION * 3);
        vm.stopPrank();

        assertEq(okuUSD.rewardMultiplier(), PRECISION * 3);
        assertEq(okuUSD.balanceOf(user1), 300e18);
    }
}
