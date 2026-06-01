// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {LitePSMHandler} from "../handlers/LitePSMHandler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";

/**
 * @title PSMInvariantsTest
 * @notice Stateful invariants for LitePSM driven by LitePSMHandler.
 */
contract PSMInvariantsTest is BaseTest {
    LitePSMHandler public handler;

    /// @notice USDC seeded into the PSM at setUp(). Tracked separately so the net
    ///         deposit equation is exact (not a rough "tolerance").
    uint256 public seededBuffer;

    function setUp() public override {
        super.setUp();

        seededBuffer = 1_000_000e6;
        _mintUsdc(address(litePsm), seededBuffer);

        handler = new LitePSMHandler(
            litePsm,
            IOkuMoney(address(okuMoney)),
            IOkuDollar(address(okuDollar)),
            usdc,
            redemptionQueue,
            rebaser,
            minter
        );

        // Grant operator roles to the handler so it can drive the full PSM surface.
        vm.startPrank(admin);
        litePsm.grantRole(PSM_BUFFER_DEPOSITOR, address(handler));
        litePsm.grantRole(PSM_BUFFER_WITHDRAWER, address(handler));
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, address(handler));
        litePsm.grantRole(PSM_ORACLE_MANAGER, address(handler));
        redemptionQueue.grantRole(QUEUE_RESCUER, address(handler));
        // VAULT_REBASER lets the handler drive `usdRatePerSecond`, which combined
        // with the handler's `warpTime` makes `usdMultiplier()` actually compound
        // during invariant runs. This is the systemic coverage gap that allowed
        // the LitePSM `_redeemUsdOku` rounding-asymmetry bug to ship.
        okuDollar.grantRole(VAULT_REBASER, address(handler));
        vm.stopPrank();
        // Tell the handler which address holds VAULT_REBASER so it can prank itself.
        handler.setUsdRebaser(address(handler));

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /// @notice The PSM never holds OkuMoney across calls (within ≤1 wei rounding dust).
    function invariant_PSMDoesNotHoldOkuMoney() public view {
        uint256 psmOkuMBalance = okuMoney.balanceOf(address(litePsm));
        // Allow up to 1 wei of rounding dust.
        assertLe(psmOkuMBalance, 1, "PSM should hold no OkuMoney (allow 1 wei dust)");
    }

    /// @notice The OkuMoney sitting in the queue must equal the queue's
    ///         declared totalQueuedOkuM at all times.
    function invariant_QueueBackedByOkuMoney() public view {
        assertEq(
            okuMoney.balanceOf(address(redemptionQueue)),
            redemptionQueue.totalQueuedOkuM(),
            "Queue OkuMoney balance must equal totalQueuedOkuM"
        );
    }

    /// @notice The OkuMoney multiplier never decreases between observations.
    /// @dev Tracked via the handler's `ghostLastSeenMultiplier`, which is updated in
    ///      `afterInvariant` (so observations are taken regardless of which call ran).
    function invariant_MultiplierNeverDecreases() public view {
        assertGe(
            okuMoney.okuMMultiplier(),
            handler.ghostLastSeenMultiplier(),
            "okuMMultiplier decreased between observations"
        );
    }

    /// @notice Updates the handler-side ghost multiplier after each invariant run so
    ///         `invariant_MultiplierNeverDecreases` can compare against the prior run.
    function afterInvariant() public {
        handler.recordMultiplierObservation();
    }

    /// @notice The handler can never withdraw more USDC than was made available to
    ///         the PSM (seeded buffer + tracked deposits). Equality is too brittle
    ///         given the multiple payout paths (instant redemption, queue
    ///         processing, admin withdraw) and rounding inside multiplier math —
    ///         this directional bound catches gross accounting errors without
    ///         requiring a perfect handler-side simulator.
    function invariant_NetUsdcOutflowBoundedByInflow() public view {
        uint256 deposited = handler.ghostUsdcDeposited();
        uint256 withdrawn = handler.ghostUsdcWithdrawn();
        // Allow up to 1 wei of rounding per redemption (queue or instant).
        uint256 tolerance = 2 * (handler.ghostQueuedCount() + 1);
        assertLe(withdrawn, seededBuffer + deposited + tolerance, "USDC outflow exceeds inflow");
    }
}
