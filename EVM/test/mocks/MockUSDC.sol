// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Test-only USDC mock (6 decimals like real USDC). Unprotected `mint`.
/// @dev NOT FOR PRODUCTION DEPLOYMENT. Anyone can mint; suitable only for tests.
///      Supports two failure shapes for the RedemptionQueue soft-skip tests:
///
///      1. `blocked` mapping (reverts on transferFrom) — mirrors Circle USDC's
///         blacklist behavior. Drives the revert -> `ok = false` branch.
///      2. `returnFalseFor` mapping — `transferFrom` returns `false` (no revert)
///         when either side is in this set. Drives the bool-decode branch
///         introduced by `SafeERC20.trySafeTransferFrom` in
///         {RedemptionQueue.processQueue}.
///
///      Both shapes route through the same soft-skip event downstream; the two
///      mappings keep the failure modes independently selectable so each branch
///      has a dedicated test.
contract MockUSDC is ERC20 {
    error MockUSDCBlocked();

    mapping(address => bool) public blocked;
    mapping(address => bool) public returnFalseFor;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Toggle blocked status for an address (transferFrom reverts).
    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    /// @notice Toggle return-false status for an address (transferFrom returns
    ///         `false` without reverting). Used to drive the SafeERC20 return-
    ///         data decode branch in RedemptionQueue.processQueue.
    function setReturnFalse(address account, bool returnFalse) external {
        returnFalseFor[account] = returnFalse;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (blocked[from] || blocked[to]) revert MockUSDCBlocked();
        if (returnFalseFor[from] || returnFalseFor[to]) return false;
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blocked[msg.sender] || blocked[to]) revert MockUSDCBlocked();
        if (returnFalseFor[msg.sender] || returnFalseFor[to]) return false;
        return super.transfer(to, amount);
    }
}
