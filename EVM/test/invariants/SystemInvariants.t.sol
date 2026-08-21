// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {SystemHandler} from "../handlers/SystemHandler.sol";

/**
 * @title SystemInvariantsTest
 * @notice Stateful-fuzz invariants over the whole system, driven by an
 *         adversarial handler that donates tokens to both the PSM and the queue.
 *
 * @dev Every backing invariant here is stated as a BOUND, never an equality.
 *      Free token donations are unpreventable, so an equality would be a
 *      permanent, griefable failure rather than a property of the protocol.
 */
contract SystemInvariantsTest is BaseTest {
    SystemHandler internal handler;

    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);

        address[4] memory actors = [user1, user2, user3, user4];
        handler = new SystemHandler(
            token,
            litePsm,
            queue,
            usdc,
            rateSetter,
            guardian,
            bufferDepositor,
            queueProcessor,
            minter,
            actors
        );

        // The handler drives privileged paths by pranking; it also needs to mint.
        vm.startPrank(admin);
        token.grantRole(keccak256("OKU_MINTER"), address(handler));
        token.configureMinterAllowance(address(handler), MINTER_ALLOWANCE);
        vm.stopPrank();

        targetContract(address(handler));
    }

    // ============ Raw ledger ============

    /// @notice The raw layer is stock OpenZeppelin: nothing overrides the ledger,
    ///         so the accounting identity must hold exactly.
    function invariant_RawSupplyEqualsSumOfBalances() public view {
        uint256 sum = token.balanceOf(user1) + token.balanceOf(user2) + token.balanceOf(user3)
            + token.balanceOf(user4) + token.balanceOf(address(litePsm))
            + token.balanceOf(address(queue)) + token.balanceOf(treasury)
            + token.balanceOf(address(handler));
        assertEq(sum, token.totalSupply());
    }

    function invariant_SupplyWithinCap() public view {
        assertLe(token.totalSupply(), token.maxSupply());
        assertLe(token.maxSupply(), Constants.MAX_TOTAL_SUPPLY);
    }

    // ============ Multiplier ============

    /// @notice Monotonic by deliberate narrowing of ERC-8056.
    function invariant_MultiplierNeverDecreases() public view {
        assertGe(token.uiMultiplier(), handler.ghostMaxMultiplier());
    }

    function invariant_MultiplierWithinCeiling() public view {
        assertLe(token.uiMultiplier(), Constants.MAX_MULTIPLIER);
        assertGe(token.uiMultiplier(), Constants.PRECISION);
    }

    /// @notice The ERC-8056 boundary contract, continuously enforced.
    function invariant_PastRateEndCurrentEqualsPending() public view {
        if (block.timestamp >= token.effectiveAt()) {
            assertEq(token.uiMultiplier(), token.newUIMultiplier());
        } else {
            assertLe(token.uiMultiplier(), token.newUIMultiplier());
        }
    }

    function invariant_ImpliedAprWithinCap() public view {
        assertLe(token.impliedAprBps(), Constants.MAX_IMPLIED_APR);
    }

    // ============ Display / value coherence ============

    function invariant_TotalSupplyUiMatchesConversion() public view {
        assertEq(
            token.totalSupplyUI(), MathLib.toUiAmount(token.totalSupply(), token.uiMultiplier())
        );
    }

    /// @notice Per-balance flooring: the sum of displayed balances is bounded above
    ///         by the displayed total, with a gap of at most one wei per holder.
    function invariant_DisplaySumBoundedByTotal() public view {
        uint256 sum = token.balanceOfUI(user1) + token.balanceOfUI(user2) + token.balanceOfUI(user3)
            + token.balanceOfUI(user4) + token.balanceOfUI(address(litePsm))
            + token.balanceOfUI(address(queue)) + token.balanceOfUI(treasury)
            + token.balanceOfUI(address(handler));
        assertLe(sum, token.totalSupplyUI());
        assertGe(sum + 8, token.totalSupplyUI());
    }

    /// @notice The value/display parity bound. Not an equality: `convertToAssets`
    ///         returns USDC at 6 dp while `uiMultiplier()` is 18 dp.
    function invariant_ValueDisplayParity() public view {
        uint256 cta = token.convertToAssets(Constants.PRECISION);
        uint256 m = token.uiMultiplier();
        uint256 dm = token.usdcDecimalMultiplier();
        assertLe(cta * dm, m);
        assertLt(m, (cta + 1) * dm);
    }

    // ============ Queue backing ============

    /// @notice BOUND, not equality. `donateToken` in the handler exists precisely
    ///         to prove why: anyone can transfer tokens to the queue for free, and
    ///         an equality here would be permanently griefable.
    function invariant_QueueEscrowIsBacked() public view {
        assertLe(queue.totalQueuedRaw(), token.balanceOf(address(queue)));
    }

    function invariant_QueueHeadNeverPassesTail() public view {
        assertLe(queue.queueHead(), queue.queueTail());
    }

    /// @notice The queue's reported USDC obligation is exactly the conversion of
    ///         its escrowed raw total at the live multiplier.
    /// @dev There is deliberately NO invariant asserting the buffer covers the
    ///      obligation: entries queue precisely when it does not. `WouldStrandQueue`
    ///      only stops the withdrawer from making an existing shortfall worse.
    function invariant_QueueObligationIsDerivedFromEscrow() public view {
        assertEq(
            queue.totalQueuedUsdc(),
            MathLib.dollarsToUsdc(
                MathLib.toUiAmount(queue.totalQueuedRaw(), token.uiMultiplier()),
                token.usdcDecimalMultiplier()
            )
        );
    }

    // ============ PSM solvency ============

    /// @notice The PSM cannot pay out more USDC than it has ever received.
    /// @dev Inflow includes the pre-seeded buffer and free donations, both of
    ///      which are additive. This is near-tautological by conservation — its
    ///      value is as a cross-check that the handler's accounting of the
    ///      mint/redeem/process paths matches reality. It caught a genuine bug in
    ///      an earlier revision, where the ghost omitted the seeded buffer and the
    ///      invariant tripped the first time an accrued redemption paid out more
    ///      than its principal.
    function invariant_PsmOutflowBoundedByInflow() public view {
        assertLe(handler.ghostUsdcOut(), handler.ghostUsdcIn());
    }

    // ============ Handler sanity ============

    /// @notice Guards against a silently-degenerate run: if almost every action
    ///         reverts, the invariants above are being checked against a system
    ///         that never moved.
    function invariant_HandlerIsActuallyExercisingTheSystem() public view {
        if (handler.calls() > 50) {
            assertGt(handler.successes() * 100 / handler.calls(), 30, "handler success rate < 30%");
        }
    }
}
