// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";

/**
 * @title OkuMoneyHandler
 * @notice Handler contract for OkuMoney invariant testing
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

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant PRECISION = 1e18;

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

    // Monotonic okuMPrice tracking
    uint256 public ghostLastOkuMPrice;

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
        ghostLastOkuMPrice = okuMoney.okuMPrice();
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

    /// @notice Update OkuM price (rebase)
    function rebase(uint256 priceIncrease) external {
        ghostRebaseCallCount++;
        uint256 currentPrice = okuMoney.okuMPrice();

        // Cap maximum price at 1e24 (1 million x starting value)
        uint256 maxPrice = 1e24;

        if (currentPrice >= maxPrice) {
            return; // Already at maximum, skip further rebases
        }

        // Increase by 0.01% to 5% per rebase
        uint256 minIncrease = currentPrice / 10_000; // 0.01%
        uint256 maxIncrease = currentPrice / 20; // 5%
        uint256 increase = bound(priceIncrease, minIncrease, maxIncrease);

        uint256 newPrice = currentPrice + increase;

        // Ensure we don't exceed the cap
        if (newPrice > maxPrice) {
            newPrice = maxPrice;
        }

        vm.prank(rebaser);
        try okuMoney.setOkuMPrice(newPrice) {
            ghostLastWasRebase = true;
            ghostLastOkuMPrice = newPrice;
        } catch {
            ghostRebaseRevertCount++;
        }
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
