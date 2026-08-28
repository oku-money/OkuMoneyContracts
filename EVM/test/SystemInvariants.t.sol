// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {SystemHandler} from "./handlers/SystemHandler.sol";
import {SubscriptionModule} from "../src/subscription/SubscriptionModule.sol";
import {Constants} from "../src/lib/Constants.sol";
import {MathLib} from "../src/lib/MathLib.sol";

/**
 * @title SystemInvariants
 * @notice Stateful fuzz over the whole system, driven by an adversarial handler
 *         that donates tokens and races request transitions.
 *
 * Every backing and escrow property below is a BOUND rather than an equality,
 * because the handler donates directly to the module and the wrapper. Free
 * token donations are unpreventable on any ERC-20, so an equality would be a
 * permanently griefable failure rather than a property of the protocol.
 */
contract SystemInvariants is BaseTest {
    SystemHandler internal handler;

    function setUp() public override {
        super.setUp();

        handler = new SystemHandler(
            okuM, usdOku, wrapper, module, usdc, admin, rateSetter, fulfiller, treasury
        );

        vm.startPrank(admin);
        okuM.grantRole(0x00, address(handler)); // DEFAULT_ADMIN for allowance juggling
        okuM.grantRole(keccak256("OKU_ALLOWANCE_MANAGER"), address(handler));
        okuM.grantRole(keccak256("OKU_MINTER"), address(handler));
        vm.stopPrank();

        targetContract(address(handler));
    }

    // =====================================================================
    // Solvency - the load-bearing invariant
    // =====================================================================

    /// @dev THE property pre-funding buys. If this ever fails, a USDOku holder
    ///      somewhere cannot redeem their displayed balance.
    function invariant_backingCoversLiability() public view {
        assertTrue(wrapper.backingCoversLiability(), "backing must always cover declared liability");
    }

    function invariant_unwrapIsAlwaysPayable() public view {
        // Restated concretely: the wrapper's OkuM reserves, valued at M_oku, are
        // enough to satisfy every outstanding USDOku claim at once.
        uint256 reserves = okuM.balanceOf(address(wrapper));
        uint256 backingDollars = MathLib.toUIAmount(reserves, okuM.uiMultiplier());
        assertGe(backingDollars, usdOku.totalSupply(), "a full simultaneous exit must be payable");
    }

    // =====================================================================
    // Monotonicity
    // =====================================================================

    function invariant_okuMultiplierNeverDecreases() public view {
        assertEq(
            okuM.uiMultiplier(),
            handler.ghost_maxMultiplierSeen(),
            "M_oku must never fall below its high-water mark"
        );
    }

    function invariant_usdIndexNeverDecreases() public view {
        assertEq(
            usdOku.usdOkuIndex(),
            handler.ghost_maxIndexSeen(),
            "M_usd must never fall below its high-water mark"
        );
    }

    function invariant_multiplierWithinBounds() public view {
        assertGe(okuM.uiMultiplier(), Constants.PRECISION);
        assertLe(okuM.uiMultiplier(), Constants.MAX_MULTIPLIER);
        assertLe(usdOku.usdOkuIndex(), Constants.MAX_MULTIPLIER);
    }

    // =====================================================================
    // Escrow - bounds, because donations are unpreventable
    // =====================================================================

    function invariant_usdcEscrowIsBounded() public view {
        assertGe(
            usdc.balanceOf(address(module)),
            module.totalEscrowedUsdc(),
            "module USDC must cover pending subscription escrow"
        );
    }

    function invariant_okuMEscrowIsBounded() public view {
        assertGe(
            okuM.balanceOf(address(module)),
            module.totalEscrowedOkuM(),
            "module OkuM must cover pending redemption escrow"
        );
    }

    // =====================================================================
    // Supply / ledger
    // =====================================================================

    function invariant_supplyWithinCap() public view {
        assertLe(okuM.totalSupply(), okuM.maxSupply());
        assertLe(okuM.maxSupply(), Constants.MAX_TOTAL_SUPPLY);
    }

    function invariant_usdOkuSupplyMatchesShareLedger() public view {
        assertEq(
            usdOku.totalSupply(),
            MathLib.toUIAmount(usdOku.totalShares(), usdOku.usdOkuIndex()),
            "USDOku supply is exactly shares x index"
        );
    }

    function invariant_totalSupplyUIMatchesMultiplier() public view {
        assertEq(okuM.totalSupplyUI(), MathLib.toUIAmount(okuM.totalSupply(), okuM.uiMultiplier()));
    }

    // =====================================================================
    // Display / value parity - a BOUND, never an equality
    // =====================================================================

    function invariant_displayValueParity() public view {
        uint256 assets = okuM.convertToAssets(1e18);
        uint256 mOku = okuM.uiMultiplier();
        assertLe(assets * DECIMAL_MULTIPLIER, mOku, "lower bound");
        assertLt(mOku, (assets + 1) * DECIMAL_MULTIPLIER, "upper bound");
    }

    // =====================================================================
    // Request lifecycle
    // =====================================================================

    /// @dev At most one pending request per (user, direction) — the property
    ///      that removed the redemption queue entirely.
    function invariant_atMostOnePendingRequestPerDirection() public view {
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address actor = handler.actors(i);

            uint256 subId = module.pendingRequestOf(actor, SubscriptionModule.Direction.Subscribe);
            if (subId != 0) {
                SubscriptionModule.Request memory r = module.getRequest(subId);
                assertEq(uint8(r.status), 0, "pending slot must point at a Pending request");
                assertEq(uint8(r.direction), 0, "and at the matching direction");
                assertEq(r.user, actor, "and at the right user");
            }

            uint256 redId = module.pendingRequestOf(actor, SubscriptionModule.Direction.Redeem);
            if (redId != 0) {
                SubscriptionModule.Request memory r = module.getRequest(redId);
                assertEq(uint8(r.status), 0);
                assertEq(uint8(r.direction), 1);
                assertEq(r.user, actor);
            }
        }
    }

    // =====================================================================
    // Interface claims
    // =====================================================================

    function invariant_interfaceClaimsAreStable() public view {
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
        // Never claimed: a second scaling factor over an already-scaled balance
        // would be applied twice by an aware wallet.
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
        assertFalse(module.supportsInterface(Constants.IID_ERC7540_DEPOSIT));
        assertFalse(module.supportsInterface(Constants.IID_ERC7540_REDEEM));
    }

    // =====================================================================
    // Handler liveness - guards against a vacuous run
    // =====================================================================

    /// @dev If the handler never actually does anything, every invariant above
    ///      passes trivially. `afterInvariant` runs once at the END of each
    ///      campaign, so unlike an `invariant_` function it is not evaluated
    ///      against the empty pre-run state.
    function afterInvariant() public view {
        uint256 total = handler.ghost_subscriptionsFulfilled() + handler.ghost_wraps()
            + handler.ghost_marks() + handler.ghost_donations();
        assertGt(total, 0, "handler performed no state-changing work - run is vacuous");
    }
}
