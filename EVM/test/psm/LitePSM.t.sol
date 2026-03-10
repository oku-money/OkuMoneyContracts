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
 * @dev Tests verify price-aware conversion between USDC (6 decimals) and OkuNote (18 decimals).
 *      OkuNote is a standard non-rebasing ERC-20. notePrice() tracks price appreciation
 *      separately from balanceOf().
 *
 *      Mint:   noteAmount = usdcValue18 × PRECISION / notePrice()
 *      Redeem: usdcAmount = noteAmount × notePrice() / PRECISION  (scaled to 6 decimals)
 *
 *      At initial notePrice=1e18, behavior is identical to a 1:1 decimal-scaled swap.
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

    // ============ Helpers for price-aware math ============

    /// @notice Calculate expected note amount from USDC deposit at current notePrice
    function _expectedNotesFromUsdc(uint256 usdcAmount) internal view returns (uint256) {
        uint256 usdcValue18 = usdcAmount * DECIMAL_MULTIPLIER;
        uint256 price = okuNote.notePrice();
        return (usdcValue18 * PRECISION) / price;
    }

    /// @notice Calculate expected USDC output from note redemption at current notePrice
    function _expectedUsdcFromNotes(uint256 noteAmount) internal view returns (uint256) {
        uint256 price = okuNote.notePrice();
        uint256 dollarValue18 = (noteAmount * price) / PRECISION;
        return dollarValue18 / DECIMAL_MULTIPLIER;
    }

    /// @notice Raise notePrice to a specific value using updateNotePrice
    function _setNotePrice(uint256 newPrice) internal {
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);
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

        // At base notePrice=1e18: noteAmount = 100e18 * 1e18 / 1e18 = 100e18
        uint256 expectedOkuNote = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuNote.balanceOf(user1), expectedOkuNote);
        assertEq(okuNote.balanceOf(user1), 100e18); // Explicit check: 100 OkuNote at base price
    }

    function test_Mint_OneToOneRatioAtBasePrice() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // At base notePrice=1e18: 500 USDC → 500 OkuNote (price-aware, same as 1:1)
        assertEq(okuNote.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
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
        uint256 noteAmount = _expectedNotesFromUsdc(usdcAmount);

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit MintNote(user1, usdcAmount, noteAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);
    }

    // ============ Price-Aware Mint Tests ============

    function test_Mint_PriceAware_ElevatedPrice() public {
        // Set notePrice to 1.05e18 ($1.05)
        _setNotePrice(1.05e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // noteAmount = 100e18 * 1e18 / 1.05e18 = ~95.238095238095238095e18
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuNote.balanceOf(user1), expectedNotes);
        // At $1.05, 100 USDC buys fewer notes
        assertLt(okuNote.balanceOf(user1), 100e18, "Should receive fewer notes at elevated price");
        assertGt(okuNote.balanceOf(user1), 95e18, "Should receive ~95.24 notes at $1.05");
    }

    function test_Mint_PriceAware_HighPrice() public {
        // Set notePrice to 2e18 ($2.00)
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // noteAmount = 100e18 * 1e18 / 2e18 = 50e18
        assertEq(okuNote.balanceOf(user1), 50e18, "100 USDC at $2/note = 50 notes");
    }

    function test_Mint_PriceAware_EmitsCorrectAmounts() public {
        _setNotePrice(1.05e18);

        uint256 usdcAmount = 100e6;
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit MintNote(user1, usdcAmount, expectedNotes);

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

        uint256 expectedOkuNote = _expectedNotesFromUsdc(usdcAmount);
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

        uint256 expectedOkuNote = _expectedNotesFromUsdc(100e6);
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
        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount); // 100e6 at base price

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

    function test_Redeem_OneToOneRatioAtBasePrice() public {
        uint256 noteAmount = 500e18; // 500 OkuNote
        uint256 expectedUsdc = 500e6; // At base price: 500 USDC

        _mintOkuNote(user1, noteAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // At base notePrice=1e18: 500 OkuNote → 500 USDC (price-aware, same as 1:1)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 noteAmount = 10_000e18; // 10,000 OkuNote

        _mintOkuNote(user1, noteAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuNote at base price)
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
        uint256 usdcAmount = _expectedUsdcFromNotes(noteAmount); // 100e6 at base price

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.expectEmit(true, false, false, true);
        emit RedeemNote(user1, noteAmount, usdcAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);
    }

    // ============ Price-Aware Redeem Tests ============

    function test_Redeem_PriceAware_ElevatedPrice() public {
        // Mint notes at base price, then raise price before redeeming
        uint256 noteAmount = 100e18;

        _mintOkuNote(user1, noteAmount);

        // Raise notePrice to 1.05e18 ($1.05)
        _setNotePrice(1.05e18);

        // Now each note is worth $1.05 → 100 notes = $105
        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount);
        // 100e18 * 1.05e18 / 1e18 = 105e18 dollarValue → 105e18 / 1e12 = 105e6
        assertEq(expectedUsdc, 105e6, "100 notes at $1.05 = 105 USDC");

        // Need extra buffer to cover elevated price
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 105e6, "Should receive 105 USDC");
        assertEq(okuNote.balanceOf(user1), 0, "All notes burned");
    }

    function test_Redeem_PriceAware_HighPrice() public {
        uint256 noteAmount = 50e18;

        _mintOkuNote(user1, noteAmount);

        // Raise notePrice to 2e18 ($2.00)
        _setNotePrice(2e18);

        // 50 notes at $2 = $100
        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount);
        assertEq(expectedUsdc, 100e6, "50 notes at $2.00 = 100 USDC");

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 100e6);
    }

    function test_Redeem_PriceAware_EmitsCorrectAmounts() public {
        uint256 noteAmount = 100e18;

        _mintOkuNote(user1, noteAmount);

        _setNotePrice(1.05e18);
        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount); // 105e6

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.expectEmit(true, false, false, true);
        emit RedeemNote(user1, noteAmount, expectedUsdc);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);
    }

    // ============ Price-Aware Round-Trip Tests ============

    function test_RoundTrip_PriceAware_MintThenRedeem() public {
        // Raise price first, then do a full mint→redeem cycle
        _setNotePrice(1.05e18);

        uint256 usdcDeposit = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcDeposit);

        uint256 notesReceived = okuNote.balanceOf(user1);
        // 100e18 * 1e18 / 1.05e18 = ~95.238095238095238095e18
        assertLt(notesReceived, 100e18, "Fewer notes at elevated price");

        // Redeem all notes back
        _approveOkuNote(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(notesReceived);

        uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;

        // Round-trip should return ~100 USDC (may lose up to 1 USDC-wei from truncation)
        // At $1.05: 100 USDC → ~95.24 notes → ~95.24 * 1.05 = ~$100 → 100e6 USDC (or 99e6 from rounding)
        assertGe(usdcReceived, usdcDeposit - 1, "Round-trip loss should be at most 1 USDC-wei");
        assertLe(usdcReceived, usdcDeposit, "Should not profit from round-trip");
    }

    function test_RoundTrip_PriceAware_SymmetricAtDoublePrice() public {
        _setNotePrice(2e18);

        uint256 usdcDeposit = 200e6; // 200 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mint_OkuNote(usdcDeposit);

        // 200 USDC at $2/note = 100 notes
        uint256 notesReceived = okuNote.balanceOf(user1);
        assertEq(notesReceived, 100e18, "200 USDC at $2/note = 100 notes");

        _approveOkuNote(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(notesReceived);

        // 100 notes at $2 = 200 USDC — clean round-trip
        assertEq(usdc.balanceOf(user1) - usdcBefore, 200e6, "Clean round-trip at $2");
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

        // Drain buffer first - redeem more than buffer (5000 USDC worth at base price)
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

        // User should have received USDC (original balance + 6000e6 from queue at base price)
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

    // ============ Price-Aware Queue Tests ============

    function test_ProcessQueue_PriceAware_YieldAccruesWhileQueued() public {
        // Queue at base price, then process at elevated price
        uint256 noteAmount = 6000e18;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Queued at base price (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueLength(), 1);

        // Raise notePrice to 1.05e18 — queued notes now worth more USDC
        _setNotePrice(1.05e18);

        // Queue entry stores noteAmount=6000e18. At $1.05: USDC = 6000 * 1.05 = 6300
        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount);
        assertEq(expectedUsdc, 6300e6, "6000 notes at $1.05 = 6300 USDC");

        // Refill buffer with enough for elevated price
        _mintUsdc(address(litePsm), 10_000e6);

        vm.prank(admin);
        okuNote.grantRole(MINTER, address(redemptionQueue));

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();

        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, expectedUsdc);

        assertEq(redemptionQueue.queueLength(), 0);
        // User receives more USDC than at base price due to price appreciation
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + 6300e6,
            "User earns yield via notePrice while queued"
        );
    }

    function test_Redeem_PriceAware_QueuesWhenBufferInsufficientDueToPrice() public {
        // Buffer has 5000 USDC. At base price, 4900 notes → 4900 USDC (sufficient).
        // But at $1.05, 4900 notes → 5145 USDC (exceeds buffer).
        _setNotePrice(1.05e18);

        uint256 noteAmount = 4900e18;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount);
        assertEq(expectedUsdc, 5145e6, "4900 notes at $1.05 = 5145 USDC");
        assertGt(expectedUsdc, usdc.balanceOf(address(litePsm)), "Should exceed buffer");

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // Should be queued because USDC needed (5145) exceeds buffer (5000)
        assertEq(redemptionQueue.queueLength(), 1, "Should be queued");
        assertEq(okuNote.balanceOf(address(redemptionQueue)), noteAmount, "Notes held by queue");
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
        uint256 noteAmount = 10_000e18; // 10,000 OkuNote (needs 10,000 USDC at base price)
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount); // Buffer (5000e6) < 10000e6 → queued

        // PSM buffer is still 5000e6 since no USDC was moved, only OkuNote was queued
        // Trying to withdraw the full buffer would strand the obligation
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

        // At base notePrice=1e18: should mint exactly 1000 OkuNote (18 decimals)
        assertEq(okuNote.balanceOf(user1), 1000e18);

        // Verify the price-aware conversion equals decimal multiplier at base price
        assertEq(okuNote.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 noteAmount = 1000e18; // 1000 OkuNote (18 decimals)

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // At base notePrice=1e18: should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify via price-aware helper
        assertEq(usdc.balanceOf(user1) - usdcBefore, _expectedUsdcFromNotes(noteAmount));
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUsdc = 5000e6; // 5000 USDC

        // Mint OkuNote
        _approveUsdc(user1, address(litePsm), startingUsdc);
        vm.prank(user1);
        litePsm.mint_OkuNote(startingUsdc);

        uint256 noteReceived = okuNote.balanceOf(user1);
        assertEq(noteReceived, 5000e18); // 5000 OkuNote at base price

        // Redeem back to USDC
        _approveOkuNote(user1, address(litePsm), noteReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeem_OkuNote(noteReceived);

        // Should get back exactly what we started with at base price
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUsdc);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUsdc = 1e6; // 1 USDC (minimum realistic amount)

        _approveUsdc(user1, address(litePsm), smallUsdc);
        vm.prank(user1);
        litePsm.mint_OkuNote(smallUsdc);

        // At base price: should mint 1 OkuNote
        assertEq(okuNote.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUsdc = 1_000_000e6; // 1 million USDC

        _mintUsdc(user1, largeUsdc); // Mint more USDC to user
        _approveUsdc(user1, address(litePsm), largeUsdc);

        vm.prank(user1);
        litePsm.mint_OkuNote(largeUsdc);

        // At base price: should mint 1 million OkuNote
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
        // Verify at base notePrice the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUsdc(user1, address(litePsm), usdcAmount);
        vm.prank(user1);
        litePsm.mint_OkuNote(usdcAmount);

        // At base price: OkuNote = USDC * 10^12
        assertEq(okuNote.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuNote.balanceOf(user1), 123e18);
    }

    // ============ Truncation Dust Retention Tests (Finding 7) ============

    function test_Redeem_TruncationDustBurnedWithNote() public {
        // Mint OkuNote with sub-USDC dust: 100.0000005 OkuNote
        uint256 noteAmount = 100e18 + 5e11; // 100 OkuNote + 0.0000005 OkuNote dust

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // At base price: dollarValue18 = noteAmount * 1e18 / 1e18 = noteAmount
        // usdcAmount = noteAmount / 1e12 = 100e6 (truncated down, dust lost)
        // PSM transfers and burns the FULL noteAmount — user retains nothing.
        // The sub-USDC dust value is lost in the integer truncation.
        assertEq(okuNote.balanceOf(user1), 0, "All notes transferred and burned");
        assertEq(
            usdc.balanceOf(user1) - usdcBefore,
            100e6,
            "User receives truncated USDC (dust value lost)"
        );
    }

    function test_Redeem_QueuePath_TruncationDustQueuedWithNote() public {
        // Amount that exceeds buffer AND has dust
        uint256 noteAmount = 10_000e18 + 7e11;

        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        // PSM transfers the full noteAmount (including dust) to the queue.
        // User retains nothing — all notes are moved.
        assertEq(okuNote.balanceOf(user1), 0, "All notes transferred to queue");

        // Queue holds the full amount including dust
        assertEq(
            okuNote.balanceOf(address(redemptionQueue)),
            noteAmount,
            "Queue holds full noteAmount including dust"
        );
    }

    function test_Redeem_PriceAware_TruncationDustAtElevatedPrice() public {
        // At elevated price, dust calculation changes
        _setNotePrice(1.05e18);

        // 100 notes at $1.05: dollarValue18 = 100e18 * 1.05e18 / 1e18 = 105e18
        // usdcAmount = 105e18 / 1e12 = 105e6 (clean, no dust)
        // Add sub-USDC dust in dollar-value terms
        // dollarValue18 = noteAmount * 1.05e18 / 1e18
        // For dust to appear: we need dollarValue18 to have sub-1e12 residue
        // noteAmount = 100e18 + 1 → dollarValue18 = (100e18 + 1) * 1.05e18 / 1e18
        //            = 105e18 + 1.05 (truncated to 105e18 + 1)
        // usdcAmount = (105e18 + 1) / 1e12 = 105e6 (same, dust lost in USDC truncation)
        uint256 noteAmount = 100e18;

        _mintOkuNote(user1, noteAmount);
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuNote(user1, address(litePsm), noteAmount);

        vm.prank(user1);
        litePsm.redeem_OkuNote(noteAmount);

        uint256 expectedUsdc = _expectedUsdcFromNotes(noteAmount);
        assertEq(expectedUsdc, 105e6, "100 notes at $1.05 = 105 USDC");
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

        // At base price: should redeem 100 USDC
        uint256 expectedUsdc = _expectedUsdcFromNotes(amount);
        assertEq(usdc.balanceOf(user1Addr), usdcBefore + expectedUsdc);
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

        uint256 expectedOkuNote = _expectedNotesFromUsdc(100e6);
        assertEq(okuNote.balanceOf(user1), expectedOkuNote);
    }
}
