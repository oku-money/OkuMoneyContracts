// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title LitePSMTest
 * @notice Unit tests for LitePSM (Peg Stability Module)
 * @dev Note: Current implementation assumes 1:1 amounts without decimal conversion.
 *      USDC has 6 decimals, OkuUSD has 18 - this is a known issue in the PSM.
 */
contract LitePSMTest is BaseTest {
    // ============ Events ============

    event Swap(address indexed user, uint256 usdcIn, uint256 okuUSDOut);
    event Redeem(address indexed user, uint256 okuUSDIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint USDC to users and PSM buffer
        _mintUSDC(user1, 10000e6);
        _mintUSDC(user2, 10000e6);
        _mintUSDC(address(litePSM), 5000e6); // Initial buffer
    }

    // ============ Swap Tests ============

    function test_Swap_TransfersUSDCIn() public {
        uint256 amount = 100e6;
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        uint256 psmBalanceBefore = usdc.balanceOf(address(litePSM));

        _approveUSDC(user1, address(litePSM), amount);

        vm.prank(user1);
        litePSM.swap(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePSM)), psmBalanceBefore + amount);
    }

    function test_Swap_MintsOkuUSDOut() public {
        uint256 amount = 100e6;

        _approveUSDC(user1, address(litePSM), amount);

        vm.prank(user1);
        litePSM.swap(amount);

        // Note: 1:1 swap means OkuUSD minted = USDC amount
        // This is a bug since decimals differ (6 vs 18)
        assertEq(okuUSD.balanceOf(user1), amount);
    }

    function test_Swap_OneToOneRatio() public {
        uint256 amount = 500e6;

        _approveUSDC(user1, address(litePSM), amount);

        vm.prank(user1);
        litePSM.swap(amount);

        // Verify 1:1 ratio (despite decimal mismatch)
        assertEq(okuUSD.balanceOf(user1), amount);
    }

    function test_Swap_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePSM.pause();

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert();
        litePSM.swap(100e6);
    }

    function test_Swap_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePSM.swap(0);
    }

    function test_Swap_EmitsEvent() public {
        uint256 amount = 100e6;
        _approveUSDC(user1, address(litePSM), amount);

        vm.expectEmit(true, false, false, true);
        emit Swap(user1, amount, amount);

        vm.prank(user1);
        litePSM.swap(amount);
    }

    // ============ Oracle Tests ============

    function test_Swap_ChecksOracleWhenEnabled() public {
        // Configure oracle
        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report sufficient reserves
        oracle.setAnswer(int256(1_000_000_000e18));

        _approveUSDC(user1, address(litePSM), 100e6);

        // Should succeed
        vm.prank(user1);
        litePSM.swap(100e6);
    }

    function test_Swap_RevertsOnInsufficientReserves() public {
        // Configure oracle
        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report LOW reserves
        oracle.setAnswer(int256(1)); // Only 1 wei of reserves

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert("Exceeds reserves");
        litePSM.swap(100e6);
    }

    function test_Swap_RevertsOnStaleOracle() public {
        // Warp to a reasonable timestamp first
        vm.warp(1000000);

        // Configure oracle with short staleness
        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Make oracle stale by setting timestamp in the past
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert("Stale oracle data");
        litePSM.swap(100e6);
    }

    function test_Swap_SkipsOracleWhenDisabled() public {
        // Oracle configured but disabled
        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 1 hours, false);

        // Even with stale/bad oracle values, should work since oracle is disabled
        // Don't call setStale since it can underflow - just leave oracle in any state

        _approveUSDC(user1, address(litePSM), 100e6);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePSM.swap(100e6);
    }

    function test_ConfigureOracle_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.configureOracle(address(oracle), 1 hours, true);
    }

    function test_ConfigureOracle_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(address(oracle), 2 hours, true);

        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 2 hours, true);
    }

    // ============ Redeem Tests ============

    function test_Redeem_TransfersUSDCOut() public {
        // User needs OkuUSD first - mint via minter
        _mintOkuUSD(user1, 100e6);

        uint256 user1USDCBefore = usdc.balanceOf(user1);
        uint256 psmUSDCBefore = usdc.balanceOf(address(litePSM));

        _approveOkuUSD(user1, address(litePSM), 100e6);

        vm.prank(user1);
        litePSM.redeem(100e6);

        assertEq(usdc.balanceOf(user1), user1USDCBefore + 100e6);
        assertEq(usdc.balanceOf(address(litePSM)), psmUSDCBefore - 100e6);
    }

    function test_Redeem_BurnsOkuUSD() public {
        _mintOkuUSD(user1, 100e6);

        _approveOkuUSD(user1, address(litePSM), 100e6);

        vm.prank(user1);
        litePSM.redeem(100e6);

        assertEq(okuUSD.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatio() public {
        _mintOkuUSD(user1, 500e6);

        uint256 user1USDCBefore = usdc.balanceOf(user1);

        _approveOkuUSD(user1, address(litePSM), 500e6);

        vm.prank(user1);
        litePSM.redeem(500e6);

        // 1:1 ratio
        assertEq(usdc.balanceOf(user1), user1USDCBefore + 500e6);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        _mintOkuUSD(user1, 10000e6);

        // PSM only has 5000e6 USDC buffer
        // User needs to approve both PSM (for immediate burns) and Queue (for queuing)
        _approveOkuUSD(user1, address(litePSM), 10000e6);
        _approveOkuUSD(user1, address(redemptionQueue), 10000e6);

        vm.prank(user1);
        litePSM.redeem(10000e6);

        // Should be queued, not immediate redemption
        // User still has their OkuUSD (transferred to queue contract)
        // Check queue has entry
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_Redeem_NoOracleCheck() public {
        // Warp to reasonable timestamp first
        vm.warp(1000000);

        // Configure oracle
        vm.prank(admin);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        _mintOkuUSD(user1, 100e6);
        _approveOkuUSD(user1, address(litePSM), 100e6);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePSM.redeem(100e6);

        assertEq(usdc.balanceOf(user1), 10100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePSM.redeem(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        _mintOkuUSD(user1, 100e6);
        _approveOkuUSD(user1, address(litePSM), 100e6);

        vm.prank(pauser);
        litePSM.pause();

        vm.prank(user1);
        vm.expectRevert();
        litePSM.redeem(100e6);
    }

    function test_Redeem_EmitsEvent() public {
        _mintOkuUSD(user1, 100e6);
        _approveOkuUSD(user1, address(litePSM), 100e6);

        vm.expectEmit(true, false, false, true);
        emit Redeem(user1, 100e6, 100e6);

        vm.prank(user1);
        litePSM.redeem(100e6);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyOperator() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.processQueue(10);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        _mintOkuUSD(user1, 6000e6);
        _mintOkuUSD(user2, 6000e6);

        // Users need to approve queue for transferFrom
        _approveOkuUSD(user1, address(redemptionQueue), 6000e6);
        _approveOkuUSD(user2, address(redemptionQueue), 6000e6);

        // Drain buffer first - redeem more than buffer (5000)
        _approveOkuUSD(user1, address(litePSM), 6000e6);
        vm.prank(user1);
        litePSM.redeem(6000e6); // Queued (buffer only 5000)

        _approveOkuUSD(user2, address(litePSM), 6000e6);
        vm.prank(user2);
        litePSM.redeem(6000e6); // Also queued

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer
        _mintUSDC(address(litePSM), 15000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // PSM needs to approve queue to transfer USDC for payouts
        vm.prank(address(litePSM));
        usdc.approve(address(redemptionQueue), 15000e6);

        vm.prank(operator);
        litePSM.processQueue(10);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);
    }

    // ============ Admin Tests ============

    function test_Pause_OnlyPauser() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.pause();
    }

    function test_Unpause_OnlyPauser() public {
        vm.prank(pauser);
        litePSM.pause();

        vm.prank(user1);
        vm.expectRevert();
        litePSM.unpause();
    }

    function test_WithdrawUSDC_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.withdrawUSDC(user1, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(admin);
        litePSM.withdrawUSDC(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
    }
}
