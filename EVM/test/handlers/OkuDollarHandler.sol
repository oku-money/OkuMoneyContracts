// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title OkuDollarHandler
 * @notice Stateful handler for OkuDollar invariant testing — exercises wrap, unwrap,
 *         transfer, rebase (OkuMoney multiplier), depositReserves, withdrawSurplus,
 *         setUsdYieldRate, setNextUsdYieldRate, setMinCollateralRatio.
 *
 *         The handler must be granted VAULT_REBASER, VAULT_RESERVE_MANAGER and
 *         DEFAULT_ADMIN_ROLE on the OkuDollar instance — see VaultInvariants.setUp.
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
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = 9e17; // matches OkuDollar contract

    // Ghost variables
    uint256 public ghostTotalWrapped;
    uint256 public ghostTotalUnwrapped;
    uint256 public ghostTotalDepositedReserves;
    uint256 public ghostTotalWithdrawnSurplus;

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
    uint256 public ghostDepositReservesCalls;
    uint256 public ghostDepositReservesReverts;
    uint256 public ghostWithdrawSurplusCalls;
    uint256 public ghostWithdrawSurplusReverts;
    uint256 public ghostSetYieldRateCalls;
    uint256 public ghostSetYieldRateReverts;
    uint256 public ghostSetNextYieldRateCalls;
    uint256 public ghostSetNextYieldRateReverts;
    uint256 public ghostSetMinCollatRatioCalls;
    uint256 public ghostSetMinCollatRatioReverts;

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

    // ============ Reserve Management ============

    function depositReserves(uint256 amount) external {
        ghostDepositReservesCalls++;
        amount = bound(amount, 1e18, 1_000_000e18);

        // Bail out cleanly if minting would exceed allowance/cap.
        uint256 allowance = okuMoney.minterAllowance(minter);
        uint256 remaining = okuMoney.maxSupply() - okuMoney.totalSupply();
        if (amount > allowance || amount > remaining) return;

        vm.prank(minter);
        okuMoney.mint(address(this), amount);
        IERC20(address(okuMoney)).approve(address(okuDollar), amount);

        try okuDollar.depositReserves(amount) {
            ghostTotalDepositedReserves += amount;
        } catch {
            ghostDepositReservesReverts++;
        }
    }

    function withdrawSurplus(uint256 amount) external {
        ghostWithdrawSurplusCalls++;
        uint256 surplusVal = okuDollar.surplus();
        if (surplusVal == 0) return;
        // Use a conservative cap that avoids the floor-rounding revert path.
        uint256 cap = surplusVal > 1e6 ? surplusVal - 1e6 : surplusVal / 2;
        if (cap == 0) return;
        amount = bound(amount, 1, cap);

        try okuDollar.withdrawSurplus(amount) {
            ghostTotalWithdrawnSurplus += amount;
        } catch {
            ghostWithdrawSurplusReverts++;
        }
    }

    // ============ Yield-rate management ============

    function setUsdYieldRate(uint256 rate, uint256 endOffset) external {
        ghostSetYieldRateCalls++;
        // Stay above PRECISION (no negative yield) and below MAX_RATE.
        rate = bound(rate, PRECISION, TestConstants.MAX_RATE);
        endOffset = bound(endOffset, 1 hours, 365 days);

        try okuDollar.setUsdYieldRate(rate, block.timestamp + endOffset) {}
        catch {
            ghostSetYieldRateReverts++;
        }
    }

    function setNextUsdYieldRate(uint256 rate) external {
        ghostSetNextYieldRateCalls++;
        rate = bound(rate, PRECISION, TestConstants.MAX_RATE);

        // Pre-check: contract requires usdRateEnd != 0 AND not yet expired.
        uint256 endTs = okuDollar.usdRateEnd();
        if (endTs == 0 || block.timestamp >= endTs) return;

        try okuDollar.setNextUsdYieldRate(rate) {}
        catch {
            ghostSetNextYieldRateReverts++;
        }
    }

    function setMinCollateralRatio(uint256 newRatio) external {
        ghostSetMinCollatRatioCalls++;
        // Bound between the contract's hard floor and PRECISION.
        newRatio = bound(newRatio, MIN_COLLATERAL_RATIO_FLOOR, PRECISION);

        try okuDollar.setMinCollateralRatio(newRatio) {}
        catch {
            ghostSetMinCollatRatioReverts++;
        }
    }

    // ============ Time Progression ============
    //
    // Without time advancement, `usdMultiplier()` stays at PRECISION no matter what
    // rate is set, because `rpow(rate, 0, PRECISION) == PRECISION`. This masked the
    // LitePSM `_redeemUsdOku` rounding-asymmetry bug from all invariant runs.
    // Advancing the clock here lets the multiplier actually compound, exercising the
    // full state space the production contracts experience.
    //
    // After each warp we auto-rebalance reserves to model the operational contract:
    // the orchestrator must keep reserves topped up to match accrued obligations
    // when `usdRatePerSecond > PRECISION`. This isolates the rounding-asymmetry
    // and share-conversion invariants from the orthogonal collateral-drift
    // failure mode (which is its own operational concern, not a code bug).

    uint256 public ghostWarpCalls;
    uint256 public ghostTotalElapsed;

    function warpTime(uint256 elapsed) external {
        ghostWarpCalls++;
        elapsed = bound(elapsed, 1, 30 days);
        ghostTotalElapsed += elapsed;
        vm.warp(block.timestamp + elapsed);
        // Roll a block too so any same-block guards (e.g. yield-sandwich) stay clean.
        vm.roll(block.number + 1);
        // Rebalance reserves to keep `invariant_VaultBacked` meaningful under a
        // live yield rate. This mirrors the operational pattern: a topped-up vault.
        _rebalanceReservesIfNeeded();
    }

    /// @notice If obligations exceed reserves (after a multiplier-compounding warp),
    ///         mint and deposit just enough OkuMoney to fully back the vault.
    function _rebalanceReservesIfNeeded() internal {
        uint256 obligationsUsd = okuDollar.totalSupply();
        uint256 okuMMult = okuMoney.okuMMultiplier();
        if (okuMMult == 0) return;
        // Required OkuM = ceil(obligations / okuMMult)
        uint256 required = Math.mulDiv(obligationsUsd, PRECISION, okuMMult, Math.Rounding.Ceil);
        uint256 currentReserves = okuMoney.balanceOf(address(okuDollar));
        if (currentReserves >= required) return;
        uint256 deficit = required - currentReserves;
        // Add a tiny safety buffer (10 wei) for downstream rounding.
        uint256 topUp = deficit + 10;
        // Respect MaxSupply ceiling.
        uint256 mintable = okuMoney.maxSupply() - okuMoney.totalSupply();
        if (topUp > mintable) topUp = mintable;
        if (topUp == 0) return;

        vm.prank(minter);
        try okuMoney.mint(address(this), topUp) {
            IERC20(address(okuMoney)).approve(address(okuDollar), topUp);
            try okuDollar.depositReserves(topUp) {} catch {}
        } catch {}
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
            + ghostTransferCalls + ghostDepositReservesCalls + ghostWithdrawSurplusCalls
            + ghostSetYieldRateCalls + ghostSetNextYieldRateCalls + ghostSetMinCollatRatioCalls
            + ghostWarpCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMReverts + ghostWrapReverts + ghostUnwrapReverts + ghostRebaseReverts
            + ghostTransferReverts + ghostDepositReservesReverts + ghostWithdrawSurplusReverts
            + ghostSetYieldRateReverts + ghostSetNextYieldRateReverts
            + ghostSetMinCollatRatioReverts;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Wrap-call counter retained for backward-compat with VaultInvariants.
    function ghostWrapCallCount() external view returns (uint256) {
        return ghostWrapCalls;
    }
}
