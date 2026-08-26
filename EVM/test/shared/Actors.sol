// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestKeys} from "./Keys.sol";

/**
 * @title Actors
 * @notice Named test actors with deterministic addresses, one per role.
 * @dev Names mirror `src/lib/Roles.sol` so a test's `vm.prank` reads as the role
 *      being exercised. The v1 vault actors (`usdRebaser`, `reserveManager`,
 *      `vaultPauser`, `vaultUnpauser`) are gone with the vault; `rebaser` is
 *      renamed `rateSetter` to match `OKU_RATE_SETTER`.
 */
abstract contract Actors is Test {
    // ============ Admin / governance ============

    address public admin = makeAddr("admin");

    // ============ Token roles (OkuM + USDOku) ============

    address public pauser = makeAddr("pauser");
    address public unpauser = makeAddr("unpauser");
    address public minter = makeAddr("minter");
    address public burner = makeAddr("burner");
    address public rateSetter = makeAddr("rateSetter");
    address public guardian = makeAddr("guardian");
    address public blacklister = makeAddr("blacklister");
    address public unblacklister = makeAddr("unblacklister");
    address public capManager = makeAddr("capManager");
    address public allowanceManager = makeAddr("allowanceManager");

    // ============ SubscriptionModule roles ============

    address public psmPauser = makeAddr("psmPauser");
    address public psmUnpauser = makeAddr("psmUnpauser");
    address public queueProcessor = makeAddr("queueProcessor");
    address public bufferDepositor = makeAddr("bufferDepositor");
    address public bufferWithdrawer = makeAddr("bufferWithdrawer");

    // ============ RedemptionQueue roles ============

    address public queueRescuer = makeAddr("queueRescuer");

    // ============ USDOkuWrapper roles ============

    address public wrapperAdmin = makeAddr("wrapperAdmin");
    address public wrapperReserveManager = makeAddr("wrapperReserveManager");
    address public wrapperPauser = makeAddr("wrapperPauser");
    address public wrapperUnpauser = makeAddr("wrapperUnpauser");

    // ============ Generic users ============

    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public user4 = makeAddr("user4");
    address public user5 = makeAddr("user5");

    address public treasury = makeAddr("treasury");

    // ============ Signing keys (EIP-712 / EIP-2612) ============

    uint256 public constant orchestratorPk = TestKeys.ORCHESTRATOR_PK;
    uint256 public constant user1Pk = TestKeys.USER1_PK;
    uint256 public constant user2Pk = TestKeys.USER2_PK;
    uint256 public constant wrongPk = TestKeys.WRONG_PK;

    address public orchestratorSigner;

    function _initOrchestrator() internal {
        orchestratorSigner = vm.addr(orchestratorPk);
    }
}
