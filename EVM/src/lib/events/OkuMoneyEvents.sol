// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuMoneyEvents
 * @notice Event declarations for the OkuMoney token contract.
 * @dev Solidity does not allow contracts to emit events declared in libraries, so
 *      events are extracted into per-contract abstract event contracts that the
 *      main contract inherits. This keeps the contract bodies focused on logic
 *      while preserving normal `emit` semantics.
 */
abstract contract OkuMoneyEvents {
    /// @notice Emitted when multiplier is updated directly via setOkuMMultiplier
    /// @param oldMultiplier Previous multiplier value
    /// @param newMultiplier New multiplier value
    /// @param totalSupply Token supply at time of update (for dollar value calculations)
    event OkuMMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply);

    /// @notice Emitted when yield is distributed via distributeYield
    /// @param yieldAmount Dollar yield distributed (18 decimals)
    /// @param oldMultiplier Previous multiplier value
    /// @param newMultiplier New multiplier value
    /// @param totalSupply Token supply at time of distribution
    event YieldDistributed(
        uint256 yieldAmount, uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply
    );

    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    /// @notice Emitted alongside the standard ERC-20 Transfer with the dollar-denominated value
    /// @dev dollarValue = amount * okuMMultiplier / PRECISION
    event TransferValue(
        address indexed from, address indexed to, uint256 amount, uint256 dollarValue
    );
}
