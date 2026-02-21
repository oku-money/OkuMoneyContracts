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

    // Ghost call/revert counters
    uint256 public ghost_mintOkuUSDCallCount;
    uint256 public ghost_mintOkuUSDRevertCount;
    uint256 public ghost_depositCallCount;
    uint256 public ghost_depositRevertCount;
    uint256 public ghost_redeemCallCount;
    uint256 public ghost_redeemRevertCount;
    uint256 public ghost_withdrawCallCount;
    uint256 public ghost_withdrawRevertCount;
    uint256 public ghost_rebaseCallCount;
    uint256 public ghost_rebaseRevertCount;
    uint256 public ghost_transferSharesCallCount;
    uint256 public ghost_transferSharesRevertCount;

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

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    // ============ Handler Functions ============

    /// @notice Mint OkuUSD to actors (so they have tokens to deposit)
    function mintOkuUSD(uint256 actorSeed, uint256 amount) external {
        ghost_mintOkuUSDCallCount++;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuUSD.minterAllowance(minter);
        uint256 remaining = okuUSD.maxSupply() - okuUSD.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuUSD.mint(actor, amount) {} catch {
            ghost_mintOkuUSDRevertCount++;
        }
    }

    /// @notice Deposit OkuUSD into vault
    function deposit(uint256 actorSeed, uint256 amount) external {
        ghost_depositCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUSD.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.startPrank(actor);
        okuUSD.approve(address(wokuUSD), amount);
        try wokuUSD.deposit(amount, actor) {
            ghost_totalDeposited += amount;
        } catch {
            ghost_depositRevertCount++;
        }
        vm.stopPrank();
    }

    /// @notice Redeem shares from vault
    function redeem(uint256 actorSeed, uint256 shares) external {
        ghost_redeemCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = wokuUSD.balanceOf(actor);
        shares = bound(shares, 0, balance);

        if (shares == 0) return;

        vm.prank(actor);
        try wokuUSD.redeem(shares, actor, actor) returns (uint256 assets) {
            ghost_totalWithdrawn += assets;
        } catch {
            ghost_redeemRevertCount++;
        }
    }

    /// @notice Withdraw assets from vault
    function withdraw(uint256 actorSeed, uint256 assets) external {
        ghost_withdrawCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 maxAssets = wokuUSD.maxWithdraw(actor);
        assets = bound(assets, 0, maxAssets);

        if (assets == 0) return;

        vm.prank(actor);
        try wokuUSD.withdraw(assets, actor, actor) {
            ghost_totalWithdrawn += assets;
        } catch {
            ghost_withdrawRevertCount++;
        }
    }

    /// @notice Trigger rebase
    function rebase(uint256 multiplierIncrease) external {
        ghost_rebaseCallCount++;
        uint256 currentMultiplier = okuUSD.rewardMultiplier();
        uint256 increase =
            bound(multiplierIncrease, currentMultiplier / 10_000, currentMultiplier / 10);
        uint256 newMultiplier = currentMultiplier + increase;

        vm.prank(rebaser);
        try okuUSD.updateRewardMultiplier(newMultiplier) {
            ghost_rebaseCount++;
        } catch {
            ghost_rebaseRevertCount++;
        }
    }

    /// @notice Transfer wOkuUSD between actors
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shares) external {
        ghost_transferSharesCallCount++;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = wokuUSD.balanceOf(from);
        shares = bound(shares, 0, balance);

        if (shares == 0 || from == to) return;

        vm.prank(from);
        try wokuUSD.transfer(to, shares) {} catch {
            ghost_transferSharesRevertCount++;
        }
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function ghost_totalCalls() external view returns (uint256) {
        return ghost_mintOkuUSDCallCount + ghost_depositCallCount + ghost_redeemCallCount
            + ghost_withdrawCallCount + ghost_rebaseCallCount + ghost_transferSharesCallCount;
    }

    function ghost_totalReverts() external view returns (uint256) {
        return ghost_mintOkuUSDRevertCount + ghost_depositRevertCount + ghost_redeemRevertCount
            + ghost_withdrawRevertCount + ghost_rebaseRevertCount + ghost_transferSharesRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
