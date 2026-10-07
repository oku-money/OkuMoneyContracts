// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title LitePSMEvents
 * @notice Event declarations for the LitePSM contract.
 */
abstract contract LitePSMEvents {
    /// @notice Emitted when user mints OkuMoney by depositing USDC
    event OkuMMinted(
        address indexed user, uint256 usdcAmount, uint256 okuMAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when OkuMoney is redeemed for USDC from the PSM buffer.
    event OkuMRedeemed(
        address indexed user, uint256 okuMIn, uint256 usdcOut, uint256 okuMMultiplier
    );

    /// @notice Emitted when user mints OkuDollar by depositing USDC
    event UsdOkuMinted(
        address indexed user, uint256 usdcAmount, uint256 usdAmount, uint256 okuMMultiplier
    );

    /// @notice Emitted when user redeems OkuDollar for USDC.
    /// @dev This is the sole event emitted for OkuDollar redemptions; no underlying
    ///      `OkuMRedeemed` is emitted for the internal unwrap+redeem path.
    event UsdOkuRedeemed(
        address indexed user, uint256 usdIn, uint256 usdcOut, uint256 okuMMultiplier
    );

    /// @notice Emitted when admin deposits USDC to buffer
    event BufferDeposited(address indexed depositor, uint256 amount, uint256 newBufferBalance);

    /// @notice Emitted when admin withdraws USDC from buffer
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBufferBalance);
}
