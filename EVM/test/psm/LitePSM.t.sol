// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";

/**
 * @title LitePSMTest
 * @notice Unit tests for LitePSM (Peg Stability Module)
 * @dev Tests verify correct 1:1 value conversion between USDC (6 decimals) and OkuNote (18 decimals).
 *      The PSM multiplies by 10^12 when minting and divides by 10^12 when redeeming.
 */
contract LitePSMTest is BaseTest {
    // Decimal conversion constant
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12;
    // ============ Events ============

    event MintNote(address indexed user, uint256 usdcAmount, uint256 noteAmount);
    event RedeemNote(address indexed user, uint256 noteIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);
    event BufferDeposited(address indexed depositor, uint256 amount);

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
        litePsm.mint_OkuNote(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePsm)), psmBalanceBefore + amount);
    }

    function test_Mint_MintsOkuNoteOut() public {
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // Should mint 100 OkuNote (18 decimals) = 100e6 * 10^12 = 100e18
        uint256 expectedOkuNote = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(okuNote.balanceOf(user1), expectedOkuNote);
        assertEq(okuNote.balanceOf(user1), 100e18); // Explicit check: 100 OkuNote
    }

    function test_Mint_OneToOneRatio() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // Verify 1:1 VALUE ratio: 500 USDC → 500 OkuNote (with decimal conversion)
        assertEq(okuNote.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
        assertEq(okuNote.balanceOf(user1), 500e18); // 500 OkuNote
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mint_OkuNote(100e6);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePsm.mint_OkuNote(0);
    }

    function test_Mint_EmitsEvent() public {
        uint256 usdcAmount = 100e6;
        uint256 noteAmount = usdcAmount * DECIMAL_MULTIPLIER;

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit MintNote(user1, usdcAmount, noteAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);
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

        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Should succeed
        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        uint256 expectedOkuNote = usdcAmount * DECIMAL_MULTIPLIER;
        assertEq(
            okuNote.balanceOf(user1), balanceBefore + expectedOkuNote, "OkuNote should be minted"
        );
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
        litePsm.mint_OkuNote(100e6);
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
        litePsm.mint_OkuNote(100e6);
    }

    function test_Mint_RevertsOnIncompleteRound() public {
        // Warp to a reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Simulate an incomplete round (answeredInRound < roundId)
        oracle.setRoundIncomplete();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert("Incomplete oracle round");
        litePsm.mint_OkuNote(100e6);
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

        uint256 balanceBefore = okuNote.balanceOf(user1);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePsm.mint_OkuNote(100e6);

        uint256 expectedOkuNote = 100e6 * DECIMAL_MULTIPLIER;
        assertEq(okuNote.balanceOf(user1), balanceBefore + expectedOkuNote);
    }

    function test_ConfigureOracle_OnlyOracleManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ORACLE_MANAGER
            )
        );
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
        // User needs OkuNote first - mint 100 OkuNote (18 decimals)
        uint256 noteAmount = 100e18;
        uint256 expectedUsdc = 100e6; // Should receive 100 USDC (6 decimals)

        _mintOkuNote(user1, noteAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 psmUsdcBefore = usdc.balanceOf(address(litePsm));

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
        assertEq(usdc.balanceOf(address(litePsm)), psmUsdcBefore - expectedUsdc);
    }

    function test_Redeem_BurnsOkuNote() public {
        uint256 noteAmount = 100e18; // 100 OkuNote

        _mintOkuNote(user1, noteAmount);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(okuNote.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatio() public {
        uint256 noteAmount = 500e18; // 500 OkuNote
        uint256 expectedUsdc = 500e6; // Should receive 500 USDC

        _mintOkuNote(user1, noteAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // 1:1 VALUE ratio: 500 OkuNote → 500 USDC (with decimal conversion)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 noteAmount = 10_000e18; // 10,000 OkuNote

        _mintOkuNote(user1, noteAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuNote)
        // User only needs to approve PSM — PSM handles the transfer to queue
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // Should be queued, not immediate redemption (buffer insufficient)
        // User still has their OkuNote (transferred to queue contract)
        // Check queue has entry
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_Redeem_QueuesWithOnlyPSMApproval() public {
        uint256 noteAmount = 10_000e18; // 10,000 OkuNote (buffer only has 5000 USDC worth)

        _mintOkuNote(user1, noteAmount);

        // Verify only PSM approval is needed — no queue approval at all
        _approveOkuNote(user1, address(litePsm), noteAmount);
        // Deliberately do NOT approve the queue

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Must succeed with only PSM approval

        assertEq(redemptionQueue.queueLength(), 1);
        // OkuNote is now held by the queue contract
        assertEq(okuNote.balanceOf(address(redemptionQueue)), noteAmount);
    }

    function test_Redeem_NoOracleCheck() public {
        // Warp to reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        uint256 noteAmount = 100e18; // 100 OkuNote

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(usdc.balanceOf(user1), 10_100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        litePsm.redeem_OkuNote(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        uint256 noteAmount = 100e18;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.redeem_OkuNote(noteAmount);
    }

    function test_Redeem_EmitsEvent() public {
        uint256 noteAmount = 100e18;
        uint256 usdcAmount = 100e6;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.expectEmit(true, false, false, true);
        emit RedeemNote(user1, noteAmount, usdcAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyQueueProcessor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_PROCESSOR
            )
        );
        litePsm.processQueue(0, 10, 0);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        uint256 noteAmount = 6000e18; // 6,000 OkuNote each

        _mintOkuNote(user1, noteAmount);
        _mintOkuNote(user2, noteAmount);

        // Drain buffer first - redeem more than buffer (5000 USDC worth)
        // Only PSM approval needed; PSM moves tokens to queue internally
        _approveOkuNote(user1, address(litePsm), noteAmount);
        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Queued (buffer only 5000 USDC)

        _approveOkuNote(user2, address(litePsm), noteAmount);
        vm.prank(user2);
        litePsm.redeem_OkuNote(noteAmount); // Also queued

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer
        _mintUsdc(address(litePsm), 15_000e6);

        // Grant queue ability to burn OkuNote
        vm.prank(admin);
        okuNote.grantRole(MINTER, address(redemptionQueue));

        // processQueue now handles approve-use-revoke internally
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, 12_000e6); // 6000 USDC * 2 entries

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);
    }

    function test_ProcessQueue_ApprovesAndRevokesAllowance() public {
        // Setup: create a queued redemption
        uint256 noteAmount = 6000e18; // 6,000 OkuNote

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Queued (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Refill buffer
        _mintUsdc(address(litePsm), 10_000e6);

        // Grant queue ability to burn OkuNote
        vm.prank(admin);
        okuNote.grantRole(MINTER, address(redemptionQueue));

        // Verify allowance is 0 before processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Process queue
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, 6000e6);

        // Verify allowance is revoked back to 0 after processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Queue should be processed
        assertEq(redemptionQueue.queueLength(), 0);

        // User should have received USDC (original balance + 6000e6 from queue)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 6000e6);
    }

    function test_ProcessQueue_PartialProcessingRevokesAllowance() public {
        // Setup: create multiple queued redemptions
        uint256 noteAmount = 6000e18; // 6,000 OkuNote each

        _mintOkuNote(user1, noteAmount);
        _mintOkuNote(user2, noteAmount);

        _approveOkuNote(user1, address(litePsm), noteAmount);
        _approveOkuNote(user2, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        vm.prank(user2);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(redemptionQueue.queueLength(), 2);

        // Refill buffer with only enough for one redemption
        _mintUsdc(address(litePsm), 7000e6);

        // Grant queue ability to burn OkuNote
        vm.prank(admin);
        okuNote.grantRole(MINTER, address(redemptionQueue));

        // Process only 1 entry
        uint256 head = redemptionQueue.queueHead();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, head + 1, 6000e6);

        // Allowance should still be revoked even with partial processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Only 1 entry processed
        assertEq(redemptionQueue.queueLength(), 1);
    }

    // ============ Admin Tests ============

    function test_Pause_OnlyPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_PAUSER
            )
        );
        litePsm.pause();
    }

    function test_Unpause_OnlyUnpauser() public {
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_UNPAUSER
            )
        );
        litePsm.unpause();
    }

    function test_WithdrawUSDC_OnlyBufferWithdrawer() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BUFFER_WITHDRAWER
            )
        );
        litePsm.withdrawUsdc(user1, 100e6);
    }

    function test_WithdrawUSDC_TransfersToRecipient() public {
        uint256 amount = 100e6;
        uint256 user1Before = usdc.balanceOf(user1);

        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(user1, amount);

        assertEq(usdc.balanceOf(user1), user1Before + amount);
    }

    function test_WithdrawUSDC_RevertsWhenWouldStrandQueue() public {
        // Queue a redemption to create an obligation
        uint256 noteAmount = 10_000e18; // 10,000 OkuNote (needs 10,000 USDC)
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Buffer (5000e6) < 10000e6 → queued

        // PSM buffer is 0 now (all USDC went nowhere, but queue obligation is 10000 USDC)
        // Actually buffer is still 5000e6 since no USDC was moved, only OkuNote was queued
        // Trying to withdraw the full buffer would strand the 10000 USDC obligation
        uint256 obligation = redemptionQueue.totalQueuedUsdc();
        assertGt(obligation, 0, "Queue should have obligation");

        // Withdrawing more than (balance - obligation) should revert
        uint256 balance = usdc.balanceOf(address(litePsm));
        uint256 safeWithdraw = balance > obligation ? balance - obligation : 0;
        uint256 unsafeAmount = safeWithdraw + 1e6;

        if (unsafeAmount <= balance) {
            vm.prank(bufferWithdrawer);
            vm.expectRevert("Would strand queue");
            litePsm.withdrawUsdc(user1, unsafeAmount);
        }
    }

    // ============ Decimal Conversion Tests ============

    function test_DecimalConversion_MintConvertsCorrectly() public {
        uint256 usdcAmount = 1000e6; // 1000 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // Should mint exactly 1000 OkuNote (18 decimals)
        assertEq(okuNote.balanceOf(user1), 1000e18);

        // Verify the conversion factor
        assertEq(okuNote.balanceOf(user1), usdcAmount * DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 noteAmount = 1000e18; // 1000 OkuNote (18 decimals)

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // Should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify the conversion factor
        assertEq(usdc.balanceOf(user1) - usdcBefore, noteAmount / DECIMAL_MULTIPLIER);
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUsdc = 5000e6; // 5000 USDC

        // Mint OkuNote
        _approveUsdc(user1, address(litePsm), startingUsdc);
        vm.prank(user1);
        litePsm.mint_OkuNote(startingUsdc);

        uint256 noteReceived = okuNote.balanceOf(user1);
        assertEq(noteReceived, 5000e18); // 5000 OkuNote

        // Redeem back to USDC
        _approveOkuNote(user1, address(litePsm), noteReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeem_OkuNote(noteReceived);

        // Should get back exactly what we started with
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUsdc);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUsdc = 1e6; // 1 USDC (minimum realistic amount)

        _approveUsdc(user1, address(litePsm), smallUsdc);
        vm.prank(user1);
        litePsm.mint_OkuNote(smallUsdc);

        // Should mint 1 OkuNote
        assertEq(okuNote.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUsdc = 1_000_000e6; // 1 million USDC

        _mintUsdc(user1, largeUsdc); // Mint more USDC to user
        _approveUsdc(user1, address(litePsm), largeUsdc);

        vm.prank(user1);
        litePsm.mint_OkuNote(largeUsdc);

        // Should mint 1 million OkuNote
        assertEq(okuNote.balanceOf(user1), 1_000_000e18);
    }

    function test_DecimalConversion_RedeemTooSmall() public {
        // 1 wei of OkuNote should fail since it rounds to 0 USDC
        uint256 tinyAmount = 1; // 1 wei of OkuNote

        _mintOkuNote(user1, tinyAmount);
        _approveOkuNote(user1, address(litePsm), tinyAmount);

        vm.prank(user1);
        vm.expectRevert("Amount too small");
        litePsm.redeem_OkuNote(tinyAmount);
    }

    function test_DecimalConversion_ExactConversionFactor() public {
        // Verify the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUsdc(user1, address(litePsm), usdcAmount);
        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // OkuNote should be exactly USDC * 10^12
        assertEq(okuNote.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuNote.balanceOf(user1), 123e18);
    }

    // ============ Truncation Dust Retention Tests (Finding 7) ============

    function test_Redeem_TruncationDustRetainedByUser() public {
        // Mint OkuNote with sub-USDC dust: 100.5e12 wei = 100 USDC + 0.5e12 dust
        uint256 noteAmount = 100e18 + 5e11; // 100 OkuNote + 0.0000005 OkuNote dust

        _mintOkuNote(user1, noteAmount);
        // Only approve aligned amount (PSM only takes aligned)
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 noteBalanceBefore = okuNote.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // User should have received 100 USDC (truncated down)
        // And retained 5e11 dust in their OkuNote balance
        uint256 dustRetained = okuNote.balanceOf(user1);
        assertEq(dustRetained, 5e11, "User should retain sub-USDC dust");
        assertEq(noteBalanceBefore - dustRetained, 100e18, "PSM should only take aligned amount");
    }

    function test_Redeem_QueuePath_TruncationDustRetained() public {
        // Amount that exceeds buffer AND has dust
        uint256 noteAmount = 10_000e18 + 7e11;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // User should retain sub-USDC dust
        assertEq(okuNote.balanceOf(user1), 7e11, "Queue path should also retain dust");

        // Queue should hold aligned amount
        assertEq(okuNote.balanceOf(address(redemptionQueue)), 10_000e18);
    }

    // ============ DepositBuffer Tests ============

    function test_DepositBuffer_OnlyBufferDepositor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BUFFER_DEPOSITOR
            )
        );
        litePsm.depositBuffer(100e6);
    }

    function test_DepositBuffer_TransfersUSDC() public {
        uint256 amount = 1000e6;
        _mintUsdc(bufferDepositor, amount);
        _approveUsdc(bufferDepositor, address(litePsm), amount);

        uint256 psmBefore = usdc.balanceOf(address(litePsm));

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(amount);

        assertEq(usdc.balanceOf(address(litePsm)), psmBefore + amount);
        assertEq(usdc.balanceOf(bufferDepositor), 0);
    }

    function test_DepositBuffer_EmitsEvent() public {
        uint256 amount = 500e6;
        _mintUsdc(bufferDepositor, amount);
        _approveUsdc(bufferDepositor, address(litePsm), amount);

        vm.expectEmit(true, false, false, true);
        emit BufferDeposited(bufferDepositor, amount);

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(amount);
    }

    // ============ WithdrawUSDC Underflow Guard (Finding 8) ============

    function test_WithdrawUSDC_RevertInsufficientBalance() public {
        // PSM has 5000e6 buffer. Try to withdraw more than balance.
        uint256 balance = usdc.balanceOf(address(litePsm));

        vm.prank(bufferWithdrawer);
        vm.expectRevert("Insufficient USDC balance");
        litePsm.withdrawUsdc(user1, balance + 1);
    }

    // ============ RedeemWithPermit Tests ============

    function test_RedeemWithPermit_Success() public {
        uint256 amount = 100e18;
        _mintOkuNote(user1, amount);

        // Generate permit signature
        uint256 user1Pk = 0xA11CE; // Private key for signing
        address user1Addr = vm.addr(user1Pk);

        // Mint to the permit user instead
        _mintOkuNote(user1Addr, amount);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuNote.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        uint256 usdcBefore = usdc.balanceOf(user1Addr);

        vm.prank(user1Addr);
        litePsm.redeem_OkuNoteWithPermit(amount, deadline, v, r, s);

        // Should redeem 100 USDC
        assertEq(usdc.balanceOf(user1Addr), usdcBefore + 100e6);
        assertEq(okuNote.balanceOf(user1Addr), 0);
    }

    function test_RedeemWithPermit_RevertsExpiredDeadline() public {
        uint256 amount = 100e18;
        uint256 user1Pk = 0xA11CE;
        address user1Addr = vm.addr(user1Pk);
        _mintOkuNote(user1Addr, amount);

        uint256 deadline = block.timestamp - 1; // Already expired
        bytes32 domainSeparator = _getOkuNoteDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuNote.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        vm.prank(user1Addr);
        vm.expectRevert(); // ERC2612ExpiredSignature
        litePsm.redeem_OkuNoteWithPermit(amount, deadline, v, r, s);
    }

    // ============ UUPS Upgrade (Finding 24) ============

    function test_UUPS_UpgradePSM() public {
        LitePSM newImpl = new LitePSM();

        vm.prank(admin);
        litePsm.upgradeToAndCall(address(newImpl), "");

        // Verify state preserved (okuNote address still set)
        assertEq(address(litePsm.okuNote()), address(okuNote));
    }

    function test_UUPS_UpgradePSM_RevertNotUpgrader() public {
        LitePSM newImpl = new LitePSM();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_UPGRADER
            )
        );
        litePsm.upgradeToAndCall(address(newImpl), "");
    }

    // ============ Internal Helpers ============

    function _getOkuNoteDomainSeparator() internal view returns (bytes32) {
        // EIP-712 domain separator for OkuNote
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

    // ============ Oracle Edge Case Tests ============

    function test_Mint_SkipsOracleWhenEnabledButAddressZero() public {
        // Oracle enabled but address is zero — both conditions must hold for check
        vm.prank(oracleManager);
        litePsm.configureOracle(address(0), 1 hours, true);

        _approveUsdc(user1, address(litePsm), 100e6);

        // Should succeed because oracle address is zero
        vm.prank(user1);
        litePsm.mint_OkuNote(100e6);

        uint256 expectedOkuNote = 100e6 * DECIMAL_MULTIPLIER;
        assertEq(okuNote.balanceOf(user1), expectedOkuNote);
    }
}
