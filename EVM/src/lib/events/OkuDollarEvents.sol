// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuDollarEvents
 * @notice Event declarations for the OkuDollar (rebasing) token contract.
 */
abstract contract OkuDollarEvents {
    /// @notice Emitted on internal share movements, carrying shares plus the
    ///         dollar-denominated value of the move.
    /// @param from        Sender (zero on wrap)
    /// @param to          Recipient (zero on unwrap)
    /// @param shares      Internal shares moved (= raw OkuM backing)
    /// @param dollarValue Their dollar value at the current multiplier
    event TransferValue(
        address indexed from, address indexed to, uint256 shares, uint256 dollarValue
    );

    /// @notice Emitted when OkuMoney is wrapped into OkuDollar
    /// @param user Address wrapping tokens
    /// @param receiver Address credited with the OkuDollar
    /// @param okuMAmount OkuMoney deposited (18 decimals)
    /// @param usdMinted OkuDollar minted (18 decimals)
    /// @param multiplier Shared OkuM/UsdOku multiplier at time of wrap
    event Wrapped(
        address indexed user,
        address indexed receiver,
        uint256 okuMAmount,
        uint256 usdMinted,
        uint256 multiplier
    );

    /// @notice Emitted when OkuDollar is unwrapped back to OkuMoney
    /// @param user Address unwrapping tokens
    /// @param receiver Address receiving the OkuMoney
    /// @param usdAmount OkuDollar redeemed (18 decimals)
    /// @param okuMReturned OkuMoney returned (18 decimals)
    /// @param multiplier Shared OkuM/UsdOku multiplier at time of unwrap
    event Unwrapped(
        address indexed user,
        address indexed receiver,
        uint256 usdAmount,
        uint256 okuMReturned,
        uint256 multiplier
    );

    // `Deposit` / `Withdraw` (ERC-4626, emitted by wrap()/unwrap()) come from the
    // inherited `IERC4626` interface on OkuDollar, not declared here.

    /// @notice Emitted when donated OkuM is rescued from the vault.
    /// @param receiver   Recipient of the rescued OkuM
    /// @param okuMAmount OkuM moved out (18 decimals)
    event DonationRescued(address indexed receiver, uint256 okuMAmount);

    /// @notice Emitted when an address is added to the OkuDollar blacklist
    event Blacklisted(address indexed account);

    /// @notice Emitted when an address is removed from the OkuDollar blacklist
    event Unblacklisted(address indexed account);
}
