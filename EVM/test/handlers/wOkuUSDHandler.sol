// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";
import {wOkuUSD} from "../../src/token/wOkuUSD.sol";

/**
 * @title wOkuUSDHandler
 * @notice Handler contract for wOkuUSD vault invariant testing
 */
contract wOkuUSDHandler is Test {
    OkuUSD public okuUSD;
    wOkuUSD public wokuUSD;
    address public minter;
    address public rebaser;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant PRECISION = 1e18;

    // Ghost variables
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_rebaseCount;

    constructor(OkuUSD _okuUSD, wOkuUSD _wokuUSD, address _minter, address _rebaser) {
        okuUSD = _okuUSD;
        wokuUSD = _wokuUSD;
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

    // ============ Handler Functions ============

    /// @notice Mint OkuUSD to actors (so they have tokens to deposit)
    function mintOkuUSD(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = __bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuUSD.minterAllowance(minter);
        uint256 remaining = okuUSD.maxSupply() - okuUSD.totalSupply();
        amount = __bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.mint(actor, amount) {} catch {}
    }

    /// @notice Deposit OkuUSD into vault
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(actor);
        amount = __bound(amount, 0, balance);

        if (amount == 0) return;

        vm.startPrank(actor);
        okuUSD.approve(address(wokuUSD), amount);
        try wokuUSD.deposit(amount, actor) {
            ghost_totalDeposited += amount;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Redeem shares from vault
    function redeem(uint256 actorSeed, uint256 shares) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = wokuUSD.balanceOf(actor);
        shares = __bound(shares, 0, balance);

        if (shares == 0) return;

        vm.prank(actor);
        try wokuUSD.redeem(shares, actor, actor) returns (uint256 assets) {
            ghost_totalWithdrawn += assets;
        } catch {}
    }

    /// @notice Withdraw assets from vault
    function withdraw(uint256 actorSeed, uint256 assets) external {
        address actor = actors[actorSeed % actors.length];
        uint256 maxAssets = wokuUSD.maxWithdraw(actor);
        assets = __bound(assets, 0, maxAssets);

        if (assets == 0) return;

        vm.prank(actor);
        try wokuUSD.withdraw(assets, actor, actor) {
            ghost_totalWithdrawn += assets;
        } catch {}
    }

    /// @notice Trigger rebase
    function rebase(uint256 multiplierIncrease) external {
        uint256 currentMultiplier = okuUSD.rewardMultiplier();
        uint256 increase =
            __bound(multiplierIncrease, currentMultiplier / 10_000, currentMultiplier / 10);
        uint256 newMultiplier = currentMultiplier + increase;

        vm.prank(rebaser);
        try okuUSD.updateRewardMultiplier(newMultiplier) {
            ghost_rebaseCount++;
        } catch {}
    }

    /// @notice Transfer wOkuUSD between actors
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shares) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = wokuUSD.balanceOf(from);
        shares = __bound(shares, 0, balance);

        if (shares == 0 || from == to) return;

        vm.prank(from);
        try wokuUSD.transfer(to, shares) {} catch {}
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
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
