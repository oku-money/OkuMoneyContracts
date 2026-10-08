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
            rateManager,
            minter,
            [blacklister, unblacklister, pauser, unpauser]
        );

        // Grant operator roles to the handler so it can drive the full PSM surface.
        vm.startPrank(admin);
        litePsm.grantRole(PSM_BUFFER_DEPOSITOR, address(handler));
        litePsm.grantRole(PSM_BUFFER_WITHDRAWER, address(handler));
        vm.stopPrank();
        // The handler drives `okuMRatePerSecond` by pranking `rateManager` (OKUM_RATE_MANAGER
        // from BaseTest); with `warpTime` this makes the multiplier compound, which
        // the PSM redeem rounding paths need in order to be exercised.

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /// @notice The PSM never holds OkuMoney across calls (within ≤1 wei rounding dust).
    function invariant_PSMDoesNotHoldOkuMoney() public view {
        uint256 psmOkuMBalance = okuMoney.balanceOf(address(litePsm));
        // Allow up to 1 wei of rounding dust.
        assertLe(psmOkuMBalance, 1, "PSM should hold no OkuMoney (allow 1 wei dust)");
    }

    /// @notice A blacklisted user is never paid USDC by a redeem.
    function invariant_BlacklistedNeverPaid() public view {
        assertEq(handler.ghostBlacklistedPaid(), 0, "blacklisted user received USDC");
    }

    /// @notice No USDC leaves the PSM through a payout path while it is paused.
    function invariant_NoOutflowWhilePaused() public view {
        assertEq(handler.ghostOutflowWhilePaused(), 0, "USDC left a paused PSM");
    }

    /// @notice PSM USDC balance == seed + every inflow - every outflow (exact, no tolerance).
    function invariant_PsmUsdcBalanceIsExact() public view {
        assertEq(
            usdc.balanceOf(address(litePsm)),
            seededBuffer + handler.ghostUsdcDeposited() - handler.ghostUsdcWithdrawn(),
            "PSM USDC accounting drifted"
        );
    }

    /// @notice No handler action may revert on every call. A handler whose bounds drift out
    ///         of sync with the contracts passes every other invariant while exercising
    ///         nothing.
    function invariant_NoHandlerActionAlwaysReverts() public view {
        _assertSometimesSucceeds(
            handler.ghostSetUsdYieldRateCalls(), handler.ghostSetUsdYieldRateReverts(), "yield rate"
        );
        _assertSometimesSucceeds(
            handler.ghostMintOkuMCalls(), handler.ghostMintOkuMReverts(), "mintOkuM"
        );
        _assertSometimesSucceeds(
            handler.ghostRedeemOkuMCalls(), handler.ghostRedeemOkuMReverts(), "redeemOkuM"
        );
        _assertSometimesSucceeds(
            handler.ghostMintOkuDollarCalls(), handler.ghostMintOkuDollarReverts(), "mintUsdOku"
        );
        _assertSometimesSucceeds(
            handler.ghostRedeemOkuDollarCalls(),
            handler.ghostRedeemOkuDollarReverts(),
            "redeemUsdOku"
        );
        _assertSometimesSucceeds(
            handler.ghostDepositBufferCalls(), handler.ghostDepositBufferReverts(), "depositBuffer"
        );
    }

    function _assertSometimesSucceeds(
        uint256 calls,
        uint256 reverts,
        string memory name
    )
        internal
        pure
    {
        if (calls >= 100) assertLt(reverts, calls, string.concat(name, " handler never succeeds"));
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
}
