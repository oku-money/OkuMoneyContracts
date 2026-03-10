// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuNote} from "../../src/token/OkuNote.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title OkuUSDHandler
 * @notice Handler contract for OkuUSD vault invariant testing
 */
contract OkuUSDHandler is Test {
    OkuNote public okuNote;
    OkuUSD public okuUsd;
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
    uint256 public ghostMintOkuNoteCallCount;
    uint256 public ghostMintOkuNoteRevertCount;
    uint256 public ghostWrapCallCount;
    uint256 public ghostWrapRevertCount;
    uint256 public ghostUnwrapCallCount;
    uint256 public ghostUnwrapRevertCount;
    uint256 public ghostRebaseCallCount;
    uint256 public ghostRebaseRevertCount;
    uint256 public ghostTransferCallCount;
    uint256 public ghostTransferRevertCount;

    constructor(OkuNote _okuNote, OkuUSD _okuUsd, address _minter, address _rebaser) {
        okuNote = _okuNote;
        okuUsd = _okuUsd;
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

    /// @notice Mint OkuNote to actors (so they have tokens to wrap)
    function mintOkuNote(uint256 actorSeed, uint256 amount) external {
        ghostMintOkuNoteCallCount++;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 1_000_000e18);

        uint256 allowance = okuNote.minterAllowance(minter);
        uint256 remaining = okuNote.maxSupply() - okuNote.totalSupply();
        amount = bound(amount, 0, _min(allowance, remaining));

        if (amount == 0) return;

        vm.prank(minter);
        try okuNote.mint(actor, amount) {}
        catch {
            ghostMintOkuNoteRevertCount++;
        }
    }

    /// @notice Wrap OkuNote into OkuUSD vault
    function wrap(uint256 actorSeed, uint256 amount) external {
        ghostWrapCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuNote.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.startPrank(actor);
        IERC20(address(okuNote)).approve(address(okuUsd), amount);
        try okuUsd.wrap(amount, actor) {
            ghostTotalWrapped += amount;
        } catch {
            ghostWrapRevertCount++;
        }
        vm.stopPrank();
    }

    /// @notice Unwrap OkuUSD to get OkuNote back
    function unwrap(uint256 actorSeed, uint256 amount) external {
        ghostUnwrapCallCount++;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = okuUsd.balanceOf(actor);
        amount = bound(amount, 0, balance);

        if (amount == 0) return;

        vm.prank(actor);
        try okuUsd.unwrap(amount, actor) returns (uint256 notesReturned) {
            ghostTotalUnwrapped += notesReturned;
        } catch {
            ghostUnwrapRevertCount++;
        }
    }

    /// @notice Trigger note price update (rebase)
    function rebase(uint256 priceIncrease) external {
        ghostRebaseCallCount++;
        uint256 currentPrice = okuNote.notePrice();
        uint256 increase = bound(priceIncrease, currentPrice / 10_000, currentPrice / 10);
        uint256 newPrice = currentPrice + increase;

        vm.prank(rebaser);
        try okuNote.updateNotePrice(newPrice) {
            ghostRebaseCount++;
        } catch {
            ghostRebaseRevertCount++;
        }
    }

    /// @notice Transfer OkuUSD between actors
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ghostTransferCallCount++;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = okuUsd.balanceOf(from);
        amount = bound(amount, 0, balance);

        if (amount == 0 || from == to) return;

        vm.prank(from);
        try okuUsd.transfer(to, amount) {}
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
        return ghostMintOkuNoteCallCount + ghostWrapCallCount + ghostUnwrapCallCount
            + ghostRebaseCallCount + ghostTransferCallCount;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuNoteRevertCount + ghostWrapRevertCount + ghostUnwrapRevertCount
            + ghostRebaseRevertCount + ghostTransferRevertCount;
    }

    // ============ Helper Functions ============

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
