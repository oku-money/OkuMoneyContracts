// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {OkuM} from "../src/token/OkuM.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {USDOkuWrapper} from "../src/wrapper/USDOkuWrapper.sol";
import {SubscriptionModule} from "../src/psm/SubscriptionModule.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {Constants} from "../src/lib/Constants.sol";
import {MathLib} from "../src/lib/MathLib.sol";
import {Roles} from "../src/lib/Roles.sol";

import {Actors} from "./shared/Actors.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title BaseTest
 * @notice Deploys the five-proxy stack and wires every role. Base for all suites.
 * @dev Deployment order is forced by the cross-assertions and post-deploy
 *      wiring:
 *
 *        1. OkuM — owns `asset()` / `usdcDecimalMultiplier()`, the single
 *           source of truth the module and queue assert against.
 *        2. RedemptionQueue, 3. SubscriptionModule — cross-assert against OkuM.
 *        4. USDOku, 5. USDOkuWrapper — the wrapper asserts nothing at init but
 *           must exist before `USDOku.setSolvencySource` and the mint/burn
 *           grants.
 *
 *      Post-deploy wiring mirrors the production deploy script:
 *        - `QUEUE_PSM` -> module proxy (never in `initialize`)
 *        - OkuM `OKU_MINTER`/`OKU_BURNER` -> module; `OKU_BURNER` -> queue
 *        - USDOku `OKU_MINTER`/`OKU_BURNER` -> wrapper
 *        - `OkuM.setStepFeeSource(module)` — step coverage fail-closed until this
 *        - `USDOku.setSolvencySource(wrapper)`
 */
abstract contract BaseTest is Actors {
    // ============ Rate constants (M_usd, USDOku) ============

    /// @notice ~5% APY per-second rate. This is the live rate that was running on
    ///         Sepolia when the May-2026 redemption incident surfaced; retained as
    ///         the default fixture rate so regression suites exercise the exact
    ///         index trajectory that exposed it.
    uint256 internal constant RATE_5_PCT_APY = 1_000_000_001_546_176_000;
    /// @notice ~2% APY per-second rate.
    uint256 internal constant RATE_2_PCT_APY = 1_000_000_000_634_000_000;
    /// @notice ~10% APY per-second rate — at/near the `MAX_IMPLIED_APR` ceiling.
    uint256 internal constant RATE_10_PCT_APY = 1_000_000_003_022_265_980;

    uint256 internal constant INITIAL_MAX_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MINTER_ALLOWANCE = 1_000_000_000e18;

    // ============ Deployed system ============

    OkuM internal token;
    USDOku internal usdOku;
    USDOkuWrapper internal wrapper;
    SubscriptionModule internal module;
    RedemptionQueue internal queue;
    MockUSDC internal usdc;

    function setUp() public virtual {
        _initOrchestrator();

        usdc = new MockUSDC();

        // 1. OkuM first — the module and queue cross-assert against it.
        OkuM tokenImpl = new OkuM();
        token = OkuM(
            address(
                new ERC1967Proxy(
                    address(tokenImpl),
                    abi.encodeCall(
                        OkuM.initialize,
                        ("Oku Money", "OkuM", address(usdc), admin, INITIAL_MAX_SUPPLY)
                    )
                )
            )
        );

        // 2. Queue.
        RedemptionQueue queueImpl = new RedemptionQueue();
        queue = RedemptionQueue(
            address(
                new ERC1967Proxy(
                    address(queueImpl),
                    abi.encodeCall(
                        RedemptionQueue.initialize, (address(token), address(usdc), admin)
                    )
                )
            )
        );

        // 3. Module.
        SubscriptionModule moduleImpl = new SubscriptionModule();
        module = SubscriptionModule(
            address(
                new ERC1967Proxy(
                    address(moduleImpl),
                    abi.encodeCall(
                        SubscriptionModule.initialize,
                        (address(token), address(usdc), address(queue), admin)
                    )
                )
            )
        );

        // 4. USDOku.
        USDOku usdOkuImpl = new USDOku();
        usdOku = USDOku(
            address(
                new ERC1967Proxy(
                    address(usdOkuImpl),
                    abi.encodeCall(USDOku.initialize, ("USD Oku", "USDOku", admin))
                )
            )
        );

        // 5. Wrapper.
        USDOkuWrapper wrapperImpl = new USDOkuWrapper();
        wrapper = USDOkuWrapper(
            address(
                new ERC1967Proxy(
                    address(wrapperImpl),
                    abi.encodeCall(
                        USDOkuWrapper.initialize, (address(token), address(usdOku), admin)
                    )
                )
            )
        );

        _wireRoles();
    }

    function _wireRoles() internal {
        vm.startPrank(admin);

        // Contract grants: mint/burn never go to an EOA in production.
        token.grantRole(Roles.OKU_MINTER, address(module));
        token.grantRole(Roles.OKU_BURNER, address(module));
        token.grantRole(Roles.OKU_BURNER, address(queue));
        token.configureMinterAllowance(address(module), MINTER_ALLOWANCE);

        usdOku.grantRole(Roles.OKU_MINTER, address(wrapper));
        usdOku.grantRole(Roles.OKU_BURNER, address(wrapper));

        // Post-deploy grant, deliberately not in `initialize`.
        queue.grantRole(Roles.QUEUE_PSM, address(module));

        // Post-deploy wiring: step coverage and solvency both fail closed
        // until these two writes land.
        token.setStepFeeSource(address(module));
        usdOku.setSolvencySource(address(wrapper));

        // Named-actor grants so tests can prank the specific role.
        token.grantRole(Roles.OKU_PAUSER, pauser);
        token.grantRole(Roles.OKU_UNPAUSER, unpauser);
        token.grantRole(Roles.OKU_MINTER, minter);
        token.grantRole(Roles.OKU_BURNER, burner);
        token.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        token.grantRole(Roles.OKU_GUARDIAN, guardian);
        token.grantRole(Roles.OKU_BLACKLISTER, blacklister);
        token.grantRole(Roles.OKU_UNBLACKLISTER, unblacklister);
        token.grantRole(Roles.OKU_CAP_MANAGER, capManager);
        token.grantRole(Roles.OKU_ALLOWANCE_MANAGER, allowanceManager);
        token.configureMinterAllowance(minter, MINTER_ALLOWANCE);

        // Same OKU_* constants, granted per-contract on USDOku.
        usdOku.grantRole(Roles.OKU_PAUSER, pauser);
        usdOku.grantRole(Roles.OKU_UNPAUSER, unpauser);
        usdOku.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        usdOku.grantRole(Roles.OKU_GUARDIAN, guardian);
        usdOku.grantRole(Roles.OKU_BLACKLISTER, blacklister);
        usdOku.grantRole(Roles.OKU_UNBLACKLISTER, unblacklister);
        usdOku.grantRole(Roles.OKU_CAP_MANAGER, capManager);

        module.grantRole(Roles.PSM_PAUSER, psmPauser);
        module.grantRole(Roles.PSM_UNPAUSER, psmUnpauser);
        module.grantRole(Roles.PSM_QUEUE_PROCESSOR, queueProcessor);
        module.grantRole(Roles.PSM_BUFFER_DEPOSITOR, bufferDepositor);
        module.grantRole(Roles.PSM_BUFFER_WITHDRAWER, bufferWithdrawer);
        // Same cold actor as the token's cap manager: one key, two
        // correctly-scoped capabilities on two contracts.
        module.grantRole(Roles.PSM_FEE_MANAGER, capManager);

        queue.grantRole(Roles.QUEUE_RESCUER, queueRescuer);

        wrapper.grantRole(Roles.WRAPPER_ADMIN, wrapperAdmin);
        wrapper.grantRole(Roles.WRAPPER_PAUSER, wrapperPauser);
        wrapper.grantRole(Roles.WRAPPER_UNPAUSER, wrapperUnpauser);
        wrapper.grantRole(Roles.WRAPPER_RESERVE_MANAGER, wrapperReserveManager);

        // Post-deploy wiring for the one-tx USDOku convenience path — same
        // cold key as the token-side fail-closed wiring above.
        module.setUsdOkuWrapper(address(wrapper));

        vm.stopPrank();
    }

    // ============ Helpers ============

    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @dev Mint raw tokens directly via the `minter` actor, bypassing the module.
    function _mintRaw(address to, uint256 amount) internal {
        vm.prank(minter);
        token.mint(to, amount);
    }

    /// @dev Seed the module's USDC buffer.
    function _seedBuffer(uint256 usdcAmount) internal {
        usdc.mint(bufferDepositor, usdcAmount);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(module), usdcAmount);
        module.depositBuffer(usdcAmount);
        vm.stopPrank();
    }

    // ============ M_oku step helpers ============

    /// @dev Ensure `tin + tout` covers a step of `stepBps` (split as evenly as
    ///      `MAX_FEE_BPS` allows), via the fee manager.
    function _setFeesForStep(uint256 stepBps) internal {
        uint256 half = (stepBps + 1) / 2;
        uint256 tin_ = half > Constants.MAX_FEE_BPS ? Constants.MAX_FEE_BPS : half;
        uint256 tout_ = stepBps > tin_ ? stepBps - tin_ : tin_;
        if (tout_ > Constants.MAX_FEE_BPS) tout_ = Constants.MAX_FEE_BPS;
        vm.prank(capManager);
        module.setFees(tin_, tout_);
    }

    /// @dev Move `M_oku` to `newMultiplier`, covering fees first, then warp past
    ///      the post-step sync window so subsequent pricing ops do not revert.
    ///
    ///      Splits into as many `MAX_STEP_BPS` chunks as the move needs. A
    ///      fixture helper's job is "put the multiplier here"; the per-step bound
    ///      is a property of the authority, asserted deterministically in
    ///      `OkuMultiplierTest`, not something every suite should have to
    ///      arithmetic its way around.
    function _step(uint256 newMultiplier) internal {
        uint256 current = token.uiMultiplier();
        require(newMultiplier > current, "_step: not increasing");
        uint256 maxSingle = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
        if (newMultiplier > maxSingle) {
            _stepUpTo(newMultiplier);
            return;
        }
        _stepNoWarp(newMultiplier);
        _warpPastSyncWindow();
    }

    /// @dev Step without clearing the window — for sync-window tests.
    function _stepNoWarp(uint256 newMultiplier) internal {
        uint256 current = token.uiMultiplier();
        require(newMultiplier > current, "_step: not increasing");
        uint256 stepBps =
            ((newMultiplier - current) * Constants.BASIS_POINTS + current - 1) / current;
        uint256 combined = module.tin() + module.tout();
        if (combined < stepBps) _setFeesForStep(stepBps);
        vm.prank(rateSetter);
        token.setOkuMultiplier(newMultiplier);
    }

    /// @dev Step `M_oku` up by `bps` basis points of its current value.
    function _stepBy(uint256 bps) internal {
        uint256 current = token.uiMultiplier();
        _step(current + (current * bps) / Constants.BASIS_POINTS);
    }

    /// @dev Drive `M_oku` to at least `target` via repeated maximum steps.
    ///      ASSERTS on failure rather than giving up quietly, so no test passes
    ///      vacuously against a multiplier that never reached the value under
    ///      test. ~1% per step: 5x needs ~162 steps, `MAX_MULTIPLIER` ~1,390.
    function _stepToAtLeast(uint256 target) internal {
        uint256 iterations;
        while (token.uiMultiplier() < target) {
            require(iterations < 3000, "_stepToAtLeast: target unreachable");
            uint256 current = token.uiMultiplier();
            uint256 next = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
            if (next > target) next = target;
            if (next > Constants.MAX_MULTIPLIER) next = Constants.MAX_MULTIPLIER;
            _step(next);
            iterations++;
        }
    }

    /// @dev Step `M_oku` up to exactly `target`, in `MAX_STEP_BPS`-sized chunks.
    function _stepUpTo(uint256 target) internal {
        uint256 iterations;
        while (token.uiMultiplier() < target) {
            require(iterations < 3000, "_stepUpTo: target unreachable");
            uint256 current = token.uiMultiplier();
            uint256 next = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
            if (next > target) next = target;
            _step(next);
            iterations++;
        }
    }

    /// @dev COMPATIBILITY SHIM for suites written against continuous accrual.
    ///
    ///      Advances the clock by `seconds_` and marks `M_oku` to exactly the
    ///      value continuous accrual at `ratePerSecond` would have produced over
    ///      that horizon. The end state is identical; only the path differs —
    ///      which is the point, since `M_oku` is now a discrete mark rather than
    ///      a trajectory. Retained (rather than rewriting every call site as an
    ///      explicit step) precisely because these suites assert on the *value*
    ///      of the multiplier over a realistic horizon, and that assertion is
    ///      still exactly the one worth making.
    ///
    ///      Multi-step horizons interleave a `_warpPastSyncWindow` per chunk, so
    ///      elapsed time can exceed `seconds_` by `syncWindowDuration()` per
    ///      chunk. No suite depends on the exact end timestamp.
    function _accrue(uint256 ratePerSecond, uint256 seconds_) internal {
        uint256 duration =
            seconds_ > Constants.MAX_RATE_DURATION ? Constants.MAX_RATE_DURATION : seconds_;
        uint256 target = Math.mulDiv(
            token.uiMultiplier(),
            MathLib.rpow(ratePerSecond, duration, Constants.PRECISION),
            Constants.PRECISION
        );
        vm.warp(block.timestamp + duration);
        if (target > token.uiMultiplier()) _stepUpTo(target);
    }

    /// @dev Alias of `_stepToAtLeast`, kept for suites written against the
    ///      continuous-accrual helper of the same shape.
    function _accrueToAtLeast(uint256 target) internal {
        _stepToAtLeast(target);
    }

    /// @dev Return to a fee-free schedule after stepping. Because
    ///      `stepHighWaterMark` floors `setFees`, this requires the cold
    ///      `resetStepHighWaterMark` escape hatch first — exactly the production
    ///      path, exercised here deliberately.
    function _resetFees() internal {
        vm.startPrank(capManager);
        token.resetStepHighWaterMark();
        module.setFees(0, 0);
        vm.stopPrank();
    }

    /// @dev Advance time past the currently-armed sync window, if any.
    function _warpPastSyncWindow() internal {
        uint256 lockedUntil = token.syncLockedUntil();
        if (block.timestamp < lockedUntil) {
            vm.warp(lockedUntil);
        }
    }

    // ============ M_usd accrual helpers (USDOku) ============

    /// @dev Set a USDOku rate and warp forward, so `usdOkuIndex()` is strictly
    ///      above 1e18. Clamps the warp to `rateEnd` so accrual is not silently
    ///      truncated.
    function _accrueUsd(uint256 ratePerSecond, uint256 seconds_) internal {
        uint256 duration =
            seconds_ > Constants.MAX_RATE_DURATION ? Constants.MAX_RATE_DURATION : seconds_;
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(ratePerSecond, block.timestamp + duration);
        vm.warp(block.timestamp + duration);
    }

    // ============ Module / wrapper flows ============

    /// @dev Mint via the module: seeds USDC, approves, mints.
    function _psmMint(address user, uint256 usdcAmount) internal returns (uint256 rawOut) {
        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(module), usdcAmount);
        rawOut = module.mint(usdcAmount);
        vm.stopPrank();
    }

    /// @dev Wrap OkuM into USDOku via the wrapper.
    function _wrap(address user, uint256 okuMAmount) internal returns (uint256 usdOkuOut) {
        vm.startPrank(user);
        token.approve(address(wrapper), okuMAmount);
        usdOkuOut = wrapper.wrap(okuMAmount);
        vm.stopPrank();
    }

    /// @dev Unwrap USDOku back into OkuM via the wrapper.
    function _unwrap(address user, uint256 usdOkuAmount) internal returns (uint256 okuMOut) {
        vm.startPrank(user);
        usdOku.approve(address(wrapper), usdOkuAmount);
        okuMOut = wrapper.unwrap(usdOkuAmount);
        vm.stopPrank();
    }

    /// @dev Mint USDOku directly from USDC in one transaction via the module.
    function _mintUsdOku(address user, uint256 usdcAmount) internal returns (uint256 usdOkuOut) {
        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(module), usdcAmount);
        usdOkuOut = module.mintUsdOku(usdcAmount);
        vm.stopPrank();
    }

    /// @dev Redeem USDOku directly for USDC in one transaction via the module.
    function _redeemUsdOku(address user, uint256 usdOkuAmount) internal returns (uint256 usdcOut) {
        vm.startPrank(user);
        usdOku.approve(address(module), usdOkuAmount);
        usdcOut = module.redeemUsdOku(usdOkuAmount);
        vm.stopPrank();
    }

    /// @dev Fund the wrapper's OkuM buffer directly (issuer top-up shape).
    function _fundWrapperBacking(uint256 amount) internal {
        _mintRaw(treasury, amount);
        vm.prank(treasury);
        token.transfer(address(wrapper), amount);
    }
}
