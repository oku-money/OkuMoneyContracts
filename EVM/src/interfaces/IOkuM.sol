// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IScaledUIAmount} from "./erc8056/IScaledUIAmount.sol";
import {IScaledUIAmountConversion} from "./erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "./erc8056/IScaledUIAmountBalances.sol";

/**
 * @title IOkuM
 * @notice Consumer-facing surface of the OkuM share token.
 * @dev Composes the standard surfaces rather than redeclaring them, so there is
 *      exactly one declaration of each function in the inheritance graph:
 *        - `IERC20`                       — the raw accounting layer
 *        - `IScaledUIAmount` + extensions — the ERC-8056 display layer
 *      and adds only what is unique to this token: the value-layer anchor
 *      (`asset`, `usdcDecimalMultiplier`) and the role-gated supply hooks the
 *      module, queue and wrapper call.
 */
interface IOkuM is IERC20, IScaledUIAmount, IScaledUIAmountConversion, IScaledUIAmountBalances {
    // ============ Value-layer anchor ============

    /// @notice The underlying asset all value conversions are denominated against.
    /// @dev USDC on the deployed chain. Single source of truth: the module and
    ///      queue cross-assert against this at `initialize` rather than deriving
    ///      their own copy from a separately-supplied address.
    function asset() external view returns (address);

    /// @notice `10 ** (18 - IERC20Metadata(asset()).decimals())`. `1e12` for Circle USDC.
    function usdcDecimalMultiplier() external view returns (uint256);

    // ============ Supply hooks (role-gated) ============

    /// @notice Mint `amount` raw tokens to `to`. Requires `OKU_MINTER`.
    function mint(address to, uint256 amount) external;

    /// @notice Burn `amount` raw tokens from the caller. Requires `OKU_BURNER`.
    function burn(uint256 amount) external;
}
