// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {RedemptionQueueEvents} from "../../src/lib/events/RedemptionQueueEvents.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {MockCallbackUSDC} from "../mocks/MockCallbackUSDC.sol";
import {QueueFundsTopper} from "../mocks/QueueFundsTopper.sol";

/**
 * @title ProcessQueueCallbackTopUpTest
 * @notice Regression test for the lazy-revalidation fix in `processQueue`'s
 *         `usdcAvailable` bound (`RedemptionQueue.sol`, the `usdcAvailable < usdcAmount`
 *         branch) — a different fix than {AdvanceHeadReentrancyTest}'s `nonReentrant`,
 *         closing a liveness gap rather than a strand.
 *
 * @dev `processQueue` caches `usdcAvailable = min(balanceOf(caller), allowance(caller,
 *      this))` ONCE before the loop and decrements it locally per settled entry, rather
 *      than re-reading on-chain every iteration (gas). That cached bound is only
 *      accurate if nothing external changes the caller's real balance/allowance
 *      mid-batch — true for Circle USDC (no transfer callback), but not guaranteed for
 *      whatever collateral token is actually configured (a deploy-time parameter).
 *
 *      If a transfer-callback token tops up the caller's REAL funds mid-batch (e.g. via
 *      a recipient's callback minting/forwarding more collateral to the caller), the
 *      stale cached bound under-reports what's actually available. PRE-FIX, that caused
 *      a premature `break`: a later entry the live funds now cover got skipped as
 *      `InsufficientFunds` anyway, staying live and reprocessable next batch —
 *      liveness-only, never a fund-loss or a strand (unlike {AdvanceHeadReentrancyTest}'s
 *      bug, this one cannot make an entry unreachable). The fix re-validates live,
 *      exactly once, only on the path that would otherwise halt the batch.
 *
 *      REGRESSION COVERAGE: if the lazy re-check is ever removed (reverting to a purely
 *      cached, never-resynced bound), `test_LazyRevalidation_RecoversFromStaleCache`
 *      fails — the second entry would stay live instead of settling. Verified against a
 *      build with the re-check removed: the assertion that entry 1 settles fails as
 *      predicted (second entry remains queued, `InsufficientFunds` emitted instead of
 *      `RedemptionProcessed`).
 */
contract ProcessQueueCallbackTopUpTest is Test {
    OkuMoney internal okuMoney;
    MockCallbackUSDC internal usdc;
    RedemptionQueue internal redemptionQueue;

    address internal user1 = makeAddr("user1");
    uint256 internal constant ENTRY_OKUM = 100e18;
    // At okuMMultiplier() == PRECISION (1e18, the initial no-yield state) and USDC's
    // 1e12 decimal multiplier, 100e18 OkuM prices to exactly 100e6 USDC.
    uint256 internal constant ENTRY_USDC = 100e6;

    function setUp() public {
        OkuMoney okuMoneyImpl = new OkuMoney();
        okuMoney = OkuMoney(
            address(
                new ERC1967Proxy(
                    address(okuMoneyImpl),
                    abi.encodeCall(
                        OkuMoney.initialize, ("OkuMoney", "OkuM", address(this), 1_000_000_000e18)
                    )
                )
            )
        );

        usdc = new MockCallbackUSDC();

        RedemptionQueue queueImpl = new RedemptionQueue();
        redemptionQueue = RedemptionQueue(
            address(
                new ERC1967Proxy(
                    address(queueImpl),
                    abi.encodeCall(
                        RedemptionQueue.initialize,
                        (address(okuMoney), address(usdc), address(this))
                    )
                )
            )
        );
        redemptionQueue.grantRole(Roles.QUEUE_PSM, address(this));
        okuMoney.grantRole(Roles.OKUM_BURNER, address(redemptionQueue));

        okuMoney.configureMinterAllowance(address(this), ENTRY_OKUM * 2);
    }

    /// @notice The scenario the fix exists for: entry 0's recipient tops up the
    ///         caller's REAL USDC balance via a transfer callback, mid-batch. The
    ///         pre-loop cache cannot see that top-up; the fix's lazy re-check can.
    function test_LazyRevalidation_RecoversFromStaleCache() public {
        // Entry 0: a topper that mints ENTRY_USDC more to this test contract (the
        // `processQueue` caller) the moment IT is called back during its own transfer.
        QueueFundsTopper topper = new QueueFundsTopper(address(usdc), address(this), ENTRY_USDC);
        okuMoney.mint(address(redemptionQueue), ENTRY_OKUM);
        redemptionQueue.enqueue(address(topper), ENTRY_OKUM);

        // Entry 1: an ordinary EOA, no callback involved on its own transfer.
        okuMoney.mint(address(redemptionQueue), ENTRY_OKUM);
        redemptionQueue.enqueue(user1, ENTRY_OKUM);

        // BALANCE funded for exactly one entry; ALLOWANCE pre-sized for two so a real
        // ERC20 allowance decrement on entry 0's transfer can't itself explain entry 1
        // settling (that would be a confound, not evidence the top-up was picked up).
        // Without the mid-batch top-up, entry 1 is unfundable on BALANCE alone — that's
        // deliberate: it isolates "did the top-up actually get picked up" from "there
        // was enough money the whole time anyway."
        usdc.mint(address(this), ENTRY_USDC);
        usdc.approve(address(redemptionQueue), ENTRY_USDC * 2);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionProcessed(
            address(topper), ENTRY_OKUM, ENTRY_OKUM, ENTRY_USDC, 0
        );
        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionProcessed(user1, ENTRY_OKUM, ENTRY_OKUM, ENTRY_USDC, 0);
        redemptionQueue.processQueue(0, 2);

        assertTrue(
            topper.callbackFired(), "callback must have fired for this test to mean anything"
        );
        assertEq(usdc.balanceOf(address(topper)), ENTRY_USDC, "entry 0 must have settled");
        assertEq(
            usdc.balanceOf(user1), ENTRY_USDC, "entry 1 must ALSO have settled via the live top-up"
        );
        assertEq(redemptionQueue.totalQueuedOkuM(), 0, "both entries burned, nothing left escrowed");
    }

    /// @notice Without any top-up, the cache is accurate and the second entry correctly
    ///         stays live. Isolates "the lazy re-check doesn't let UNDERFUNDED batches
    ///         through" from "it correctly recovers a batch that WAS fundable."
    function test_WithoutTopUp_SecondEntryCorrectlyStaysLive() public {
        okuMoney.mint(address(redemptionQueue), ENTRY_OKUM);
        redemptionQueue.enqueue(user1, ENTRY_OKUM);
        okuMoney.mint(address(redemptionQueue), ENTRY_OKUM);
        redemptionQueue.enqueue(makeAddr("user2"), ENTRY_OKUM);

        usdc.mint(address(this), ENTRY_USDC);
        usdc.approve(address(redemptionQueue), ENTRY_USDC);

        redemptionQueue.processQueue(0, 2);

        assertEq(usdc.balanceOf(user1), ENTRY_USDC, "entry 0 settles normally");
        RedemptionQueue.QueueEntry memory stillQueued = redemptionQueue.getQueueEntry(1);
        assertEq(
            stillQueued.user,
            makeAddr("user2"),
            "entry 1 correctly remains live -- genuinely underfunded"
        );
        assertEq(
            redemptionQueue.totalQueuedOkuM(), ENTRY_OKUM, "only entry 0 should have decremented"
        );
    }
}
