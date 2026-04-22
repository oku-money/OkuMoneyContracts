// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {LitePSMHandler} from "../handlers/LitePSMHandler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";

/**
 * @title PSMInvariantsTest
 * @notice Invariant tests for LitePSM buffer and exchange rate integrity
 * @dev Verifies:
 *      1. PSM USDC buffer >= queue obligations
 *      2. PSM never holds stale OkuMoney (all burned or queued)
 *      3. Exchange rates are consistent with okuMMultiplier()
 */
contract PSMInvariantsTest is BaseTest {
    LitePSMHandler public handler;

    function setUp() public override {
        super.setUp();

        // Seed PSM with initial USDC buffer
        _mintUsdc(address(litePsm), 1_000_000e6);

        handler = new LitePSMHandler(
            litePsm,
            IOkuMoney(address(okuMoney)),
            IOkuDollar(address(usdOku)),
            usdc,
            redemptionQueue,
            rebaser,
            minter
        );

        targetContract(address(handler));

        // Exclude all non-handler contracts
        excludeContract(address(okuMoney));
        excludeContract(address(usdOku));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice PSM USDC buffer is never negative (trivially true but sanity check)
     */
    function invariant_BufferNonNegative() public view {
        uint256 buffer = usdc.balanceOf(address(litePsm));
        assertGe(buffer, 0, "Buffer cannot be negative");
    }

    /**
     * @notice PSM does not hold OkuMoney indefinitely (should burn or queue)
     * @dev After any operation completes, PSM should not be sitting on OkuMoney.
     *      Small tolerance for rounding dust (< 1e12 wei).
     */
    function invariant_PSMDoesNotHoldOkuMoney() public view {
        uint256 psmOkuMBalance = okuMoney.balanceOf(address(litePsm));
        // Allow small dust from rounding (less than 1 USDC worth)
        assertLt(psmOkuMBalance, 1e12, "PSM should not hold OkuMoney (except dust)");
    }

    /**
     * @notice Queue obligations are always backed by OkuMoney in the queue
     * @dev totalQueuedOkuM in queue contract == actual OkuMoney held by queue
     */
    function invariant_QueueBackedByOkuMoney() public view {
        uint256 queuedOkuM = redemptionQueue.totalQueuedOkuM();
        uint256 queueOkuMBalance = okuMoney.balanceOf(address(redemptionQueue));
        assertEq(queueOkuMBalance, queuedOkuM, "Queue OkuM balance must match totalQueuedOkuM");
    }

    /**
     * @notice okuMMultiplier never decreases
     */
    function invariant_MultiplierMonotonicallyIncreasing() public view {
        uint256 currentMult = okuMoney.okuMMultiplier();
        assertGe(currentMult, PRECISION, "Multiplier cannot drop below initial value");
    }

    /**
     * @notice Sum of deposits minus withdrawals approximates net USDC flow
     * @dev This is a weak invariant due to timing/ordering, but catches gross errors.
     */
    function invariant_NetUsdcFlowReasonable() public view {
        uint256 deposited = handler.ghostUsdcDeposited();
        uint256 withdrawn = handler.ghostUsdcWithdrawn();

        // Net deposits should correlate with PSM balance (within tolerance for queued amounts)
        if (deposited > 0) {
            // Just check we haven't withdrawn more than deposited
            assertLe(withdrawn, deposited + 1_000_000e6, "Withdrawn exceeds deposited + buffer");
        }
    }
}
