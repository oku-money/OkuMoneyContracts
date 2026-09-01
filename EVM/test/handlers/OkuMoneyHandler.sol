// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title OkuMoneyHandler
 * @notice Handler contract for OkuMoney invariant testing
 * @dev Updated with realistic fuzz bounds:
 *      - Price capped at PRECISION * 5 (5x, ~500% yield)
 *      - vm.roll(block.number + 1) after rebase to avoid yield distribution lock
 */
contract OkuMoneyHandler is Test {
    OkuMoney public okuMoney;
    address public minter;
    address public rebaser;
    address public allowanceManager;

    // Tracking state for invariant verification
    address[] public actors;
    mapping(address => bool) public isActor;
    mapping(address => uint256) public lastAllowance;
    bool public allowanceWasReset;

    uint256 public constant MAX_SUPPLY = TestConstants.MAX_SUPPLY;
    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_FUZZ_PRICE = TestConstants.MAX_FUZZ_PRICE;
    uint256 public constant MIN_EPOCH_DURATION = TestConstants.MIN_EPOCH_DURATION;
    uint256 public constant MAX_EPOCH_DURATION = TestConstants.MAX_EPOCH_DURATION;

    // Ghost variables for tracking
    uint256 public ghostMintedTotal;
    uint256 public ghostBurnedTotal;
    bool public ghostLastWasRebase;

    // Ghost call/revert counters
    uint256 public ghostMintCallCount;
    uint256 public ghostMintRevertCount;
    uint256 public ghostBurnCallCount;
    uint256 public ghostBurnRevertCount;
    uint256 public ghostTransferCallCount;
    uint256 public ghostTransferRevertCount;
    uint256 public ghostRebaseCallCount;
    uint256 public ghostRebaseRevertCount;
    uint256 public ghostResetCallCount;
    uint256 public ghostResetRevertCount;

    // Monotonic okuMMultiplier tracking
    uint256 public ghostLastOkuMMultiplier;

    constructor(OkuMoney _okuMoney, address _minter, address _rebaser, address _allowanceManager) {
        okuMoney = _okuMoney;
        minter = _minter;
        rebaser = _rebaser;
        allowanceManager = _allowanceManager;

        // Initialize actors
        _addActor(makeAddr("actor1"));
        _addActor(makeAddr("actor2"));
        _addActor(makeAddr("actor3"));

        lastAllowance[minter] = okuMoney.minterAllowance(minter);
        ghostLastOkuMMultiplier = okuMoney.okuMMultiplier();
    }

    function _addActor(address actor) internal {
        if (!isActor[actor]) {
            actors.push(actor);
            isActor[actor] = true;
        }
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    // ============ Handler Functions ============

    /// @notice Mint tokens to a random actor
    function mint(uint256 actorSeed, uint256 amount) external {
        ghostLastWasRebase = false;
        ghostMintCallCount++;

        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1, MAX_SUPPLY / 100);

        uint256 allowance = okuMoney.minterAllowance(minter);
        uint256 remaining = okuMoney.maxSupply() - okuMoney.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuMoney.mint(actor, amount) {
            ghostMintedTotal += amount;
            lastAllowance[minter] = okuMoney.minterAllowance(minter);
        } catch {
            ghostMintRevertCount++;
        }
    }

    /// @notice Burn tokens from a random actor (transfer to minter, then self-burn)
    function burn(uint256 actorSeed, uint256 amount) external {
        ghostLastWasRebase = false;
        ghostBurnCallCount++;

        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuMoney.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        // Transfer tokens to minter first (self-burn model)
        vm.prank(actor);
        try okuMoney.transfer(minter, amount) {
            vm.prank(minter);
            try okuMoney.burn(amount) {
                ghostBurnedTotal += amount;
            } catch {
                ghostBurnRevertCount++;
            }
        } catch {
            ghostBurnRevertCount++;
        }
    }

    /// @notice Transfer between random actors
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghostLastWasRebase = false;
        ghostTransferCallCount++;

        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = okuMoney.balanceOf(from);
        amount = bound(amount, 0, balance);

        if (amount == 0 || from == to) return;

        vm.prank(from);
        try okuMoney.transfer(to, amount) {}
        catch {
            ghostTransferRevertCount++;
        }
    }

    /// @notice Run a yield epoch, moving the multiplier continuously.
    /// @dev Amount and duration are fuzzed across the full valid range and allowed to
    ///      exceed the APR cap, so the guard boundary is explored rather than assumed.
    function rebase(uint256 yieldAmount, uint256 durationSeed, bool warpToEnd) external {
        ghostRebaseCallCount++;
        if (okuMoney.totalSupply() == 0) return;
        if (okuMoney.okuMMultiplier() >= MAX_FUZZ_PRICE) return;

        uint256 duration = bound(durationSeed, MIN_EPOCH_DURATION, MAX_EPOCH_DURATION);
        uint256 ceiling = _maxYieldForDuration(duration);
        if (ceiling == 0) return;
        yieldAmount = bound(yieldAmount, 1, ceiling * 2);

        vm.prank(rebaser);
        try okuMoney.startYieldEpoch(yieldAmount, duration) {
            vm.warp(block.timestamp + (warpToEnd ? duration : duration / 2));
            ghostLastWasRebase = true;
            ghostLastOkuMMultiplier = okuMoney.okuMMultiplier();
            vm.roll(block.number + 1);
        } catch {
            ghostRebaseRevertCount++;
        }
    }

    /// @dev Largest yield distributable over `duration` without breaching the APR cap.
    function _maxYieldForDuration(uint256 duration) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        uint256 supply = okuMoney.totalSupply();
        if (supply == 0) return 0;
        uint256 maxDelta = (current * TestConstants.MAX_IMPLIED_APR_BPS * duration)
            / (TestConstants.BASIS_POINTS * TestConstants.SECONDS_PER_YEAR);
        return (maxDelta * supply) / PRECISION;
    }

    /// @notice Observe okuMMultiplier from outside the handler (e.g. from
    ///         OkuMMultiplierInvariants.afterInvariant) so the ghost gets updated
    ///         even if every handler call in the run reverted.
    function recordMultiplierObservation() external {
        uint256 cur = okuMoney.okuMMultiplier();
        if (cur > ghostLastOkuMMultiplier) ghostLastOkuMMultiplier = cur;
    }

    /// @notice Reset minter allowance (simulates allowance manager action)
    function resetAllowance(uint256 newAllowance) external {
        ghostResetCallCount++;
        newAllowance = bound(newAllowance, 0, MAX_SUPPLY);

        vm.prank(allowanceManager);
        try okuMoney.configureMinterAllowance(minter, newAllowance) {
            allowanceWasReset = true;
            lastAllowance[minter] = newAllowance;
        } catch {
            ghostResetRevertCount++;
        }
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function wasLastOperationRebase() external view returns (bool) {
        return ghostLastWasRebase;
    }

    function wasAllowanceReset() external view returns (bool) {
        return allowanceWasReset;
    }

    function ghostTotalCalls() external view returns (uint256) {
        return ghostMintCallCount + ghostBurnCallCount + ghostTransferCallCount
            + ghostRebaseCallCount + ghostResetCallCount;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintRevertCount + ghostBurnRevertCount + ghostTransferRevertCount
            + ghostRebaseRevertCount + ghostResetRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
