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
    /// @notice Emitted when a yield epoch begins streaming.
    /// @param yieldAmount     Realized dollar yield to distribute over the epoch (18 decimals)
    /// @param startMultiplier Multiplier at `startTime` (equals the pre-call multiplier —
    ///                        an epoch never introduces a discontinuity)
    /// @param endMultiplier   Multiplier the epoch will reach at `endTime`
    /// @param ratePerSecond   Per-second multiplier increment (linear)
    /// @param totalSupply     Supply snapshot used to derive the per-token increment
    /// @param startTime       Accrual start (indexed)
    /// @param endTime         Accrual end; multiplier flatlines past this
    /// @dev `totalSupply` is emitted because the per-token increment is derived from
    ///      it at call time. Supply moving during the epoch causes the delivered
    ///      total to drift from `yieldAmount`; indexers need the snapshot to
    ///      reconcile. See {OkuMoney.startYieldEpoch}.
    event YieldEpochStarted(
        uint256 yieldAmount,
        uint256 startMultiplier,
        uint256 endMultiplier,
        uint256 ratePerSecond,
        uint256 totalSupply,
        uint256 indexed startTime,
        uint256 endTime
    );

    /// @notice Emitted when a successor epoch is scheduled.
    /// @param yieldAmount   Realized dollar yield the successor will distribute
    /// @param ratePerSecond Per-second multiplier increment of the successor
    /// @param totalSupply   Supply snapshot used to derive the increment
    /// @param startTime     When the successor begins (indexed) — the current epoch's `endTime`
    /// @param endTime       When the successor ends
    event YieldEpochScheduled(
        uint256 yieldAmount,
        uint256 ratePerSecond,
        uint256 totalSupply,
        uint256 indexed startTime,
        uint256 endTime
    );

    /// @notice Emitted when a scheduled successor epoch is revoked before taking effect.
    /// @param startTime Start time of the cancelled epoch (indexed)
    /// @param endTime   End time of the cancelled epoch
    event YieldEpochCancelled(uint256 indexed startTime, uint256 endTime);

    /// @notice Emitted when accrual is halted, freezing the multiplier.
    /// @param frozenMultiplier Multiplier value at the moment of the halt
    /// @param hadPendingEpoch  Whether a scheduled successor was discarded
    event AccrualHalted(uint256 frozenMultiplier, bool hadPendingEpoch);

    /// @notice Emitted when accrual is un-halted, permitting new epochs.
    /// @param currentMultiplier Multiplier at the moment of resumption
    /// @dev Resuming does NOT restart accrual — the multiplier stays flat until a
    ///      new epoch is started. Backdated catch-up is impossible by construction.
    event AccrualResumed(uint256 currentMultiplier);

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
