// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {L2BlockNumber} from "../../src/lib/L2BlockNumber.sol";
import {OverrideBlockGuard} from "../../src/lib/OverrideBlockGuard.sol";
import {OkuMoneyEvents} from "../../src/lib/events/OkuMoneyEvents.sol";
import {IArbSys} from "../../src/lib/L2BlockNumber.sol";

contract L2BlockNumberHarness {
    function current() external view returns (uint256) {
        return L2BlockNumber.current();
    }
}

/// @notice Cyfrin #11 (and the #12 fence that rides on the same block source): on Arbitrum
///         `block.number` is a parent-chain estimate shared by many L2 blocks, so the
///         override stamp, its guard and its event must use `ArbSys.arbBlockNumber()`.
contract L2BlockNumberTest is BaseTest {
    uint256 internal constant ARBITRUM_ONE = 42_161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421_614;
    address internal constant ARB_SYS = address(100);

    L2BlockNumberHarness internal harness;

    function setUp() public override {
        super.setUp();
        harness = new L2BlockNumberHarness();
    }

    /// @dev ArbSys is faked with `vm.mockCall`, not an etched contract. Foundry (v1.8.5, the
    ///      version CI pins) emulates the ArbSys precompile at address 100 itself whenever the
    ///      chain id is Arbitrum, answering `arbBlockNumber()` with `block.number`; `vm.etch`
    ///      cannot override that, but a mock intercepts before it. Re-mocking replaces the value.
    function _setArbBlock(uint256 l2Height) internal {
        vm.mockCall(ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), abi.encode(l2Height));
    }

    function _arbitrum(uint256 chainId, uint256 l2Height) internal {
        vm.chainId(chainId);
        _setArbBlock(l2Height);
    }

    // ---- library ----

    function test_Current_IsBlockNumberOffArbitrum() public {
        assertEq(harness.current(), block.number);

        // a chain that is not Arbitrum never calls address 100, even if code sits there
        vm.chainId(8453);
        _setArbBlock(999_999);
        assertEq(harness.current(), block.number);

        vm.chainId(1);
        assertEq(harness.current(), block.number);
    }

    function test_Current_ReadsArbSysOnArbitrumOneAndSepolia() public {
        _arbitrum(ARBITRUM_ONE, 7_000_000);
        assertEq(harness.current(), 7_000_000);
        assertTrue(harness.current() != block.number);

        _arbitrum(ARBITRUM_SEPOLIA, 123);
        assertEq(harness.current(), 123);
    }

    function test_Current_FallsBackToBlockNumberWithoutPrecompile() public {
        // A Hardhat fork of Arbitrum reports chain id 42161 but emulates no ArbSys: the call
        // returns nothing usable and the library falls back to `block.number`
        vm.chainId(ARBITRUM_ONE);
        vm.mockCall(ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), hex"");
        assertEq(harness.current(), block.number);

        // ... and so does a precompile that answers with something other than one word
        vm.mockCall(ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), hex"00");
        assertEq(harness.current(), block.number);
        vm.mockCall(
            ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), abi.encode(uint256(5), uint256(6))
        );
        assertEq(harness.current(), block.number);

        // a failing call falls back too
        vm.mockCallRevert(ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), "boom");
        assertEq(harness.current(), block.number);
    }

    // ---- override stamp, event, guard on Arbitrum ----

    function test_Override_StampsAndEmitsL2Height() public {
        _arbitrum(ARBITRUM_ONE, 7_000_000);

        vm.expectEmit(true, false, false, true, address(okuMoney));
        emit OkuMoneyEvents.OkuMMultiplierUpdated(
            PRECISION, PRECISION * 2, okuMoney.totalSupply(), 7_000_000
        );
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        assertEq(okuMoney.lastOverrideBlock(), 7_000_000);
        assertTrue(okuMoney.lastOverrideBlock() != block.number);
    }

    /// @dev The #11 failure: the parent-chain estimate stays put while L2 blocks advance.
    ///      Guarded paths must reopen with the L2 height, not wait for `block.number`.
    function test_Guard_ReopensWhenL2HeightAdvancesWithoutBlockNumber() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        _arbitrum(ARBITRUM_ONE, 7_000_000);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuDollar.wrap(10e18, user1, 0);

        // next L2 block; the parent-chain estimate (`block.number`) has not moved
        uint256 estimate = block.number;
        _setArbBlock(7_000_001);
        assertEq(block.number, estimate);

        vm.prank(user1);
        okuDollar.wrap(10e18, user1, 0);
        assertGt(okuDollar.balanceOf(user1), 0);
    }

    /// @dev Conversely the guard follows the L2 height: a moved estimate alone does not
    ///      reopen the block the override landed in.
    function test_Guard_StaysClosedWhenOnlyBlockNumberAdvances() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        _arbitrum(ARBITRUM_ONE, 7_000_000);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        vm.roll(block.number + 5);

        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuDollar.wrap(10e18, user1, 0);
    }

    /// @dev #12 on Arbitrum: the same-block fence compares the L2 height too, so a second
    ///      override inside one L2 block reverts even after the estimate advanced, and one
    ///      in the next L2 block lands even though the estimate did not.
    function test_SecondOverride_FencedOnL2HeightNotBlockNumber() public {
        _arbitrum(ARBITRUM_ONE, 7_000_000);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        vm.roll(block.number + 5); // estimate moved, same L2 block
        vm.prank(rateManager);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        okuMoney.setOkuMMultiplier(PRECISION * 3);

        _setArbBlock(7_000_001); // next L2 block
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 3);
        assertEq(okuMoney.okuMMultiplier(), PRECISION * 3);
        assertEq(okuMoney.lastOverrideBlock(), 7_000_001);
    }

    /// @dev PSM paths use the same guard.
    function test_PsmPathsFollowL2Height() public {
        _arbitrum(ARBITRUM_ONE, 7_000_000);
        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        vm.prank(user1);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.redeemOkuM(1e18);

        _setArbBlock(7_000_001);
        // past the guard: whatever happens next is not OverrideInProgress
        vm.prank(user1);
        try litePsm.redeemOkuM(1e18) {}
        catch (bytes memory reason) {
            assertTrue(bytes4(reason) != OverrideBlockGuard.OverrideInProgress.selector);
        }
    }
}
