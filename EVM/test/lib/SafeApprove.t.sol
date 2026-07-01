// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeApprove} from "../../src/lib/SafeApprove.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title SafeApproveTest
 * @notice Unit tests for the SafeApprove library (approve-do-revoke pattern).
 */
contract SafeApproveTest is Test {
    using SafeApprove for IERC20;

    MockUSDC internal token;
    address internal spender = makeAddr("spender");

    function setUp() public {
        token = new MockUSDC();
    }

    function test_SetExactAllowance_SetsCorrectAmount() public {
        IERC20(address(token)).setExactAllowance(spender, 500e6);
        assertEq(token.allowance(address(this), spender), 500e6);
    }

    function test_SetExactAllowance_OverwritesPreviousAllowance() public {
        IERC20(address(token)).setExactAllowance(spender, 100e6);
        assertEq(token.allowance(address(this), spender), 100e6);

        IERC20(address(token)).setExactAllowance(spender, 200e6);
        assertEq(token.allowance(address(this), spender), 200e6);
    }

    function test_RevokeAllowance_ZerosAllowance() public {
        IERC20(address(token)).setExactAllowance(spender, 500e6);
        assertEq(token.allowance(address(this), spender), 500e6);

        IERC20(address(token)).revokeAllowance(spender);
        assertEq(token.allowance(address(this), spender), 0);
    }

    function test_RevokeAllowance_NoopWhenAlreadyZero() public {
        assertEq(token.allowance(address(this), spender), 0);
        IERC20(address(token)).revokeAllowance(spender);
        assertEq(token.allowance(address(this), spender), 0);
    }

    function test_SetExactAllowance_ZeroAmount() public {
        IERC20(address(token)).setExactAllowance(spender, 100e6);
        IERC20(address(token)).setExactAllowance(spender, 0);
        assertEq(token.allowance(address(this), spender), 0);
    }

    function testFuzz_SetAndRevoke_RoundTrip(uint256 amount) public {
        IERC20(address(token)).setExactAllowance(spender, amount);
        assertEq(token.allowance(address(this), spender), amount);

        IERC20(address(token)).revokeAllowance(spender);
        assertEq(token.allowance(address(this), spender), 0);
    }
}
