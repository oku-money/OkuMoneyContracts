// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {USDOkuWrapper} from "../src/wrapper/USDOkuWrapper.sol";
import {SubscriptionModule} from "../src/subscription/SubscriptionModule.sol";
import {Roles} from "../src/lib/Roles.sol";
import {Constants} from "../src/lib/Constants.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Deploy} from "./shared/Deploy.sol";

/**
 * @title BaseTest
 * @notice Shared fixture: four proxies wired as production expects, plus the
 *         contract-only role grants and helpers for driving both multipliers.
 * @dev Deliberately mirrors the real deploy sequence rather than shortcutting it,
 *      because two of the sharpest edges in this system are ordering-dependent:
 *      `SubscriptionModule` cross-asserts `okuM.asset()` at init, and
 *      `USDOku.setUsdOkuRate` fails closed until `setWrapper` is called.
 */
abstract contract BaseTest is Test {
    uint256 internal constant MAX_SUPPLY = 1e9 * 1e18;
    uint256 internal constant USDC_UNIT = 1e6;
    /// @dev `10**(18-6)` — matches what OkuM derives from MockUSDC at init.
    uint256 internal constant DECIMAL_MULTIPLIER = 1e12;

    OkuM internal okuM;
    USDOku internal usdOku;
    USDOkuWrapper internal wrapper;
    SubscriptionModule internal module;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal rateSetter = makeAddr("rateSetter");
    address internal fulfiller = makeAddr("fulfiller");
    address internal guardian = makeAddr("guardian");
    address internal resumer = makeAddr("resumer");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual {
        usdc = new MockUSDC();

        (okuM,) = Deploy.okuM(admin, MAX_SUPPLY, address(usdc));
        (module,) = Deploy.subscriptionModule(address(okuM), address(usdc), admin, treasury);
        (usdOku,) = Deploy.usdOku(admin);
        (wrapper,) = Deploy.wrapper(address(okuM), address(usdOku), admin);

        vm.startPrank(admin);

        // Contract-only supply authority: the module mints/burns OkuM, the
        // wrapper mints/burns USDOku. Neither holds the other's, and no EOA
        // holds either once production wiring revokes admin's grant.
        okuM.grantRole(Roles.OKU_MINTER, address(module));
        okuM.grantRole(Roles.OKU_BURNER, address(module));
        okuM.configureMinterAllowance(address(module), MAX_SUPPLY);
        usdOku.grantRole(Roles.OKU_MINTER, address(wrapper));
        usdOku.grantRole(Roles.OKU_BURNER, address(wrapper));

        // Operational keys.
        okuM.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        okuM.grantRole(Roles.OKU_GUARDIAN, guardian);
        okuM.grantRole(Roles.OKU_ACCRUAL_RESUMER, resumer);
        okuM.grantRole(Roles.OKU_PAUSER, pauser);
        usdOku.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        usdOku.grantRole(Roles.OKU_GUARDIAN, guardian);
        usdOku.grantRole(Roles.OKU_ACCRUAL_RESUMER, resumer);
        module.grantRole(Roles.REQUEST_FULFILLER, fulfiller);

        // Post-deploy wiring with no on-chain default.
        usdOku.setWrapper(address(wrapper));

        vm.stopPrank();

        // Treasury funds redemption fulfillment via allowance, not a buffer.
        usdc.mint(treasury, 100_000_000 * USDC_UNIT);
        vm.prank(treasury);
        usdc.approve(address(module), type(uint256).max);
    }

    // ============ Helpers ============

    /// @dev Mint OkuM to `to` by driving a full subscription request/fulfill cycle,
    ///      so balances arrive the same way they will in production.
    function _subscribe(address to, uint256 usdcAmount) internal returns (uint256 rawOut) {
        usdc.mint(to, usdcAmount);
        vm.startPrank(to);
        usdc.approve(address(module), usdcAmount);
        uint256 requestId = module.requestSubscription(usdcAmount, 0);
        vm.stopPrank();

        uint256 before = okuM.balanceOf(to);
        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);
        rawOut = okuM.balanceOf(to) - before;
    }

    /// @dev Step `M_oku` up by `bps`, respecting MAX_STEP_BPS and epoch ordering.
    /// @dev Every read is hoisted above `vm.prank` deliberately: arguments are
    ///      evaluated before the call, so an inline `okuM.syncEpoch()` would
    ///      consume the prank and the step would be attempted by the test
    ///      contract instead of `rateSetter`.
    function _stepOkuMultiplier(uint256 bps) internal {
        uint256 current = okuM.uiMultiplier();
        uint256 next = current + (current * bps) / Constants.BASIS_POINTS;
        uint256 nextEpoch = okuM.syncEpoch() + 1;
        vm.prank(rateSetter);
        okuM.setOkuMultiplier(next, nextEpoch);
    }

    /// @dev Accrue `M_usd` by running a rate for `duration`, then warping past it.
    /// @dev The wrapper must already hold enough OkuM to cover the liability this
    ///      rate projects — see {_prefundWrapper}. `MAX_SOLVENCY_GAP_BPS == 0`, so
    ///      an unfunded rate reverts `SolvencyGapExceeded`.
    function _accrueUsdOku(uint256 ratePerSecond, uint256 duration) internal {
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(ratePerSecond, block.timestamp + duration);
        vm.warp(block.timestamp + duration);
    }

    /// @dev Transfer OkuM into the wrapper so a forward rate can be declared.
    ///      This is the pre-funding step the design requires: the issuer funds the
    ///      yield before promising it. Funding arrives as a plain ERC-20 transfer;
    ///      there is deliberately no privileged deposit path.
    function _prefundWrapper(uint256 usdcAmount) internal returns (uint256 okuMFunded) {
        address funder = makeAddr("issuerTreasury");
        okuMFunded = _subscribe(funder, usdcAmount);
        vm.prank(funder);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuM.transfer(address(wrapper), okuMFunded);
    }

    /// @dev Per-second rate for a given nominal (simple) APR in bps.
    function _ratePerSecondForAprBps(uint256 aprBps) internal pure returns (uint256) {
        return Constants.PRECISION + (Constants.PRECISION * aprBps / Constants.BASIS_POINTS)
            / Constants.SECONDS_PER_YEAR;
    }

    /// @dev Sign an ERC-2612 permit for either token. `domainSeparator` selects
    ///      which one, so a signature is never valid across both.
    function _signPermit(
        uint256 privateKey,
        bytes32 domainSeparator,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    )
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return
            vm.sign(
                privateKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
            );
    }
}
