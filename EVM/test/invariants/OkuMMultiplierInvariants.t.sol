// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title OkuMPriceInvariantsTest
 * @notice Invariant tests for OkuMoney okuMMultiplier() monotonicity and balance consistency
 * @dev OkuMoney is a standard ERC-20: balanceOf() returns raw token amounts.
 *      okuMMultiplier() tracks multiplier appreciation separately and must never decrease.
 */
contract OkuMPriceInvariantsTest is BaseTest {
    OkuMoneyHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /**
     * @notice Actor balances never exceed totalSupply.
     * @dev Deliberately `<=`, not `==`: addresses outside the actor set (the
     *      PSM, the minter) also hold OkuM, so equality would not hold.
     */
    function invariant_ActorBalancesDoNotExceedTotalSupply() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfBalances = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfBalances += okuMoney.balanceOf(actors[i]);
        }

        // Sum of actor balances should not exceed total supply
        // (other addresses like minter may also hold tokens)
        assertLe(
            sumOfBalances,
            okuMoney.totalSupply(),
            "Sum of actor balances should not exceed totalSupply"
        );
    }

    /**
     * @notice okuMMultiplier() never decreases between observations.
     * @dev The ghost is written only in `afterInvariant`, i.e. AFTER this
     *      assertion, so it holds the previous observation and the comparison
     *      is meaningful across handler calls.
     */
    function invariant_OkuMPriceNeverDecreases() public view {
        uint256 current = okuMoney.okuMMultiplier();
        assertGe(current, PRECISION, "okuMMultiplier below initial value");
        assertGe(
            current,
            handler.ghostLastOkuMMultiplier(),
            "okuMMultiplier decreased between observations"
        );
    }

    function afterInvariant() public {
        handler.recordMultiplierObservation();
    }

    /**
     * @notice okuMMultiplier() does not affect totalSupply (non-rebasing)
     * @dev After a price update, totalSupply should remain unchanged.
     */
    function invariant_OkuMPriceDoesNotAffectSupply() public view {
        // totalSupply is always minted - burned, regardless of okuMMultiplier
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(
            okuMoney.totalSupply(),
            expectedSupply,
            "totalSupply should equal minted - burned regardless of okuMMultiplier"
        );
    }
}
