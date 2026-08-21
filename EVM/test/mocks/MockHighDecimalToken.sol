// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockHighDecimalToken
/// @notice Test-only ERC-20 with a configurable `decimals()`.
/// @dev Two uses:
///        - `d > 18` exercises `AssetDecimalsTooLarge` / `UsdcDecimalsTooLarge`.
///        - `d == 18` makes `usdcDecimalMultiplier == 1`, which is the only
///          configuration in which the `AmountTooSmall` guard on `LitePSM.mint`
///          is reachable. With 6-decimal USDC the smallest input is worth 1e12
///          dollar-wei and would need a multiplier above 1e30 to floor to zero
///          raw, but `MAX_MULTIPLIER` is 1e24 — so the guard is defensive for
///          high-precision assets, not live for Circle USDC.
contract MockHighDecimalToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 d) ERC20("HighDec", "HD") {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
