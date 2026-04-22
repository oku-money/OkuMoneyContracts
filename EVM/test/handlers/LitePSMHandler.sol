// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title LitePSMHandler
 * @notice Handler contract for LitePSM invariant testing
 * @dev Covers mint/redeem operations for both OkuMoney and OkuDollar paths
 */
contract LitePSMHandler is Test {
    LitePSM public psm;
    IOkuMoney public okuMoney;
    IOkuDollar public usdOku;
    IERC20 public usdc;
    RedemptionQueue public queue;
    address public rebaser;
    address public minter;

    // Actors
    address[] public actors;
    mapping(address => bool) public isActor;

    // Constants
    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_FUZZ_PRICE = TestConstants.MAX_FUZZ_PRICE;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;

    // Ghost variables for tracking
    uint256 public ghostUsdcDeposited;
    uint256 public ghostUsdcWithdrawn;
    uint256 public ghostOkuMMinted;
    uint256 public ghostOkuMBurned;
    uint256 public ghostUsdOkuMinted;
    uint256 public ghostUsdOkuBurned;
    uint256 public ghostQueuedCount;
    uint256 public ghostProcessedCount;

    // Call counters
    uint256 public ghostMintOkuMCallCount;
    uint256 public ghostMintOkuMRevertCount;
    uint256 public ghostRedeemOkuMCallCount;
    uint256 public ghostRedeemOkuMRevertCount;
    uint256 public ghostMintUsdOkuCallCount;
    uint256 public ghostMintUsdOkuRevertCount;
    uint256 public ghostRedeemUsdOkuCallCount;
    uint256 public ghostRedeemUsdOkuRevertCount;
    uint256 public ghostRebaseCallCount;

    constructor(
        LitePSM _psm,
        IOkuMoney _okuMoney,
        IOkuDollar _usdOku,
        IERC20 _usdc,
        RedemptionQueue _queue,
        address _rebaser,
        address _minter
    ) {
        psm = _psm;
        okuMoney = _okuMoney;
        usdOku = _usdOku;
        usdc = _usdc;
        queue = _queue;
        rebaser = _rebaser;
        minter = _minter;

        // Initialize actors
        _addActor(makeAddr("psmActor1"));
        _addActor(makeAddr("psmActor2"));
        _addActor(makeAddr("psmActor3"));
    }

    function _addActor(address actor) internal {
        if (!isActor[actor]) {
            actors.push(actor);
            isActor[actor] = true;
        }
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    // ============ Handler Functions ============

    /// @notice Mint OkuMoney via PSM
    function mintOkuM(uint256 actorSeed, uint256 usdcAmount) external {
        ghostMintOkuMCallCount++;

        address actor = actors[actorSeed % actors.length];

        // Realistic bounds: 1 USDC to 100,000 USDC per operation
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);

        // Ensure actor has USDC
        uint256 actorBalance = usdc.balanceOf(actor);
        if (actorBalance < usdcAmount) {
            deal(address(usdc), actor, usdcAmount);
        }

        // Approve PSM
        vm.prank(actor);
        usdc.approve(address(psm), usdcAmount);

        // Calculate expected OkuM
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 expectedOkuM = (usdcAmount * DECIMAL_MULTIPLIER * PRECISION) / okuMMult;

        vm.prank(actor);
        try psm.mintOkuM(usdcAmount) {
            ghostUsdcDeposited += usdcAmount;
            ghostOkuMMinted += expectedOkuM;
        } catch {
            ghostMintOkuMRevertCount++;
        }
    }

    /// @notice Redeem OkuMoney via PSM
    function redeemOkuM(uint256 actorSeed, uint256 okuMAmount) external {
        ghostRedeemOkuMCallCount++;

        address actor = actors[actorSeed % actors.length];

        // Get actor's OkuMoney balance
        uint256 actorBalance = okuMoney.balanceOf(actor);
        if (actorBalance == 0) return;

        okuMAmount = bound(okuMAmount, 1e18, actorBalance);

        // Approve PSM
        vm.prank(actor);
        IERC20(address(okuMoney)).approve(address(psm), okuMAmount);

        // Calculate expected USDC
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 expectedUsdc = (okuMAmount * okuMMult) / PRECISION / DECIMAL_MULTIPLIER;

        uint256 psmUsdcBalance = usdc.balanceOf(address(psm));

        vm.prank(actor);
        try psm.redeemOkuM(okuMAmount) {
            if (psmUsdcBalance >= expectedUsdc) {
                // Instant redemption
                ghostUsdcWithdrawn += expectedUsdc;
                ghostOkuMBurned += okuMAmount;
            } else {
                // Queued redemption
                ghostQueuedCount++;
            }
        } catch {
            ghostRedeemOkuMRevertCount++;
        }
    }

    /// @notice Mint OkuDollar via PSM
    function mintUsdOku(uint256 actorSeed, uint256 usdcAmount) external {
        ghostMintUsdOkuCallCount++;

        address actor = actors[actorSeed % actors.length];

        // Realistic bounds
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);

        // Ensure actor has USDC
        uint256 actorBalance = usdc.balanceOf(actor);
        if (actorBalance < usdcAmount) {
            deal(address(usdc), actor, usdcAmount);
        }

        // Approve PSM
        vm.prank(actor);
        usdc.approve(address(psm), usdcAmount);

        vm.prank(actor);
        try psm.mintUsdOku(usdcAmount) {
            ghostUsdcDeposited += usdcAmount;
            ghostUsdOkuMinted += usdcAmount * DECIMAL_MULTIPLIER; // Approximate in dollar terms
        } catch {
            ghostMintUsdOkuRevertCount++;
        }
    }

    /// @notice Redeem OkuDollar via PSM
    function redeemUsdOku(uint256 actorSeed, uint256 usdAmount) external {
        ghostRedeemUsdOkuCallCount++;

        address actor = actors[actorSeed % actors.length];

        // Get actor's OkuDollar balance
        uint256 actorBalance = usdOku.balanceOf(actor);
        if (actorBalance == 0) return;

        usdAmount = bound(usdAmount, 1e18, actorBalance);

        // Approve PSM
        vm.prank(actor);
        IERC20(address(usdOku)).approve(address(psm), usdAmount);

        vm.prank(actor);
        try psm.redeemUsdOku(usdAmount) {
            ghostUsdOkuBurned += usdAmount;
        } catch {
            ghostRedeemUsdOkuRevertCount++;
        }
    }

    /// @notice Trigger rebase (price increase)
    /// @dev Tightened bounds and rolls to next block after rebase
    function rebase(uint256 priceIncrease) external {
        ghostRebaseCallCount++;

        uint256 currentPrice = okuMoney.okuMMultiplier();

        // Cap at 5x
        if (currentPrice >= MAX_FUZZ_PRICE) {
            return;
        }

        // Increase by 0.01% to 2%
        uint256 minIncrease = currentPrice / 10_000;
        uint256 maxIncrease = currentPrice / 50;
        uint256 increase = bound(priceIncrease, minIncrease, maxIncrease);

        uint256 newPrice = currentPrice + increase;
        if (newPrice > MAX_FUZZ_PRICE) {
            newPrice = MAX_FUZZ_PRICE;
        }

        vm.prank(rebaser);
        try okuMoney.setOkuMMultiplier(newPrice) {
            // Roll to next block to avoid yield distribution lock
            vm.roll(block.number + 1);
        } catch {}
    }

    // ============ View Functions ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function ghostTotalCalls() external view returns (uint256) {
        return ghostMintOkuMCallCount + ghostRedeemOkuMCallCount + ghostMintUsdOkuCallCount
            + ghostRedeemUsdOkuCallCount + ghostRebaseCallCount;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMRevertCount + ghostRedeemOkuMRevertCount + ghostMintUsdOkuRevertCount
            + ghostRedeemUsdOkuRevertCount;
    }
}
