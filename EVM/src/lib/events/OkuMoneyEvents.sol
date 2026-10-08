// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuMoneyEvents
 * @notice Event declarations for the OkuMoney token contract.
 * @dev Solidity cannot emit events declared in libraries, so they live in abstract
 *      contracts the main contract inherits.
 */
abstract contract OkuMoneyEvents {
    /// @notice Emitted when the discrete emergency override {setOkuMMultiplier} re-anchors
    ///         the accrual base.
    /// @dev Not emitted for streaming accrual or rate changes (see {OkuMYieldRateUpdated}).
    /// @param oldMultiplier  Multiplier immediately before the override
    /// @param newMultiplier  New base multiplier
    /// @param totalSupply    Token supply at time of update
    /// @param blockNumber    `block.number` at update time
    event OkuMMultiplierUpdated(
        uint256 oldMultiplier,
        uint256 newMultiplier,
        uint256 totalSupply,
        uint256 indexed blockNumber
    );

    /// @notice Emitted when the active yield rate is set, re-anchoring the accrual base.
    /// @param oldRate            Previous per-second rate
    /// @param newRate            New per-second rate (PRECISION = no yield)
    /// @param endTimestamp       Timestamp the new rate expires (0 = halted; only
    ///                           valid when newRate == PRECISION)
    /// @param snapshotMultiplier Multiplier snapshotted as the new accrual base
    event OkuMYieldRateUpdated(
        uint256 oldRate, uint256 newRate, uint256 endTimestamp, uint256 snapshotMultiplier
    );

    /// @notice Emitted when a successor rate is pre-staged.
    /// @param newRate     Successor per-second rate
    /// @param activatesAt Timestamp the successor takes effect (= current okuMRateEnd)
    /// @param expiresAt   Timestamp the successor's own window elapses (bounds the
    ///                    overhang if it is left unattended past `activatesAt`)
    event NextOkuMYieldRateSet(uint256 newRate, uint256 activatesAt, uint256 expiresAt);

    /// @notice A minter's remaining allowance was set by `configureMinterAllowance`.
    /// @param minter       The minter (LitePSM in practice)
    /// @param oldAllowance Remaining allowance before the call
    /// @param newAllowance Allowance now (replaces, does not add)
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    /// @notice The supply cap was changed by `setMaxSupply`.
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    /// @notice `account` was added to OkuMoney's blacklist.
    event Blacklisted(address indexed account);
    /// @notice `account` was removed from OkuMoney's blacklist.
    event Unblacklisted(address indexed account);
}
