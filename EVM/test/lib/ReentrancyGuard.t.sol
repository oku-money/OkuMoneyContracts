// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuardHarness} from "../mocks/ReentrancyGuardHarness.sol";
import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ReentrancyGuardTest
 * @notice Branch-coverage tests for `ReentrancyGuardUpgradeable`. Drives the
 *         `ReentrancyGuardReentrantCall` revert path (line 62) which is only
 *         exercisable in production by composing a malicious external token —
 *         a brittle setup compared with this dedicated harness.
 */
contract ReentrancyGuardTest is Test {
    ReentrancyGuardHarness internal h;

    function setUp() public {
        h = new ReentrancyGuardHarness();
        h.init();
    }

    function test_NonReentrant_AllowsSingleEntry() public {
        h.noReenter();
        assertEq(h.counter(), 1);
        assertFalse(h.entered(), "guard must release after call");
    }

    function test_NonReentrant_AllowsSequentialEntries() public {
        h.noReenter();
        h.noReenter();
        h.noReenter();
        assertEq(h.counter(), 3);
    }

    function test_NonReentrant_RevertsOnReentry() public {
        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        h.enter(true);
    }

    function test_Init_DoubleInitReverts() public {
        // OZ Initializable rejects re-initialization (forwards to InvalidInitialization).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        h.init();
    }
}
