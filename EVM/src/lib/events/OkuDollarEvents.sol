// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuDollarEvents
 * @notice Event declarations for the OkuDollar (rebasing) token contract.
 */
abstract contract OkuDollarEvents {
    /// @notice Emitted on internal share movements, carrying shares plus the
    ///         dollar-denominated value of the move.
    event TransferValue(
        address indexed from, address indexed to, uint256 shares, uint256 dollarValue
    );

    /// @notice Emitted when OkuMoney is wrapped into OkuDollar
    /// @param user Address wrapping tokens
    /// @param okuMAmount OkuMoney deposited (18 decimals)
    /// @param usdMinted OkuDollar minted (18 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of wrap
    /// @param usdMultiplier OkuDollar multiplier at time of wrap
    event Wrapped(
        address indexed user,
        address indexed receiver,
        uint256 okuMAmount,
        uint256 usdMinted,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );

    /// @notice Emitted when OkuDollar is unwrapped back to OkuMoney
    /// @param user Address unwrapping tokens
    /// @param usdAmount OkuDollar redeemed (18 decimals)
    /// @param okuMReturned OkuMoney returned (18 decimals)
    /// @param okuMMultiplier OkuMoney multiplier at time of unwrap
    /// @param usdMultiplier OkuDollar multiplier at time of unwrap
    event Unwrapped(
        address indexed user,
        address indexed receiver,
        uint256 usdAmount,
        uint256 okuMReturned,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );

    // `Deposit` / `Withdraw` (ERC-4626, emitted by wrap()/unwrap()) come from the
    // inherited `IERC4626` interface on OkuDollar, not declared here.

    /// @notice Emitted when donated OkuM is rescued from the vault.
    event DonationRescued(address indexed receiver, uint256 okuMAmount);

    /// @notice Emitted when an address is added to the OkuDollar blacklist
    event Blacklisted(address indexed account);

    /// @notice Emitted when an address is removed from the OkuDollar blacklist
    event Unblacklisted(address indexed account);
}
