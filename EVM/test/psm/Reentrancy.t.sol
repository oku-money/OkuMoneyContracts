// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LitePSM} from "../../src/psm/LitePSM.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {ReentrantOkuMoney} from "../mocks/ReentrantOkuMoney.sol";

/**
 * @title ReentrancyTest
 * @notice Verifies that `nonReentrant` guards on LitePSM block reentrant calls from a
 *         malicious OkuMoney token.
 * @dev Uses {ReentrantOkuMoney} whose `burn()` calls back into the PSM.
 *      This scenario is unreachable in production (OkuMoney is a controlled,
 *      standard ERC-20) but demonstrates that the guard is effective should a
 *      future upgrade ever introduce transfer hooks.
 */
contract ReentrancyTest is Test {
    ReentrantOkuMoney internal rOkuM;
    MockUSDC internal usdc;
    LitePSM internal litePsm;
    OkuDollar internal okuDollar;

    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");

    function setUp() public {
        // Deploy mocks
        rOkuM = new ReentrantOkuMoney();
        usdc = new MockUSDC();

        // Deploy OkuDollar
        OkuDollar dollarImpl = new OkuDollar();
        okuDollar = OkuDollar(
            address(
                new ERC1967Proxy(
                    address(dollarImpl),
                    abi.encodeCall(
                        OkuDollar.initialize, (address(rOkuM), "OkuDollar", "usdOku", admin)
                    )
                )
            )
        );

        // Deploy LitePSM
        LitePSM psmImpl = new LitePSM();
        litePsm = LitePSM(
            address(
                new ERC1967Proxy(
                    address(psmImpl),
                    abi.encodeCall(
                        LitePSM.initialize,
                        (address(rOkuM), address(okuDollar), address(usdc), admin)
                    )
                )
            )
        );

        // Fund user with USDC and OkuM
        usdc.mint(user, 1000e6);
        rOkuM.mint(user, 1000e18);
        rOkuM.mint(address(litePsm), 1000e18); // PSM holds OkuM for burn
        usdc.mint(address(litePsm), 1000e6); // PSM buffer

        // Approve PSM
        vm.startPrank(user);
        IERC20(address(rOkuM)).approve(address(litePsm), type(uint256).max);
        usdc.approve(address(litePsm), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Verify that a reentrant callback from `burn()` into `mintOkuM`
    ///         during `redeemOkuM` is blocked by `nonReentrant`.
    function test_RedeemOkuM_ReentrantMintOkuM_Reverts() public {
        // Configure rOkuM to call litePsm.mintOkuM(100e6) on burn
        rOkuM.setReentrantCallback(address(litePsm), abi.encodeCall(LitePSM.mintOkuM, (100e6)));

        // The redeemOkuM call should revert because the reentrant callback
        // into mintOkuM hits the nonReentrant guard.
        vm.prank(user);
        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        litePsm.redeemOkuM(100e18);
    }
}
