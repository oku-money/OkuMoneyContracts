// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockHighDecimalToken
/// @notice Test-only ERC-20 that reports more than 18 decimals.
/// @dev Used solely to exercise the `UsdcDecimalsTooLarge` revert in
///      `LitePSM.initialize`.
contract MockHighDecimalToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 d) ERC20("HighDec", "HD") {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
