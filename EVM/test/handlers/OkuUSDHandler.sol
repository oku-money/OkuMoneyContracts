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

    // Ghost call/revert counters
    uint256 public ghost_mintCallCount;
    uint256 public ghost_mintRevertCount;
    uint256 public ghost_burnCallCount;
    uint256 public ghost_burnRevertCount;
    uint256 public ghost_transferCallCount;
    uint256 public ghost_transferRevertCount;
    uint256 public ghost_rebaseCallCount;
    uint256 public ghost_rebaseRevertCount;
    uint256 public ghost_resetCallCount;
    uint256 public ghost_resetRevertCount;

    // Monotonic multiplier tracking
    uint256 public ghost_lastMultiplier;

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
        ghost_lastMultiplier = okuUSD.rewardMultiplier();
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
        ghost_mintCallCount++;

        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1, MAX_SUPPLY / 100);

        uint256 allowance = okuUSD.minterAllowance(minter);
        uint256 remaining = okuUSD.maxSupply() - okuUSD.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.mint(actor, amount) {
            ghost_mintedTotal += amount;
            lastAllowance[minter] = okuUSD.minterAllowance(minter);
        } catch {
            ghost_mintRevertCount++;
        }
    }

    /// @notice Burn tokens from a random actor
    function burn(uint256 actorSeed, uint256 amount) external {
        ghost_lastWasRebase = false;
        ghost_burnCallCount++;

        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.burn(actor, amount) {
            ghost_burnedTotal += amount;
        } catch {
            ghost_burnRevertCount++;
        }
    }

    /// @notice Transfer between random actors
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghost_lastWasRebase = false;
        ghost_transferCallCount++;

        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(from);
        amount = bound(amount, 0, balance);

        if (amount == 0 || from == to) return;

        vm.prank(from);
        try okuUSD.transfer(to, amount) {} catch {
            ghost_transferRevertCount++;
        }
    }

    /// @notice Update reward multiplier (rebase)
    function rebase(uint256 multiplierIncrease) external {
        ghost_rebaseCallCount++;
        uint256 currentMultiplier = okuUSD.rewardMultiplier();

        // Cap maximum multiplier at 1e24 (1 million x starting value)
        uint256 MAX_MULTIPLIER = 1e24;

        if (currentMultiplier >= MAX_MULTIPLIER) {
            return; // Already at maximum, skip further rebases
        }

        // Increase by 0.01% to 5% per rebase
        uint256 minIncrease = currentMultiplier / 10_000; // 0.01%
        uint256 maxIncrease = currentMultiplier / 20;     // 5%
        uint256 increase = bound(multiplierIncrease, minIncrease, maxIncrease);

        uint256 newMultiplier = currentMultiplier + increase;

        // Ensure we don't exceed the cap
        if (newMultiplier > MAX_MULTIPLIER) {
            newMultiplier = MAX_MULTIPLIER;
        }

        vm.prank(rebaser);
        try okuUSD.updateRewardMultiplier(newMultiplier) {
            ghost_lastWasRebase = true;
            ghost_lastMultiplier = newMultiplier;
        } catch {
            ghost_rebaseRevertCount++;
        }
    }

    /// @notice Reset minter allowance (simulates allowance manager action)
    function resetAllowance(uint256 newAllowance) external {
        ghost_resetCallCount++;
        newAllowance = bound(newAllowance, 0, MAX_SUPPLY);

        vm.prank(allowanceManager);
        try okuUSD.configureMinterAllowance(minter, newAllowance) {
            allowanceWasReset = true;
            lastAllowance[minter] = newAllowance;
        } catch {
            ghost_resetRevertCount++;
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
        return ghost_lastWasRebase;
    }

    function wasAllowanceReset() external view returns (bool) {
        return allowanceWasReset;
    }

    function ghost_totalCalls() external view returns (uint256) {
        return ghost_mintCallCount + ghost_burnCallCount + ghost_transferCallCount
            + ghost_rebaseCallCount + ghost_resetCallCount;
    }

    function ghost_totalReverts() external view returns (uint256) {
        return ghost_mintRevertCount + ghost_burnRevertCount + ghost_transferRevertCount
            + ghost_rebaseRevertCount + ghost_resetRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
