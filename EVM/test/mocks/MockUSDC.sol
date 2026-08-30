// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice 6-decimal USDC stand-in for tests and testnet deploys.
 * @dev Also deployed by `scripts/deploy/index.ts` on testnets, and compiled into
 *      the Hardhat artifact set via the `test/mocks/*.sol` source-path override in
 *      `hardhat.config.ts` — so this file is not test-only.
 *
 *      `blocked` reproduces Circle's blacklist shape (revert on transfer) and
 *      `returnFalseFor` reproduces a non-standard silent `false` return. Both are
 *      independently settable so fulfillment paths can be tested against a
 *      recipient that fails loudly and one that fails quietly.
 */
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;
    mapping(address => bool) public returnFalseFor;

    error AccountBlocked(address account);

    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Unprotected mint — tests and testnet faucets only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setReturnFalse(address account, bool value) external {
        returnFalseFor[account] = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (returnFalseFor[msg.sender] || returnFalseFor[to]) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (returnFalseFor[from] || returnFalseFor[to]) return false;
        return super.transferFrom(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && blocked[from]) revert AccountBlocked(from);
        if (to != address(0) && blocked[to]) revert AccountBlocked(to);
        super._update(from, to, amount);
    }
}
