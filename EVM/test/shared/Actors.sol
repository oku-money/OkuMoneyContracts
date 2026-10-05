// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestKeys} from "./Keys.sol";

/**
 * @title Actors
 * @notice Named test actors with deterministic addresses
 * @dev Use this contract as a base to get consistent actor addresses across all tests.
 *      Each actor has a descriptive name matching their role in the system.
 *      Private keys are sourced from TestKeys to prevent collision.
 */
abstract contract Actors is Test {
    // ============ Admin / Governance ============

    address public admin = makeAddr("admin");

    // ============ OkuMoney Roles ============

    address public pauser = makeAddr("pauser");
    address public unpauser = makeAddr("unpauser");
    address public minter = makeAddr("minter");
    address public rebaser = makeAddr("rebaser");
    address public blacklister = makeAddr("blacklister");
    address public unblacklister = makeAddr("unblacklister");
    address public capManager = makeAddr("capManager");
    address public allowanceManager = makeAddr("allowanceManager");

    // ============ OkuDollar Vault Roles ============

    address public vaultPauser = makeAddr("vaultPauser");
    address public vaultUnpauser = makeAddr("vaultUnpauser");
    address public vaultRescuer = makeAddr("vaultRescuer");
    // REMOVED (single-multiplier refactor): usdRebaser (VAULT_REBASER is gone; the
    // rate lives on OkuMoney and is driven by `rebaser`) and reserveManager
    // (VAULT_RESERVE_MANAGER is gone; collateralization is 1.0 by construction).

    // ============ LitePSM Roles ============

    address public queueProcessor = makeAddr("queueProcessor");
    address public bufferDepositor = makeAddr("bufferDepositor");
    address public bufferWithdrawer = makeAddr("bufferWithdrawer");

    // ============ RedemptionQueue Roles ============

    address public queueRescuer = makeAddr("queueRescuer");

    // OkuBridge / OkuBridgeRouter actor aliases were removed in the noBridge
    // refactor. If those contracts return, restore the named actors from the
    // master branch.

    // ============ Generic Test Users ============

    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public user4 = makeAddr("user4");
    address public user5 = makeAddr("user5");

    // ============ Generic Recipients ============

    /// @dev Not fee-related despite the name history; used as a generic
    ///      recipient address in `rescueDonation` tests.
    address public treasury = makeAddr("treasury");

    // ============ Signing keys (for EIP-712 / EIP-2612 tests) ============

    uint256 public constant orchestratorPk = TestKeys.ORCHESTRATOR_PK;
    uint256 public constant user1Pk = TestKeys.USER1_PK;
    uint256 public constant user2Pk = TestKeys.USER2_PK;
    uint256 public constant wrongPk = TestKeys.WRONG_PK;

    address public orchestratorSigner;

    /// @notice Initialize orchestrator signer address from its private key.
    /// @dev The bridge tests that consumed this helper were removed in the
    ///      noBridge refactor. Retained because EIP-2612 permit tests still
    ///      reuse the orchestrator key.
    function _initOrchestrator() internal {
        orchestratorSigner = vm.addr(orchestratorPk);
    }
}
