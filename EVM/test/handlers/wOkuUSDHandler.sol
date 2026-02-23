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
    OkuUSD public okuUsd;
    wOkuUSD public wokuUsd;
    address public minter;
    address public rebaser;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant PRECISION = 1e18;

    // Ghost variables
    uint256 public ghostTotalDeposited;
    uint256 public ghostTotalWithdrawn;
    uint256 public ghostRebaseCount;

    // Ghost call/revert counters
    uint256 public ghostMintOkuUsdCallCount;
    uint256 public ghostMintOkuUsdRevertCount;
    uint256 public ghostDepositCallCount;
    uint256 public ghostDepositRevertCount;
    uint256 public ghostRedeemCallCount;
    uint256 public ghostRedeemRevertCount;
    uint256 public ghostWithdrawCallCount;
    uint256 public ghostWithdrawRevertCount;
    uint256 public ghostRebaseCallCount;
    uint256 public ghostRebaseRevertCount;
    uint256 public ghostTransferSharesCallCount;
    uint256 public ghostTransferSharesRevertCount;

    constructor(OkuUSD _okuUsd, wOkuUSD _wokuUsd, address _minter, address _rebaser) {
        okuUsd = _okuUsd;
        wokuUsd = _wokuUsd;
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
    function mintOkuUsd(uint256 actorSeed, uint256 amount) external {
        ghostMintOkuUsdCallCount++;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuUsd.minterAllowance(minter);
        uint256 remaining = okuUsd.maxSupply() - okuUsd.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuUsd.mint(actor, amount) {} catch {
            ghostMintOkuUsdRevertCount++;
        }
    }

    /// @notice Deposit OkuUSD into vault
    function deposit(uint256 actorSeed, uint256 amount) external {
        ghostDepositCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUsd.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.startPrank(actor);
        okuUsd.approve(address(wokuUsd), amount);
        try wokuUsd.deposit(amount, actor) {
            ghostTotalDeposited += amount;
        } catch {
            ghostDepositRevertCount++;
        }
        vm.stopPrank();
    }

    /// @notice Redeem shares from vault
    function redeem(uint256 actorSeed, uint256 shares) external {
        ghostRedeemCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = wokuUsd.balanceOf(actor);
        shares = bound(shares, 0, balance);

        if (shares == 0) return;

        vm.prank(actor);
        try wokuUsd.redeem(shares, actor, actor) returns (uint256 assets) {
            ghostTotalWithdrawn += assets;
        } catch {
            ghostRedeemRevertCount++;
        }
    }

    /// @notice Withdraw assets from vault
    function withdraw(uint256 actorSeed, uint256 assets) external {
        ghostWithdrawCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 maxAssets = wokuUsd.maxWithdraw(actor);
        assets = bound(assets, 0, maxAssets);

        if (assets == 0) return;

        vm.prank(actor);
        try wokuUsd.withdraw(assets, actor, actor) {
            ghostTotalWithdrawn += assets;
        } catch {
            ghostWithdrawRevertCount++;
        }
    }

    /// @notice Trigger rebase
    function rebase(uint256 multiplierIncrease) external {
        ghostRebaseCallCount++;
        uint256 currentMultiplier = okuUsd.rewardMultiplier();
        uint256 increase =
            bound(multiplierIncrease, currentMultiplier / 10_000, currentMultiplier / 10);
        uint256 newMultiplier = currentMultiplier + increase;

        vm.prank(rebaser);
        try okuUsd.updateRewardMultiplier(newMultiplier) {
            ghostRebaseCount++;
        } catch {
            ghostRebaseRevertCount++;
        }
    }

    /// @notice Transfer wOkuUSD between actors
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shares) external {
        ghostTransferSharesCallCount++;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = wokuUsd.balanceOf(from);
        shares = bound(shares, 0, balance);

        if (shares == 0 || from == to) return;

        vm.prank(from);
        try wokuUsd.transfer(to, shares) {} catch {
            ghostTransferSharesRevertCount++;
        }
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function ghostTotalCalls() external view returns (uint256) {
        return ghostMintOkuUsdCallCount + ghostDepositCallCount + ghostRedeemCallCount
            + ghostWithdrawCallCount + ghostRebaseCallCount + ghostTransferSharesCallCount;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuUsdRevertCount + ghostDepositRevertCount + ghostRedeemRevertCount
            + ghostWithdrawRevertCount + ghostRebaseRevertCount + ghostTransferSharesRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
