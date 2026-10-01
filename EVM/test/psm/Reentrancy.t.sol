// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockCallbackUSDC} from "../mocks/MockCallbackUSDC.sol";
import {ReentrantOkuMoney} from "../mocks/ReentrantOkuMoney.sol";
import {QueueReentrancyAttacker} from "../mocks/QueueReentrancyAttacker.sol";
import {Roles} from "../../src/lib/Roles.sol";

/**
 * @title ReentrancyTest
 * @notice Verifies that `nonReentrant` guards on LitePSM and RedemptionQueue
 *         block reentrant calls from a malicious OkuMoney token.
 * @dev Uses {ReentrantOkuMoney} whose `burn()` calls back into the PSM/queue.
 *      This scenario is unreachable in production (OkuMoney is a controlled,
 *      standard ERC-20) but demonstrates that the guard is effective should a
 *      future upgrade ever introduce transfer hooks.
 */
contract ReentrancyTest is Test {
    ReentrantOkuMoney internal rOkuM;
    MockUSDC internal usdc;
    LitePSM internal litePsm;
    RedemptionQueue internal redemptionQueue;
    OkuDollar internal okuDollar;

    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");

    function setUp() public {
        // Deploy mocks
        rOkuM = new ReentrantOkuMoney();
        usdc = new MockUSDC();

        // Deploy OkuDollar
        OkuDollar dollarImpl = new OkuDollar();
        okuDollar = OkuDollar(
            address(
                new ERC1967Proxy(
                    address(dollarImpl),
                    abi.encodeCall(
                        OkuDollar.initialize, (address(rOkuM), "OkuDollar", "usdOku", admin)
                    )
                )
            )
        );

        // Deploy RedemptionQueue
        RedemptionQueue queueImpl = new RedemptionQueue();
        redemptionQueue = RedemptionQueue(
            address(
                new ERC1967Proxy(
                    address(queueImpl),
                    abi.encodeCall(
                        RedemptionQueue.initialize, (address(rOkuM), address(usdc), admin)
                    )
                )
            )
        );

        // Deploy LitePSM
        LitePSM psmImpl = new LitePSM();
        litePsm = LitePSM(
            address(
                new ERC1967Proxy(
                    address(psmImpl),
                    abi.encodeCall(
                        LitePSM.initialize,
                        (
                            address(rOkuM),
                            address(okuDollar),
                            address(usdc),
                            address(redemptionQueue),
                            admin
                        )
                    )
                )
            )
        );

        // Wire roles
        vm.startPrank(admin);
        redemptionQueue.grantRole(Roles.QUEUE_PSM, address(litePsm));
        vm.stopPrank();

        // Fund user with USDC and OkuM
        usdc.mint(user, 1000e6);
        rOkuM.mint(user, 1000e18);
        rOkuM.mint(address(litePsm), 1000e18); // PSM holds OkuM for burn
        usdc.mint(address(litePsm), 1000e6); // PSM buffer

        // Approve PSM
        vm.startPrank(user);
        IERC20(address(rOkuM)).approve(address(litePsm), type(uint256).max);
        usdc.approve(address(litePsm), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Verify that a reentrant callback from `burn()` into `mintOkuM`
    ///         during `redeemOkuM` is blocked by `nonReentrant`.
    function test_RedeemOkuM_ReentrantMintOkuM_Reverts() public {
        // Configure rOkuM to call litePsm.mintOkuM(100e6) on burn
        rOkuM.setReentrantCallback(address(litePsm), abi.encodeCall(LitePSM.mintOkuM, (100e6)));

        // The redeemOkuM call should revert because the reentrant callback
        // into mintOkuM hits the nonReentrant guard.
        vm.prank(user);
        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        litePsm.redeemOkuM(100e18);
    }

    /// @notice Verify that a reentrant callback from `burn()` inside
    ///         `processQueue` is blocked by `nonReentrant`.
    function test_ProcessQueue_ReentrantMintOkuM_Reverts() public {
        // First enqueue an entry via the PSM path (need to set up the queue)
        // Drain the buffer so redemption goes to queue
        vm.prank(admin);
        litePsm.grantRole(Roles.PSM_BUFFER_WITHDRAWER, admin);
        vm.prank(admin);
        litePsm.withdrawUsdc(admin, 1000e6);

        // Now redeem so it queues
        vm.prank(user);
        litePsm.redeemOkuM(100e18);

        // Re-fund the buffer
        usdc.mint(address(litePsm), 1000e6);

        // Now configure the reentrant callback on burn (which processQueue calls)
        rOkuM.setReentrantCallback(address(litePsm), abi.encodeCall(LitePSM.mintOkuM, (100e6)));

        // Give PSM the queue processor role and try to process
        vm.prank(admin);
        litePsm.grantRole(Roles.PSM_QUEUE_PROCESSOR, admin);

        // Approve USDC from PSM to queue
        vm.prank(admin);
        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        litePsm.processQueue(0, 1, 1000e6);
    }
}

/**
 * @title AdvanceHeadReentrancyTest
 * @notice Regression test for a DIFFERENT reentrancy surface than {ReentrancyTest} above:
 *         this one is on the USDC/collateral side, not the OkuMoney side, and targets
 *         `advanceHead` rather than `processQueue`/`rescueQueueEntry` themselves.
 *
 * @dev `processQueue` deletes a queue slot BEFORE its external `trySafeTransferFrom` call
 *      and restores it from memory only if that call reports failure
 *      (`RedemptionQueue.sol:275-284`). For the duration of that external call, a live
 *      entry transiently reads `user == address(0)` — the exact sentinel `advanceHead`
 *      uses to decide a slot is safe to skip past. Against a collateral token that (a)
 *      calls back into the recipient during `transferFrom` and (b) signals failure by
 *      returning `false` rather than reverting, a reentrant `advanceHead(1)` fired from
 *      that callback could — PRE-FIX — move `queueHead` past the transiently-cleared
 *      slot permanently: `processQueue`'s restore runs immediately after and does put
 *      the entry's data back, but the slot is now below `queueHead` and therefore
 *      unreachable by every bound check in the contract.
 *
 *      {MockCallbackUSDC} and {QueueReentrancyAttacker} exist solely to construct this
 *      token shape for the test below. Circle USDC has no transfer callback, so this is
 *      not reachable with the collateral actually configured on any live deployment —
 *      but the collateral token is a deploy-time parameter
 *      (`RedemptionQueue.initialize` validates only `decimals() <= 18`), not a property
 *      either contract can itself enforce, which is why the fix is a `nonReentrant`
 *      modifier rather than a token allow-list.
 *
 *      REGRESSION COVERAGE: if `nonReentrant` is ever removed from `advanceHead`, this
 *      test fails — `test_AdvanceHead_ReentrancyGuard_BlocksAttack` asserts the reentrant
 *      call is rejected AND `test_AdvanceHead_ReentrancyGuard_EntryStaysReachable` asserts
 *      the targeted entry remains reachable afterward. Verified against a build with the
 *      modifier manually removed: both assertions fail as expected
 *      (`advanceHeadSucceeded == true` and `queueHead() == 1`, stranding index 0).
 */
contract AdvanceHeadReentrancyTest is Test {
    OkuMoney internal okuMoney;
    MockCallbackUSDC internal usdc;
    RedemptionQueue internal redemptionQueue;
    QueueReentrancyAttacker internal attacker;

    uint256 internal constant OKUM_AMOUNT = 100e18;
    uint256 internal constant USDC_FUNDING = 1000e6;

    function setUp() public {
        // This test is its own admin/minter/allowance-manager/QUEUE_PSM holder — the
        // exploit lives entirely inside RedemptionQueue.processQueue, so LitePSM is not
        // needed to reproduce it.
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
        // Deliberately absent from `initialize` (see its own NatSpec) — self-grant as
        // DEFAULT_ADMIN_ROLE holder so this test can call enqueue/processQueue directly.
        redemptionQueue.grantRole(Roles.QUEUE_PSM, address(this));

        // Fund the queue with a live entry whose `user` is the attacker contract.
        okuMoney.configureMinterAllowance(address(this), OKUM_AMOUNT);
        okuMoney.mint(address(redemptionQueue), OKUM_AMOUNT);

        attacker = new QueueReentrancyAttacker(address(redemptionQueue), 1);
        redemptionQueue.enqueue(address(attacker), OKUM_AMOUNT);

        // Fund this test contract (the `processQueue` caller) with USDC to pay out, and
        // configure the mock to fail payouts to the attacker AFTER firing its callback —
        // the soft-skip path, which is what leaves the slot's restore-after-delete window
        // reachable to a reentrant call in the first place (a hard revert would unwind
        // the reentrant call too; see {MockCallbackUSDC}'s NatSpec).
        usdc.mint(address(this), USDC_FUNDING);
        usdc.approve(address(redemptionQueue), USDC_FUNDING);
        usdc.setFailTransfersTo(address(attacker), true);
    }

    /// @notice The reentrant `advanceHead` call fired from inside `transferFrom` must be
    ///         rejected by the shared `nonReentrant` guard, not merely fail for some
    ///         unrelated reason (e.g. no cleared slots to skip — there's exactly one
    ///         slot and it's mid-flight-cleared at the moment of the call, so without the
    ///         guard it WOULD succeed).
    function test_AdvanceHead_ReentrancyGuard_BlocksAttack() public {
        redemptionQueue.processQueue(0, 1);

        assertTrue(
            attacker.callbackFired(), "callback must have fired for this test to mean anything"
        );
        assertFalse(
            attacker.advanceHeadSucceeded(),
            "reentrant advanceHead must be rejected by nonReentrant"
        );
    }

    /// @notice The actual property that matters: the entry must still be reachable by
    ///         every bound check after the attack attempt, not just "the reentrant call
    ///         reverted somewhere." Asserts `queueHead` didn't move and the entry's data
    ///         survived processQueue's restore-on-failure path intact.
    function test_AdvanceHead_ReentrancyGuard_EntryStaysReachable() public {
        redemptionQueue.processQueue(0, 1);

        assertEq(
            redemptionQueue.queueHead(), 0, "queueHead must not have advanced past the live entry"
        );
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, address(attacker), "entry must still be reachable at index 0");
        assertEq(entry.okuMAmount, OKUM_AMOUNT, "entry amount must be the restored original");
        assertEq(
            redemptionQueue.totalQueuedOkuM(),
            OKUM_AMOUNT,
            "totalQueuedOkuM must be unchanged -- entry was soft-skipped, not burned"
        );
    }

    /// @notice Sanity check on the mock itself: without the attacker's callback in the
    ///         loop, a transfer that's simply configured to fail soft-skips normally,
    ///         same as {MockUSDC}'s `returnFalseFor`. Isolates "the mock token behaves
    ///         like a normal soft-failing token when nothing reenters" from "the
    ///         reentrancy guard holds when something does."
    function test_Baseline_SoftFailureWithoutReentrancy_RestoresEntryNormally() public {
        QueueReentrancyAttacker inertRecipient =
            new QueueReentrancyAttacker(address(redemptionQueue), 0);
        okuMoney.configureMinterAllowance(address(this), OKUM_AMOUNT);
        okuMoney.mint(address(redemptionQueue), OKUM_AMOUNT);
        redemptionQueue.enqueue(address(inertRecipient), OKUM_AMOUNT);
        usdc.setFailTransfersTo(address(inertRecipient), true);

        redemptionQueue.processQueue(1, 2);

        assertTrue(
            inertRecipient.callbackFired(), "callback still fires -- this mock always calls back"
        );
        assertFalse(
            inertRecipient.advanceHeadSucceeded(),
            "maxSlots=0 -> advanceHead is a deliberate no-op here"
        );
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(1);
        assertEq(entry.user, address(inertRecipient), "second entry also restored correctly");
    }
}
