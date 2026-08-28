// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {USDOkuWrapper} from "../src/wrapper/USDOkuWrapper.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {MathLib} from "../src/lib/MathLib.sol";

/**
 * @title WrapperTest
 * @notice Wrap/unwrap mechanics, the solvency views, and surplus recovery.
 *         Pricing correctness itself is proven in Differential.t.sol.
 */
contract WrapperTest is BaseTest {
    function test_initialize_rejectsZeroAddresses() public {
        USDOkuWrapper impl = new USDOkuWrapper();

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(USDOkuWrapper.initialize, (address(0), address(usdOku), admin))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(USDOkuWrapper.initialize, (address(okuM), address(0), admin))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(USDOkuWrapper.initialize, (address(okuM), address(usdOku), address(0)))
        );
    }

    function test_accessorsReflectWiring() public view {
        assertEq(address(wrapper.okuM()), address(okuM));
        assertEq(address(wrapper.usdOku()), address(usdOku));
        assertTrue(wrapper.wrapEnabled());
    }

    // ============ Input validation ============

    function test_wrap_rejectsZeroInputs() public {
        vm.startPrank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        wrapper.wrap(0, alice, 0);

        vm.expectRevert(Errors.ZeroAddress.selector);
        wrapper.wrap(1e18, address(0), 0);
        vm.stopPrank();
    }

    function test_unwrap_rejectsZeroInputs() public {
        vm.startPrank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        wrapper.unwrap(0, alice);

        vm.expectRevert(Errors.ZeroAddress.selector);
        wrapper.unwrap(1e18, address(0));
        vm.stopPrank();
    }

    function test_wrap_enforcesMinOut() public {
        uint256 raw = _subscribe(alice, 100 * USDC_UNIT);
        uint256 quoted = wrapper.quoteWrap(raw);

        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        vm.expectPartialRevert(USDOkuWrapper.OutputBelowMinimum.selector);
        wrapper.wrap(raw, alice, quoted + 1);
        vm.stopPrank();
    }

    function test_quoteUnwrapMatchesUnwrap() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);

        uint256 quoted = wrapper.quoteUnwrap(500e18);
        uint256 actual = wrapper.unwrap(500e18, alice);
        vm.stopPrank();
        assertEq(actual, quoted, "quote must match the payout");
    }

    // ============ Solvency views ============

    function test_solvencyViewsAtGenesis() public view {
        assertEq(wrapper.declaredLiability(), 0);
        assertEq(wrapper.realizedBacking(), 0);
        assertEq(wrapper.solvencyGapBps(), 0, "0/0 is defined as zero, not a revert");
        assertEq(wrapper.backingRatioBps(), Constants.BASIS_POINTS);
        assertTrue(wrapper.backingCoversLiability());
        assertEq(wrapper.withdrawableSurplus(), 0);
    }

    /// @dev backing == 0 with liability > 0 is the sentinel case. It should be
    ///      unreachable under pre-funding, but the view must not divide by zero.
    function test_solvencyGapSentinelWhenBackingIsZero() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        // Forcibly strand the liability by moving the backing out from under it.
        // Read hoisted: an inline balanceOf would consume the prank.
        uint256 reserves = okuM.balanceOf(address(wrapper));
        vm.prank(address(wrapper));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuM.transfer(bob, reserves);

        assertEq(wrapper.realizedBacking(), 0);
        assertGt(wrapper.declaredLiability(), 0);
        assertEq(wrapper.solvencyGapBps(), type(int256).max, "sentinel, not a revert");
        assertEq(wrapper.backingRatioBps(), 0);
        assertFalse(wrapper.backingCoversLiability());
    }

    function test_backingRatioAndGapWithSurplus() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        _prefundWrapper(100 * USDC_UNIT);

        assertGt(wrapper.backingRatioBps(), Constants.BASIS_POINTS, "over 100%");
        assertLt(wrapper.solvencyGapBps(), 0, "negative gap == surplus");
    }

    // ============ Sunset ============

    function test_setWrapEnabled_requiresWrapperAdmin() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        wrapper.setWrapEnabled(false);
    }

    function test_setWrapEnabled_isTwoWay() public {
        vm.startPrank(admin);
        wrapper.setWrapEnabled(false);
        assertFalse(wrapper.wrapEnabled());
        wrapper.setWrapEnabled(true);
        assertTrue(wrapper.wrapEnabled(), "a paused rollout can be resumed");
        vm.stopPrank();
    }

    // ============ withdrawSurplus ============

    function test_withdrawSurplus_rejectsZeroInputs() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAmount.selector);
        wrapper.withdrawSurplus(0, admin);

        vm.expectRevert(Errors.ZeroAddress.selector);
        wrapper.withdrawSurplus(1e18, address(0));
        vm.stopPrank();
    }

    function test_withdrawSurplus_rejectsMoreThanReserves() public {
        _prefundWrapper(10 * USDC_UNIT);
        vm.prank(admin);
        vm.expectPartialRevert(USDOkuWrapper.InsufficientReserves.selector);
        wrapper.withdrawSurplus(1_000_000e18, admin);
    }
}
