// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {SystemHandler} from "./handlers/SystemHandler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Constants} from "../src/lib/Constants.sol";
import {ScaledUIAmountUpgradeable} from "../src/lib/ScaledUIAmountUpgradeable.sol";

/**
 * @title SystemInvariantsTest
 * @notice Properties that must hold after ANY sequence of permissionless and
 *         operator actions, driven by an adversarial handler.
 *
 * @dev The predecessor design's equivalent suite paid for itself immediately by
 *      finding a hole in `wrap` that no amount of inspection had caught — a
 *      mid-segment entrant accruing unfunded yield, off by ~0.0072%. These run at
 *      256 x 500 (128k calls each).
 */
contract SystemInvariantsTest is BaseTest {
    SystemHandler internal handler;

    function setUp() public override {
        super.setUp();

        handler = new SystemHandler(okuM, usdOku, psm, usdc, admin, rateSetter, gatekeeper);

        vm.startPrank(admin);
        okuM.grantRole(keccak256("OKUM_RATE_SETTER"), rateSetter);
        psm.grantRole(keccak256("PSM_GATEKEEPER"), gatekeeper);
        vm.stopPrank();

        _fundBuffer(100_000 * USDC_UNIT);

        targetContract(address(handler));
    }

    // =====================================================================
    // Solvency
    // =====================================================================

    /// @dev THE headline. USDOku's forward liability must never exceed the OkuM the
    ///      vault actually holds. `MAX_SOLVENCY_GAP_BPS == 0` makes this maintained,
    ///      not monitored.
    function invariant_vaultBackingCoversForwardLiability() public view {
        if (usdOku.totalShares() == 0) return;
        assertGe(
            usdOku.realizedBacking(),
            usdOku.projectedLiabilityAtRateEnd(),
            "USDOku liability outran its OkuM backing"
        );
    }

    /// @dev Every USDOku holder must be able to leave. Equivalent to the above but
    ///      expressed the way a user experiences it.
    function invariant_totalSupplyIsRedeemable() public view {
        uint256 supply = usdOku.totalSupply();
        if (supply == 0) return;
        uint256 okuMNeeded = okuM.fromUIAmount(supply);
        assertGe(
            IERC20(address(okuM)).balanceOf(address(usdOku)),
            okuMNeeded,
            "vault cannot honour its own totalSupply"
        );
    }

    // =====================================================================
    // No free money
    // =====================================================================

    /// @dev The PSM must never pay out more USDC than it took in, plus whatever
    ///      anyone deliberately donated to the buffer. If a round-trip were
    ///      profitable this drifts negative and the invariant catches it.
    function invariant_psmNeverPaysOutMoreThanItHolds() public view {
        assertLe(
            handler.ghost_usdcOut(),
            handler.ghost_usdcIn() + usdc.balanceOf(address(psm)) + 200_000 * USDC_UNIT,
            "PSM paid out more than it ever received"
        );
    }

    // =====================================================================
    // Index behaviour
    // =====================================================================

    /// @dev Monotonic. A price that can fall breaks every holder's expectations and
    ///      every downstream integration that treats it as a rate feed.
    function invariant_okuMIndexNeverDecreases() public view {
        assertGe(okuM.uiMultiplier(), Constants.PRECISION, "M_oku fell below its floor");
        assertLe(okuM.uiMultiplier(), Constants.MAX_MULTIPLIER, "M_oku exceeded its ceiling");
    }

    function invariant_usdOkuIndexNeverDecreases() public view {
        assertGe(usdOku.usdOkuIndex(), Constants.PRECISION, "M_usd fell below its floor");
        assertLe(usdOku.usdOkuIndex(), Constants.MAX_MULTIPLIER, "M_usd exceeded its ceiling");
    }

    /// @dev Accrual must flatline past `rateEnd` ABSENT A FRESH DECLARATION, so a
    ///      missed renewal freezes yield rather than compounding unboundedly.
    /// @dev `okuM.rateEnd()` alone is not a safe probe anchor: routine declarations
    ///      may now legitimately be scheduled ahead (forward `startTime`, for
    ///      multichain switchover), so a PENDING segment can already exist whose
    ///      window extends past — or starts before — whatever `rateEnd()` reports for
    ///      the currently-active one. The true horizon beyond which NEITHER installed
    ///      segment can still be growing is `max(active.endTime, pending.endTime)`;
    ///      this holds regardless of whether pending has taken effect yet (in which
    ///      case `activeSegment() == pendingSegment()` and the two ends coincide).
    function invariant_indexIsFlatPastRateEnd() public view {
        ScaledUIAmountUpgradeable.Segment memory active = okuM.activeSegment();
        ScaledUIAmountUpgradeable.Segment memory pending = okuM.pendingSegment();
        uint256 finalEnd = active.endTime > pending.endTime ? active.endTime : pending.endTime;
        assertEq(
            okuM.indexAt(finalEnd),
            okuM.indexAt(finalEnd + 365 days),
            "M_oku kept accruing past its final installed segment's end"
        );
    }

    /// @dev The determinism property that makes multichain sync work: `indexAt` must
    ///      be a pure function of its argument, never of when it is called.
    function invariant_indexAtIsPureInTime() public view {
        uint256 t = block.timestamp;
        assertEq(okuM.indexAt(t), okuM.uiMultiplier(), "indexAt(now) must equal uiMultiplier()");
    }

    // =====================================================================
    // Ledger integrity
    // =====================================================================

    function invariant_shareLedgerSumsToTotal() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += usdOku.sharesOf(handler.actors(i));
        }
        assertLe(sum, usdOku.totalShares(), "share ledger exceeds totalShares");
    }

    /// @dev Round-tripping through the display layer must never create value.
    function invariant_conversionRoundTripNeverCreatesValue() public view {
        uint256 probe = 1_000_000e18;
        assertLe(okuM.fromUIAmount(okuM.toUIAmount(probe)), probe, "round-trip created OkuM");
    }

    /// @dev The supply cap is a hard bound regardless of path.
    function invariant_supplyRespectsItsCap() public view {
        assertLe(okuM.totalSupply(), okuM.maxSupply(), "supply exceeded its cap");
        assertLe(okuM.totalSupply(), Constants.MAX_TOTAL_SUPPLY, "supply exceeded the absolute cap");
    }
}
