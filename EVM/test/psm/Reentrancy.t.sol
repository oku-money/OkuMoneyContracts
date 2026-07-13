// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {ReentrantOkuMoney} from "../mocks/ReentrantOkuMoney.sol";
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
                        OkuDollar.initialize, (address(rOkuM), "OkuDollar", "usdOku", admin, 95e16)
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
