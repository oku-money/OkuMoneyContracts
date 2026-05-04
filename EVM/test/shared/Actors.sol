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

    address public usdRebaser = makeAddr("usdRebaser");
    address public reserveManager = makeAddr("reserveManager");
    address public vaultPauser = makeAddr("vaultPauser");
    address public vaultUnpauser = makeAddr("vaultUnpauser");

    // ============ LitePSM Roles ============

    address public queueProcessor = makeAddr("queueProcessor");
    address public bufferDepositor = makeAddr("bufferDepositor");
    address public bufferWithdrawer = makeAddr("bufferWithdrawer");
    address public oracleManager = makeAddr("oracleManager");

    // ============ RedemptionQueue Roles ============

    address public queueRescuer = makeAddr("queueRescuer");

    // ============ OkuBridge Roles ============

    address public bridgeSigner = makeAddr("bridgeSigner");
    address public bridgeFeeManager = makeAddr("bridgeFeeManager");
    address public refundInitiator = makeAddr("refundInitiator");
    address public refundConfirmer = makeAddr("refundConfirmer");
    address public nonceAdmin = makeAddr("nonceAdmin");
    address public chainManager = makeAddr("chainManager");
    address public limitsManager = makeAddr("limitsManager");

    // ============ OkuBridgeRouter Roles ============

    address public adapterManager = makeAddr("adapterManager");
    address public bridgeManager = makeAddr("bridgeManager");

    // ============ Generic Test Users ============

    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public user4 = makeAddr("user4");
    address public user5 = makeAddr("user5");

    // ============ Fee Recipients ============

    address public feeRecipient = makeAddr("feeRecipient");
    address public treasury = makeAddr("treasury");

    // ============ Signing keys (for EIP-712 / EIP-2612 tests) ============

    uint256 public constant orchestratorPk = TestKeys.ORCHESTRATOR_PK;
    uint256 public constant user1Pk = TestKeys.USER1_PK;
    uint256 public constant user2Pk = TestKeys.USER2_PK;
    uint256 public constant wrongPk = TestKeys.WRONG_PK;

    address public orchestratorSigner;

    /// @notice Initialize orchestrator signer address from its private key.
    /// @dev Called from BridgeBaseTest.setUp(). Other tests that need signed payloads
    ///      should call this themselves and reuse the existing key constants.
    function _initOrchestrator() internal {
        orchestratorSigner = vm.addr(orchestratorPk);
    }
}
