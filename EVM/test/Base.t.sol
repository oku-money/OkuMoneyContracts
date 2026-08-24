// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Roles} from "../src/lib/Roles.sol";

import {Actors} from "./shared/Actors.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title BaseTest
 * @notice Deploys the three-proxy stack and wires every role. Base for all suites.
 * @dev Deployment order is forced by the value-layer single-source-of-truth
 *      cross-assertions: the token must exist first, because `LitePSM.initialize`
 *      and `RedemptionQueue.initialize` both read `token.asset()` and
 *      `token.usdcDecimalMultiplier()` and revert on mismatch.
 *
 *      `QUEUE_PSM` is granted to the PSM proxy after both exist, mirroring the
 *      production deploy script.
 */
abstract contract BaseTest is Actors {
    // ============ Rate constants ============

    /// @notice ~5% APY per-second rate. This is the live rate that was running on
    ///         Sepolia when the May-2026 redemption incident surfaced; retained as
    ///         the default fixture rate so regression suites exercise the exact
    ///         multiplier trajectory that exposed it.
    uint256 internal constant RATE_5_PCT_APY = 1_000_000_001_546_176_000;
    /// @notice ~2% APY per-second rate.
    uint256 internal constant RATE_2_PCT_APY = 1_000_000_000_634_000_000;
    /// @notice ~10% APY per-second rate — at/near the `MAX_IMPLIED_APR` ceiling.
    uint256 internal constant RATE_10_PCT_APY = 1_000_000_003_022_265_980;

    uint256 internal constant INITIAL_MAX_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MINTER_ALLOWANCE = 1_000_000_000e18;

    // ============ Deployed system ============

    OkuDollar internal token;
    LitePSM internal litePsm;
    RedemptionQueue internal queue;
    MockUSDC internal usdc;

    function setUp() public virtual {
        _initOrchestrator();

        usdc = new MockUSDC();

        // 1. Token first — the PSM and queue cross-assert against it.
        OkuDollar tokenImpl = new OkuDollar();
        token = OkuDollar(
            address(
                new ERC1967Proxy(
                    address(tokenImpl),
                    abi.encodeCall(
                        OkuDollar.initialize,
                        ("Oku Dollar", "rUSDOku", address(usdc), admin, INITIAL_MAX_SUPPLY)
                    )
                )
            )
        );

        // 2. Queue.
        RedemptionQueue queueImpl = new RedemptionQueue();
        queue = RedemptionQueue(
            address(
                new ERC1967Proxy(
                    address(queueImpl),
                    abi.encodeCall(
                        RedemptionQueue.initialize, (address(token), address(usdc), admin)
                    )
                )
            )
        );

        // 3. PSM.
        LitePSM psmImpl = new LitePSM();
        litePsm = LitePSM(
            address(
                new ERC1967Proxy(
                    address(psmImpl),
                    abi.encodeCall(
                        LitePSM.initialize, (address(token), address(usdc), address(queue), admin)
                    )
                )
            )
        );

        _wireRoles();
    }

    function _wireRoles() internal {
        vm.startPrank(admin);

        // Contract grants: mint/burn never go to an EOA in production.
        token.grantRole(Roles.OKU_MINTER, address(litePsm));
        token.grantRole(Roles.OKU_BURNER, address(litePsm));
        token.grantRole(Roles.OKU_BURNER, address(queue));
        token.configureMinterAllowance(address(litePsm), MINTER_ALLOWANCE);

        // Post-deploy grant, deliberately not in `initialize`.
        queue.grantRole(Roles.QUEUE_PSM, address(litePsm));

        // Named-actor grants so tests can prank the specific role.
        token.grantRole(Roles.OKU_PAUSER, pauser);
        token.grantRole(Roles.OKU_UNPAUSER, unpauser);
        token.grantRole(Roles.OKU_MINTER, minter);
        token.grantRole(Roles.OKU_BURNER, burner);
        token.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        token.grantRole(Roles.OKU_GUARDIAN, guardian);
        token.grantRole(Roles.OKU_BLACKLISTER, blacklister);
        token.grantRole(Roles.OKU_UNBLACKLISTER, unblacklister);
        token.grantRole(Roles.OKU_CAP_MANAGER, capManager);
        token.grantRole(Roles.OKU_ALLOWANCE_MANAGER, allowanceManager);
        token.configureMinterAllowance(minter, MINTER_ALLOWANCE);

        litePsm.grantRole(Roles.PSM_PAUSER, psmPauser);
        litePsm.grantRole(Roles.PSM_UNPAUSER, psmUnpauser);
        litePsm.grantRole(Roles.PSM_QUEUE_PROCESSOR, queueProcessor);
        litePsm.grantRole(Roles.PSM_BUFFER_DEPOSITOR, bufferDepositor);
        litePsm.grantRole(Roles.PSM_BUFFER_WITHDRAWER, bufferWithdrawer);
        // Same cold actor as the token's cap manager: one key, two
        // correctly-scoped capabilities on two contracts.
        litePsm.grantRole(Roles.PSM_FEE_MANAGER, capManager);

        queue.grantRole(Roles.QUEUE_RESCUER, queueRescuer);

        vm.stopPrank();
    }

    // ============ Helpers ============

    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @dev Mint raw tokens directly via the `minter` actor, bypassing the PSM.
    function _mintRaw(address to, uint256 amount) internal {
        vm.prank(minter);
        token.mint(to, amount);
    }

    /// @dev Seed the PSM's USDC buffer.
    function _seedBuffer(uint256 usdcAmount) internal {
        usdc.mint(bufferDepositor, usdcAmount);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(litePsm), usdcAmount);
        litePsm.depositBuffer(usdcAmount);
        vm.stopPrank();
    }

    /// @dev Set a rate and warp forward, so `uiMultiplier()` is strictly above 1e18.
    ///      Clamps the warp to `rateEnd` so accrual is not silently truncated.
    function _accrue(uint256 ratePerSecond, uint256 seconds_) internal {
        uint256 duration =
            seconds_ > Constants.MAX_RATE_DURATION ? Constants.MAX_RATE_DURATION : seconds_;
        vm.prank(rateSetter);
        token.setYieldRate(ratePerSecond, block.timestamp + duration);
        vm.warp(block.timestamp + duration);
    }

    /// @dev Drive the multiplier to at least `target` by accruing at the APR cap
    ///      over repeated maximum-length segments.
    ///
    ///      ASSERTS on failure rather than giving up quietly. An earlier revision
    ///      returned silently once a small iteration budget was exhausted, which
    ///      made two tests pass vacuously against a multiplier that had never
    ///      reached the value under test.
    ///
    ///      Each segment multiplies by ~1.0082, so reaching `MAX_MULTIPLIER` would
    ///      need ~1,600 segments; defensive bounds that far out belong in
    ///      `ScaledUIHarness`, not here.
    function _accrueToAtLeast(uint256 target) internal {
        uint256 iterations;
        while (token.uiMultiplier() < target) {
            require(iterations < 2000, "_accrueToAtLeast: target unreachable by accrual");
            _accrue(RATE_10_PCT_APY, Constants.MAX_RATE_DURATION);
            iterations++;
        }
    }

    /// @dev Mint via the PSM: seeds USDC, approves, mints.
    function _psmMint(address user, uint256 usdcAmount) internal returns (uint256 rawOut) {
        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(litePsm), usdcAmount);
        rawOut = litePsm.mint(usdcAmount);
        vm.stopPrank();
    }
}
