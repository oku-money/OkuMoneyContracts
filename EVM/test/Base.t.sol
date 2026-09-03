// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OkuMoney} from "../src/token/OkuMoney.sol";
import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {TestConstants} from "./shared/Constants.sol";
import {TestRoles} from "./shared/Roles.sol";
import {Actors} from "./shared/Actors.sol";
import {Deploy} from "./shared/Deploy.sol";

/**
 * @title BaseTest
 * @notice Base test contract with deployment helpers, actors, and utility functions
 * @dev Updated for OkuMoney non-rebasing redesign. OkuMoney is a standard ERC-20 with
 *      okuMMultiplier() tracking the dollar value per token separately from balanceOf().
 *      See Constants.sol for terminology legend.
 *
 *      Uses shared scaffolding:
 *      - TestConstants: All numeric constants (re-exported from src + test-only)
 *      - TestRoles: All role keccaks (re-exported from src + DEFAULT_ADMIN_ROLE)
 *      - Actors: Named test actors with deterministic addresses
 *      - Deploy: Proxy deployment helpers
 */
abstract contract BaseTest is Test, Actors {
    // ============ Re-exported Constants ============

    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_SUPPLY = TestConstants.MAX_SUPPLY;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;
    uint256 public constant MAX_RATE = TestConstants.MAX_RATE;
    uint256 public constant BASIS_POINTS = TestConstants.BASIS_POINTS;

    // ============ Re-exported Roles ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = TestRoles.DEFAULT_ADMIN_ROLE;

    // OkuMoney roles (OKUM_ prefix)
    bytes32 public constant OKUM_UPGRADER = TestRoles.OKUM_UPGRADER;
    bytes32 public constant OKUM_PAUSER = TestRoles.OKUM_PAUSER;
    bytes32 public constant OKUM_UNPAUSER = TestRoles.OKUM_UNPAUSER;
    bytes32 public constant OKUM_MINTER = TestRoles.OKUM_MINTER;
    /// @dev Cycle 4 (EVM-15): burn-only role.
    bytes32 public constant OKUM_BURNER = TestRoles.OKUM_BURNER;
    bytes32 public constant OKUM_REBASER = TestRoles.OKUM_REBASER;
    bytes32 public constant OKUM_BLACKLISTER = TestRoles.OKUM_BLACKLISTER;
    bytes32 public constant OKUM_UNBLACKLISTER = TestRoles.OKUM_UNBLACKLISTER;
    bytes32 public constant OKUM_CAP_MANAGER = TestRoles.OKUM_CAP_MANAGER;
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = TestRoles.OKUM_ALLOWANCE_MANAGER;

    // OkuDollar vault roles (VAULT_ prefix)
    bytes32 public constant VAULT_UPGRADER = TestRoles.VAULT_UPGRADER;
    bytes32 public constant VAULT_PAUSER = TestRoles.VAULT_PAUSER;
    bytes32 public constant VAULT_UNPAUSER = TestRoles.VAULT_UNPAUSER;
    bytes32 public constant VAULT_RESCUER = TestRoles.VAULT_RESCUER;
    // REMOVED (single-multiplier refactor): VAULT_REBASER, VAULT_RESERVE_MANAGER,
    // VAULT_ADMIN — see TestRoles.

    // LitePSM roles (PSM_ prefix)
    bytes32 public constant PSM_UPGRADER = TestRoles.PSM_UPGRADER;
    bytes32 public constant PSM_PAUSER = TestRoles.PSM_PAUSER;
    bytes32 public constant PSM_UNPAUSER = TestRoles.PSM_UNPAUSER;
    bytes32 public constant PSM_QUEUE_PROCESSOR = TestRoles.PSM_QUEUE_PROCESSOR;
    bytes32 public constant PSM_BUFFER_DEPOSITOR = TestRoles.PSM_BUFFER_DEPOSITOR;
    bytes32 public constant PSM_BUFFER_WITHDRAWER = TestRoles.PSM_BUFFER_WITHDRAWER;
    // RedemptionQueue roles (QUEUE_ prefix)
    bytes32 public constant QUEUE_PSM = TestRoles.QUEUE_PSM;
    bytes32 public constant QUEUE_UPGRADER = TestRoles.QUEUE_UPGRADER;
    bytes32 public constant QUEUE_RESCUER = TestRoles.QUEUE_RESCUER;

    // ============ Contracts ============

    OkuMoney public okuMoney;
    OkuMoney public okuMoneyImpl;
    OkuDollar public okuDollar;
    OkuDollar public okuDollarImpl;
    LitePSM public litePsm;
    LitePSM public litePsmImpl;
    RedemptionQueue public redemptionQueue;
    RedemptionQueue public redemptionQueueImpl;
    MockUSDC public usdc;

    // ============ Setup ============

    function setUp() public virtual {
        _deployContracts();
        _setupRoles();
        _setupMinterAllowances();
    }

    function _deployContracts() internal {
        // Deploy mocks
        usdc = new MockUSDC();

        // Deploy OkuMoney
        (okuMoney, okuMoneyImpl) = Deploy.deployOkuMoney(admin);

        // Deploy OkuDollar vault
        (okuDollar, okuDollarImpl) = Deploy.deployOkuDollar(address(okuMoney), admin);

        // Deploy RedemptionQueue
        (redemptionQueue, redemptionQueueImpl) =
            Deploy.deployRedemptionQueue(address(okuMoney), address(usdc), admin);

        // Deploy LitePSM
        (litePsm, litePsmImpl) = Deploy.deployLitePSM(
            address(okuMoney), address(okuDollar), address(usdc), address(redemptionQueue), admin
        );
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuMoney roles - Granular RBAC (OKUM_ prefix)
        // Cycle 4 (EVM-15): OKUM_BURNER split from OKUM_MINTER. Mint
        // and burn now require explicit grants; tests grant both
        // together because every minter in this setup is also a burner.
        okuMoney.grantRole(OKUM_PAUSER, pauser);
        okuMoney.grantRole(OKUM_UNPAUSER, unpauser);
        okuMoney.grantRole(OKUM_MINTER, minter);
        okuMoney.grantRole(OKUM_BURNER, minter);
        okuMoney.grantRole(OKUM_MINTER, address(litePsm)); // PSM can mint
        okuMoney.grantRole(OKUM_BURNER, address(litePsm)); // PSM can burn
        okuMoney.grantRole(OKUM_REBASER, rebaser);
        okuMoney.grantRole(OKUM_BLACKLISTER, blacklister);
        okuMoney.grantRole(OKUM_UNBLACKLISTER, unblacklister);
        okuMoney.grantRole(OKUM_CAP_MANAGER, capManager);
        okuMoney.grantRole(OKUM_ALLOWANCE_MANAGER, allowanceManager);

        // OkuDollar vault roles (VAULT_ prefix)
        // REMOVED (single-multiplier refactor): VAULT_REBASER / VAULT_RESERVE_MANAGER
        // grants — those roles no longer exist.
        okuDollar.grantRole(VAULT_RESCUER, vaultRescuer);
        okuDollar.grantRole(VAULT_PAUSER, vaultPauser);
        okuDollar.grantRole(VAULT_UNPAUSER, vaultUnpauser);
        // OkuDollar blacklist (shared OKUM_ roles — one grant covers both tokens)
        okuDollar.grantRole(OKUM_BLACKLISTER, blacklister);
        okuDollar.grantRole(OKUM_UNBLACKLISTER, unblacklister);

        // LitePSM roles - Granular RBAC (PSM_ prefix)
        litePsm.grantRole(PSM_PAUSER, pauser);
        litePsm.grantRole(PSM_UNPAUSER, unpauser);
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, queueProcessor);
        litePsm.grantRole(PSM_BUFFER_DEPOSITOR, bufferDepositor);
        litePsm.grantRole(PSM_BUFFER_WITHDRAWER, bufferWithdrawer);
        // RedemptionQueue roles (QUEUE_ prefix)
        redemptionQueue.grantRole(QUEUE_PSM, address(litePsm));
        redemptionQueue.grantRole(QUEUE_RESCUER, queueRescuer);

        // Grant RedemptionQueue burn role on OkuMoney (self-burn in
        // processQueue). Cycle 4: only OKUM_BURNER is required for the
        // burn path now — minting is not needed.
        okuMoney.grantRole(OKUM_BURNER, address(redemptionQueue));

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        // allowanceManager has OKUM_ALLOWANCE_MANAGER role on OkuMoney
        vm.startPrank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(litePsm), MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(redemptionQueue), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuMoney tokens to a user (raw token amount, no share conversion)
    function _mintOkuMoney(address to, uint256 amount) internal {
        vm.prank(minter);
        okuMoney.mint(to, amount);
    }

    /// @notice Mint OkuDollar tokens to a user via wrap flow (multiplier-aware)
    function _mintUsdOku(address to, uint256 okuMAmount) internal {
        // Mint OkuMoney to the to address first
        _mintOkuMoney(to, okuMAmount);
        // Approve vault to pull OkuMoney
        vm.startPrank(to);
        IERC20(address(okuMoney)).approve(address(okuDollar), okuMAmount);
        // Wrap OkuMoney into OkuDollar (0 minAmountOut for test helpers)
        okuDollar.wrap(okuMAmount, to, 0);
        vm.stopPrank();
    }

    /// @notice Mint USDC tokens to a user
    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuMoney spending
    function _approveOkuMoney(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuMoney.approve(spender, amount);
    }

    /// @notice Approve OkuDollar spending
    function _approveOkuDollar(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuDollar.approve(spender, amount);
    }

    /// @notice Approve USDC spending
    function _approveUsdc(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdc.approve(spender, amount);
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuMoney.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier (strictly above current, up to 2x).
    /// @dev Tightened from 10x to 2x for more realistic scenarios.
    ///      `setOkuMMultiplier` requires strict increase, so the lower bound is
    ///      `current + 1`. Tests that need the no-op semantics should call the
    ///      contract directly and assert the revert.
    function _boundOkuMMultiplier(uint256 mult) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        return bound(mult, current + 1, current * TestConstants.MAX_MULTIPLIER_FACTOR);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier increase (0.01% to 100%)
    function _boundOkuMMultiplierIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        return bound(increase, current / 10_000, current);
    }

    /// @notice Bound price to realistic fuzz range (capped at MAX_FUZZ_PRICE)
    function _boundPrice(uint256 price) internal pure returns (uint256) {
        return bound(price, PRECISION, TestConstants.MAX_FUZZ_PRICE);
    }

    /// @notice Get minimum of two values
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Get maximum of two values
    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice Stamp `lastYieldDistributionBlock` on OkuMoney for the current block.
    /// @dev REPLACES `distributeYield(...)`, which was deleted in the streaming-accrual
    ///      refactor. `setOkuMMultiplier` is now the ONLY function that stamps the
    ///      sandwich-guard block (continuous accrual creates no step, so
    ///      `setOkuMYieldRate` deliberately does not stamp). Bumps the multiplier by
    ///      the smallest legal increment, since a non-increasing value reverts.
    function _stampYieldLockBlock() internal {
        // Read BEFORE the prank: `vm.prank` applies to the next call, and an inline
        // `okuMoney.okuMMultiplier()` argument would consume it as a staticcall,
        // leaving `setOkuMMultiplier` to execute as the test contract (no role).
        uint256 next = okuMoney.okuMMultiplier() + 1;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(next);
    }

    /// @notice Set OkuMoney multiplier and roll to next block to avoid yield distribution lock
    /// @dev Use this helper when testing multiplier-aware operations that would be blocked
    ///      in the same block as a multiplier change (sandwich attack prevention).
    function _setOkuMMultiplierAndRoll(uint256 newMultiplier) internal {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newMultiplier);
        vm.roll(block.number + 1);
    }

    /// @notice Elevate the (single) multiplier to at least `targetMultiplier`.
    /// @dev SINGLE MULTIPLIER: `okuDollar.usdMultiplier()` is exactly
    ///      `okuMoney.okuMMultiplier()`, so this drives the OkuMoney rate schedule.
    ///      Retains the historical name because many tests call it; see
    ///      {_elevateOkuMMultiplier} for the alias.
    ///
    ///      Uses `setOkuMYieldRate` + `vm.warp` rather than the discrete
    ///      `setOkuMMultiplier` override so no `lastYieldDistributionBlock` stamp is
    ///      left behind (which would block PSM/vault ops for the rest of the block).
    function _elevateUsdMultiplier(uint256 targetMultiplier) internal {
        require(targetMultiplier >= PRECISION, "target below floor");
        uint256 current = okuMoney.okuMMultiplier();
        if (targetMultiplier <= current) return;

        // Set the active rate to MAX_RATE with no end timestamp (open-ended) so the
        // multiplier compounds continuously. Then warp forward enough seconds to clear
        // the target. We loop in case rounding leaves us short on the first warp.
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(MAX_RATE, 0);

        uint256 elapsed = 1;
        while (okuMoney.okuMMultiplier() < targetMultiplier) {
            vm.warp(block.timestamp + elapsed);
            elapsed *= 2;
            // Safety: bound the loop in case targetMultiplier is unreachable.
            require(elapsed < 365 days * 4, "target unreachable");
        }

        // Snapshot the achieved multiplier and stop accrual so subsequent reads stay stable.
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(PRECISION, 0);
    }

    /// @notice Alias for {_elevateUsdMultiplier} — there is only one multiplier now.
    function _elevateOkuMMultiplier(uint256 targetMultiplier) internal {
        _elevateUsdMultiplier(targetMultiplier);
    }
}
