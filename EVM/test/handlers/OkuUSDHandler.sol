// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";

/**
 * @title OkuUSDHandler
 * @notice Handler contract for OkuUSD invariant testing
 */
contract OkuUSDHandler is Test {
    OkuUSD public okuUSD;
    address public minter;
    address public rebaser;
    address public allowanceManager;

    // Tracking state for invariant verification
    address[] public actors;
    mapping(address => bool) public isActor;
    mapping(address => uint256) public lastAllowance;
    bool public allowanceWasReset;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant PRECISION = 1e18;

    // Ghost variables for tracking
    uint256 public ghost_mintedTotal;
    uint256 public ghost_burnedTotal;
    bool public ghost_lastWasRebase;

    constructor(OkuUSD _okuUSD, address _minter, address _rebaser, address _allowanceManager) {
        okuUSD = _okuUSD;
        minter = _minter;
        rebaser = _rebaser;
        allowanceManager = _allowanceManager;

        // Initialize actors
        _addActor(makeAddr("actor1"));
        _addActor(makeAddr("actor2"));
        _addActor(makeAddr("actor3"));

        lastAllowance[minter] = okuUSD.minterAllowance(minter);
    }

    function _addActor(address actor) internal {
        if (!isActor[actor]) {
            actors.push(actor);
            isActor[actor] = true;
        }
    }

    // ============ Handler Functions ============

    /// @notice Mint tokens to a random actor
    function mint(uint256 actorSeed, uint256 amount) external {
        ghost_lastWasRebase = false;

        address actor = actors[actorSeed % actors.length];
        amount = __bound(amount, 1, MAX_SUPPLY / 100);

        uint256 allowance = okuUSD.minterAllowance(minter);
        uint256 remaining = okuUSD.maxSupply() - okuUSD.totalSupply();
        amount = __bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.mint(actor, amount) {
            ghost_mintedTotal += amount;
            lastAllowance[minter] = okuUSD.minterAllowance(minter);
        } catch {}
    }

    /// @notice Burn tokens from a random actor
    function burn(uint256 actorSeed, uint256 amount) external {
        ghost_lastWasRebase = false;

        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(actor);
        amount = __bound(amount, 0, balance);

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.burn(actor, amount) {
            ghost_burnedTotal += amount;
        } catch {}
    }

    /// @notice Transfer between random actors
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghost_lastWasRebase = false;

        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(from);
        amount = __bound(amount, 0, balance);

        if (amount == 0 || from == to) return;

        vm.prank(from);
        try okuUSD.transfer(to, amount) {} catch {}
    }

    /// @notice Update reward multiplier (rebase)
    function rebase(uint256 multiplierIncrease) external {
        uint256 currentMultiplier = okuUSD.rewardMultiplier();
        // Increase by 0.01% to 10%
        uint256 increase =
            __bound(multiplierIncrease, currentMultiplier / 10_000, currentMultiplier / 10);
        uint256 newMultiplier = currentMultiplier + increase;

        // Cap at 1e27 (1 billion x starting value) to prevent extreme arithmetic issues
        // This still allows for massive yield accumulation while keeping math tractable
        if (newMultiplier > 1e27) {
            return; // Skip rebase if it would exceed reasonable bounds
        }

        vm.prank(rebaser);
        try okuUSD.updateRewardMultiplier(newMultiplier) {
            ghost_lastWasRebase = true;
        } catch {}
    }

    /// @notice Reset minter allowance (simulates allowance manager action)
    function resetAllowance(uint256 newAllowance) external {
        newAllowance = __bound(newAllowance, 0, MAX_SUPPLY);

        vm.prank(allowanceManager);
        try okuUSD.configureMinterAllowance(minter, newAllowance) {
            allowanceWasReset = true;
            lastAllowance[minter] = newAllowance;
        } catch {}
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function wasLastOperationRebase() external view returns (bool) {
        return ghost_lastWasRebase;
    }

    function wasAllowanceReset() external view returns (bool) {
        return allowanceWasReset;
    }

    // ============ Helper Functions ============

    /// @notice Custom bound function without console logging
    function __bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        if (x < min) return min;
        if (x > max) return max;
        return x;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
