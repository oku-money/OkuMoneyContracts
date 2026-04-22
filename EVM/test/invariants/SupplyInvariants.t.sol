// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title SupplyInvariantsTest
 * @notice Invariant tests for OkuMoney supply cap enforcement
 * @dev Updated for non-rebasing OkuMoney redesign. totalSupply() is standard ERC-20;
 *      okuMMultiplier() tracks multiplier appreciation separately.
 */
contract SupplyInvariantsTest is BaseTest {
    OkuMoneyHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(usdOku));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice Supply cap never exceeded
     * @dev OkuMoney is non-rebasing: totalSupply() is raw token count,
     *      okuMMultiplier() updates do not change totalSupply().
     */
    function invariant_SupplyCapRespected() public view {
        assertLe(okuMoney.totalSupply(), okuMoney.maxSupply(), "Supply exceeds maxSupply");
    }

    /**
     * @notice Minted total tracks with supply (minted - burned = totalSupply)
     */
    function invariant_MintBurnAccounting() public view {
        uint256 actualSupply = okuMoney.totalSupply();

        if (handler.ghostMintedTotal() == 0) {
            assertEq(actualSupply, 0, "Supply should be zero if nothing minted");
        }

        // totalSupply = minted - burned
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(actualSupply, expectedSupply, "Supply should equal minted - burned");
    }

    // NOTE: Handler success rate check moved to HandlerSanity.t.sol
}
