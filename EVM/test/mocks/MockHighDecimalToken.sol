// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockHighDecimalToken
 * @notice ERC-20 with a configurable `decimals()`, used to drive the
 *         `UsdcDecimalsTooLarge` rejection path in `OkuM.initialize`.
 * @dev OkuM is 18 decimals, so an asset with more precision would force
 *      negative-exponent math in the decimal multiplier. It is rejected rather
 *      than approximated.
 */
contract MockHighDecimalToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 d) ERC20("High Decimal", "HIGH") {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
