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
    /// @notice Emitted when the discrete emergency override {setOkuMMultiplier} re-anchors
    ///         the accrual base.
    /// @dev NOT emitted for normal streaming accrual (which is continuous and has no
    ///      discrete events) nor for rate-schedule changes (see {OkuMYieldRateUpdated}).
    /// @param oldMultiplier  Multiplier immediately before the override
    /// @param newMultiplier  New base multiplier
    /// @param totalSupply    Token supply at time of update
    /// @param blockNumber    `block.number` at update time (indexed, so
    ///                       subgraphs can shard yield events without
    ///                       re-deriving it from the log).
    event OkuMMultiplierUpdated(
        uint256 oldMultiplier,
        uint256 newMultiplier,
        uint256 totalSupply,
        uint256 indexed blockNumber
    );

    /// @notice Emitted when the active yield rate is set, re-anchoring the accrual base.
    /// @param oldRate            Previous per-second rate
    /// @param newRate            New per-second rate (PRECISION = no yield)
    /// @param endTimestamp       Timestamp the new rate expires (0 = open-ended)
    /// @param snapshotMultiplier Multiplier snapshotted as the new accrual base
    event OkuMYieldRateUpdated(
        uint256 oldRate, uint256 newRate, uint256 endTimestamp, uint256 snapshotMultiplier
    );

    /// @notice Emitted when a successor rate is pre-staged.
    /// @dev The successor activates off `activatesAt` with no transaction at the
    ///      boundary — the primitive that keeps cross-chain epoch handovers
    ///      simultaneous.
    /// @param newRate     Successor per-second rate
    /// @param activatesAt Timestamp the successor takes effect (= current okuMRateEnd)
    /// @param expiresAt   Timestamp the successor's own window elapses (bounds the
    ///                    overhang if it is left unattended past `activatesAt`)
    event NextOkuMYieldRateSet(uint256 newRate, uint256 activatesAt, uint256 expiresAt);

    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
}
