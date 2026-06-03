// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title TestKeys
 * @notice Centralized private keys used across the test suite.
 * @dev Moving keys here prevents accidental collisions where the same literal
 *      private key is used for multiple unrelated signers (e.g. permit signer
 *      and orchestrator signer share `0xA11CE`, which would let a single test
 *      sign for both roles by mistake).
 *
 *      All keys are arbitrary literals — never use these for any production purpose.
 */
library TestKeys {
    /// @notice Default user1 signing key (used by EIP-2612 permit tests).
    uint256 internal constant USER1_PK = 0xA11CE;

    /// @notice Default user2 signing key.
    uint256 internal constant USER2_PK = 0xB0B1E;

    /// @notice Orchestrator signing key. Originally used for OkuBridge EIP-712
    /// BridgeRequest signatures (removed in the noBridge refactor). Retained
    /// because the off-chain orchestrator concept persists (it just no longer
    /// signs on-chain payloads) and existing test scaffolding still references it.
    uint256 internal constant ORCHESTRATOR_PK = 0xC0FFEE;

    /// @notice An "always wrong" signing key for negative signature tests.
    uint256 internal constant WRONG_PK = 0xBADBAD;
}
