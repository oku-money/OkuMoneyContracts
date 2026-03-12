// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title OkuDollarHandler
 * @notice Handler contract for OkuDollar vault invariant testing
 */
contract OkuDollarHandler is Test {
    OkuMoney public okuMoney;
    OkuDollar public usdOku;
    address public minter;
    address public rebaser;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant PRECISION = 1e18;

    // Ghost variables
    uint256 public ghostTotalWrapped;
    uint256 public ghostTotalUnwrapped;
    uint256 public ghostRebaseCount;

    // Ghost call/revert counters
    uint256 public ghostMintOkuMCallCount;
    uint256 public ghostMintOkuMRevertCount;
    uint256 public ghostWrapCallCount;
    uint256 public ghostWrapRevertCount;
    uint256 public ghostUnwrapCallCount;
    uint256 public ghostUnwrapRevertCount;
    uint256 public ghostRebaseCallCount;
    uint256 public ghostRebaseRevertCount;
    uint256 public ghostTransferCallCount;
    uint256 public ghostTransferRevertCount;

    constructor(OkuMoney _okuMoney, OkuDollar _usdOku, address _minter, address _rebaser) {
        okuMoney = _okuMoney;
        usdOku = _usdOku;
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

    /// @notice Mint OkuMoney to actors (so they have tokens to wrap)
    function mintOkuM(uint256 actorSeed, uint256 amount) external {
        ghostMintOkuMCallCount++;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuMoney.minterAllowance(minter);
        uint256 remaining = okuMoney.maxSupply() - okuMoney.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuMoney.mint(actor, amount) {}
        catch {
            ghostMintOkuMRevertCount++;
        }
    }

    /// @notice Wrap OkuMoney into OkuDollar vault
    function wrap(uint256 actorSeed, uint256 amount) external {
        ghostWrapCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuMoney.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.startPrank(actor);
        IERC20(address(okuMoney)).approve(address(usdOku), amount);
        try usdOku.wrap(amount, actor, 0) {
            ghostTotalWrapped += amount;
        } catch {
            ghostWrapRevertCount++;
        }
        vm.stopPrank();
    }

    /// @notice Unwrap OkuDollar to get OkuMoney back
    function unwrap(uint256 actorSeed, uint256 amount) external {
        ghostUnwrapCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = usdOku.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.prank(actor);
        try usdOku.unwrap(amount, actor) returns (uint256 okuMReturned) {
            ghostTotalUnwrapped += okuMReturned;
        } catch {
            ghostUnwrapRevertCount++;
        }
    }

    /// @notice Trigger OkuM price update (rebase)
    function rebase(uint256 priceIncrease) external {
        ghostRebaseCallCount++;
        uint256 currentPrice = okuMoney.okuMPrice();
        uint256 increase = bound(priceIncrease, currentPrice / 10_000, currentPrice / 10);
        uint256 newPrice = currentPrice + increase;

        vm.prank(rebaser);
        try okuMoney.updateOkuMPrice(newPrice) {
            ghostRebaseCount++;
        } catch {
            ghostRebaseRevertCount++;
        }
    }

    /// @notice Transfer OkuDollar between actors
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghostTransferCallCount++;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = usdOku.balanceOf(from);
        amount = bound(amount, 0, balance);

        if (amount == 0 || from == to) return;

        vm.prank(from);
        try usdOku.transfer(to, amount) {}
        catch {
            ghostTransferRevertCount++;
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
        return ghostMintOkuMCallCount + ghostWrapCallCount + ghostUnwrapCallCount
            + ghostRebaseCallCount + ghostTransferCallCount;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMRevertCount + ghostWrapRevertCount + ghostUnwrapRevertCount
            + ghostRebaseRevertCount + ghostTransferRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
