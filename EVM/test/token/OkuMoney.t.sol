// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";

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
    event YieldDistributed(
        uint256 yieldAmount,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 totalSupply,
        uint256 indexed blockNumber
    );
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
        vm.expectRevert();
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

    // ============ distributeYield Tests ============

    function test_DistributeYield_OnlyRebaser() public {
        _mintOkuMoney(user1, 10_000e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, OKUM_REBASER
            )
        );
        okuMoney.distributeYield(1000e18);
    }

    function test_DistributeYield_CorrectPriceMath() public {
        // $1000 yield on 10000 tokens → +$0.10/token
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        uint256 priceBefore = okuMoney.okuMMultiplier();

        vm.prank(rebaser);
        okuMoney.distributeYield(1000e18);

        uint256 priceAfter = okuMoney.okuMMultiplier();
        assertEq(priceAfter, priceBefore + 0.1e18);
    }

    function test_DistributeYield_ZeroSupplyReverts() public {
        // No tokens minted
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.ZeroSupply.selector);
        okuMoney.distributeYield(1000e18);
    }

    function test_DistributeYield_EmitsEvent() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        uint256 yieldAmount = 1000e18;
        uint256 expectedOldPrice = PRECISION;
        uint256 expectedNewPrice = PRECISION + 0.1e18;

        // Cycle 4 (EVM-01): event payload now includes the indexed
        // `blockNumber` field.
        vm.expectEmit(true, false, false, true);
        emit YieldDistributed(yieldAmount, expectedOldPrice, expectedNewPrice, supply, block.number);

        vm.prank(rebaser);
        okuMoney.distributeYield(yieldAmount);
    }

    function test_DistributeYield_MonotonicallyIncreases() public {
        _mintOkuMoney(user1, 10_000e18);

        uint256 price0 = okuMoney.okuMMultiplier();

        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);
        uint256 price1 = okuMoney.okuMMultiplier();
        assertGt(price1, price0);

        vm.prank(rebaser);
        okuMoney.distributeYield(200e18);
        uint256 price2 = okuMoney.okuMMultiplier();
        assertGt(price2, price1);
    }

    function test_DistributeYield_DoesNotAffectBalances() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        uint256 balanceBefore = okuMoney.balanceOf(user1);
        uint256 totalSupplyBefore = okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.distributeYield(1000e18);

        assertEq(okuMoney.balanceOf(user1), balanceBefore, "balanceOf unchanged after yield");
        assertEq(okuMoney.totalSupply(), totalSupplyBefore, "totalSupply unchanged after yield");
    }

    // ============ okuMMultiplier Storage Tests ============

    function test_OkuMPrice_ReturnsStoredValue() public {
        // No time dependency — price is a stored value
        assertEq(okuMoney.okuMMultiplier(), PRECISION);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 3);

        assertEq(okuMoney.okuMMultiplier(), PRECISION * 3);
    }

    function test_OkuMMultiplierConstantBetweenUpdates() public {
        // Price does not change without an explicit call
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

    function test_LastYieldDistributionBlock_InitiallyZero() public view {
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);
    }

    function test_DistributeYield_SetsLastYieldDistributionBlock() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        vm.prank(rebaser);
        okuMoney.distributeYield(1000e18);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_SetOkuMMultiplier_SetsLastYieldDistributionBlock() public {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_DistributeYield_UpdatesLastYieldDistributionBlock() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        uint256 blockBefore = okuMoney.lastYieldDistributionBlock();
        assertEq(blockBefore, 0);

        vm.prank(rebaser);
        okuMoney.distributeYield(1000e18);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_SetOkuMMultiplier_UpdatesLastYieldDistributionBlock() public {
        uint256 blockBefore = okuMoney.lastYieldDistributionBlock();
        assertEq(blockBefore, 0);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
    }

    function test_LastYieldDistributionBlock_UpdatesOnEachDistribution() public {
        uint256 supply = 10_000e18;
        _mintOkuMoney(user1, supply);

        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);
        uint256 block1 = okuMoney.lastYieldDistributionBlock();

        // Roll forward and distribute again
        vm.roll(block.number + 10);

        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);
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

        vm.expectRevert(); // ERC2612ExpiredSignature
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

        vm.expectRevert(); // ERC2612InvalidSigner
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
}
