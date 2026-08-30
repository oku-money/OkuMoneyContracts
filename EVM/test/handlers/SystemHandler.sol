// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {USDOku} from "../../src/token/USDOku.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Constants} from "../../src/lib/Constants.sol";

/**
 * @title SystemHandler
 * @notice Adversarial driver for the invariant suite.
 *
 * @dev Deliberately hostile: it donates tokens directly to both the vault and the
 *      PSM (to break any assumption that balances only move through sanctioned
 *      paths), races rate declarations against conversions, and warps time in
 *      irregular jumps including past `rateEnd`.
 *
 *      Calls that revert for legitimate reasons — a closed window, an exhausted
 *      buffer, an unfunded rate — are swallowed. The invariants care about states
 *      reached, not about every call succeeding. Reverts that would indicate a bug
 *      surface as invariant violations instead.
 *
 *      `_bound` is used rather than `bound`: they are numerically identical, but
 *      `bound` emits a console2 log per call and at 128k calls per run that buries
 *      the output.
 */
contract SystemHandler is CommonBase, StdCheats, StdUtils {
    OkuM public okuM;
    USDOku public usdOku;
    LitePSM public psm;
    MockUSDC public usdc;

    address public admin;
    address public rateSetter;
    address public gatekeeper;

    address[3] public actors;
    address internal currentActor;

    uint256 public ghost_usdcIn;
    uint256 public ghost_usdcOut;

    modifier useActor(uint256 seed) {
        currentActor = actors[_bound(seed, 0, actors.length - 1)];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    constructor(
        OkuM _okuM,
        USDOku _usdOku,
        LitePSM _psm,
        MockUSDC _usdc,
        address _admin,
        address _rateSetter,
        address _gatekeeper
    ) {
        okuM = _okuM;
        usdOku = _usdOku;
        psm = _psm;
        usdc = _usdc;
        admin = _admin;
        rateSetter = _rateSetter;
        gatekeeper = _gatekeeper;

        actors[0] = makeAddr("h_alice");
        actors[1] = makeAddr("h_bob");
        actors[2] = makeAddr("h_carol");
    }

    // ============ Conversions ============

    function mintOkuM(uint256 seed, uint256 amount) external useActor(seed) {
        amount = _bound(amount, 1e6, 100_000e6);
        usdc.mint(currentActor, amount);
        usdc.approve(address(psm), amount);
        try psm.mintOkuM(amount, 0) {
            ghost_usdcIn += amount;
        } catch {}
    }

    function redeemOkuM(uint256 seed, uint256 amount) external useActor(seed) {
        uint256 bal = okuM.balanceOf(currentActor);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        IERC20(address(okuM)).approve(address(psm), amount);
        uint256 before = usdc.balanceOf(currentActor);
        try psm.redeemOkuM(amount, 0) {
            ghost_usdcOut += usdc.balanceOf(currentActor) - before;
        } catch {}
    }

    function wrap(uint256 seed, uint256 amount) external useActor(seed) {
        uint256 bal = okuM.balanceOf(currentActor);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        IERC20(address(okuM)).approve(address(usdOku), amount);
        try usdOku.wrap(amount, currentActor, 0) {} catch {}
    }

    function unwrap(uint256 seed, uint256 amount) external useActor(seed) {
        uint256 bal = usdOku.balanceOf(currentActor);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        try usdOku.unwrap(amount, currentActor) {} catch {}
    }

    function transferUsdOku(uint256 seed, uint256 amount) external useActor(seed) {
        uint256 bal = usdOku.balanceOf(currentActor);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        try usdOku.transfer(actors[0], amount) {} catch {}
    }

    // ============ Operator actions ============

    function setOkuMRate(uint256 aprBps, uint256 duration) external {
        aprBps = _bound(aprBps, 0, Constants.MAX_IMPLIED_APR_BPS);
        duration = _bound(duration, 1 hours, Constants.MAX_RATE_DURATION);

        uint256 base = okuM.uiMultiplier();
        uint256 rate = Constants.PRECISION + (Constants.PRECISION * aprBps / Constants.BASIS_POINTS)
            / Constants.SECONDS_PER_YEAR;

        vm.prank(gatekeeper);
        psm.closeWindow();
        vm.prank(rateSetter);
        try okuM.setOkuMRate(
            base, rate, uint64(block.timestamp), uint64(block.timestamp + duration), 0
        ) {}
            catch {}
        vm.prank(gatekeeper);
        psm.openWindow();
    }

    function setUsdOkuRate(uint256 aprBps, uint256 duration) external {
        aprBps = _bound(aprBps, 0, Constants.MAX_IMPLIED_APR_BPS);
        duration = _bound(duration, 1 hours, Constants.MAX_RATE_DURATION);

        uint256 base = usdOku.usdOkuIndex();
        uint256 rate = Constants.PRECISION + (Constants.PRECISION * aprBps / Constants.BASIS_POINTS)
            / Constants.SECONDS_PER_YEAR;

        vm.prank(rateSetter);
        try usdOku.setUsdOkuRate(
            base, rate, uint64(block.timestamp), uint64(block.timestamp + duration)
        ) {}
            catch {}
    }

    function toggleWindow(uint256 seed) external {
        vm.prank(gatekeeper);
        if (seed % 2 == 0) psm.closeWindow();
        else psm.openWindow();
    }

    function fundVault(uint256 amount) external {
        amount = _bound(amount, 1e6, 50_000e6);
        address funder = makeAddr("h_funder");
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(psm), amount);
        try psm.mintOkuM(amount, 0) returns (uint256 raw) {
            IERC20(address(okuM)).approve(address(usdOku), raw);
            usdOku.depositReserves(raw);
        } catch {}
        vm.stopPrank();
    }

    function fundBuffer(uint256 amount) external {
        amount = _bound(amount, 1e6, 50_000e6);
        address funder = makeAddr("h_bufferFunder");
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(psm), amount);
        psm.depositBuffer(amount);
        vm.stopPrank();
    }

    // ============ Adversarial ============

    /// @dev Donate OkuM straight into the vault, bypassing every sanctioned path.
    ///      Any invariant that assumes balances only move through wrap/unwrap breaks
    ///      here.
    function donateToVault(uint256 seed, uint256 amount) external useActor(seed) {
        uint256 bal = okuM.balanceOf(currentActor);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        IERC20(address(okuM)).transfer(address(usdOku), amount);
    }

    function donateToPsm(uint256 amount) external {
        amount = _bound(amount, 1, 10_000e6);
        usdc.mint(address(psm), amount);
    }

    /// @dev Irregular jumps, including past `rateEnd` where accrual must flatline.
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + _bound(secs, 1, 45 days));
    }
}
