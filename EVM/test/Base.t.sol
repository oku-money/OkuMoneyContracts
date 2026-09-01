// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OkuMoney} from "../src/token/OkuMoney.sol";
import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {TestConstants} from "./shared/Constants.sol";
import {TestRoles} from "./shared/Roles.sol";
import {Actors} from "./shared/Actors.sol";
import {Deploy} from "./shared/Deploy.sol";

/**
 * @title BaseTest
 * @notice Base test contract with deployment helpers, actors, and utility functions
 * @dev Updated for OkuMoney non-rebasing redesign. OkuMoney is a standard ERC-20 with
 *      okuMMultiplier() tracking the dollar value per token separately from balanceOf().
 *      See Constants.sol for terminology legend.
 *
 *      Uses shared scaffolding:
 *      - TestConstants: All numeric constants (re-exported from src + test-only)
 *      - TestRoles: All role keccaks (re-exported from src + DEFAULT_ADMIN_ROLE)
 *      - Actors: Named test actors with deterministic addresses
 *      - Deploy: Proxy deployment helpers
 */
abstract contract BaseTest is Test, Actors {
    // ============ Re-exported Constants ============

    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_SUPPLY = TestConstants.MAX_SUPPLY;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;
    uint256 public constant MAX_RATE = TestConstants.MAX_RATE;
    uint256 public constant BASIS_POINTS = TestConstants.BASIS_POINTS;

    // Yield-epoch bounds
    uint256 public constant MIN_EPOCH_DURATION = TestConstants.MIN_EPOCH_DURATION;
    uint256 public constant MAX_EPOCH_DURATION = TestConstants.MAX_EPOCH_DURATION;
    uint256 public constant MAX_IMPLIED_APR_BPS = TestConstants.MAX_IMPLIED_APR_BPS;
    uint256 public constant SECONDS_PER_YEAR = TestConstants.SECONDS_PER_YEAR;

    // ============ Re-exported Roles ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = TestRoles.DEFAULT_ADMIN_ROLE;

    // OkuMoney roles (OKUM_ prefix)
    bytes32 public constant OKUM_UPGRADER = TestRoles.OKUM_UPGRADER;
    bytes32 public constant OKUM_PAUSER = TestRoles.OKUM_PAUSER;
    bytes32 public constant OKUM_UNPAUSER = TestRoles.OKUM_UNPAUSER;
    bytes32 public constant OKUM_MINTER = TestRoles.OKUM_MINTER;
    /// @dev Cycle 4 (EVM-15): burn-only role.
    bytes32 public constant OKUM_BURNER = TestRoles.OKUM_BURNER;
    bytes32 public constant OKUM_REBASER = TestRoles.OKUM_REBASER;
    bytes32 public constant OKUM_BLACKLISTER = TestRoles.OKUM_BLACKLISTER;
    bytes32 public constant OKUM_UNBLACKLISTER = TestRoles.OKUM_UNBLACKLISTER;
    bytes32 public constant OKUM_CAP_MANAGER = TestRoles.OKUM_CAP_MANAGER;
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = TestRoles.OKUM_ALLOWANCE_MANAGER;

    // OkuDollar vault roles (VAULT_ prefix)
    bytes32 public constant VAULT_UPGRADER = TestRoles.VAULT_UPGRADER;
    bytes32 public constant VAULT_REBASER = TestRoles.VAULT_REBASER;
    bytes32 public constant VAULT_RESERVE_MANAGER = TestRoles.VAULT_RESERVE_MANAGER;
    bytes32 public constant VAULT_PAUSER = TestRoles.VAULT_PAUSER;
    bytes32 public constant VAULT_UNPAUSER = TestRoles.VAULT_UNPAUSER;
    bytes32 public constant VAULT_ADMIN = TestRoles.VAULT_ADMIN;

    // LitePSM roles (PSM_ prefix)
    bytes32 public constant PSM_UPGRADER = TestRoles.PSM_UPGRADER;
    bytes32 public constant PSM_PAUSER = TestRoles.PSM_PAUSER;
    bytes32 public constant PSM_UNPAUSER = TestRoles.PSM_UNPAUSER;
    bytes32 public constant PSM_BUFFER_DEPOSITOR = TestRoles.PSM_BUFFER_DEPOSITOR;
    bytes32 public constant PSM_BUFFER_WITHDRAWER = TestRoles.PSM_BUFFER_WITHDRAWER;

    // ============ Contracts ============

    OkuMoney public okuMoney;
    OkuMoney public okuMoneyImpl;
    OkuDollar public okuDollar;
    OkuDollar public okuDollarImpl;
    LitePSM public litePsm;
    LitePSM public litePsmImpl;
    MockUSDC public usdc;

    // ============ Setup ============

    function setUp() public virtual {
        _deployContracts();
        _setupRoles();
        _setupMinterAllowances();
    }

    function _deployContracts() internal {
        // Deploy mocks
        usdc = new MockUSDC();

        // Deploy OkuMoney
        (okuMoney, okuMoneyImpl) = Deploy.deployOkuMoney(admin);

        // Deploy OkuDollar vault
        (okuDollar, okuDollarImpl) = Deploy.deployOkuDollar(address(okuMoney), admin);

        // Deploy LitePSM
        (litePsm, litePsmImpl) =
            Deploy.deployLitePSM(address(okuMoney), address(okuDollar), address(usdc), admin);
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuMoney roles - Granular RBAC (OKUM_ prefix)
        // Cycle 4 (EVM-15): OKUM_BURNER split from OKUM_MINTER. Mint
        // and burn now require explicit grants; tests grant both
        // together because every minter in this setup is also a burner.
        okuMoney.grantRole(OKUM_PAUSER, pauser);
        okuMoney.grantRole(OKUM_UNPAUSER, unpauser);
        okuMoney.grantRole(OKUM_MINTER, minter);
        okuMoney.grantRole(OKUM_BURNER, minter);
        okuMoney.grantRole(OKUM_MINTER, address(litePsm)); // PSM can mint
        okuMoney.grantRole(OKUM_BURNER, address(litePsm)); // PSM can burn
        okuMoney.grantRole(OKUM_REBASER, rebaser);
        okuMoney.grantRole(OKUM_BLACKLISTER, blacklister);
        okuMoney.grantRole(OKUM_UNBLACKLISTER, unblacklister);
        okuMoney.grantRole(OKUM_CAP_MANAGER, capManager);
        okuMoney.grantRole(OKUM_ALLOWANCE_MANAGER, allowanceManager);

        // OkuDollar vault roles (VAULT_ prefix)
        okuDollar.grantRole(VAULT_REBASER, usdRebaser);
        okuDollar.grantRole(VAULT_RESERVE_MANAGER, reserveManager);
        okuDollar.grantRole(VAULT_PAUSER, vaultPauser);
        okuDollar.grantRole(VAULT_UNPAUSER, vaultUnpauser);
        // OkuDollar blacklist (shared OKUM_ roles — one grant covers both tokens)
        okuDollar.grantRole(OKUM_BLACKLISTER, blacklister);
        okuDollar.grantRole(OKUM_UNBLACKLISTER, unblacklister);

        // LitePSM roles - Granular RBAC (PSM_ prefix)
        litePsm.grantRole(PSM_PAUSER, pauser);
        litePsm.grantRole(PSM_UNPAUSER, unpauser);
        litePsm.grantRole(PSM_BUFFER_DEPOSITOR, bufferDepositor);
        litePsm.grantRole(PSM_BUFFER_WITHDRAWER, bufferWithdrawer);

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        // allowanceManager has OKUM_ALLOWANCE_MANAGER role on OkuMoney
        vm.startPrank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(litePsm), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuMoney tokens to a user (raw token amount, no share conversion)
    function _mintOkuMoney(address to, uint256 amount) internal {
        vm.prank(minter);
        okuMoney.mint(to, amount);
    }

    /// @notice Mint OkuDollar tokens to a user via wrap flow (multiplier-aware)
    function _mintUsdOku(address to, uint256 okuMAmount) internal {
        // Mint OkuMoney to the to address first
        _mintOkuMoney(to, okuMAmount);
        // Approve vault to pull OkuMoney
        vm.startPrank(to);
        IERC20(address(okuMoney)).approve(address(okuDollar), okuMAmount);
        // Wrap OkuMoney into OkuDollar (0 minAmountOut for test helpers)
        okuDollar.wrap(okuMAmount, to, 0);
        vm.stopPrank();
    }

    /// @notice Mint USDC tokens to a user
    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuMoney spending
    function _approveOkuMoney(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuMoney.approve(spender, amount);
    }

    /// @notice Approve OkuDollar spending
    function _approveOkuDollar(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuDollar.approve(spender, amount);
    }

    /// @notice Approve USDC spending
    function _approveUsdc(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdc.approve(spender, amount);
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuMoney.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier (strictly above current, up to 2x).
    /// @dev Tightened from 10x to 2x for more realistic scenarios.
    ///      `setOkuMMultiplier` requires strict increase, so the lower bound is
    ///      `current + 1`. Tests that need the no-op semantics should call the
    ///      contract directly and assert the revert.
    /// @dev Lower bound is `current + MIN_EPOCH_DURATION`, not `current + 1`. The
    ///      multiplier now advances only through epochs, and the smallest legal epoch
    ///      runs for `MIN_EPOCH_DURATION` seconds at >= 1 wei/second — so the smallest
    ///      reachable increment is `MIN_EPOCH_DURATION` wei. Targets nearer than that
    ///      are unreachable by construction, not a test-harness limitation.
    function _boundOkuMMultiplier(uint256 mult) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        return
            bound(mult, current + MIN_EPOCH_DURATION, current * TestConstants.MAX_MULTIPLIER_FACTOR);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier increase (0.01% to 100%)
    /// @dev Floor raised to `MIN_EPOCH_DURATION` for the reason described on
    ///      {_boundOkuMMultiplier}.
    function _boundOkuMMultiplierIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        uint256 floor_ = current / 10_000;
        if (floor_ < MIN_EPOCH_DURATION) floor_ = MIN_EPOCH_DURATION;
        return bound(increase, floor_, current);
    }

    /// @notice Bound price to realistic fuzz range (capped at MAX_FUZZ_PRICE)
    function _boundPrice(uint256 price) internal pure returns (uint256) {
        return bound(price, PRECISION, TestConstants.MAX_FUZZ_PRICE);
    }

    /// @notice Get minimum of two values
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Get maximum of two values
    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ============ Yield Epoch Helpers ============
    //
    // `okuMMultiplier` accrues continuously over an epoch and can no longer be written
    // directly. These helpers drive it through the only production path —
    // `startYieldEpoch` plus the passage of time — so tests exercise real mechanics
    // rather than a synthetic setter.
    //
    // GOTCHA: `vm.prank` is consumed by the next call, INCLUDING calls made while
    // evaluating arguments. This silently steals the prank:
    //
    //     vm.prank(rebaser);
    //     okuMoney.startYieldEpoch(amt, _minLegalDuration(amt));   // WRONG
    //
    // `_minLegalDuration` reads state, consumes the prank, and `startYieldEpoch` then
    // reverts with AccessControlUnauthorizedAccount. Hoist the call instead:
    //
    //     uint256 d = _minLegalDuration(amt);
    //     vm.prank(rebaser);
    //     okuMoney.startYieldEpoch(amt, d);                        // RIGHT

    /// @notice Drive the multiplier to `newMultiplier` and roll one block.
    /// @dev Retains the historical name and block-roll so existing call sites keep
    ///      working. The block roll is now cosmetic — the same-block yield fence it
    ///      was written for is gone, because continuous accrual has no instant to
    ///      sandwich.
    function _setOkuMMultiplierAndRoll(uint256 newMultiplier) internal {
        _runYieldEpochTo(newMultiplier, TestConstants.MIN_EPOCH_DURATION);
        vm.roll(block.number + 1);
    }

    /// @notice Drive `okuMMultiplier()` to exactly `target`, running as many epochs as
    ///         the APR cap requires.
    /// @dev `MAX_IMPLIED_APR_BPS` bounds a single epoch to a 20% gain, so large targets
    ///      (a doubling, say) are unreachable in one epoch and need several — four, for
    ///      2x. This walks the multiplier up through legitimate epochs rather than
    ///      writing it directly, which no longer exists as an operation.
    ///
    ///      Exactness comes from choosing `duration` so the contract's two floor
    ///      divisions are lossless. When the outstanding delta fits inside
    ///      `[MIN_EPOCH_DURATION, MAX_EPOCH_DURATION]` we set `duration == delta` and
    ///      `ratePerSecond == 1`, which lands on the target precisely.
    ///
    ///      Time advances by the sum of the epoch durations; tests asserting on
    ///      `block.timestamp` should account for that.
    function _runYieldEpochTo(uint256 target, uint256) internal {
        uint256 current = okuMoney.okuMMultiplier();
        require(target > current, "target must exceed current multiplier");

        // An epoch derives its per-token increment from `totalSupply`, so it needs a
        // non-zero supply. Many tests move the multiplier before minting anything;
        // seed a dust holder so those keep working. The amount is immaterial to the
        // multiplier trajectory — it only has to be non-zero.
        if (okuMoney.totalSupply() == 0) {
            _mintOkuMoney(epochSeedHolder, 1e18);
        }

        // Each iteration either lands exactly on the target or strictly reduces the
        // gap; the bound is a guard against a pathological input, not a real limit.
        for (uint256 i = 0; i < 64; i++) {
            current = okuMoney.okuMMultiplier();
            if (current == target) return;

            uint256 delta = target - current;

            // Largest delta a single epoch may deliver without breaching the APR cap
            // (evaluated at the longest permitted duration, where the cap binds).
            uint256 maxDelta = (current * MAX_IMPLIED_APR_BPS * MAX_EPOCH_DURATION)
                / (BASIS_POINTS * SECONDS_PER_YEAR);
            if (delta > maxDelta) delta = maxDelta;

            uint256 duration;
            uint256 ratePerSecond;
            if (delta >= MIN_EPOCH_DURATION && delta <= MAX_EPOCH_DURATION) {
                // Exact fit: one wei of multiplier per second for `delta` seconds.
                duration = delta;
                ratePerSecond = 1;
            } else if (delta > MAX_EPOCH_DURATION) {
                duration = MAX_EPOCH_DURATION;
                ratePerSecond = delta / duration;
            } else {
                // delta < MIN_EPOCH_DURATION: unreachable exactly, because the shortest
                // legal epoch delivers at least MIN_EPOCH_DURATION wei. Deliver that
                // minimum and stop — the achieved value is within MIN_EPOCH_DURATION
                // wei (~3.6e-15 of $1) of the requested target.
                duration = MIN_EPOCH_DURATION;
                ratePerSecond = 1;
                uint256 supplyMin = okuMoney.totalSupply();
                uint256 dollarsMin = (duration * supplyMin + PRECISION - 1) / PRECISION;
                vm.prank(rebaser);
                okuMoney.startYieldEpoch(dollarsMin, duration);
                vm.warp(block.timestamp + duration);
                return;
            }

            uint256 achieved = ratePerSecond * duration;
            uint256 supply = okuMoney.totalSupply();
            // Ceil so the contract's floor recovers `achieved` exactly.
            uint256 dollars = (achieved * supply + PRECISION - 1) / PRECISION;

            vm.prank(rebaser);
            okuMoney.startYieldEpoch(dollars, duration);
            vm.warp(block.timestamp + duration);
        }

        require(okuMoney.okuMMultiplier() == target, "epoch walk did not reach target");
    }

    /// @notice Distribute `yieldAmount` over `duration`, warping to the epoch's end.
    function _distributeYieldOverEpoch(uint256 yieldAmount, uint256 duration) internal {
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(yieldAmount, duration);
        vm.warp(block.timestamp + duration);
    }

    /// @notice Distribute `yieldAmount` over the shortest duration the APR cap allows.
    /// @dev Callers that care about the dollar amount rather than the schedule should
    ///      use this: it derives a legal duration instead of forcing the caller to.
    ///      A larger amount simply streams over a proportionally longer window.
    function _distributeYield(uint256 yieldAmount) internal {
        _distributeYieldOverEpoch(yieldAmount, _minLegalDuration(yieldAmount));
    }

    /// @notice Shortest duration over which `yieldAmount` satisfies `MAX_IMPLIED_APR_BPS`.
    /// @dev Inverts the APR check: duration >= (delta / current) * YEAR * BPS / CAP.
    ///      Adds a small margin so the contract's own flooring cannot land a wei above
    ///      the cap.
    function _minLegalDuration(uint256 yieldAmount) internal view returns (uint256) {
        uint256 supply = okuMoney.totalSupply();
        if (supply == 0) return MIN_EPOCH_DURATION;
        uint256 current = okuMoney.okuMMultiplier();
        uint256 delta = (yieldAmount * PRECISION) / supply;
        uint256 needed =
            (delta * SECONDS_PER_YEAR * BASIS_POINTS) / (current * MAX_IMPLIED_APR_BPS) + 2;
        if (needed < MIN_EPOCH_DURATION) return MIN_EPOCH_DURATION;
        require(needed <= MAX_EPOCH_DURATION, "yieldAmount too large for any legal epoch");
        return needed;
    }

    /// @notice Largest dollar amount distributable over `duration` without breaching
    ///         `MAX_IMPLIED_APR_BPS`, at the current supply and multiplier.
    /// @dev Lets fuzz tests pick valid amounts without duplicating the APR arithmetic.
    function _maxYieldForDuration(uint256 duration) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        uint256 supply = okuMoney.totalSupply();
        if (supply == 0) return 0;
        uint256 maxDelta = (current * TestConstants.MAX_IMPLIED_APR_BPS * duration)
            / (BASIS_POINTS * TestConstants.SECONDS_PER_YEAR);
        return (maxDelta * supply) / PRECISION;
    }

    /// @notice Elevate OkuDollar's `usdMultiplier()` to (approximately) `targetMultiplier`.
    /// @dev Drives the multiplier via `setUsdYieldRate` + `vm.warp` rather than a direct
    ///      override; this mirrors the only production path for moving the multiplier.
    ///      The achieved value is the smallest multiplier >= target reachable by warping
    ///      forward at MAX_RATE.
    function _elevateUsdMultiplier(uint256 targetMultiplier) internal {
        require(targetMultiplier >= PRECISION, "target below floor");
        uint256 current = okuDollar.usdMultiplier();
        if (targetMultiplier <= current) return;

        // Set the active rate to MAX_RATE with no end timestamp (open-ended) so the
        // multiplier compounds continuously. Then warp forward enough seconds to clear
        // the target. We loop in case rounding leaves us short on the first warp.
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(MAX_RATE, 0);

        uint256 elapsed = 1;
        while (okuDollar.usdMultiplier() < targetMultiplier) {
            vm.warp(block.timestamp + elapsed);
            elapsed *= 2;
            // Safety: bound the loop in case targetMultiplier is unreachable.
            require(elapsed < 365 days * 4, "target unreachable");
        }

        // Snapshot the achieved multiplier and stop accrual so subsequent reads stay stable.
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION, 0);
    }
}
