// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SafeApprove
 * @notice Helpers for the "approve, do, revoke" pattern used when this contract
 *         hands a one-shot allowance to a trusted callee.
 * @dev Wraps OpenZeppelin's `forceApprove` so allowance changes work uniformly
 *      across tokens that require zero-then-set (e.g. USDT-like). Callers should
 *      pair `setExactAllowance` with `revokeAllowance` around the inner call so
 *      no allowance lingers if the callee under-pulls.
 */
library SafeApprove {
    using SafeERC20 for IERC20;

    /// @notice Set `spender`'s allowance on `token` to exactly `amount`.
    function setExactAllowance(IERC20 token, address spender, uint256 amount) internal {
        token.forceApprove(spender, amount);
    }

    /// @notice Revoke any remaining allowance `spender` holds on `token`.
    function revokeAllowance(IERC20 token, address spender) internal {
        token.forceApprove(spender, 0);
    }
}
