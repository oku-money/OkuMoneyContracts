// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

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
    event Redeem(address indexed user, uint256 okuUsdIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint USDC to users and PSM buffer
        _mintUsdc(user1, 10_000e6);
        _mintUsdc(user2, 10_000e6);
        _mintUsdc(address(litePsm), 5000e6); // Initial buffer
    }

    // ============ Mint Tests ============

    function test_Mint_TransfersUSDCIn() public {
        uint256 amount = 100e6;
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        uint256 psmBalanceBefore = usdc.balanceOf(address(litePsm));

        _approveUsdc(user1, address(litePsm), amount);

        vm.prank(user1);
        litePsm.mint(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePsm)), psmBalanceBefore + amount);
    }

    function test_Mint_MintsOkuUSDOut() public {
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint(usdcAmount);

        // Should mint 100 OkuUSD (18 decimals) = 100e6 * 10^12 = 100e18
        uint256 expectedOkuUsd = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(okuUsd.balanceOf(user1), expectedOkuUsd);
        assertEq(okuUsd.balanceOf(user1), 100e18); // Explicit check: 100 OkuUSD
    }

    function test_Mint_OneToOneRatio() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint(usdcAmount);

        // Verify 1:1 VALUE ratio: 500 USDC → 500 OkuUSD (with decimal conversion)
        assertEq(okuUsd.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
        assertEq(okuUsd.balanceOf(user1), 500e18); // 500 OkuUSD
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mint(100e6);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePsm.mint(0);
    }

    function test_Mint_EmitsEvent() public {
        uint256 usdcAmount = 100e6;
        uint256 okuUsdAmount = usdcAmount * DECIMAL_MULTIPLIER;

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit Mint(user1, usdcAmount, okuUsdAmount);

        vm.prank(user1);
        litePsm.mint(usdcAmount);
    }

    // ============ Oracle Tests ============

    function test_Mint_ChecksOracleWhenEnabled() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report sufficient reserves
        oracle.setAnswer(int256(1_000_000_000e18));

        uint256 usdcAmount = 100e6;
        _approveUsdc(user1, address(litePsm), usdcAmount);

        uint256 balanceBefore = okuUsd.balanceOf(user1);

        // Should succeed
        vm.prank(user1);
        litePsm.mint(usdcAmount);

        uint256 expectedOkuUsd = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(okuUsd.balanceOf(user1), balanceBefore + expectedOkuUsd, "OkuUSD should be minted");
    }

    function test_Mint_RevertsOnInsufficientReserves() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report LOW reserves
        oracle.setAnswer(int256(1)); // Only 1 wei of reserves

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert("Exceeds reserves");
        litePsm.mint(100e6);
    }

    function test_Mint_RevertsOnStaleOracle() public {
        // Warp to a reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle with short staleness
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Make oracle stale by setting timestamp in the past
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert("Stale oracle data");
        litePsm.mint(100e6);
    }

    function test_Mint_SkipsOracleWhenDisabled() public {
        // Warp to reasonable timestamp to allow setStale to work without underflow
        vm.warp(1_000_000);

        // Oracle configured but disabled
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, false);

        // Set stale oracle data - should be ignored since oracle is disabled
        oracle.setTimestamp(block.timestamp - 2 hours);

        _approveUsdc(user1, address(litePsm), 100e6);

        uint256 balanceBefore = okuUsd.balanceOf(user1);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePsm.mint(100e6);

        uint256 expectedOkuUsd = 100e6 * DECIMAL_MULTIPLIER;
        assertEq(okuUsd.balanceOf(user1), balanceBefore + expectedOkuUsd);
    }

    function test_ConfigureOracle_OnlyOracleManager() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ORACLE_MANAGER));
        litePsm.configureOracle(address(oracle), 1 hours, true);
    }

    function test_ConfigureOracle_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(address(oracle), 2 hours, true);

        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 2 hours, true);
    }

    // ============ Redeem Tests ============

    function test_Redeem_TransfersUSDCOut() public {
        // User needs OkuUSD first - mint 100 OkuUSD (18 decimals)
        uint256 okuUsdAmount = 100e18;
        uint256 expectedUsdc = 100e6; // Should receive 100 USDC (6 decimals)

        _mintOkuUsd(user1, okuUsdAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 psmUsdcBefore = usdc.balanceOf(address(litePsm));

        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
        assertEq(usdc.balanceOf(address(litePsm)), psmUsdcBefore - expectedUsdc);
    }

    function test_Redeem_BurnsOkuUSD() public {
        uint256 okuUsdAmount = 100e18; // 100 OkuUSD

        _mintOkuUsd(user1, okuUsdAmount);

        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        assertEq(okuUsd.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatio() public {
        uint256 okuUsdAmount = 500e18; // 500 OkuUSD
        uint256 expectedUsdc = 500e6; // Should receive 500 USDC

        _mintOkuUsd(user1, okuUsdAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        // 1:1 VALUE ratio: 500 OkuUSD → 500 USDC (with decimal conversion)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 okuUsdAmount = 10_000e18; // 10,000 OkuUSD

        _mintOkuUsd(user1, okuUsdAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuUSD)
        // User needs to approve both PSM (for immediate burns) and Queue (for queuing)
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);
        _approveOkuUsd(user1, address(redemptionQueue), okuUsdAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

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
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        uint256 okuUsdAmount = 100e18; // 100 OkuUSD

        _mintOkuUsd(user1, okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        assertEq(usdc.balanceOf(user1), 10_100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePsm.redeem(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        uint256 okuUsdAmount = 100e18;

        _mintOkuUsd(user1, okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.redeem(okuUsdAmount);
    }

    function test_Redeem_EmitsEvent() public {
        uint256 okuUsdAmount = 100e18;
        uint256 usdcAmount = 100e6;

        _mintOkuUsd(user1, okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        vm.expectEmit(true, false, false, true);
        emit Redeem(user1, okuUsdAmount, usdcAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyQueueProcessor() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_PROCESSOR));
        litePsm.processQueue(10);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        uint256 okuUsdAmount = 6000e18; // 6,000 OkuUSD each

        _mintOkuUsd(user1, okuUsdAmount);
        _mintOkuUsd(user2, okuUsdAmount);

        // Users need to approve queue for transferFrom
        _approveOkuUsd(user1, address(redemptionQueue), okuUsdAmount);
        _approveOkuUsd(user2, address(redemptionQueue), okuUsdAmount);

        // Drain buffer first - redeem more than buffer (5000 USDC worth)
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);
        vm.prank(user1);
        litePsm.redeem(okuUsdAmount); // Queued (buffer only 5000 USDC)

        _approveOkuUsd(user2, address(litePsm), okuUsdAmount);
        vm.prank(user2);
        litePsm.redeem(okuUsdAmount); // Also queued

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer
        _mintUsdc(address(litePsm), 15_000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // processQueue now handles approve-use-revoke internally
        vm.prank(queueProcessor);
        litePsm.processQueue(10);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);
    }

    function test_ProcessQueue_ApprovesAndRevokesAllowance() public {
        // Setup: create a queued redemption
        uint256 okuUsdAmount = 6000e18; // 6,000 OkuUSD

        _mintOkuUsd(user1, okuUsdAmount);
        _approveOkuUsd(user1, address(redemptionQueue), okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount); // Queued (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Refill buffer
        _mintUsdc(address(litePsm), 10_000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Verify allowance is 0 before processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Process queue
        vm.prank(queueProcessor);
        litePsm.processQueue(10);

        // Verify allowance is revoked back to 0 after processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);

        // User should have received USDC (original balance + 6000e6 from queue)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 6000e6);
    }

    function test_ProcessQueue_PartialProcessingRevokesAllowance() public {
        // Setup: create multiple queued redemptions
        uint256 okuUsdAmount = 6000e18; // 6,000 OkuUSD each

        _mintOkuUsd(user1, okuUsdAmount);
        _mintOkuUsd(user2, okuUsdAmount);

        _approveOkuUsd(user1, address(redemptionQueue), okuUsdAmount);
        _approveOkuUsd(user2, address(redemptionQueue), okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);
        _approveOkuUsd(user2, address(litePsm), okuUsdAmount);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        vm.prank(user2);
        litePsm.redeem(okuUsdAmount);

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer with only enough for one redemption
        _mintUsdc(address(litePsm), 7000e6);

        // Grant queue ability to burn OkuUSD
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Process only 1 entry
        vm.prank(queueProcessor);
        litePsm.processQueue(1);

        // Allowance should still be revoked even with partial processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Only 1 entry processed
        assertEq(redemptionQueue.queueLength(), 1);
    }

    // ============ Admin Tests ============

    function test_Pause_OnlyPauser() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_PAUSER));
        litePsm.pause();
    }

    function test_Unpause_OnlyUnpauser() public {
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_UNPAUSER));
        litePsm.unpause();
    }

    function test_WithdrawUSDC_OnlyBufferWithdrawer() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BUFFER_WITHDRAWER));
        litePsm.withdrawUsdc(user1, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
    }

    // ============ Decimal Conversion Tests ============

    function test_DecimalConversion_MintConvertsCorrectly() public {
        uint256 usdcAmount = 1000e6; // 1000 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint(usdcAmount);

        // Should mint exactly 1000 OkuUSD (18 decimals)
        assertEq(okuUsd.balanceOf(user1), 1000e18);

        // Verify the conversion factor
        assertEq(okuUsd.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 okuUsdAmount = 1000e18; // 1000 OkuUSD (18 decimals)

        _mintOkuUsd(user1, okuUsdAmount);
        _approveOkuUsd(user1, address(litePsm), okuUsdAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem(okuUsdAmount);

        // Should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify the conversion factor
        assertEq(usdc.balanceOf(user1) - usdcBefore, okuUsdAmount / DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUsdc = 5000e6; // 5000 USDC

        // Mint OkuUSD
        _approveUsdc(user1, address(litePsm), startingUsdc);
        vm.prank(user1);
        litePsm.mint(startingUsdc);

        uint256 okuUsdReceived = okuUsd.balanceOf(user1);
        assertEq(okuUsdReceived, 5000e18); // 5000 OkuUSD

        // Redeem back to USDC
        _approveOkuUsd(user1, address(litePsm), okuUsdReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeem(okuUsdReceived);

        // Should get back exactly what we started with
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUsdc);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUsdc = 1e6; // 1 USDC (minimum realistic amount)

        _approveUsdc(user1, address(litePsm), smallUsdc);
        vm.prank(user1);
        litePsm.mint(smallUsdc);

        // Should mint 1 OkuUSD
        assertEq(okuUsd.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUsdc = 1_000_000e6; // 1 million USDC

        _mintUsdc(user1, largeUsdc); // Mint more USDC to user
        _approveUsdc(user1, address(litePsm), largeUsdc);

        vm.prank(user1);
        litePsm.mint(largeUsdc);

        // Should mint 1 million OkuUSD
        assertEq(okuUsd.balanceOf(user1), 1_000_000e18);
    }

    function test_DecimalConversion_RedeemTooSmall() public {
        // 1 wei of OkuUSD should fail since it rounds to 0 USDC
        uint256 tinyAmount = 1; // 1 wei of OkuUSD

        _mintOkuUsd(user1, tinyAmount);
        _approveOkuUsd(user1, address(litePsm), tinyAmount);

        vm.prank(user1);
        vm.expectRevert("Amount too small");
        litePsm.redeem(tinyAmount);
    }

    function test_DecimalConversion_ExactConversionFactor() public {
        // Verify the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUsdc(user1, address(litePsm), usdcAmount);
        vm.prank(user1);
        litePsm.mint(usdcAmount);

        // OkuUSD should be exactly USDC * 10^12
        assertEq(okuUsd.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuUsd.balanceOf(user1), 123e18);
    }
}
