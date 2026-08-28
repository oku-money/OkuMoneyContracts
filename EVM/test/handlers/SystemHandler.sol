// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {USDOku} from "../../src/token/USDOku.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";
import {SubscriptionModule} from "../../src/subscription/SubscriptionModule.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title SystemHandler
 * @notice Adversarial driver for the stateful-fuzz suite.
 *
 * Deliberately hostile in two ways that matter:
 *
 *   1. It DONATES tokens directly to the module and the wrapper. Free token
 *      donations are unpreventable on any ERC-20, which is why every backing
 *      and escrow property in the invariant suite is a BOUND and never an
 *      equality — an equality would be permanently griefable rather than a
 *      property of the protocol.
 *   2. It races request transitions: fulfil, reject and cancel are all reachable
 *      against the same pending slot in any order.
 *
 * Actions that would revert for boring reasons (no balance, wrong state, an
 * unfunded rate) return early rather than reverting, so `fail_on_revert` can
 * stay on and a genuine revert is a real finding.
 */
contract SystemHandler is CommonBase, StdCheats, StdUtils {
    OkuM public immutable okuM;
    USDOku public immutable usdOku;
    USDOkuWrapper public immutable wrapper;
    SubscriptionModule public immutable module;
    MockUSDC public immutable usdc;

    address public immutable admin;
    address public immutable rateSetter;
    address public immutable fulfiller;
    address public immutable treasury;

    address[] public actors;
    address internal currentActor;

    // Ghost variables for cross-checking.
    uint256 public ghost_subscriptionsFulfilled;
    uint256 public ghost_redemptionsFulfilled;
    uint256 public ghost_requestsRejected;
    uint256 public ghost_requestsCancelled;
    uint256 public ghost_wraps;
    uint256 public ghost_unwraps;
    uint256 public ghost_marks;
    uint256 public ghost_rateWrites;
    uint256 public ghost_donations;
    /// @dev Highest M_oku ever observed — used to assert monotonicity.
    uint256 public ghost_maxMultiplierSeen;
    /// @dev Highest M_usd ever observed.
    uint256 public ghost_maxIndexSeen;

    modifier useActor(uint256 seed) {
        currentActor = actors[bound(seed, 0, actors.length - 1)];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
        _recordExtremes();
    }

    constructor(
        OkuM _okuM,
        USDOku _usdOku,
        USDOkuWrapper _wrapper,
        SubscriptionModule _module,
        MockUSDC _usdc,
        address _admin,
        address _rateSetter,
        address _fulfiller,
        address _treasury
    ) {
        okuM = _okuM;
        usdOku = _usdOku;
        wrapper = _wrapper;
        module = _module;
        usdc = _usdc;
        admin = _admin;
        rateSetter = _rateSetter;
        fulfiller = _fulfiller;
        treasury = _treasury;

        for (uint256 i = 0; i < 4; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("actor", i))))));
        }
        _recordExtremes();
    }

    function _recordExtremes() internal {
        uint256 m = okuM.uiMultiplier();
        if (m > ghost_maxMultiplierSeen) ghost_maxMultiplierSeen = m;
        uint256 i = usdOku.usdOkuIndex();
        if (i > ghost_maxIndexSeen) ghost_maxIndexSeen = i;
    }

    // ============ Subscription lifecycle ============

    function requestSubscription(uint256 actorSeed, uint256 amount) public useActor(actorSeed) {
        amount = bound(amount, 1e6, 1_000_000e6);
        if (module.pendingRequestOf(currentActor, SubscriptionModule.Direction.Subscribe) != 0) {
            return;
        }
        usdc.mint(currentActor, amount);
        usdc.approve(address(module), amount);
        module.requestSubscription(amount, 0);
    }

    function fulfillSubscription(uint256 actorSeed) public {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 id = module.pendingRequestOf(actor, SubscriptionModule.Direction.Subscribe);
        if (id == 0) return;

        SubscriptionModule.Request memory r = module.getRequest(id);
        if (block.timestamp > uint256(r.createdAt) + Constants.MAX_REQUEST_AGE) return;
        // Respect the supply cap and the module's minter allowance.
        uint256 out = module.quoteSubscription(r.amountIn);
        if (out == 0) return;
        if (okuM.totalSupply() + out > okuM.maxSupply()) return;
        if (okuM.minterAllowance(address(module)) < out) return;

        vm.prank(fulfiller);
        module.fulfillSubscription(id);
        ghost_subscriptionsFulfilled++;
        _recordExtremes();
    }

    function requestRedemption(uint256 actorSeed, uint256 amount) public useActor(actorSeed) {
        uint256 bal = okuM.balanceOf(currentActor);
        if (bal == 0) return;
        if (module.pendingRequestOf(currentActor, SubscriptionModule.Direction.Redeem) != 0) {
            return;
        }
        amount = bound(amount, 1, bal);
        if (amount > type(uint96).max) return;
        okuM.approve(address(module), amount);
        module.requestRedemption(amount, 0);
    }

    function fulfillRedemption(uint256 actorSeed) public {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 id = module.pendingRequestOf(actor, SubscriptionModule.Direction.Redeem);
        if (id == 0) return;

        SubscriptionModule.Request memory r = module.getRequest(id);
        if (block.timestamp > uint256(r.createdAt) + Constants.MAX_REQUEST_AGE) return;
        uint256 net = module.quoteRedemption(r.amountIn);
        if (net == 0) return;
        if (usdc.balanceOf(treasury) < net) return;
        if (usdc.allowance(treasury, address(module)) < net) return;

        vm.prank(fulfiller);
        module.fulfillRedemption(id);
        ghost_redemptionsFulfilled++;
        _recordExtremes();
    }

    function rejectRequest(uint256 actorSeed, bool redeemDirection) public {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        SubscriptionModule.Direction d = redeemDirection
            ? SubscriptionModule.Direction.Redeem
            : SubscriptionModule.Direction.Subscribe;
        uint256 id = module.pendingRequestOf(actor, d);
        if (id == 0) return;

        vm.prank(fulfiller);
        module.rejectRequest(id, bytes32("FUZZ"));
        ghost_requestsRejected++;
    }

    function cancelRequest(uint256 actorSeed, bool redeemDirection) public {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        SubscriptionModule.Direction d = redeemDirection
            ? SubscriptionModule.Direction.Redeem
            : SubscriptionModule.Direction.Subscribe;
        uint256 id = module.pendingRequestOf(actor, d);
        if (id == 0) return;

        SubscriptionModule.Request memory r = module.getRequest(id);
        if (block.timestamp < uint256(r.createdAt) + Constants.MIN_CANCEL_DELAY) return;

        vm.prank(actor);
        module.cancelRequest(id);
        ghost_requestsCancelled++;
    }

    // ============ Wrapper ============

    function wrap(uint256 actorSeed, uint256 amount) public useActor(actorSeed) {
        if (!wrapper.wrapEnabled()) return;
        uint256 bal = okuM.balanceOf(currentActor);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        // Skip amounts that would round to zero shares.
        uint256 quoted = wrapper.quoteWrap(amount);
        if (quoted == 0) return;

        okuM.approve(address(wrapper), amount);
        // Wrap is now gated on PROJECTED coverage: newly minted shares must also
        // be funded for the rest of the live segment. Pre-fund what this wrap
        // will owe, mirroring what a solvent issuer does operationally.
        _fundForProjectedWrap(quoted);
        try wrapper.wrap(amount, currentActor, 0) {
            ghost_wraps++;
        } catch {
            return;
        }
    }

    function unwrap(uint256 actorSeed, uint256 amount) public useActor(actorSeed) {
        uint256 bal = usdOku.balanceOf(currentActor);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        if (wrapper.quoteUnwrap(amount) == 0) return;

        wrapper.unwrap(amount, currentActor);
        ghost_unwraps++;
    }

    /// @dev Tops the wrapper up so a wrap of `dollarsIn` stays covered through
    ///      `rateEnd`. Approximates the remaining accrual generously.
    function _fundForProjectedWrap(uint256 dollarsIn) internal {
        uint256 projIdx = usdOku.projectedIndexAtRateEnd();
        uint256 liveIdx = usdOku.usdOkuIndex();
        if (projIdx <= liveIdx) return;
        uint256 growthBps = ((projIdx - liveIdx) * Constants.BASIS_POINTS) / liveIdx;
        uint256 need = (dollarsIn * (growthBps + 10)) / Constants.BASIS_POINTS;
        if (need == 0) return;
        uint256 needRaw = (need * Constants.PRECISION) / okuM.uiMultiplier();
        if (needRaw > 0) _mintOkuMTo(address(wrapper), needRaw);
    }

    // ============ Rate authority ============

    function stepMultiplier(uint256 bps) public {
        if (okuM.accrualHalted()) return;
        bps = bound(bps, 1, Constants.MAX_STEP_BPS);
        uint256 current = okuM.uiMultiplier();
        uint256 next = current + (current * bps) / Constants.BASIS_POINTS;
        if (next > Constants.MAX_MULTIPLIER) return;
        if (next <= current) return;

        vm.prank(rateSetter);
        okuM.setOkuMultiplier(next, okuM.syncEpoch() + 1);
        ghost_marks++;
        _recordExtremes();
    }

    /// @dev Only ever attempts a rate it has already funded, mirroring the real
    ///      operational sequence. An unfunded attempt would revert, and under
    ///      `fail_on_revert` that would mask genuine findings.
    function setRate(uint256 aprBps, uint256 daysAhead) public {
        if (usdOku.accrualHalted()) return;
        aprBps = bound(aprBps, 0, Constants.MAX_IMPLIED_APR_BPS);
        daysAhead = bound(daysAhead, 1, 30);

        uint256 rate = aprBps == 0
            ? Constants.PRECISION
            : Constants.PRECISION + ((Constants.PRECISION * aprBps) / Constants.BASIS_POINTS)
                / Constants.SECONDS_PER_YEAR;
        uint256 end = block.timestamp + daysAhead * 1 days;

        // Pre-fund generously, then only proceed if the projection is covered.
        if (aprBps > 0) {
            uint256 liability = wrapper.declaredLiability();
            if (liability > 0) {
                uint256 need = (liability * (aprBps + 50)) / Constants.BASIS_POINTS;
                uint256 needRaw = (need * Constants.PRECISION) / okuM.uiMultiplier();
                if (needRaw > 0) _mintOkuMTo(address(wrapper), needRaw);
            }
            if (wrapper.realizedBacking() < liability) return;
        }

        try this.externalSetRate(rate, end) {
            ghost_rateWrites++;
        } catch {
            return;
        }
        _recordExtremes();
    }

    function externalSetRate(uint256 rate, uint256 end) external {
        require(msg.sender == address(this), "internal");
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(rate, end);
    }

    // ============ Adversarial: donations ============
    // Free token donations are unpreventable. Every backing and escrow property
    // must survive them, which is why they are bounds and not equalities.

    function donateOkuMToWrapper(uint256 amount) public {
        amount = bound(amount, 1, 1000e18);
        _mintOkuMTo(address(wrapper), amount);
        ghost_donations++;
    }

    function donateOkuMToModule(uint256 amount) public {
        amount = bound(amount, 1, 1000e18);
        _mintOkuMTo(address(module), amount);
        ghost_donations++;
    }

    function donateUsdcToModule(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);
        usdc.mint(address(module), amount);
        ghost_donations++;
    }

    // ============ Time ============

    function warp(uint256 secondsAhead) public {
        vm.warp(block.timestamp + bound(secondsAhead, 1 hours, 10 days));
        _recordExtremes();
    }

    // ============ Internals ============

    function _mintOkuMTo(address to, uint256 amount) internal {
        if (okuM.totalSupply() + amount > okuM.maxSupply()) return;
        vm.startPrank(admin);
        okuM.configureMinterAllowance(admin, amount);
        okuM.mint(to, amount);
        vm.stopPrank();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}
