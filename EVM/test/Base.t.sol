// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Roles} from "../src/lib/Roles.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title BaseTest
 * @notice Shared fixture: deployed proxies, wired roles, named actors.
 *
 * @dev A note on a foundry footgun this suite hits repeatedly: `vm.prank` and
 *      `vm.expectRevert` are consumed by ARGUMENT EVALUATION. An inline
 *      `okuM.uiMultiplier()` inside a call that follows `vm.prank` spends the prank
 *      on the view, and the real call executes as the test contract. Every read is
 *      therefore hoisted above the cheatcode, deliberately, throughout.
 */
abstract contract BaseTest is Test {
    OkuM internal okuM;
    USDOku internal usdOku;
    LitePSM internal psm;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal rateSetter = makeAddr("rateSetter");
    address internal gatekeeper = makeAddr("gatekeeper");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant USDC_UNIT = 1e6;
    uint256 internal constant INITIAL_MAX_SUPPLY = 1e9 * 1e18;

    function setUp() public virtual {
        // A non-zero start time: at timestamp 0 every segment anchor collapses and
        // whole classes of ordering bug become invisible.
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();

        okuM = OkuM(
            address(
                new ERC1967Proxy(
                    address(new OkuM()),
                    abi.encodeCall(
                        OkuM.initialize, ("Oku Money", "OkuM", admin, INITIAL_MAX_SUPPLY)
                    )
                )
            )
        );

        usdOku = USDOku(
            address(
                new ERC1967Proxy(
                    address(new USDOku()),
                    abi.encodeCall(
                        USDOku.initialize, ("Oku Dollar", "USDOku", address(okuM), admin)
                    )
                )
            )
        );

        psm = LitePSM(
            address(
                new ERC1967Proxy(
                    address(new LitePSM()),
                    abi.encodeCall(LitePSM.initialize, (address(okuM), address(usdc), admin))
                )
            )
        );

        vm.startPrank(admin);
        okuM.grantRole(Roles.OKUM_RATE_SETTER, rateSetter);
        okuM.grantRole(Roles.OKUM_MINTER, address(psm));
        okuM.grantRole(Roles.OKUM_BURNER, address(psm));
        okuM.configureMinterAllowance(address(psm), INITIAL_MAX_SUPPLY);

        okuM.grantRole(Roles.OKUM_MINTER, address(usdOku));
        okuM.configureMinterAllowance(address(usdOku), INITIAL_MAX_SUPPLY);

        usdOku.grantRole(Roles.VAULT_RATE_SETTER, rateSetter);

        psm.grantRole(Roles.PSM_GATEKEEPER, gatekeeper);
        vm.stopPrank();

        vm.prank(gatekeeper);
        psm.openWindow();
    }

    // ============ Helpers ============

    /// @dev Per-second rate delivering `aprBps` nominal (simple) APR.
    function _rateFor(uint256 aprBps) internal pure returns (uint256) {
        return Constants.PRECISION + (Constants.PRECISION * aprBps / Constants.BASIS_POINTS)
            / Constants.SECONDS_PER_YEAR;
    }

    /// @dev Declare an OkuM segment starting now for `duration` at `aprBps`.
    ///      `setOkuMRate` does not gate on the PSM window — a routine declaration
    ///      moves slope, not level — so this is a plain single-prank call.
    function _setOkuMRate(uint256 aprBps, uint256 duration) internal {
        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(aprBps);
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + duration);

        vm.prank(rateSetter);
        okuM.setOkuMRate(base, rate, start, end, 0);
    }

    /// @dev Declare a USDOku segment starting now for `duration` at `aprBps`.
    function _setUsdOkuRate(uint256 aprBps, uint256 duration) internal {
        uint256 base = usdOku.usdOkuIndex();
        uint256 rate = _rateFor(aprBps);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(
            base, rate, uint64(block.timestamp), uint64(block.timestamp + duration)
        );
    }

    /// @dev Buy OkuM through the PSM the way a real user would.
    function _mint(address to, uint256 usdcAmount) internal returns (uint256 okuMOut) {
        usdc.mint(to, usdcAmount);
        vm.startPrank(to);
        usdc.approve(address(psm), usdcAmount);
        okuMOut = psm.mintOkuM(usdcAmount, 0);
        vm.stopPrank();
    }

    /// @dev Seed the PSM's redemption buffer.
    function _fundBuffer(uint256 usdcAmount) internal {
        usdc.mint(address(this), usdcAmount);
        usdc.approve(address(psm), usdcAmount);
        psm.depositBuffer(usdcAmount);
    }

    /// @dev Put OkuM into the vault so USDOku can declare a forward rate.
    function _fundVault(uint256 usdcAmount) internal returns (uint256 okuMFunded) {
        address funder = makeAddr("issuerTreasury");
        okuMFunded = _mint(funder, usdcAmount);
        vm.startPrank(funder);
        IERC20(address(okuM)).approve(address(usdOku), okuMFunded);
        usdOku.depositReserves(okuMFunded);
        vm.stopPrank();
    }

    /// @dev Wrap OkuM into USDOku.
    function _wrap(address who, uint256 okuMAmount) internal returns (uint256 usdOut) {
        vm.startPrank(who);
        IERC20(address(okuM)).approve(address(usdOku), okuMAmount);
        usdOut = usdOku.wrap(okuMAmount, who, 0);
        vm.stopPrank();
    }

    /// @dev Sign an ERC-2612 permit for either token; `domainSeparator` selects which,
    ///      so a signature is never valid across both.
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
