// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title OkuDollarHandler
 * @notice Stateful handler for OkuDollar invariant testing — exercises wrap, unwrap,
 *         transfer, discrete rebase, and the (single) yield-rate schedule.
 *
 *         The handler must be granted OKUM_REBASER on the OkuMoney instance so it can
 *         drive the shared multiplier — see VaultInvariants.setUp.
 *
 * @dev REMOVED (single-multiplier refactor): depositReserves / withdrawSurplus actions
 *      (collateralization is 1.0 by construction, so there is no surplus and nothing to
 *      top up), setMinCollateralRatio (no min-ratio config exists), and
 *      setUsdYieldRate / setNextUsdYieldRate (OkuDollar has no rate of its own; the
 *      equivalents now live on OkuMoney as setOkuMYieldRate / setNextOkuMYieldRate).
 */
contract OkuDollarHandler is Test {
    OkuMoney public okuMoney;
    OkuDollar public okuDollar;
    address public minter;
    address public rebaser;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant MAX_SUPPLY = TestConstants.MAX_SUPPLY;
    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_FUZZ_PRICE = TestConstants.MAX_FUZZ_PRICE;

    // Ghost variables
    uint256 public ghostTotalWrapped;
    uint256 public ghostTotalUnwrapped;

    // Call/revert counters
    uint256 public ghostMintOkuMCalls;
    uint256 public ghostMintOkuMReverts;
    uint256 public ghostWrapCalls;
    uint256 public ghostWrapReverts;
    uint256 public ghostUnwrapCalls;
    uint256 public ghostUnwrapReverts;
    uint256 public ghostRebaseCalls;
    uint256 public ghostRebaseReverts;
    uint256 public ghostTransferCalls;
    uint256 public ghostTransferReverts;
    uint256 public ghostSetYieldRateCalls;
    uint256 public ghostSetYieldRateReverts;
    uint256 public ghostSetNextYieldRateCalls;
    uint256 public ghostSetNextYieldRateReverts;

    constructor(OkuMoney _okuMoney, OkuDollar _okuDollar, address _minter, address _rebaser) {
        okuMoney = _okuMoney;
        okuDollar = _okuDollar;
        minter = _minter;
        rebaser = _rebaser;

        _addActor(makeAddr("vaultActor1"));
        _addActor(makeAddr("vaultActor2"));
        _addActor(makeAddr("vaultActor3"));
    }

    function _addActor(address actor) internal {
        if (!isActor[actor]) {
            actors.push(actor);
            isActor[actor] = true;
        }
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    // ============ User Operations ============

    function mintOkuM(uint256 actorSeed, uint256 amount) external {
        ghostMintOkuMCalls++;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuMoney.minterAllowance(minter);
        uint256 remaining = okuMoney.maxSupply() - okuMoney.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));
        if (amount == 0) return;

        vm.prank(minter);
        try okuMoney.mint(actor, amount) {}
        catch {
            ghostMintOkuMReverts++;
        }
    }

    function wrap(uint256 actorSeed, uint256 amount) external {
        ghostWrapCalls++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuMoney.balanceOf(actor);
        amount = bound(amount, 0, balance);
        if (amount == 0) return;

        vm.startPrank(actor);
        IERC20(address(okuMoney)).approve(address(okuDollar), amount);
        try okuDollar.wrap(amount, actor, 0) {
            ghostTotalWrapped += amount;
        } catch {
            ghostWrapReverts++;
        }
        vm.stopPrank();
    }

    function unwrap(uint256 actorSeed, uint256 amount) external {
        ghostUnwrapCalls++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuDollar.balanceOf(actor);
        amount = bound(amount, 0, balance);
        if (amount == 0) return;

        vm.prank(actor);
        try okuDollar.unwrap(amount, actor) returns (uint256 okuMReturned) {
            ghostTotalUnwrapped += okuMReturned;
        } catch {
            ghostUnwrapReverts++;
        }
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghostTransferCalls++;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = okuDollar.balanceOf(from);
        amount = bound(amount, 0, balance);
        if (amount == 0 || from == to) return;

        vm.prank(from);
        try okuDollar.transfer(to, amount) {}
        catch {
            ghostTransferReverts++;
        }
    }

    /// @notice OkuMoney multiplier rebase. Per-call cap raised to 10% to stress
    ///         truncation/dust branches at non-trivial multipliers.
    function rebase(uint256 priceIncrease) external {
        ghostRebaseCalls++;
        uint256 currentPrice = okuMoney.okuMMultiplier();
        if (currentPrice >= MAX_FUZZ_PRICE) return;

        uint256 minIncrease = currentPrice / 10_000;
        uint256 maxIncrease = currentPrice / 10; // 10% per call (raised from 2%)
        uint256 increase = bound(priceIncrease, minIncrease, maxIncrease);
        uint256 newPrice = currentPrice + increase;
        if (newPrice > MAX_FUZZ_PRICE) newPrice = MAX_FUZZ_PRICE;

        vm.prank(rebaser);
        try okuMoney.setOkuMMultiplier(newPrice) {
            vm.roll(block.number + 1);
        } catch {
            ghostRebaseReverts++;
        }
    }

    // REMOVED (single-multiplier refactor): depositReserves / withdrawSurplus /
    // setMinCollateralRatio handler actions. Under the single-multiplier design the
    // vault holds exactly the OkuM backing its shares (1:1), so there is no surplus
    // to withdraw, no reserve top-up to perform, and no min-ratio to configure.
    // Donations are handled by `rescueDonation` (see VAULT_RESCUER), which is a
    // one-shot admin escape hatch rather than an interesting fuzz action.

    // ============ Yield-rate management ============
    // The rate lives on OkuMoney now — OkuDollar's `usdMultiplier()` just reads it.

    function setOkuMYieldRate(uint256 rate, uint256 endOffset) external {
        ghostSetYieldRateCalls++;
        // Stay above PRECISION (no negative yield) and below MAX_RATE.
        rate = bound(rate, PRECISION, TestConstants.MAX_RATE);
        endOffset = bound(endOffset, 1 hours, 365 days);
        // A halted rate (== PRECISION) requires endTimestamp == 0; any yielding
        // rate requires a bounded future window — see setOkuMYieldRate's NatSpec.
        uint256 endTimestamp = rate == PRECISION ? 0 : block.timestamp + endOffset;

        vm.prank(rebaser);
        try okuMoney.setOkuMYieldRate(rate, endTimestamp) {}
        catch {
            ghostSetYieldRateReverts++;
        }
    }

    function setNextOkuMYieldRate(uint256 rate, uint256 pendingEndOffset) external {
        ghostSetNextYieldRateCalls++;
        rate = bound(rate, PRECISION, TestConstants.MAX_RATE);
        pendingEndOffset = bound(pendingEndOffset, 1 hours, 365 days);

        // Pre-check: contract requires okuMRateEnd != 0 AND not yet expired.
        uint256 endTs = okuMoney.okuMRateEnd();
        if (endTs == 0 || block.timestamp >= endTs) return;

        vm.prank(rebaser);
        try okuMoney.setNextOkuMYieldRate(rate, endTs + pendingEndOffset) {}
        catch {
            ghostSetNextYieldRateReverts++;
        }
    }

    // ============ Time Progression ============
    //
    // Without time advancement, the multiplier stays at PRECISION no matter what
    // rate is set, because `rpow(rate, 0, PRECISION) == PRECISION`. This masked the
    // LitePSM `_redeemUsdOku` rounding-asymmetry bug from all invariant runs.
    // Advancing the clock here lets the multiplier actually compound, exercising the
    // full state space the production contracts experience.
    //
    // No reserve rebalancing is needed any more: under the single multiplier, shares
    // track raw OkuM 1:1, so accrual moves reserves and obligations in lockstep and
    // the vault can never drift out of backing.

    uint256 public ghostWarpCalls;
    uint256 public ghostTotalElapsed;

    function warpTime(uint256 elapsed) external {
        ghostWarpCalls++;
        elapsed = bound(elapsed, 1, 30 days);
        ghostTotalElapsed += elapsed;
        vm.warp(block.timestamp + elapsed);
        // Roll a block too so any same-block guards (e.g. yield-sandwich) stay clean.
        vm.roll(block.number + 1);
    }

    // ============ Aggregates ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function ghostTotalCalls() external view returns (uint256) {
        return ghostMintOkuMCalls + ghostWrapCalls + ghostUnwrapCalls + ghostRebaseCalls
            + ghostTransferCalls + ghostSetYieldRateCalls + ghostSetNextYieldRateCalls
            + ghostWarpCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMReverts + ghostWrapReverts + ghostUnwrapReverts + ghostRebaseReverts
            + ghostTransferReverts + ghostSetYieldRateReverts + ghostSetNextYieldRateReverts;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Wrap-call counter retained for backward-compat with VaultInvariants.
    function ghostWrapCallCount() external view returns (uint256) {
        return ghostWrapCalls;
    }
}
