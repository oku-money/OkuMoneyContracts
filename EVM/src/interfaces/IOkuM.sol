// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IScaledUIAmount} from "./erc8056/IScaledUIAmount.sol";
import {IScaledUIAmountNewUIMultiplier} from "./erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "./erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "./erc8056/IScaledUIAmountBalances.sol";

/**
 * @title IOkuM
 * @notice Oku Money's share token: raw ERC-20 ledger + ERC-8056 display layer.
 * @dev `uiMultiplier()` is the ONE price in this system. It is simultaneously:
 *        - the ERC-8056 display multiplier (what wallets show),
 *        - the LitePSM mint/redeem price (what USDC converts at), and
 *        - the OkuM <-> USDOku conversion price (what wrap/unwrap convert at).
 *      They are the same number by construction, not by convention.
 *
 *      `indexAt`, `rateEnd` and `accrualHalted` are deliberately NOT redeclared here.
 *      They come from `ScaledUIAmountUpgradeable`; restating them would force every
 *      implementer into a diamond override for no benefit. Consumers that need them
 *      (the vault's forward projection, cross-chain reconciliation) import the
 *      concrete type.
 */
interface IOkuM is
    IERC20,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    /// @notice Remaining mint allowance for `minter_`, in raw units.
    function minterAllowance(address minter_) external view returns (uint256);

    /// @notice Global raw supply ceiling.
    function maxSupply() external view returns (uint256);

    /// @notice Whether `account` is blacklisted.
    function isBlacklisted(address account) external view returns (bool);

    /// @notice Mint raw OkuM. Role-gated, allowance-decrementing, cap-checked.
    function mint(address to, uint256 amount) external;

    /// @notice Burn raw OkuM from the caller's balance.
    function burn(uint256 amount) external;
}
