// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Stand-in for Arbitrum's ArbSys precompile (address 100). Etch its runtime code at
///      `address(100)` and drive the L2 height with {setArbBlockNumber}; the slot is
///      written with `vm.store`/this setter on the etched address.
contract MockArbSys {
    uint256 public height;

    function setArbBlockNumber(uint256 h) external {
        height = h;
    }

    function arbBlockNumber() external view returns (uint256) {
        return height;
    }
}
