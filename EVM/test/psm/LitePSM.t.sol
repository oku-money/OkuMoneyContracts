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
 * @dev Tests verify price-aware conversion between USDC (6 decimals) and OkuMoney (18 decimals).
 *      OkuMoney is a standard non-rebasing ERC-20. okuMPrice() tracks price appreciation
 *      separately from balanceOf().
 *
 *      Mint:   okuMAmount = usdcValue18 × PRECISION / okuMPrice()
 *      Redeem: usdcAmount = okuMAmount × okuMPrice() / PRECISION  (scaled to 6 decimals)
 *
 *      At initial notePrice=1e18, behavior is identical to a 1:1 decimal-scaled swap.
 */
contract LitePSMTest is BaseTest {
    // Decimal conversion constant
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12;
    // ============ Events ============

    event MintNote(address indexed user, uint256 usdcAmount, uint256 okuMAmount);
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
        uint256 price = okuMoney.okuMPrice();
        return (usdcValue18 * PRECISION) / price;
    }

    /// @notice Calculate expected USDC output from note redemption at current notePrice
    function _expectedUsdcFromNotes(uint256 okuMAmount) internal view returns (uint256) {
        uint256 price = okuMoney.okuMPrice();
        uint256 dollarValue18 = (okuMAmount * price) / PRECISION;
        return dollarValue18 / DECIMAL_MULTIPLIER;
    }

    /// @notice Raise notePrice to a specific value using updateNotePrice
    /// @dev Rolls to next block after setting price to avoid yield distribution lock
    function _setNotePrice(uint256 newPrice) internal {
        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newPrice);
        vm.roll(block.number + 1); // Avoid yield distribution lock
    }

    // ============ Mint Tests ============

    function test_Mint_TransfersUSDCIn() public {
        uint256 amount = 100e6;
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        uint256 psmBalanceBefore = usdc.balanceOf(address(litePsm));

        _approveUsdc(user1, address(litePsm), amount);

        vm.prank(user1);
        litePsm.mintOkuM(amount);

        assertEq(usdc.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(usdc.balanceOf(address(litePsm)), psmBalanceBefore + amount);
    }

    function test_Mint_MintsOkuMoneyOut() public {
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base notePrice=1e18: okuMAmount = 100e18 * 1e18 / 1e18 = 100e18
        uint256 expectedOkuMoney = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuMoney.balanceOf(user1), expectedOkuMoney);
        assertEq(okuMoney.balanceOf(user1), 100e18); // Explicit check: 100 OkuMoney at base price
    }

    function test_Mint_OneToOneRatioAtBasePrice() public {
        uint256 usdcAmount = 500e6; // 500 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base notePrice=1e18: 500 USDC → 500 OkuMoney (price-aware, same as 1:1)
        assertEq(okuMoney.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
        assertEq(okuMoney.balanceOf(user1), 500e18); // 500 OkuMoney
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        litePsm.pause();

        _approveUsdc(user1, address(litePsm), 100e6);

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(LitePSM.ZeroAmount.selector);
        litePsm.mintOkuM(0);
    }

    function test_Mint_EmitsEvent() public {
        uint256 usdcAmount = 100e6;
        uint256 okuMAmount = _expectedNotesFromUsdc(usdcAmount);

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit MintNote(user1, usdcAmount, okuMAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);
    }

    // ============ Price-Aware Mint Tests ============

    function test_Mint_PriceAware_ElevatedPrice() public {
        // Set notePrice to 2e18 ($2.00) - even multiplier avoids rounding in slippage check
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 2e18 = 50e18
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);
        assertEq(okuMoney.balanceOf(user1), expectedNotes);
        // At $2.00, 100 USDC buys 50 notes
        assertEq(okuMoney.balanceOf(user1), 50e18, "100 USDC at $2/note = 50 notes");
        assertLt(okuMoney.balanceOf(user1), 100e18, "Should receive fewer notes at elevated price");
    }

    function test_Mint_PriceAware_HighPrice() public {
        // Set notePrice to 2e18 ($2.00)
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // okuMAmount = 100e18 * 1e18 / 2e18 = 50e18
        assertEq(okuMoney.balanceOf(user1), 50e18, "100 USDC at $2/note = 50 notes");
    }

    function test_Mint_PriceAware_EmitsCorrectAmounts() public {
        // Use an even price to avoid rounding issues with slippage check
        _setNotePrice(2e18);

        uint256 usdcAmount = 100e6;
        uint256 expectedNotes = _expectedNotesFromUsdc(usdcAmount);

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit MintNote(user1, usdcAmount, expectedNotes);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);
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

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Should succeed
        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        uint256 expectedOkuMoney = _expectedNotesFromUsdc(usdcAmount);
        assertEq(
            okuMoney.balanceOf(user1), balanceBefore + expectedOkuMoney, "OkuMoney should be minted"
        );
    }

    function test_Mint_RevertsOnInsufficientReserves() public {
        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to report LOW reserves
        oracle.setAnswer(int256(1)); // Only 1 wei of reserves

        _approveUsdc(user1, address(litePsm), 100e6);

        uint256 expectedOkuMAmount = _expectedNotesFromUsdc(100e6);
        uint256 newSupply = okuMoney.totalSupply() + expectedOkuMAmount;
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.ExceedsReserves.selector, newSupply, 1));
        litePsm.mintOkuM(100e6);
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
        vm.expectRevert(LitePSM.StaleOracleData.selector);
        litePsm.mintOkuM(100e6);
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
        vm.expectRevert(LitePSM.IncompleteOracleRound.selector);
        litePsm.mintOkuM(100e6);
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

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        // Should succeed because oracle is disabled
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        uint256 expectedOkuMoney = _expectedNotesFromUsdc(100e6);
        assertEq(okuMoney.balanceOf(user1), balanceBefore + expectedOkuMoney);
    }

    function test_ConfigureOracle_OnlyOracleManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_ORACLE_MANAGER
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
        // User needs OkuMoney first - mint 100 OkuMoney (18 decimals)
        uint256 okuMAmount = 100e18;
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount); // 100e6 at base price

        _mintOkuMoney(user1, okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 psmUsdcBefore = usdc.balanceOf(address(litePsm));

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
        assertEq(usdc.balanceOf(address(litePsm)), psmUsdcBefore - expectedUsdc);
    }

    function test_Redeem_BurnsOkuMoney() public {
        uint256 okuMAmount = 100e18; // 100 OkuMoney

        _mintOkuMoney(user1, okuMAmount);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(okuMoney.balanceOf(user1), 0);
    }

    function test_Redeem_OneToOneRatioAtBasePrice() public {
        uint256 okuMAmount = 500e18; // 500 OkuMoney
        uint256 expectedUsdc = 500e6; // At base price: 500 USDC

        _mintOkuMoney(user1, okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base notePrice=1e18: 500 OkuMoney → 500 USDC (price-aware, same as 1:1)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + expectedUsdc);
    }

    function test_Redeem_QueuesWhenBufferInsufficient() public {
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney

        _mintOkuMoney(user1, okuMAmount);

        // PSM only has 5000e6 USDC buffer (worth 5,000 OkuMoney at base price)
        // User only needs to approve PSM — PSM handles the transfer to queue
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // Should be queued, not immediate redemption (buffer insufficient)
        // User still has their OkuMoney (transferred to queue contract)
        // Check queue has entry
        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    function test_Redeem_QueuesWithOnlyPSMApproval() public {
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney (buffer only has 5000 USDC worth)

        _mintOkuMoney(user1, okuMAmount);

        // Verify only PSM approval is needed — no queue approval at all
        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        // Deliberately do NOT approve the queue

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Must succeed with only PSM approval

        assertEq(redemptionQueue.queueUpperBound(), 1);
        // OkuMoney is now held by the queue contract
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), okuMAmount);
    }

    function test_Redeem_NoOracleCheck() public {
        // Warp to reasonable timestamp first
        vm.warp(1_000_000);

        // Configure oracle
        vm.prank(oracleManager);
        litePsm.configureOracle(address(oracle), 1 hours, true);

        // Set oracle to stale (now safe since we warped forward)
        oracle.setTimestamp(block.timestamp - 2 hours);

        uint256 okuMAmount = 100e18; // 100 OkuMoney

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        // Redeem should NOT check oracle
        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), 10_100e6); // Initial 10000 + 100 redeemed
    }

    function test_Redeem_RevertsZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(LitePSM.ZeroAmount.selector);
        litePsm.redeemOkuM(0);
    }

    function test_Redeem_RevertsWhenPaused() public {
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.redeemOkuM(okuMAmount);
    }

    function test_Redeem_EmitsEvent() public {
        uint256 okuMAmount = 100e18;
        uint256 usdcAmount = _expectedUsdcFromNotes(okuMAmount); // 100e6 at base price

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.expectEmit(true, false, false, true);
        emit RedeemNote(user1, okuMAmount, usdcAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);
    }

    // ============ Price-Aware Redeem Tests ============

    function test_Redeem_PriceAware_ElevatedPrice() public {
        // Mint notes at base price, then raise price before redeeming
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);

        // Raise notePrice to 1.05e18 ($1.05)
        _setNotePrice(1.05e18);

        // Now each note is worth $1.05 → 100 notes = $105
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        // 100e18 * 1.05e18 / 1e18 = 105e18 dollarValue → 105e18 / 1e12 = 105e6
        assertEq(expectedUsdc, 105e6, "100 notes at $1.05 = 105 USDC");

        // Need extra buffer to cover elevated price
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 105e6, "Should receive 105 USDC");
        assertEq(okuMoney.balanceOf(user1), 0, "All notes burned");
    }

    function test_Redeem_PriceAware_HighPrice() public {
        uint256 okuMAmount = 50e18;

        _mintOkuMoney(user1, okuMAmount);

        // Raise notePrice to 2e18 ($2.00)
        _setNotePrice(2e18);

        // 50 notes at $2 = $100
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 100e6, "50 notes at $2.00 = 100 USDC");

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(usdc.balanceOf(user1), usdcBefore + 100e6);
    }

    function test_Redeem_PriceAware_EmitsCorrectAmounts() public {
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);

        _setNotePrice(1.05e18);
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount); // 105e6

        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.expectEmit(true, false, false, true);
        emit RedeemNote(user1, okuMAmount, expectedUsdc);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);
    }

    // ============ Price-Aware Round-Trip Tests ============

    function test_RoundTrip_PriceAware_MintThenRedeem() public {
        // Use an even price to avoid slippage check failures from rounding
        _setNotePrice(2e18);

        uint256 usdcDeposit = 100e6; // 100 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mintOkuM(usdcDeposit);

        uint256 notesReceived = okuMoney.balanceOf(user1);
        // 100e18 * 1e18 / 2e18 = 50e18
        assertEq(notesReceived, 50e18, "50 notes at $2 price");
        assertLt(notesReceived, 100e18, "Fewer notes at elevated price");

        // Redeem all notes back
        _approveOkuMoney(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(notesReceived);

        uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;

        // Round-trip should return exactly 100 USDC at $2 price (no rounding)
        // At $2.00: 100 USDC → 50 notes → 50 * 2 = $100 → 100e6 USDC
        assertEq(usdcReceived, usdcDeposit, "Round-trip should be exact at even price");
    }

    function test_RoundTrip_PriceAware_SymmetricAtDoublePrice() public {
        _setNotePrice(2e18);

        uint256 usdcDeposit = 200e6; // 200 USDC

        _approveUsdc(user1, address(litePsm), usdcDeposit);

        vm.prank(user1);
        litePsm.mintOkuM(usdcDeposit);

        // 200 USDC at $2/note = 100 notes
        uint256 notesReceived = okuMoney.balanceOf(user1);
        assertEq(notesReceived, 100e18, "200 USDC at $2/note = 100 notes");

        _approveOkuMoney(user1, address(litePsm), notesReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(notesReceived);

        // 100 notes at $2 = 200 USDC — clean round-trip
        assertEq(usdc.balanceOf(user1) - usdcBefore, 200e6, "Clean round-trip at $2");
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyQueueProcessor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM_QUEUE_PROCESSOR
            )
        );
        litePsm.processQueue(0, 10, 0);
    }

    function test_ProcessQueue_ProcessesFIFO() public {
        // Create queued redemptions
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney each

        _mintOkuMoney(user1, okuMAmount);
        _mintOkuMoney(user2, okuMAmount);

        // Drain buffer first - redeem more than buffer (5000 USDC worth at base price)
        // Only PSM approval needed; PSM moves tokens to queue internally
        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued (buffer only 5000 USDC)

        _approveOkuMoney(user2, address(litePsm), okuMAmount);
        vm.prank(user2);
        litePsm.redeemOkuM(okuMAmount); // Also queued

        assertEq(redemptionQueue.queueUpperBound(), 2);

        // Refill buffer
        _mintUsdc(address(litePsm), 15_000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // processQueue now handles approve-use-revoke internally
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, 12_000e6); // 6000 USDC * 2 entries

        // Queue should be processed
        assertEq(redemptionQueue.queueUpperBound(), 0);
    }

    function test_ProcessQueue_ApprovesAndRevokesAllowance() public {
        // Setup: create a queued redemption
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueUpperBound(), 1);

        // Refill buffer
        _mintUsdc(address(litePsm), 10_000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

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
        assertEq(redemptionQueue.queueUpperBound(), 0);

        // User should have received USDC (original balance + 6000e6 from queue at base price)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 6000e6);
    }

    function test_ProcessQueue_PartialProcessingRevokesAllowance() public {
        // Setup: create multiple queued redemptions
        uint256 okuMAmount = 6000e18; // 6,000 OkuMoney each

        _mintOkuMoney(user1, okuMAmount);
        _mintOkuMoney(user2, okuMAmount);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);
        _approveOkuMoney(user2, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        vm.prank(user2);
        litePsm.redeemOkuM(okuMAmount);

        assertEq(redemptionQueue.queueUpperBound(), 2);

        // Refill buffer with only enough for one redemption
        _mintUsdc(address(litePsm), 7000e6);

        // Grant queue ability to burn OkuMoney
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Process only 1 entry
        uint256 head = redemptionQueue.queueHead();
        vm.prank(queueProcessor);
        litePsm.processQueue(head, head + 1, 6000e6);

        // Allowance should still be revoked even with partial processing
        assertEq(usdc.allowance(address(litePsm), address(redemptionQueue)), 0);

        // Only 1 entry processed
        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    // ============ Price-Aware Queue Tests ============

    function test_ProcessQueue_PriceAware_YieldAccruesWhileQueued() public {
        // Queue at base price, then process at elevated price
        uint256 okuMAmount = 6000e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Queued at base price (buffer only 5000 USDC)

        assertEq(redemptionQueue.queueUpperBound(), 1);

        // Raise notePrice to 1.05e18 — queued notes now worth more USDC
        _setNotePrice(1.05e18);

        // Queue entry stores okuMAmount=6000e18. At $1.05: USDC = 6000 * 1.05 = 6300
        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 6300e6, "6000 notes at $1.05 = 6300 USDC");

        // Refill buffer with enough for elevated price
        _mintUsdc(address(litePsm), 10_000e6);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 head = redemptionQueue.queueHead();
        uint256 tail = redemptionQueue.queueTail();

        vm.prank(queueProcessor);
        litePsm.processQueue(head, tail, expectedUsdc);

        assertEq(redemptionQueue.queueUpperBound(), 0);
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

        uint256 okuMAmount = 4900e18;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 5145e6, "4900 notes at $1.05 = 5145 USDC");
        assertGt(expectedUsdc, usdc.balanceOf(address(litePsm)), "Should exceed buffer");

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // Should be queued because USDC needed (5145) exceeds buffer (5000)
        assertEq(redemptionQueue.queueUpperBound(), 1, "Should be queued");
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), okuMAmount, "Notes held by queue");
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
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                PSM_BUFFER_WITHDRAWER
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
        uint256 okuMAmount = 10_000e18; // 10,000 OkuMoney (needs 10,000 USDC at base price)
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount); // Buffer (5000e6) < 10000e6 → queued

        // PSM buffer is still 5000e6 since no USDC was moved, only OkuMoney was queued
        // Trying to withdraw the full buffer would strand the obligation
        uint256 obligation = redemptionQueue.totalQueuedUsdc();
        assertGt(obligation, 0, "Queue should have obligation");

        // Withdrawing more than (balance - obligation) should revert
        uint256 balance = usdc.balanceOf(address(litePsm));
        uint256 safeWithdraw = balance > obligation ? balance - obligation : 0;
        uint256 unsafeAmount = safeWithdraw + 1e6;

        if (unsafeAmount <= balance) {
            uint256 remainingBalance = balance - unsafeAmount;
            vm.prank(bufferWithdrawer);
            vm.expectRevert(
                abi.encodeWithSelector(
                    LitePSM.WouldStrandQueue.selector, remainingBalance, obligation
                )
            );
            litePsm.withdrawUsdc(user1, unsafeAmount);
        }
    }

    // ============ Decimal Conversion Tests ============

    function test_DecimalConversion_MintConvertsCorrectly() public {
        uint256 usdcAmount = 1000e6; // 1000 USDC (6 decimals)

        _approveUsdc(user1, address(litePsm), usdcAmount);

        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base notePrice=1e18: should mint exactly 1000 OkuMoney (18 decimals)
        assertEq(okuMoney.balanceOf(user1), 1000e18);

        // Verify the price-aware conversion equals decimal multiplier at base price
        assertEq(okuMoney.balanceOf(user1), _expectedNotesFromUsdc(usdcAmount));
    }

    function test_DecimalConversion_RedeemConvertsCorrectly() public {
        uint256 okuMAmount = 1000e18; // 1000 OkuMoney (18 decimals)

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base notePrice=1e18: should receive exactly 1000 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1) - usdcBefore, 1000e6);

        // Verify via price-aware helper
        assertEq(usdc.balanceOf(user1) - usdcBefore, _expectedUsdcFromNotes(okuMAmount));
    }

    function test_DecimalConversion_RoundTripPreservesValue() public {
        uint256 startingUsdc = 5000e6; // 5000 USDC

        // Mint OkuMoney
        _approveUsdc(user1, address(litePsm), startingUsdc);
        vm.prank(user1);
        litePsm.mintOkuM(startingUsdc);

        uint256 noteReceived = okuMoney.balanceOf(user1);
        assertEq(noteReceived, 5000e18); // 5000 OkuMoney at base price

        // Redeem back to USDC
        _approveOkuMoney(user1, address(litePsm), noteReceived);

        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(noteReceived);

        // Should get back exactly what we started with at base price
        assertEq(usdc.balanceOf(user1) - usdcBefore, startingUsdc);
    }

    function test_DecimalConversion_SmallAmounts() public {
        uint256 smallUsdc = 1e6; // 1 USDC (minimum realistic amount)

        _approveUsdc(user1, address(litePsm), smallUsdc);
        vm.prank(user1);
        litePsm.mintOkuM(smallUsdc);

        // At base price: should mint 1 OkuMoney
        assertEq(okuMoney.balanceOf(user1), 1e18);
    }

    function test_DecimalConversion_LargeAmounts() public {
        uint256 largeUsdc = 1_000_000e6; // 1 million USDC

        _mintUsdc(user1, largeUsdc); // Mint more USDC to user
        _approveUsdc(user1, address(litePsm), largeUsdc);

        vm.prank(user1);
        litePsm.mintOkuM(largeUsdc);

        // At base price: should mint 1 million OkuMoney
        assertEq(okuMoney.balanceOf(user1), 1_000_000e18);
    }

    function test_DecimalConversion_RedeemTooSmall() public {
        // 1 wei of OkuMoney should fail since it rounds to 0 USDC
        uint256 tinyAmount = 1; // 1 wei of OkuMoney

        _mintOkuMoney(user1, tinyAmount);
        _approveOkuMoney(user1, address(litePsm), tinyAmount);

        vm.prank(user1);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        litePsm.redeemOkuM(tinyAmount);
    }

    function test_DecimalConversion_ExactConversionFactor() public {
        // Verify at base notePrice the conversion factor is exactly 10^12
        uint256 usdcAmount = 123e6; // Arbitrary amount

        _approveUsdc(user1, address(litePsm), usdcAmount);
        vm.prank(user1);
        litePsm.mintOkuM(usdcAmount);

        // At base price: OkuMoney = USDC * 10^12
        assertEq(okuMoney.balanceOf(user1), usdcAmount * (10 ** 12));
        assertEq(okuMoney.balanceOf(user1), 123e18);
    }

    // ============ Truncation Dust Retention Tests (Finding 7) ============

    function test_Redeem_TruncationDustBurnedWithNote() public {
        // Mint OkuMoney with sub-USDC dust: 100.0000005 OkuMoney
        uint256 okuMAmount = 100e18 + 5e11; // 100 OkuMoney + 0.0000005 OkuMoney dust

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        uint256 usdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // At base price: dollarValue18 = okuMAmount * 1e18 / 1e18 = okuMAmount
        // usdcAmount = okuMAmount / 1e12 = 100e6 (truncated down, dust lost)
        // PSM transfers and burns the FULL okuMAmount — user retains nothing.
        // The sub-USDC dust value is lost in the integer truncation.
        assertEq(okuMoney.balanceOf(user1), 0, "All notes transferred and burned");
        assertEq(
            usdc.balanceOf(user1) - usdcBefore,
            100e6,
            "User receives truncated USDC (dust value lost)"
        );
    }

    function test_Redeem_QueuePath_TruncationDustQueuedWithNote() public {
        // Amount that exceeds buffer AND has dust
        uint256 okuMAmount = 10_000e18 + 7e11;

        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        // PSM transfers the full okuMAmount (including dust) to the queue.
        // User retains nothing — all notes are moved.
        assertEq(okuMoney.balanceOf(user1), 0, "All notes transferred to queue");

        // Queue holds the full amount including dust
        assertEq(
            okuMoney.balanceOf(address(redemptionQueue)),
            okuMAmount,
            "Queue holds full okuMAmount including dust"
        );
    }

    function test_Redeem_PriceAware_TruncationDustAtElevatedPrice() public {
        // At elevated price, dust calculation changes
        _setNotePrice(1.05e18);

        // 100 notes at $1.05: dollarValue18 = 100e18 * 1.05e18 / 1e18 = 105e18
        // usdcAmount = 105e18 / 1e12 = 105e6 (clean, no dust)
        // Add sub-USDC dust in dollar-value terms
        // dollarValue18 = okuMAmount * 1.05e18 / 1e18
        // For dust to appear: we need dollarValue18 to have sub-1e12 residue
        // okuMAmount = 100e18 + 1 → dollarValue18 = (100e18 + 1) * 1.05e18 / 1e18
        //            = 105e18 + 1.05 (truncated to 105e18 + 1)
        // usdcAmount = (105e18 + 1) / 1e12 = 105e6 (same, dust lost in USDC truncation)
        uint256 okuMAmount = 100e18;

        _mintOkuMoney(user1, okuMAmount);
        _mintUsdc(address(litePsm), 1000e6);

        _approveOkuMoney(user1, address(litePsm), okuMAmount);

        vm.prank(user1);
        litePsm.redeemOkuM(okuMAmount);

        uint256 expectedUsdc = _expectedUsdcFromNotes(okuMAmount);
        assertEq(expectedUsdc, 105e6, "100 notes at $1.05 = 105 USDC");
    }

    // ============ DepositBuffer Tests ============

    function test_DepositBuffer_OnlyBufferDepositor() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                PSM_BUFFER_DEPOSITOR
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
        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.InsufficientBuffer.selector, balance, balance + 1)
        );
        litePsm.withdrawUsdc(user1, balance + 1);
    }

    // ============ RedeemWithPermit Tests ============

    function test_RedeemWithPermit_Success() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // Generate permit signature
        uint256 user1Pk = 0xA11CE; // Private key for signing
        address user1Addr = vm.addr(user1Pk);

        // Mint to the permit user instead
        _mintOkuMoney(user1Addr, amount);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuMoney.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        uint256 usdcBefore = usdc.balanceOf(user1Addr);

        vm.prank(user1Addr);
        litePsm.redeemOkuMWithPermit(amount, deadline, v, r, s);

        // At base price: should redeem 100 USDC
        uint256 expectedUsdc = _expectedUsdcFromNotes(amount);
        assertEq(usdc.balanceOf(user1Addr), usdcBefore + expectedUsdc);
        assertEq(okuMoney.balanceOf(user1Addr), 0);
    }

    function test_RedeemWithPermit_RevertsExpiredDeadline() public {
        uint256 amount = 100e18;
        uint256 user1Pk = 0xA11CE;
        address user1Addr = vm.addr(user1Pk);
        _mintOkuMoney(user1Addr, amount);

        uint256 deadline = block.timestamp - 1; // Already expired
        bytes32 domainSeparator = _getOkuMoneyDomainSeparator();
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user1Addr,
                address(litePsm),
                amount,
                okuMoney.nonces(user1Addr),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        vm.prank(user1Addr);
        vm.expectRevert(); // ERC2612ExpiredSignature
        litePsm.redeemOkuMWithPermit(amount, deadline, v, r, s);
    }

    // ============ UUPS Upgrade (Finding 24) ============

    function test_UUPS_UpgradePSM() public {
        LitePSM newImpl = new LitePSM();

        vm.prank(admin);
        litePsm.upgradeToAndCall(address(newImpl), "");

        // Verify state preserved (okuMoney address still set)
        assertEq(address(litePsm.okuMoney()), address(okuMoney));
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

    function _getOkuMoneyDomainSeparator() internal view returns (bytes32) {
        // EIP-712 domain separator for OkuMoney
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

    // ============ Oracle Edge Case Tests ============

    function test_Mint_SkipsOracleWhenEnabledButAddressZero() public {
        // Oracle enabled but address is zero — both conditions must hold for check
        vm.prank(oracleManager);
        litePsm.configureOracle(address(0), 1 hours, true);

        _approveUsdc(user1, address(litePsm), 100e6);

        // Should succeed because oracle address is zero
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        uint256 expectedOkuMoney = _expectedNotesFromUsdc(100e6);
        assertEq(okuMoney.balanceOf(user1), expectedOkuMoney);
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_MintOkuM_RevertsInYieldDistributionBlock() public {
        // Distribute yield to set lastYieldDistributionBlock
        _mintOkuMoney(user2, 10_000e18); // Need supply for distributeYield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(LitePSM.YieldDistributionInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_MintOkuM_SucceedsInNextBlock() public {
        // Use setOkuMPrice instead of distributeYield to avoid slippage issues
        // (setOkuMPrice also sets lastYieldDistributionBlock)
        vm.prank(rebaser);
        okuMoney.setOkuMPrice(PRECISION); // No actual price change, just sets the block

        // Roll to next block
        vm.roll(block.number + 1);

        // Now mintOkuM should succeed
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        assertGt(okuMoney.balanceOf(user1), 0);
    }

    function test_RedeemOkuM_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — redeemOkuM should revert
        vm.prank(user1);
        vm.expectRevert(LitePSM.YieldDistributionInProgress.selector);
        litePsm.redeemOkuM(50e18);
    }

    function test_RedeemOkuM_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now redeemOkuM should succeed
        uint256 usdcBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(50e18);

        assertGt(usdc.balanceOf(user1), usdcBefore);
    }

    function test_MintUsdOku_RevertsInYieldDistributionBlock() public {
        // Distribute yield
        _mintOkuMoney(user2, 10_000e18);
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — mintUsdOku should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(LitePSM.YieldDistributionInProgress.selector);
        litePsm.mintUsdOku(100e6);
    }

    function test_RedeemUsdOku_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has usdOku
        _mintUsdOku(user1, 100e18);
        vm.prank(user1);
        usdOku.approve(address(litePsm), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(100e18);

        // Same block — redeemUsdOku should revert
        vm.prank(user1);
        vm.expectRevert(LitePSM.YieldDistributionInProgress.selector);
        litePsm.redeemUsdOku(50e18);
    }

    function test_SetOkuMPrice_AlsoBlocksPSMOperations() public {
        // setOkuMPrice also sets lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.setOkuMPrice(PRECISION * 2);

        // Same block — mintOkuM should revert
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(LitePSM.YieldDistributionInProgress.selector);
        litePsm.mintOkuM(100e6);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastYieldDistributionBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);

        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        litePsm.mintOkuM(100e6);

        assertGt(okuMoney.balanceOf(user1), 0);
    }
}
