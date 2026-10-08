// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title LitePSMEvents
 * @notice Event declarations for the LitePSM contract.
 */
abstract contract LitePSMEvents {
    /// @notice Emitted when a user mints OkuMoney by depositing USDC.
    /// @param user       Depositor and recipient
    /// @param usdcAmount USDC paid in (USDC's own decimals)
    /// @param okuMAmount OkuM minted (18 decimals)
    /// @param okuMMultiplier OkuM multiplier used for pricing (1e18 = $1.00)
    event OkuMMinted(
        address indexed user, uint256 usdcAmount, uint256 okuMAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when OkuMoney is redeemed for USDC from the PSM buffer.
    /// @param user    Redeemer and USDC recipient
    /// @param okuMIn  OkuM burned (18 decimals)
    /// @param usdcOut USDC paid out (USDC's own decimals)
    /// @param okuMMultiplier OkuM multiplier used for pricing (1e18 = $1.00)
    event OkuMRedeemed(
        address indexed user, uint256 okuMIn, uint256 usdcOut, uint256 okuMMultiplier
    );

    /// @notice Emitted when a user mints OkuDollar (usdOku) by depositing USDC.
    /// @param user       Depositor and recipient
    /// @param usdcAmount USDC paid in (USDC's own decimals)
    /// @param usdAmount  OkuDollar minted, in dollars (18 decimals)
    /// @param okuMMultiplier OkuM multiplier used for pricing (1e18 = $1.00)
    event UsdOkuMinted(
        address indexed user, uint256 usdcAmount, uint256 usdAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when user redeems OkuDollar for USDC.
    /// @dev This is the sole event emitted for OkuDollar redemptions; no underlying
    ///      `OkuMRedeemed` is emitted for the internal unwrap+redeem path.
    /// @param user    Redeemer and USDC recipient
    /// @param usdIn   OkuDollar redeemed, in dollars (18 decimals)
    /// @param usdcOut USDC paid out (USDC's own decimals)
    /// @param okuMMultiplier OkuM multiplier used for pricing (1e18 = $1.00)
    event UsdOkuRedeemed(
        address indexed user, uint256 usdIn, uint256 usdcOut, uint256 okuMMultiplier
    );

    /// @notice Emitted when the buffer depositor adds USDC to the buffer.
    /// @param newBufferBalance PSM USDC balance after the deposit
    event BufferDeposited(address indexed depositor, uint256 amount, uint256 newBufferBalance);

    /// @notice Emitted when the buffer withdrawer takes USDC out of the buffer.
    /// @param to               Recipient of the USDC
    /// @param newBufferBalance PSM USDC balance after the withdrawal
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBufferBalance);
}
