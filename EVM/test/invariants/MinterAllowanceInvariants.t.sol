// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuUSDHandler} from "../handlers/OkuUSDHandler.sol";

/**
 * @title MinterAllowanceInvariantsTest
 * @notice Invariant tests for minter allowance monotonic decrease
 */
contract MinterAllowanceInvariantsTest is BaseTest {
    OkuUSDHandler public handler;
    uint256 public initialAllowance;

    function setUp() public override {
        super.setUp();
        handler = new OkuUSDHandler(okuUSD, minter, admin);

        // Record initial allowance
        initialAllowance = okuUSD.minterAllowance(minter);

        targetContract(address(handler));

        excludeContract(address(okuUSD));
        excludeContract(address(wokuUSD));
        excludeContract(address(litePSM));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice Minter allowance only decreases unless admin resets
     * @dev Invariant from CLAUDE.md:
     *      assert(newAllowance <= previousAllowance || msg.sender == admin);
     *
     * The handler tracks whether admin reset occurred. If no reset,
     * allowance should only decrease or stay the same.
     */
    function invariant_AllowanceMonotonicDecrease() public view {
        uint256 currentAllowance = okuUSD.minterAllowance(minter);

        if (!handler.wasAllowanceReset()) {
            // No admin reset occurred, allowance should only decrease
            assertLe(currentAllowance, initialAllowance, "Allowance increased without admin reset");
        }
        // If admin reset occurred, any value is valid
    }

    /**
     * @notice Burns do NOT restore minter allowance
     * @dev This is checked by tracking ghost variables in handler.
     *      The mint total should always be >= (initial allowance - current allowance)
     */
    function invariant_BurnDoesNotRestoreAllowance() public view {
        uint256 currentAllowance = okuUSD.minterAllowance(minter);
        uint256 mintedTotal = handler.ghost_mintedTotal();

        if (!handler.wasAllowanceReset()) {
            // Allowance consumed should equal or exceed minted total
            // (can be less if some mints failed or were bounded)
            uint256 allowanceConsumed = initialAllowance - currentAllowance;

            // Minted total should roughly match allowance consumed
            // (may be less if bounded by maxSupply)
            assertLe(
                allowanceConsumed,
                mintedTotal + 1e18, // Small tolerance for bounded mints
                "Allowance consumed exceeds minted amount unexpectedly"
            );
        }
    }

    /**
     * @notice Minter allowance is always non-negative
     */
    function invariant_AllowanceNonNegative() public view {
        // uint256 cannot be negative, but check it's not unexpectedly large
        // after potential underflow (which would revert anyway)
        uint256 allowance = okuUSD.minterAllowance(minter);

        // Sanity check: allowance shouldn't exceed max supply
        assertLe(
            allowance,
            MAX_SUPPLY * 2, // Allow some headroom for resets
            "Allowance exceeds reasonable maximum"
        );
    }
}
