// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title LitePSMTest
 * @notice Unit tests for LitePSM (Peg Stability Module)
 * @dev Tests verify correct 1:1 value conversion between USDC (6 decimals) and OkuUSD (18 decimals).
 *      The PSM multiplies by 10^12 when minting and divides by 10^12 when redeeming.
 */
contract LitePSMTest is BaseTest {
    // Decimal conversion constant
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12;
    // ============ Events ============

    event Mint(address indexed user, uint256 usdcAmount, uint256 okusdAmount);
    event Redeem(address indexed user, uint256 okuUSDIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint USDC to users and PSM buffer
        _mintUSDC(user1, 10_000e6);
        _mintUSDC(user2, 10_000e6);
        _mintUSDC(address(litePSM), 5000e6); // Initial buffer
    }

    // ============ Mint Tests ============

    function test_Mint_TransfersUSDCIn() public {
        uint256 amount = 100e6;
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        uint256 psmBalanceBefore = usdc.balanceOf(address(litePSM));

        _approveUSDC(user1, address(litePSM), amount);

        vm.prank(user1);
        litePSM.mint(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePSM)), psmBalanceBefore + amount);
    }

    function test_Mint_MintsOkuUSDOut() public {
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _approveUSDC(user1, address(litePSM), usdcAmount);

        vm.prank(user1);
        litePSM.mint(usdcAmount);

        // Should mint 100 OkuUSD (18 decimals) = 100e6 * 10^12 = 100e18
        uint256 expectedOkuUSD = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(okuUSD.balanceOf(user1), expectedOkuUSD);
        assertEq(okuUSD.balanceOf(user1), 100e18); // Explicit check: 100 OkuUSD
    }

    function test_Mint_OneToOneRatio() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUSDC(user1, address(litePSM), usdcAmount);

        vm.prank(user1);
        litePSM.mint(usdcAmount);

        // Verify 1:1 VALUE ratio: 500 USDC → 500 OkuUSD (with decimal conversion)
        assertEq(okuUSD.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
        assertEq(okuUSD.balanceOf(user1), 500e18); // 500 OkuUSD
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePSM.pause();

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert();
        litePSM.mint(100e6);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePSM.mint(0);
    }

    function test_Mint_EmitsEvent() public {
        uint256 usdcAmount = 100e6;
        uint256 okuUSDAmount = usdcAmount * DECIMAL_MULTIPLIER;

        _approveUSDC(user1, address(litePSM), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit Mint(user1, usdcAmount, okuUSDAmount);

        vm.prank(user1);
        litePSM.mint(usdcAmount);
    }

    // ============ Oracle Tests ============

    function test_Mint_ChecksOracleWhenEnabled() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report sufficient reserves
        oracle.setAnswer(int256(1_000_000_000e18));

        uint256 usdcAmount = 100e6;
        _approveUSDC(user1, address(litePSM), usdcAmount);

        uint256 balanceBefore = okuUSD.balanceOf(user1);

        // Should succeed
        vm.prank(user1);
        litePSM.mint(usdcAmount);

        uint256 expectedOkuUSD = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(okuUSD.balanceOf(user1), balanceBefore + expectedOkuUSD, "OkuUSD should be minted");
    }

    function test_Mint_RevertsOnInsufficientReserves() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report LOW reserves
        oracle.setAnswer(int256(1)); // Only 1 wei of reserves

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert("Exceeds reserves");
        litePSM.mint(100e6);
    }

    function test_Mint_RevertsOnStaleOracle() public {
        // Warp to a reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle with short staleness
        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Make oracle stale by setting timestamp in the past
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUSDC(user1, address(litePSM), 100e6);

        vm.prank(user1);
        vm.expectRevert("Stale oracle data");
        litePSM.mint(100e6);
    }

    function test_Mint_SkipsOracleWhenDisabled() public {
        // Oracle configured but disabled
        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 1 hours, false);

        // Even with stale/bad oracle values, should work since oracle is disabled
        // Don't call setStale since it can underflow - just leave oracle in any state

        _approveUSDC(user1, address(litePSM), 100e6);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePSM.mint(100e6);
    }

    function test_ConfigureOracle_OnlyOracleManager() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.configureOracle(address(oracle), 1 hours, true);
    }

    function test_ConfigureOracle_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(address(oracle), 2 hours, true);

        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 2 hours, true);
    }

    // ============ Redeem Tests ============

    function test_Redeem_TransfersUSDCOut() public {
        // User needs OkuUSD first - mint 100 OkuUSD (18 decimals)
        uint256 okuUSDAmount = 100e18;
        uint256 expectedUSDC = 100e6; // Should receive 100 USDC (6 decimals)

        _mintOkuUSD(user1, okuUSDAmount);

        uint256 user1USDCBefore = usdc.balanceOf(user1);
        uint256 psmUSDCBefore = usdc.balanceOf(address(litePSM));

        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        assertEq(usdc.balanceOf(user1), user1USDCBefore + expectedUSDC);
        assertEq(usdc.balanceOf(address(litePSM)), psmUSDCBefore - expectedUSDC);
    }

    function test_Redeem_BurnsOkuUSD() public {
        uint256 okuUSDAmount = 100e18; // 100 OkuUSD

        _mintOkuUSD(user1, okuUSDAmount);

        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        assertEq(okuUSD.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatio() public {
        uint256 okuUSDAmount = 500e18; // 500 OkuUSD
        uint256 expectedUSDC = 500e6; // Should receive 500 USDC

        _mintOkuUSD(user1, okuUSDAmount);

        uint256 user1USDCBefore = usdc.balanceOf(user1);

        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        // 1:1 VALUE ratio: 500 OkuUSD → 500 USDC (with decimal conversion)
        assertEq(usdc.balanceOf(user1), user1USDCBefore + expectedUSDC);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 okuUSDAmount = 10_000e18; // 10,000 OkuUSD

        _mintOkuUSD(user1, okuUSDAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuUSD)
        // User needs to approve both PSM (for immediate burns) and Queue (for queuing)
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);
        _approveOkuUSD(user1, address(redemptionQueue), okuUSDAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        // Should be queued, not immediate redemption (buffer insufficient)
        // User still has their OkuUSD (transferred to queue contract)
        // Check queue has entry
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_Redeem_NoOracleCheck() public {
        // Warp to reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePSM.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        uint256 okuUSDAmount = 100e18; // 100 OkuUSD

        _mintOkuUSD(user1, okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        assertEq(usdc.balanceOf(user1), 10_100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePSM.redeem(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        uint256 okuUSDAmount = 100e18;

        _mintOkuUSD(user1, okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        vm.prank(pauser);
        litePSM.pause();

        vm.prank(user1);
        vm.expectRevert();
        litePSM.redeem(okuUSDAmount);
    }

    function test_Redeem_EmitsEvent() public {
        uint256 okuUSDAmount = 100e18;
        uint256 usdcAmount = 100e6;

        _mintOkuUSD(user1, okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        vm.expectEmit(true, false, false, true);
        emit Redeem(user1, okuUSDAmount, usdcAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyQueueProcessor() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.processQueue(10);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        uint256 okuUSDAmount = 6000e18; // 6,000 OkuUSD each

        _mintOkuUSD(user1, okuUSDAmount);
        _mintOkuUSD(user2, okuUSDAmount);

        // Users need to approve queue for transferFrom
        _approveOkuUSD(user1, address(redemptionQueue), okuUSDAmount);
        _approveOkuUSD(user2, address(redemptionQueue), okuUSDAmount);

        // Drain buffer first - redeem more than buffer (5000 USDC worth)
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);
        vm.prank(user1);
        litePSM.redeem(okuUSDAmount); // Queued (buffer only 5000 USDC)

        _approveOkuUSD(user2, address(litePSM), okuUSDAmount);
        vm.prank(user2);
        litePSM.redeem(okuUSDAmount); // Also queued

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer
        _mintUSDC(address(litePSM), 15_000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // processQueue now handles approve-use-revoke internally
        vm.prank(queueProcessor);
        litePSM.processQueue(10);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);
    }

    function test_ProcessQueue_ApprovesAndRevokesAllowance() public {
        // Setup: create a queued redemption
        uint256 okuUSDAmount = 6000e18; // 6,000 OkuUSD

        _mintOkuUSD(user1, okuUSDAmount);
        _approveOkuUSD(user1, address(redemptionQueue), okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount); // Queued (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Refill buffer
        _mintUSDC(address(litePSM), 10_000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // Verify allowance is 0 before processing
        assertEq(usdc.allowance(address(litePSM), address(redemptionQueue)), 0);

        // Process queue
        vm.prank(queueProcessor);
        litePSM.processQueue(10);

        // Verify allowance is revoked back to 0 after processing
        assertEq(usdc.allowance(address(litePSM), address(redemptionQueue)), 0);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);

        // User should have received USDC (original balance + 6000e6 from queue)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 6000e6);
    }

    function test_ProcessQueue_PartialProcessingRevokesAllowance() public {
        // Setup: create multiple queued redemptions
        uint256 okuUSDAmount = 6000e18; // 6,000 OkuUSD each

        _mintOkuUSD(user1, okuUSDAmount);
        _mintOkuUSD(user2, okuUSDAmount);

        _approveOkuUSD(user1, address(redemptionQueue), okuUSDAmount);
        _approveOkuUSD(user2, address(redemptionQueue), okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);
        _approveOkuUSD(user2, address(litePSM), okuUSDAmount);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        vm.prank(user2);
        litePSM.redeem(okuUSDAmount);

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer with only enough for one redemption
        _mintUSDC(address(litePSM), 7000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // Process only 1 entry
        vm.prank(queueProcessor);
        litePSM.processQueue(1);

        // Allowance should still be revoked even with partial processing
        assertEq(usdc.allowance(address(litePSM), address(redemptionQueue)), 0);

        // Only 1 entry processed
        assertEq(redemptionQueue.queueLength(), 1);
    }

    // ============ Admin Tests ============

    function test_Pause_OnlyPauser() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.pause();
    }

    function test_Unpause_OnlyUnpauser() public {
        vm.prank(pauser);
        litePSM.pause();

        vm.prank(user1);
        vm.expectRevert();
        litePSM.unpause();
    }

    function test_WithdrawUSDC_OnlyBufferWithdrawer() public {
        vm.prank(user1);
        vm.expectRevert();
        litePSM.withdrawUSDC(user1, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(bufferWithdrawer);
        litePSM.withdrawUSDC(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
    }

    // ============ Decimal Conversion Tests ============

    function test_DecimalConversion_MintConvertsCorrectly() public {
        uint256 usdcAmount = 1000e6; // 1000 USDC (6 decimals)

        _approveUSDC(user1, address(litePSM), usdcAmount);

        vm.prank(user1);
        litePSM.mint(usdcAmount);

        // Should mint exactly 1000 OkuUSD (18 decimals)
        assertEq(okuUSD.balanceOf(user1), 1000e18);

        // Verify the conversion factor
        assertEq(okuUSD.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 okuUSDAmount = 1000e18; // 1000 OkuUSD (18 decimals)

        _mintOkuUSD(user1, okuUSDAmount);
        _approveOkuUSD(user1, address(litePSM), okuUSDAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePSM.redeem(okuUSDAmount);

        // Should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify the conversion factor
        assertEq(usdc.balanceOf(user1) - usdcBefore, okuUSDAmount / DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUSDC = 5000e6; // 5000 USDC

        // Mint OkuUSD
        _approveUSDC(user1, address(litePSM), startingUSDC);
        vm.prank(user1);
        litePSM.mint(startingUSDC);

        uint256 okuUSDReceived = okuUSD.balanceOf(user1);
        assertEq(okuUSDReceived, 5000e18); // 5000 OkuUSD

        // Redeem back to USDC
        _approveOkuUSD(user1, address(litePSM), okuUSDReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePSM.redeem(okuUSDReceived);

        // Should get back exactly what we started with
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUSDC);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUSDC = 1e6; // 1 USDC (minimum realistic amount)

        _approveUSDC(user1, address(litePSM), smallUSDC);
        vm.prank(user1);
        litePSM.mint(smallUSDC);

        // Should mint 1 OkuUSD
        assertEq(okuUSD.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUSDC = 1_000_000e6; // 1 million USDC

        _mintUSDC(user1, largeUSDC); // Mint more USDC to user
        _approveUSDC(user1, address(litePSM), largeUSDC);

        vm.prank(user1);
        litePSM.mint(largeUSDC);

        // Should mint 1 million OkuUSD
        assertEq(okuUSD.balanceOf(user1), 1_000_000e18);
    }

    function test_DecimalConversion_RedeemTooSmall() public {
        // 1 wei of OkuUSD should fail since it rounds to 0 USDC
        uint256 tinyAmount = 1; // 1 wei of OkuUSD

        _mintOkuUSD(user1, tinyAmount);
        _approveOkuUSD(user1, address(litePSM), tinyAmount);

        vm.prank(user1);
        vm.expectRevert("Amount too small");
        litePSM.redeem(tinyAmount);
    }

    function test_DecimalConversion_ExactConversionFactor() public {
        // Verify the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUSDC(user1, address(litePSM), usdcAmount);
        vm.prank(user1);
        litePSM.mint(usdcAmount);

        // OkuUSD should be exactly USDC * 10^12
        assertEq(okuUSD.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuUSD.balanceOf(user1), 123e18);
    }
}
