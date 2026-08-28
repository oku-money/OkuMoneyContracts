// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {MathLib} from "../src/lib/MathLib.sol";
import {MockHighDecimalToken} from "./mocks/MockHighDecimalToken.sol";

/**
 * @title OkuMTest
 * @notice The regulated-issuer surface and the ERC-8056 display layer.
 */
contract OkuMTest is BaseTest {
    // ============ Initialization ============

    function test_initialize_rejectsBadInputs() public {
        OkuM impl = new OkuM();

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OkuM.initialize, ("N", "S", address(0), MAX_SUPPLY, address(usdc)))
        );

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OkuM.initialize, ("N", "S", admin, MAX_SUPPLY, address(0)))
        );
    }

    /// @dev `maxSupply` is mutable, so the ceiling must be enforced on BOTH write
    ///      paths — an init-only assertion would evaporate the first time the cap
    ///      moved, taking the overflow invariant with it.
    function test_maxTotalSupplyEnforcedOnBothWritePaths() public {
        OkuM impl = new OkuM();
        vm.expectRevert(OkuM.ExceedsMaxTotalSupply.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuM.initialize, ("N", "S", admin, Constants.MAX_TOTAL_SUPPLY + 1, address(usdc))
            )
        );

        vm.prank(admin);
        vm.expectRevert(OkuM.ExceedsMaxTotalSupply.selector);
        okuM.setMaxSupply(Constants.MAX_TOTAL_SUPPLY + 1);
    }

    function test_initialize_rejectsTooManyUsdcDecimals() public {
        MockHighDecimalToken weird = new MockHighDecimalToken(19);
        OkuM impl = new OkuM();
        vm.expectPartialRevert(OkuM.UsdcDecimalsTooLarge.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OkuM.initialize, ("N", "S", admin, MAX_SUPPLY, address(weird)))
        );
    }

    function test_decimalMultiplierDerivedFromAsset() public view {
        assertEq(okuM.asset(), address(usdc));
        assertEq(okuM.usdcDecimalMultiplier(), DECIMAL_MULTIPLIER);
    }

    // ============ Multiplier authority ============

    function test_setMultiplier_rejectsDecreaseAndNoOp() public {
        uint256 current = okuM.uiMultiplier();
        vm.startPrank(rateSetter);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        okuM.setOkuMultiplier(current, 1);

        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        okuM.setOkuMultiplier(current - 1, 1);
        vm.stopPrank();
    }

    function test_setMultiplier_rejectsAboveMaxMultiplier() public {
        vm.prank(rateSetter);
        vm.expectRevert(Errors.MultiplierAboveMaximum.selector);
        okuM.setOkuMultiplier(Constants.MAX_MULTIPLIER + 1, 1);
    }

    function test_setMultiplier_acceptsExactlyMaxStep() public {
        uint256 current = okuM.uiMultiplier();
        uint256 atCap = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
        vm.prank(rateSetter);
        okuM.setOkuMultiplier(atCap, 1);
        assertEq(okuM.uiMultiplier(), atCap);
    }

    function test_setMultiplier_requiresRole() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.setOkuMultiplier(2e18, 1);
    }

    function test_epochAndPendingMultiplierTrackTheMark() public {
        _stepOkuMultiplier(50);
        assertEq(okuM.syncEpoch(), 1);
        // Steps take effect immediately, so the pending value equals the live one
        // from the block of the write onward.
        assertEq(okuM.newUIMultiplier(), okuM.uiMultiplier());
        assertEq(okuM.effectiveAt(), block.timestamp);
    }

    function test_resumeAccrual_requiresColdRole() public {
        vm.prank(guardian);
        okuM.haltAccrual();

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.resumeAccrual();

        vm.prank(resumer);
        okuM.resumeAccrual();
        assertFalse(okuM.accrualHalted());
    }

    // ============ Value views ============

    function test_totalAssetsTracksSupplyAtMultiplier() public {
        _subscribe(alice, 1000 * USDC_UNIT);
        assertEq(okuM.totalAssets(), 1000 * USDC_UNIT);

        _stepOkuMultiplier(100);
        assertApproxEqAbs(okuM.totalAssets(), 1010 * USDC_UNIT, 1);
    }

    /// @dev These are NOT inverses — a round trip quantises to USDC granularity.
    ///      The loss is 0 when the multiplier happens to land on a 1e12 boundary
    ///      and up to 1e12 (in 18dp terms) when it does not, so the assertable
    ///      property is non-inflation, plus the documented parity BOUND.
    function testFuzz_convertRoundTripNeverInflates(uint256 stepBps) public {
        stepBps = bound(stepBps, 1, Constants.MAX_STEP_BPS);
        _stepOkuMultiplier(stepBps);

        uint256 shares = 1e18;
        uint256 back = okuM.convertToShares(okuM.convertToAssets(shares));
        assertLe(back, shares, "round trip must never inflate");
        assertGe(back + DECIMAL_MULTIPLIER, shares, "and loses at most one USDC unit");
    }

    /// @dev The display and value layers read the SAME stored number, related by
    ///      a floor to USDC granularity. It is a bound, never an equality — a
    ///      fuzz test written against equality fails immediately.
    function testFuzz_displayValueParityIsABound(uint256 stepBps) public {
        stepBps = bound(stepBps, 1, Constants.MAX_STEP_BPS);
        _stepOkuMultiplier(stepBps);

        uint256 assets = okuM.convertToAssets(1e18);
        uint256 mOku = okuM.uiMultiplier();
        assertLe(assets * DECIMAL_MULTIPLIER, mOku, "lower bound");
        assertLt(mOku, (assets + 1) * DECIMAL_MULTIPLIER, "upper bound");
    }

    function test_doesNotClaimErc4626() public view {
        // A `deposit()` that reverts for everyone is worse than an absent one,
        // so the 4626 id must read false.
        assertFalse(okuM.supportsInterface(0x87dfe5a0));
    }

    // ============ Minter allowance ============

    function test_mint_requiresAllowanceAndRole() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.mint(alice, 1e18);

        vm.prank(admin);
        okuM.configureMinterAllowance(admin, 5e18);
        vm.prank(admin);
        vm.expectRevert(OkuM.ExceedsAllowance.selector);
        okuM.mint(alice, 6e18);

        vm.prank(admin);
        okuM.mint(alice, 5e18);
        assertEq(okuM.minterAllowance(admin), 0);
    }

    function test_configureMinterAllowance_rejectsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuM.configureMinterAllowance(address(0), 1e18);
    }

    function test_setMaxSupply_cannotGoBelowCurrentSupply() public {
        _subscribe(alice, 1000 * USDC_UNIT);
        vm.prank(admin);
        vm.expectRevert(OkuM.BelowCurrentSupply.selector);
        okuM.setMaxSupply(1e18);
    }

    // ============ Blacklist / pause ============

    function test_blacklist_blocksBurnOut() public {
        _subscribe(alice, 100 * USDC_UNIT);
        vm.prank(admin);
        okuM.configureMinterAllowance(admin, 1e18);

        vm.prank(admin);
        okuM.blacklist(admin);
        vm.prank(admin);
        vm.expectRevert(OkuM.SenderBlacklisted.selector);
        okuM.burn(1);
    }

    function test_blacklist_rejectsDoubleSetAndUnsetOfClean() public {
        vm.startPrank(admin);
        okuM.blacklist(bob);
        vm.expectRevert(OkuM.AlreadyBlacklisted.selector);
        okuM.blacklist(bob);

        okuM.unblacklist(bob);
        vm.expectRevert(OkuM.NotBlacklisted.selector);
        okuM.unblacklist(bob);
        vm.stopPrank();
    }

    /// @dev Pause freezes transfer/transferFrom/mint. Burn is deliberately NOT
    ///      gated, which is what makes the pause-then-blacklist protocol work: a
    ///      holder can still exit their position while the token is frozen.
    function test_pause_blocksTransferAndMintButNotBurn() public {
        uint256 raw = _subscribe(alice, 100 * USDC_UNIT);
        vm.startPrank(admin);
        okuM.configureMinterAllowance(admin, 10e18);
        okuM.grantRole(Roles.OKU_BURNER, alice);
        vm.stopPrank();

        vm.prank(pauser);
        okuM.pause();

        vm.prank(admin);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuM.mint(alice, 1e18);

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuM.transfer(bob, 1e18);

        // Burn still works.
        vm.prank(alice);
        okuM.burn(raw / 2);
        assertEq(okuM.balanceOf(alice), raw - raw / 2);
    }

    function test_unpause_isColdOnly() public {
        vm.prank(pauser);
        okuM.pause();

        vm.prank(pauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.unpause();

        vm.prank(admin);
        okuM.unpause();
        assertFalse(okuM.paused());
    }

    // ============ Permit ============

    function test_permit_blocksBlacklistedParties() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);

        vm.prank(admin);
        okuM.blacklist(owner);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                bob,
                1e18,
                okuM.nonces(owner),
                block.timestamp + 1 days
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", okuM.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        vm.expectRevert(OkuM.SenderBlacklisted.selector);
        okuM.permit(owner, bob, 1e18, block.timestamp + 1 days, v, r, s);
    }

    function test_permit_succeedsForCleanParties() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                bob,
                1e18,
                okuM.nonces(owner),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", okuM.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        okuM.permit(owner, bob, 1e18, deadline, v, r, s);
        assertEq(okuM.allowance(owner, bob), 1e18);
    }

    // ============ ERC-8056 display layer ============

    function test_balanceOfUIAndTotalSupplyUI() public {
        _subscribe(alice, 1000 * USDC_UNIT);
        _stepOkuMultiplier(100);

        assertEq(
            okuM.balanceOfUI(alice), MathLib.toUIAmount(okuM.balanceOf(alice), okuM.uiMultiplier())
        );
        assertEq(okuM.totalSupplyUI(), MathLib.toUIAmount(okuM.totalSupply(), okuM.uiMultiplier()));
    }

    /// @dev The reference implementation emits unconditionally from `_update`,
    ///      including mint and burn where the counterparty UI amount is
    ///      meaningless. We gate on both sides being non-zero.
    function test_transferWithUIAmountOnlyOnGenuineTransfers() public {
        uint256 raw = _subscribe(alice, 100 * USDC_UNIT);

        vm.recordLogs();
        vm.prank(alice);
        okuM.transfer(bob, raw / 2);
        assertGt(_countTransferWithUI(), 0, "emitted on a genuine transfer");

        vm.recordLogs();
        _subscribe(bob, 10 * USDC_UNIT); // mint path
        assertEq(_countTransferWithUI(), 0, "not emitted on mint");
    }

    function _countTransferWithUI() internal returns (uint256 n) {
        bytes32 sig = keccak256("TransferWithUIAmount(address,address,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) n++;
        }
    }
}
