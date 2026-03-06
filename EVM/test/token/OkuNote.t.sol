// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {OkuNote} from "../../src/token/OkuNote.sol";

/**
 * @title OkuNoteTest
 * @notice Unit tests for OkuNote rebasing token
 */
contract OkuNoteTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event YieldRateUpdated(
        uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuNote.name(), "OkuNote");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuNote.symbol(), "OKUNOTE");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuNote.decimals(), 18);
    }

    function test_Initialize_SetsCorrectAdmin() public view {
        assertTrue(okuNote.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Initialize_SetsCorrectMaxSupply() public view {
        assertEq(okuNote.maxSupply(), MAX_SUPPLY);
    }

    function test_Initialize_SetsInitialMultiplier() public view {
        assertEq(okuNote.rewardMultiplier(), PRECISION);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        okuNote.initialize("OkuNote2", "OKUNOTE2", admin, MAX_SUPPLY);
    }

    // ============ Minting Tests ============

    function test_Mint_OnlyMinterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
            )
        );
        okuNote.mint(user1, 100e18);
    }

    function test_Mint_IncreasesBalance() public {
        uint256 amount = 100e18;
        _mintOkuNote(user1, amount);
        assertEq(okuNote.balanceOf(user1), amount);
    }

    function test_Mint_IncreasesShares() public {
        uint256 amount = 100e18;
        _mintOkuNote(user1, amount);
        assertEq(okuNote.sharesOf(user1), _tokensToShares(amount));
    }

    function test_Mint_IncreasesTotalSupply() public {
        uint256 amount = 100e18;
        _mintOkuNote(user1, amount);
        assertEq(okuNote.totalSupply(), amount);
    }

    function test_Mint_IncreasesTotalShares() public {
        uint256 amount = 100e18;
        _mintOkuNote(user1, amount);
        assertEq(okuNote.totalShares(), _tokensToShares(amount));
    }

    function test_Mint_DecrementsMinterAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuNote.minterAllowance(minter);
        _mintOkuNote(user1, amount);
        assertEq(okuNote.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Mint_RevertsExceedingAllowance() public {
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(minter, 50e18);

        vm.prank(minter);
        vm.expectRevert("Exceeds minter allowance");
        okuNote.mint(user1, 100e18);
    }

    function test_Mint_RevertsExceedingMaxSupply() public {
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuNote.mint(user1, MAX_SUPPLY + 1);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        okuNote.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuNote.mint(user1, 100e18);
    }

    function test_Mint_RevertsToBlacklistedAddress() public {
        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuNote.mint(user1, 100e18);
    }

    function test_Mint_EmitsTransferEvent() public {
        uint256 amount = 100e18;
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, amount);

        vm.prank(minter);
        okuNote.mint(user1, amount);
    }

    // ============ Burning Tests ============

    function test_Burn_OnlyMinterRole() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, MINTER
            )
        );
        okuNote.burn(50e18);
    }

    function test_Burn_DecreasesBalance() public {
        // Mint to minter so it can self-burn
        _mintOkuNote(minter, 100e18);

        vm.prank(minter);
        okuNote.burn(40e18);

        assertEq(okuNote.balanceOf(minter), 60e18);
    }

    function test_Burn_DecreasesShares() public {
        _mintOkuNote(minter, 100e18);
        uint256 sharesBefore = okuNote.sharesOf(minter);

        vm.prank(minter);
        okuNote.burn(40e18);

        assertEq(okuNote.sharesOf(minter), sharesBefore - _tokensToShares(40e18));
    }

    function test_Burn_DecreasesTotalSupply() public {
        _mintOkuNote(minter, 100e18);

        vm.prank(minter);
        okuNote.burn(40e18);

        assertEq(okuNote.totalSupply(), 60e18);
    }

    function test_Burn_DoesNotRestoreAllowance() public {
        uint256 amount = 100e18;
        uint256 allowanceBefore = okuNote.minterAllowance(minter);

        _mintOkuNote(minter, amount);
        uint256 allowanceAfterMint = okuNote.minterAllowance(minter);

        vm.prank(minter);
        okuNote.burn(amount);

        // Allowance should NOT be restored after burn
        assertEq(okuNote.minterAllowance(minter), allowanceAfterMint);
        assertEq(okuNote.minterAllowance(minter), allowanceBefore - amount);
    }

    function test_Burn_RevertsInsufficientBalance() public {
        _mintOkuNote(minter, 100e18);

        vm.prank(minter);
        vm.expectRevert("Insufficient balance");
        okuNote.burn(150e18);
    }

    function test_Burn_RevertsForBlacklistedAccount() public {
        _mintOkuNote(minter, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(minter);

        vm.prank(minter);
        vm.expectRevert("Account blacklisted");
        okuNote.burn(50e18);
    }

    function test_Burn_WorksWhenPaused() public {
        _mintOkuNote(minter, 100e18);

        vm.prank(pauser);
        okuNote.pause();

        // Burn should work when paused (no whenNotPaused modifier)
        vm.prank(minter);
        okuNote.burn(50e18);

        assertEq(okuNote.balanceOf(minter), 50e18);
    }

    function test_Burn_EmitsTransferEvent() public {
        _mintOkuNote(minter, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(minter, address(0), 50e18);

        vm.prank(minter);
        okuNote.burn(50e18);
    }

    // ============ Transfer Tests ============

    function test_Transfer_UpdatesBalances() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 30e18));

        assertEq(okuNote.balanceOf(user1), 70e18);
        assertEq(okuNote.balanceOf(user2), 30e18);
    }

    function test_Transfer_OperatesOnShares() public {
        _mintOkuNote(user1, 100e18);
        uint256 user1SharesBefore = okuNote.sharesOf(user1);
        uint256 totalSharesBefore = okuNote.totalShares();

        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 30e18));

        // Total shares should be unchanged (internal transfer)
        assertEq(okuNote.totalShares(), totalSharesBefore);

        // User shares should transfer correctly
        uint256 transferredShares = _tokensToShares(30e18);
        assertEq(okuNote.sharesOf(user1), user1SharesBefore - transferredShares);
        assertEq(okuNote.sharesOf(user2), transferredShares);
    }

    function test_Transfer_RevertsWhenPaused() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(pauser);
        okuNote.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsFromBlacklisted() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsToBlacklisted() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 30e18);
    }

    function test_Transfer_RevertsInsufficientBalance() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 150e18);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Transfer to zero address");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(address(0), 30e18);
    }

    function test_Transfer_EmitsTransferEventWithTokenAmounts() public {
        _mintOkuNote(user1, 100e18);

        // Event should emit token amount, not shares
        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 30e18);

        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 30e18));
    }

    function test_Transfer_ToSelf() public {
        _mintOkuNote(user1, 100e18);
        uint256 balanceBefore = okuNote.balanceOf(user1);

        vm.prank(user1);
        assertTrue(okuNote.transfer(user1, 50e18));

        assertEq(okuNote.balanceOf(user1), balanceBefore);
    }

    // ============ TransferFrom Tests ============

    function test_TransferFrom_UpdatesAllowance() public {
        _mintOkuNote(user1, 100e18);
        _approveOkuNote(user1, user2, 50e18);

        vm.prank(user2);
        assertTrue(okuNote.transferFrom(user1, user3, 30e18));

        assertEq(okuNote.allowance(user1, user2), 20e18);
    }

    function test_TransferFrom_RevertsInsufficientAllowance() public {
        _mintOkuNote(user1, 100e18);
        _approveOkuNote(user1, user2, 20e18);

        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, user2, 20e18, 30e18
            )
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transferFrom(user1, user3, 30e18);
    }

    function test_TransferFrom_RevertsWhenPaused() public {
        _mintOkuNote(user1, 100e18);
        _approveOkuNote(user1, user2, 50e18);

        vm.prank(pauser);
        okuNote.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transferFrom(user1, user3, 30e18);
    }

    // ============ Rebasing Tests ============

    function test_UpdateRewardMultiplier_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, NOTE_REBASER
            )
        );
        okuNote.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_CannotDecrease() public {
        vm.prank(rebaser);
        vm.expectRevert("Multiplier cannot decrease");
        okuNote.updateRewardMultiplier(PRECISION - 1);
    }

    function test_UpdateRewardMultiplier_UpdatesBalances() public {
        _mintOkuNote(user1, 100e18);
        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Double the multiplier
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        uint256 balanceAfter = okuNote.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore * 2);
    }

    function test_UpdateRewardMultiplier_UpdatesTotalSupply() public {
        _mintOkuNote(user1, 100e18);
        uint256 supplyBefore = okuNote.totalSupply();

        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuNote.totalSupply(), supplyBefore * 2);
    }

    function test_UpdateRewardMultiplier_SharesUnchanged() public {
        _mintOkuNote(user1, 100e18);
        uint256 sharesBefore = okuNote.sharesOf(user1);
        uint256 totalSharesBefore = okuNote.totalShares();

        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        assertEq(okuNote.sharesOf(user1), sharesBefore);
        assertEq(okuNote.totalShares(), totalSharesBefore);
    }

    function test_UpdateRewardMultiplier_NoMaxSupplyCheck() public {
        // Mint close to max supply
        _mintOkuNote(user1, MAX_SUPPLY);

        // Rebase should work even though it pushes supply above original maxSupply
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        // Supply is now 2x max, but this is allowed for rebase
        assertEq(okuNote.totalSupply(), MAX_SUPPLY * 2);
    }

    function test_UpdateRewardMultiplier_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit RebaseEvent(PRECISION, PRECISION * 2);

        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);
    }

    function test_UpdateRewardMultiplier_SameMultiplier() public {
        uint256 currentMultiplier = okuNote.rewardMultiplier();

        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(currentMultiplier);

        assertEq(okuNote.rewardMultiplier(), currentMultiplier);
    }

    // ============ Blacklisting Tests ============

    function test_Blacklist_OnlyBlacklisterRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BLACKLISTER
            )
        );
        okuNote.blacklist(user2);
    }

    function test_Blacklist_WorksWhilePaused() public {
        // Pause the contract
        vm.prank(pauser);
        okuNote.pause();

        // Blacklist should still work (critical for front-run protection)
        vm.prank(blacklister);
        okuNote.blacklist(user1);

        assertTrue(okuNote.isBlacklisted(user1));
    }

    function test_Blacklist_BlocksTransfersFrom() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.prank(user1);
        vm.expectRevert("Sender blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransfersTo() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert("Recipient blacklisted");
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksMinting() public {
        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.prank(minter);
        vm.expectRevert("Recipient blacklisted");
        okuNote.mint(user1, 100e18);
    }

    function test_Blacklist_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Blacklisted(user1);

        vm.prank(blacklister);
        okuNote.blacklist(user1);
    }

    function test_Unblacklist_RestoresTransferability() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.prank(unblacklister);
        okuNote.unblacklist(user1);

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 50e18));

        assertEq(okuNote.balanceOf(user2), 50e18);
    }

    function test_Unblacklist_EmitsEvent() public {
        vm.prank(blacklister);
        okuNote.blacklist(user1);

        vm.expectEmit(true, false, false, false);
        emit Unblacklisted(user1);

        vm.prank(unblacklister);
        okuNote.unblacklist(user1);
    }

    // ============ Pause Tests ============

    function test_Pause_OnlyPauserRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, NOTE_PAUSER
            )
        );
        okuNote.pause();
    }

    function test_Pause_BlocksTransfers() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(pauser);
        okuNote.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintOkuNote(user1, 100e18);
        _approveOkuNote(user1, user2, 100e18);

        vm.prank(pauser);
        okuNote.pause();

        vm.prank(user2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuNote.transferFrom(user1, user3, 50e18);
    }

    function test_Pause_BlocksMinting() public {
        vm.prank(pauser);
        okuNote.pause();

        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuNote.mint(user1, 100e18);
    }

    function test_Pause_AllowsBlacklisting() public {
        vm.prank(pauser);
        okuNote.pause();

        // Should still be able to blacklist while paused
        vm.prank(blacklister);
        okuNote.blacklist(user1);

        assertTrue(okuNote.isBlacklisted(user1));
    }

    function test_Unpause_RestoresOperations() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(pauser);
        okuNote.pause();

        vm.prank(unpauser);
        okuNote.unpause();

        // Should be able to transfer again
        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 50e18));

        assertEq(okuNote.balanceOf(user2), 50e18);
    }

    // ============ Minter Allowance Tests ============

    function test_ConfigureMinterAllowance_OnlyAllowanceManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ALLOWANCE_MANAGER
            )
        );
        okuNote.configureMinterAllowance(minter, 1000e18);
    }

    function test_ConfigureMinterAllowance_CanIncrease() public {
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(minter, MAX_SUPPLY * 2);

        assertEq(okuNote.minterAllowance(minter), MAX_SUPPLY * 2);
    }

    function test_ConfigureMinterAllowance_CanDecrease() public {
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(minter, 100e18);

        assertEq(okuNote.minterAllowance(minter), 100e18);
    }

    function test_ConfigureMinterAllowance_CanReset() public {
        // Use some allowance
        _mintOkuNote(user1, 100e18);
        uint256 allowanceAfterMint = okuNote.minterAllowance(minter);

        // Admin resets allowance
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(minter, MAX_SUPPLY);

        assertEq(okuNote.minterAllowance(minter), MAX_SUPPLY);
        assertGt(okuNote.minterAllowance(minter), allowanceAfterMint);
    }

    function test_ConfigureMinterAllowance_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinterAllowanceUpdated(minter, MAX_SUPPLY, 1000e18);

        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(minter, 1000e18);
    }

    // ============ Supply Cap Tests ============

    function test_SetMaxSupply_OnlyCapManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, CAP_MANAGER
            )
        );
        okuNote.setMaxSupply(MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanIncrease() public {
        vm.prank(capManager);
        okuNote.setMaxSupply(MAX_SUPPLY * 2);

        assertEq(okuNote.maxSupply(), MAX_SUPPLY * 2);
    }

    function test_SetMaxSupply_CanDecrease() public {
        vm.prank(capManager);
        okuNote.setMaxSupply(MAX_SUPPLY / 2);

        assertEq(okuNote.maxSupply(), MAX_SUPPLY / 2);
    }

    function test_SetMaxSupply_DoesNotAffectExistingSupply() public {
        _mintOkuNote(user1, 100e18);

        // Lower cap below existing supply
        vm.prank(capManager);
        okuNote.setMaxSupply(50e18);

        // Existing tokens are not burned
        assertEq(okuNote.balanceOf(user1), 100e18);
        assertEq(okuNote.totalSupply(), 100e18);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MaxSupplyUpdated(MAX_SUPPLY, MAX_SUPPLY * 2);

        vm.prank(capManager);
        okuNote.setMaxSupply(MAX_SUPPLY * 2);
    }

    // ============ Share/Token Conversion Tests ============

    function test_SharesToTokens_AtInitialMultiplier() public view {
        uint256 shares = 100e18;
        uint256 tokens = okuNote.sharesToTokens(shares);
        assertEq(tokens, shares); // At 1x multiplier, shares == tokens
    }

    function test_TokensToShares_AtInitialMultiplier() public view {
        uint256 tokens = 100e18;
        uint256 shares = okuNote.tokensToShares(tokens);
        assertEq(shares, tokens); // At 1x multiplier, shares == tokens
    }

    function test_SharesToTokens_AfterRebase() public {
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        uint256 shares = 100e18;
        uint256 tokens = okuNote.sharesToTokens(shares);
        assertEq(tokens, shares * 2); // At 2x multiplier, tokens = shares * 2
    }

    function test_TokensToShares_AfterRebase() public {
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);

        uint256 tokens = 100e18;
        uint256 shares = okuNote.tokensToShares(tokens);
        assertEq(shares, tokens / 2); // At 2x multiplier, shares = tokens / 2
    }

    // ============ Edge Case Tests ============

    function test_Mint_ZeroAmount_RevertsAmountTooSmall() public {
        // Zero mint converts to zero shares and should revert
        vm.prank(minter);
        vm.expectRevert("Amount too small");
        okuNote.mint(user1, 0);
    }

    function test_Mint_SubShareAmount_RevertsAfterRebase() public {
        // At a high multiplier, tiny token amounts round to 0 shares
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 100); // 100x multiplier

        // 1 wei of tokens / 100x multiplier = 0 shares (rounds down)
        vm.prank(minter);
        vm.expectRevert("Amount too small");
        okuNote.mint(user1, 1);
    }

    function test_Transfer_ZeroAmount() public {
        _mintOkuNote(user1, 100e18);

        vm.prank(user1);
        assertTrue(okuNote.transfer(user2, 0));

        assertEq(okuNote.balanceOf(user2), 0);
    }

    function test_Mint_ExactMaxSupply() public {
        vm.prank(minter);
        okuNote.mint(user1, MAX_SUPPLY);

        assertEq(okuNote.totalSupply(), MAX_SUPPLY);
    }

    function test_ConversionAtHighMultiplier() public {
        // Set a high multiplier (100x)
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 100);

        uint256 tokens = 100e18;
        uint256 shares = okuNote.tokensToShares(tokens);
        uint256 recovered = okuNote.sharesToTokens(shares);

        // Should round-trip with minimal loss
        assertLe(recovered, tokens);
        assertGe(recovered, tokens - 100); // Allow some rounding
    }

    function test_MultipleRebases_SameBlock() public {
        _mintOkuNote(user1, 100e18);

        vm.startPrank(rebaser);
        okuNote.updateRewardMultiplier(PRECISION * 2);
        okuNote.updateRewardMultiplier(PRECISION * 3);
        vm.stopPrank();

        assertEq(okuNote.rewardMultiplier(), PRECISION * 3);
        assertEq(okuNote.balanceOf(user1), 300e18);
    }

    // ============ Continuous Yield Accrual Tests ============

    function test_SetYieldRate_OnlyRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, NOTE_REBASER
            )
        );
        okuNote.setYieldRate(PRECISION + 1, 0);
    }

    function test_SetYieldRate_MultiplierGrowsOverTime() public {
        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY per second

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        uint256 multiplierBefore = okuNote.rewardMultiplier();

        vm.warp(block.timestamp + 1 days);

        uint256 multiplierAfter = okuNote.rewardMultiplier();
        assertGt(multiplierAfter, multiplierBefore);
    }

    function test_SetYieldRate_BalancesGrowContinuously() public {
        _mintOkuNote(user1, 1000e18);
        uint256 balanceBefore = okuNote.balanceOf(user1);

        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 1 days);

        uint256 balanceAfter = okuNote.balanceOf(user1);
        assertGt(balanceAfter, balanceBefore);
    }

    function test_SetYieldRate_SnapshotPreservesValue() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Set a new rate — should snapshot accrued yield, not lose it
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        uint256 balanceAfter = okuNote.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore);
    }

    function test_SetYieldRate_RateCannotBeNegative() public {
        vm.prank(rebaser);
        vm.expectRevert("Rate cannot be negative");
        okuNote.setYieldRate(PRECISION - 1, 0);
    }

    function test_SetYieldRate_EndMustBeInFuture() public {
        // Warp to a realistic timestamp so block.timestamp - 1 != 0
        vm.warp(1000);

        vm.prank(rebaser);
        vm.expectRevert("End must be in the future");
        okuNote.setYieldRate(PRECISION + 1, block.timestamp - 1);
    }

    function test_SetYieldRate_EmitsEvent() public {
        uint256 rate = 1_000_000_001_547_125_957;

        vm.expectEmit(false, false, false, true);
        emit YieldRateUpdated(rate, 0, PRECISION);

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);
    }

    function test_SetYieldRate_ZeroRateStopsAccrual() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);
        uint256 balanceMid = okuNote.balanceOf(user1);

        // Set rate to PRECISION (no yield)
        vm.prank(rebaser);
        okuNote.setYieldRate(PRECISION, 0);

        vm.warp(block.timestamp + 30 days);
        uint256 balanceEnd = okuNote.balanceOf(user1);

        // Balance should not change after stopping accrual
        assertEq(balanceEnd, balanceMid);
    }

    function test_SetNextYieldRate_ActivatesAtRateEnd() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate1 = 1_000_000_001_547_125_957; // ~5% APY
        uint256 rate2 = 1_000_000_002_877_801_985; // ~9.5% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.startPrank(rebaser);
        okuNote.setYieldRate(rate1, endTime);
        okuNote.setNextYieldRate(rate2);
        vm.stopPrank();

        // Before rateEnd — rate1 applies
        vm.warp(endTime - 1);
        uint256 balanceBeforeEnd = okuNote.balanceOf(user1);

        // After rateEnd — rate2 takes over
        vm.warp(endTime + 30 days);
        uint256 balanceAfterEnd = okuNote.balanceOf(user1);
        assertGt(balanceAfterEnd, balanceBeforeEnd);
    }

    function test_SetNextYieldRate_RequiresRateEnd() public {
        vm.prank(rebaser);
        okuNote.setYieldRate(PRECISION + 1, 0); // no end time

        vm.prank(rebaser);
        vm.expectRevert("Current rate has no end");
        okuNote.setNextYieldRate(PRECISION + 1);
    }

    function test_SetNextYieldRate_HeadToTail() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate = 1_000_000_001_547_125_957; // ~5% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.startPrank(rebaser);
        okuNote.setYieldRate(rate, endTime);
        okuNote.setNextYieldRate(rate); // same rate continues
        vm.stopPrank();

        // Warp to just before boundary
        vm.warp(endTime - 1);
        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Warp to just after boundary
        vm.warp(endTime + 1);
        uint256 balanceAfter = okuNote.balanceOf(user1);

        // Should have grown by ~2 seconds worth of yield — no gap, no jump
        assertGt(balanceAfter, balanceBefore);
        // The difference should be small (just 2 seconds of yield on 1000 tokens)
        uint256 diff = balanceAfter - balanceBefore;
        assertLt(diff, 1e15); // less than 0.001 OkuNote for 2 seconds
    }

    function test_SetNextYieldRate_EmitsEvent() public {
        uint256 rate = 1_000_000_001_547_125_957;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, endTime);

        uint256 nextRate = 1_000_000_002_877_801_985;
        vm.expectEmit(false, false, false, true);
        emit NextYieldRateSet(nextRate, endTime);

        vm.prank(rebaser);
        okuNote.setNextYieldRate(nextRate);
    }

    function test_SetNextYieldRate_OnlyRebaser() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(rebaser);
        okuNote.setYieldRate(PRECISION + 1, endTime);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, NOTE_REBASER
            )
        );
        okuNote.setNextYieldRate(PRECISION + 1);
    }

    function test_ContinuousAccrual_FrontRunUnprofitable() public {
        // Set up a realistic 4.5% APY rate
        // rate = (1.045)^(1/31536000) ≈ 1.000000001395766... × 1e18
        uint256 rate = 1_000_000_001_395_766_300;

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

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
        litePsm.mint_OkuNote(usdcAttackAmount);
        vm.stopPrank();

        uint256 balanceAfterMint = okuNote.balanceOf(user1);

        // Advance 2 seconds (L2 block time)
        vm.warp(block.timestamp + 2);

        uint256 balanceAfterWarp = okuNote.balanceOf(user1);
        uint256 profit = balanceAfterWarp - balanceAfterMint;

        // At 4.5% APY, 2 seconds on $1M ≈ $0.00285 OkuNote
        // This is less than gas costs for mint + redeem on any chain
        assertLt(profit, 1e16); // less than 0.01 OkuNote ($0.01) for $1M attack
    }

    function test_ContinuousAccrual_MatchesExpectedAPY() public {
        _mintOkuNote(user1, 1000e18);

        // 4.5% APY: rate = (1.045)^(1/31536000) ≈ 1.000000001395766... × 1e18
        uint256 rate = 1_000_000_001_395_766_300;

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        // Warp 365 days
        vm.warp(block.timestamp + 365 days);

        uint256 balance = okuNote.balanceOf(user1);

        // Expected: 1000 * 1.045 = 1045 (within rounding tolerance)
        // Allow 0.1% tolerance for compounding approximation
        assertGt(balance, 1044e18); // at least 4.4%
        assertLt(balance, 1046e18); // at most 4.6%
    }

    function test_UpdateRewardMultiplier_EmergencyOverride() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        uint256 computedMultiplier = okuNote.rewardMultiplier();
        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Emergency override — set exact multiplier, stops accrual
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(computedMultiplier);

        // Multiplier should now be the exact snapshot
        assertEq(okuNote.rewardMultiplier(), computedMultiplier);
        // Rate should be reset
        assertEq(okuNote.ratePerSecond(), PRECISION);
        // Balance should be unchanged
        assertEq(okuNote.balanceOf(user1), balanceBefore);

        // Warp more — balance should not grow (rate is zero)
        vm.warp(block.timestamp + 30 days);
        assertEq(okuNote.balanceOf(user1), balanceBefore);
    }

    function test_BaseMultiplier_ReturnsSnapshotValue() public {
        assertEq(okuNote.baseMultiplier(), PRECISION);

        uint256 rate = 1_000_000_001_547_125_957;
        vm.prank(rebaser);
        okuNote.setYieldRate(rate, 0);

        vm.warp(block.timestamp + 30 days);

        // baseMultiplier should still be PRECISION (snapshot hasn't been updated)
        assertEq(okuNote.baseMultiplier(), PRECISION);
        // rewardMultiplier should be higher
        assertGt(okuNote.rewardMultiplier(), PRECISION);
    }

    function test_RateExpiry_StopsYieldWhenNoPendingRate() public {
        _mintOkuNote(user1, 1000e18);

        uint256 rate = 1_000_000_001_547_125_957;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuNote.setYieldRate(rate, endTime);

        // Warp past end with no pending rate
        vm.warp(endTime + 30 days);
        uint256 balanceAtExpiry = okuNote.balanceOf(user1);

        // Warp more — balance should not grow
        vm.warp(endTime + 60 days);
        assertEq(okuNote.balanceOf(user1), balanceAtExpiry);
    }

    // ============ EIP-2612 Permit Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuNote.nonces(user);

        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
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

        okuNote.permit(user, user2, amount, deadline, v, r, s);

        assertEq(okuNote.allowance(user, user2), amount);
        assertEq(okuNote.nonces(user), nonce + 1);
    }

    function test_Permit_RevertsExpired() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp - 1; // Expired

        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                okuNote.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.expectRevert(); // ERC2612ExpiredSignature
        okuNote.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_RevertsInvalidSignature() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);
        uint256 wrongPk = 0xDEAD;

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                user2,
                amount,
                okuNote.nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest); // Wrong signer

        vm.expectRevert(); // ERC2612InvalidSigner
        okuNote.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_NonceIncrementsOnSecondUse() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        // First permit
        _signAndPermit(userPk, user, user2, 50e18, block.timestamp + 1 hours);
        assertEq(okuNote.nonces(user), 1);

        // Second permit (nonce=1 now)
        _signAndPermit(userPk, user, user2, 75e18, block.timestamp + 1 hours);
        assertEq(okuNote.nonces(user), 2);
        assertEq(okuNote.allowance(user, user2), 75e18);
    }

    function test_Permit_ReplayReverts() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuNote.nonces(user);

        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
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
        okuNote.permit(user, user2, amount, deadline, v, r, s);

        // Replay with same nonce reverts
        vm.expectRevert(); // ERC2612InvalidSigner (nonce mismatch)
        okuNote.permit(user, user2, amount, deadline, v, r, s);
    }

    function test_Permit_AllowsTransferFrom() public {
        uint256 userPk = 0xBEEF;
        address user = vm.addr(userPk);

        uint256 amount = 100e18;
        _mintOkuNote(user, amount);

        // Sign permit for user2 to spend user's tokens
        _signAndPermit(userPk, user, user2, amount, block.timestamp + 1 hours);

        // user2 can now transferFrom
        vm.prank(user2);
        assertTrue(okuNote.transferFrom(user, user3, amount));

        assertEq(okuNote.balanceOf(user3), amount);
        assertEq(okuNote.balanceOf(user), 0);
    }

    // ============ UUPS Upgrade Tests ============

    function test_UUPS_UpgradeOkuNote() public {
        OkuNote okuNoteV2 = new OkuNote();

        vm.prank(admin);
        okuNote.upgradeToAndCall(address(okuNoteV2), "");

        // State preserved
        assertEq(okuNote.name(), "OkuNote");
        assertEq(okuNote.rewardMultiplier(), PRECISION);
        assertEq(okuNote.maxSupply(), MAX_SUPPLY);
    }

    function test_UUPS_UpgradeOkuNote_RevertNotUpgrader() public {
        OkuNote okuNoteV2 = new OkuNote();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, UPGRADER
            )
        );
        okuNote.upgradeToAndCall(address(okuNoteV2), "");
    }

    // ============ Internal Helpers ============

    function _getOkuNoteDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OkuNote")),
                keccak256(bytes("1")),
                block.chainid,
                address(okuNote)
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
        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                spender,
                value,
                okuNote.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        okuNote.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ MAX_RATE Tests ============

    function test_SetYieldRate_RevertsAboveMaxRate() public {
        uint256 maxRate = okuNote.MAX_RATE();

        vm.prank(rebaser);
        vm.expectRevert("Rate too high");
        okuNote.setYieldRate(maxRate + 1, 0);
    }

    function test_SetYieldRate_AcceptsMaxRate() public {
        uint256 maxRate = okuNote.MAX_RATE();

        vm.prank(rebaser);
        okuNote.setYieldRate(maxRate, 0);

        assertEq(okuNote.ratePerSecond(), maxRate);
    }

    function test_SetNextYieldRate_RevertsAboveMaxRate() public {
        uint256 maxRate = okuNote.MAX_RATE();
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuNote.setYieldRate(PRECISION + 1, endTime);

        vm.prank(rebaser);
        vm.expectRevert("Rate too high");
        okuNote.setNextYieldRate(maxRate + 1);
    }

    function test_SetNextYieldRate_AcceptsMaxRate() public {
        uint256 maxRate = okuNote.MAX_RATE();
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(rebaser);
        okuNote.setYieldRate(PRECISION + 1, endTime);

        vm.prank(rebaser);
        okuNote.setNextYieldRate(maxRate);

        assertEq(okuNote.pendingRatePerSecond(), maxRate);
    }
}
