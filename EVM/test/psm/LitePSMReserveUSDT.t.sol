// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {SharedErrors} from "../../src/lib/errors/SharedErrors.sol";
import {LitePSMEvents} from "../../src/lib/events/LitePSMEvents.sol";
import {Deploy} from "../shared/Deploy.sol";
import {MockUSDT} from "../mocks/MockUSDT.sol";

/// @title LitePSMReserveUSDTTest
/// @notice LitePSM against a USDT-style reserve: no return values, approve-race guard,
///         and an optional transfer fee. Fee 0 must match the USDC behaviour; with a fee,
///         mints and buffer deposits credit only what the PSM actually received.
contract LitePSMReserveUSDTTest is BaseTest, LitePSMEvents {
    MockUSDT internal usdt;
    LitePSM internal psm;

    uint256 internal constant BUFFER = 1_000_000e6;
    uint256 internal constant FEE_BPS = 20; // 0.2%
    uint256 internal constant MAX_FEE = 50e6;

    function setUp() public override {
        super.setUp();
        usdt = new MockUSDT();
        (psm,) = Deploy.deployLitePSM(address(okuMoney), address(okuDollar), address(usdt), admin);

        vm.startPrank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(psm));
        okuMoney.grantRole(OKUM_BURNER, address(psm));
        psm.grantRole(PSM_BUFFER_DEPOSITOR, bufferDepositor);
        psm.grantRole(PSM_BUFFER_WITHDRAWER, bufferWithdrawer);
        vm.stopPrank();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(psm), MAX_SUPPLY);

        usdt.mint(address(psm), BUFFER);
    }

    // ============ Helpers ============

    function _fundAndApprove(address user, uint256 amount) internal {
        usdt.mint(user, amount);
        vm.startPrank(user);
        usdt.approve(address(psm), 0);
        usdt.approve(address(psm), amount);
        vm.stopPrank();
    }

    function _enableFee() internal {
        usdt.setParams(FEE_BPS, MAX_FEE);
    }

    function _okuMFor(uint256 reserveIn, uint256 mult) internal pure returns (uint256) {
        return MathLib.dollarsToOkuM(MathLib.usdcToDollars(reserveIn, 1e12), mult);
    }

    function _reserveFor(uint256 okuMIn, uint256 mult) internal pure returns (uint256) {
        return MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMIn, mult), 1e12);
    }

    // ============ Fee 0: parity with USDC ============

    function test_NoFee_AllPathsWork() public {
        _setOkuMMultiplierAndRoll(1.05e18);
        uint256 mult = okuMoney.okuMMultiplier();
        uint256 amount = 1000e6;

        // mintOkuM / redeemOkuM
        _fundAndApprove(user1, amount);
        vm.prank(user1);
        psm.mintOkuM(amount);
        uint256 okuM = okuMoney.balanceOf(user1);
        assertEq(okuM, _okuMFor(amount, mult));

        _approveOkuMoney(user1, address(psm), okuM);
        vm.prank(user1);
        uint256 out = psm.redeemOkuM(okuM);
        assertEq(usdt.balanceOf(user1), out);
        assertApproxEqAbs(out, amount, 1);

        // mintUsdOku / redeemUsdOku
        _fundAndApprove(user2, amount);
        vm.prank(user2);
        psm.mintUsdOku(amount);
        uint256 usd = okuDollar.balanceOf(user2);
        assertGt(usd, 0);

        _approveOkuDollar(user2, address(psm), usd);
        vm.prank(user2);
        psm.redeemUsdOku(usd);
        assertApproxEqAbs(usdt.balanceOf(user2), amount, 2);

        // depositBuffer / withdrawUsdc
        _fundAndApprove(bufferDepositor, amount);
        uint256 bufBefore = usdt.balanceOf(address(psm));
        vm.expectEmit(address(psm));
        emit BufferDeposited(bufferDepositor, amount, bufBefore + amount);
        vm.prank(bufferDepositor);
        psm.depositBuffer(amount);

        vm.prank(bufferWithdrawer);
        psm.withdrawUsdc(bufferWithdrawer, amount);
        assertEq(usdt.balanceOf(bufferWithdrawer), amount);
        assertEq(usdt.balanceOf(address(psm)), bufBefore);
    }

    // ============ Fee > 0: mints credit the received amount ============

    function test_Fee_MintOkuM_CreditsReceived() public {
        _enableFee();
        uint256 amount = 10_000e6;
        uint256 received = amount - usdt.fee(amount);
        uint256 mult = okuMoney.okuMMultiplier();
        uint256 expected = _okuMFor(received, mult);

        _fundAndApprove(user1, amount);
        uint256 bufBefore = usdt.balanceOf(address(psm));

        vm.expectEmit(address(psm));
        emit OkuMMinted(user1, received, expected, mult);
        vm.prank(user1);
        psm.mintOkuM(amount);

        assertEq(okuMoney.balanceOf(user1), expected);
        assertEq(usdt.balanceOf(address(psm)) - bufBefore, received);
    }

    function test_Fee_MintUsdOku_CreditsReceived() public {
        _enableFee();
        _setOkuMMultiplierAndRoll(1.2e18);
        uint256 amount = 10_000e6;
        uint256 received = amount - usdt.fee(amount);
        uint256 mult = okuMoney.okuMMultiplier();
        uint256 expectedUsd = MathLib.okuMToDollars(_okuMFor(received, mult), mult);

        _fundAndApprove(user1, amount);
        uint256 bufBefore = usdt.balanceOf(address(psm));

        vm.expectEmit(address(psm));
        emit UsdOkuMinted(user1, received, expectedUsd, mult);
        vm.prank(user1);
        psm.mintUsdOku(amount);

        assertEq(okuDollar.balanceOf(user1), expectedUsd);
        assertEq(usdt.balanceOf(address(psm)) - bufBefore, received);
    }

    function test_Fee_DepositBuffer_EmitsReceived() public {
        _enableFee();
        uint256 amount = 50_000e6;
        uint256 received = amount - usdt.fee(amount);
        _fundAndApprove(bufferDepositor, amount);
        uint256 bufBefore = usdt.balanceOf(address(psm));

        vm.expectEmit(address(psm));
        emit BufferDeposited(bufferDepositor, received, bufBefore + received);
        vm.prank(bufferDepositor);
        psm.depositBuffer(amount);
    }

    /// @notice A fee that swallows the whole transfer reverts rather than minting zero.
    function test_Fee_FullFee_Reverts() public {
        usdt.setParams(10_000, type(uint256).max);
        uint256 amount = 100e6;

        _fundAndApprove(user1, amount);
        vm.prank(user1);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        psm.mintOkuM(amount);

        vm.prank(user1);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        psm.mintUsdOku(amount);

        _fundAndApprove(bufferDepositor, amount);
        vm.prank(bufferDepositor);
        vm.expectRevert(SharedErrors.AmountTooSmall.selector);
        psm.depositBuffer(amount);
    }

    /// @notice A payout fee is borne by the recipient; the buffer drops by the quote.
    function test_Fee_Redeem_BufferDropsByQuote() public {
        uint256 okuMIn = 1000e18;
        _mintOkuMoney(user1, okuMIn);
        _approveOkuMoney(user1, address(psm), okuMIn);
        uint256 quote = _reserveFor(okuMIn, okuMoney.okuMMultiplier());

        _enableFee();
        uint256 bufBefore = usdt.balanceOf(address(psm));
        vm.prank(user1);
        uint256 out = psm.redeemOkuM(okuMIn);

        assertEq(out, quote);
        assertEq(bufBefore - usdt.balanceOf(address(psm)), quote);
        assertEq(usdt.balanceOf(user1), quote - usdt.fee(quote));
    }

    // ============ Fuzz ============

    /// @notice Minted OkuM never carries more dollar value than the reserve received.
    function testFuzz_Fee_MintNeverOverBacks(uint256 amount, uint256 bps, uint256 mult) public {
        amount = bound(amount, 1e6, 10_000_000e6);
        bps = bound(bps, 0, 9999);
        mult = _boundOkuMMultiplier(mult);
        _setOkuMMultiplierAndRoll(mult);
        usdt.setParams(bps, type(uint256).max);

        uint256 received = amount - usdt.fee(amount);
        _fundAndApprove(user1, amount);
        uint256 bufBefore = usdt.balanceOf(address(psm));

        vm.prank(user1);
        try psm.mintOkuM(amount) {
            uint256 minted = okuMoney.balanceOf(user1);
            assertEq(usdt.balanceOf(address(psm)) - bufBefore, received);
            assertLe(
                MathLib.okuMToDollars(minted, okuMoney.okuMMultiplier()),
                MathLib.usdcToDollars(received, 1e12)
            );
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SharedErrors.AmountTooSmall.selector);
        }
    }
}
