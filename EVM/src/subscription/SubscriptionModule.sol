// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";

/**
 * @title SubscriptionModule
 * @notice Reviewed, two-phase USDC <-> OkuM conversion. Request / fulfill / reject
 *         / cancel, symmetrical in both directions.
 * @dev The single most important rule in this module: PRICING HAPPENS AT
 *      FULFILLMENT, NEVER AT REQUEST. A request records the input amount and a
 *      minimum output; `minOut` is the user's protection against an adverse move
 *      while they wait. Pricing at request time would hand every requester a
 *      free option (submit, watch the multiplier, cancel if it moves against
 *      you) — reintroducing the step arbitrage reviewed conversion exists to
 *      remove, inside the very mechanism meant to prevent it.
 *
 *      One pending request per `(user, direction)` — a mapping, not a queue.
 *      O(1), no cursor, no ordering fairness to enforce on-chain, because
 *      ordering is now an off-chain policy decision. This is why there is no
 *      `RedemptionQueue.sol`.
 *
 *      No `MIN_REQUEST_AMOUNT`: the anti-dust rationale that constant served in
 *      the old queue design (a shared FIFO slot an operator had to walk past)
 *      does not apply here — the slot is the user's own, and an ignored request
 *      simply expires. The only real hazard, a request whose output rounds to
 *      zero, is caught by an explicit zero-output revert at fulfillment.
 *
 *      No standing USDC buffer: `fulfillRedemption` pulls USDC from `treasury`
 *      via allowance at execution time. There is no buffer to size, deposit
 *      into, withdraw from, or strand.
 *
 *      Storage uses the ERC-7201 namespaced storage pattern:
 *      https://eips.ethereum.org/EIPS/eip-7201
 */
contract SubscriptionModule is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    enum Direction {
        Subscribe,
        Redeem
    }

    enum RequestStatus {
        Pending,
        Fulfilled,
        Rejected,
        Cancelled
    }

    struct Request {
        address user;
        uint96 amountIn; // USDC (6dp) for Subscribe, OkuM raw (18dp) for Redeem
        uint96 minOut;
        uint40 createdAt;
        Direction direction;
        RequestStatus status;
    }

    /// @custom:storage-location erc7201:okumoney.storage.Subscription
    struct SubscriptionStorage {
        IOkuM okuM;
        IERC20 usdc;
        address treasury;
        uint16 tinBps;
        uint16 toutBps;
        uint256 nextRequestId; // starts at 1; 0 is the "no pending request" sentinel
        mapping(uint256 => Request) requests;
        mapping(address => mapping(Direction => uint256)) pendingOf;
        uint256 totalEscrowedUsdc;
        uint256 totalEscrowedOkuM;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.Subscription")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SUBSCRIPTION_STORAGE_LOCATION =
        0x8c1ae4b5c327356fbc1a24d7c384e72f21676c453691bf4bcb6d53f676388000;

    function _getSubscriptionStorage() private pure returns (SubscriptionStorage storage $) {
        assembly {
            $.slot := SUBSCRIPTION_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    error AlreadyPending(uint256 existingRequestId);
    error NoSuchRequest();
    error NotRequestOwner();
    error RequestNotPending();
    error TooEarlyToCancel(uint256 cancellableAt);
    error RequestExpired(uint256 expiredAt);
    error WrongDirection();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error AmountTooSmall();
    error AmountExceedsRequestField(uint256 amount);
    error FeeAboveMaximum(uint256 requested, uint256 maximum);
    error AssetMismatch(address expected, address supplied);
    error InsufficientTreasuryAllowance(uint256 available, uint256 required);
    error CannotSweepBelowEscrow(uint256 available, uint256 requested);

    // ============ Events ============

    // `DepositRequest` and `RedeemRequest` carry ERC-7540's exact names AND exact
    // field shapes, so an indexer written for ERC-7540 reads our request logs
    // correctly. Our fields map 1:1: `controller` and `owner` are both the
    // requesting user (we have no operator delegation), and `sender` is the
    // caller. See `Constants.IID_ERC7540_*` for why compliance is not claimed.
    //
    // ERC-7540's shape has no slippage field, so `minOut` does NOT appear here.
    // It is readable via {getRequest}, and `RequestFulfilled` carries the actual
    // `amountOut`, so realised slippage stays auditable from logs alone.
    event DepositRequest(
        address indexed controller,
        address indexed owner,
        uint256 indexed requestId,
        address sender,
        uint256 assets
    );
    event RedeemRequest(
        address indexed controller,
        address indexed owner,
        uint256 indexed requestId,
        address sender,
        uint256 shares
    );
    event RequestFulfilled(
        uint256 indexed requestId,
        uint256 amountIn,
        uint256 amountOut,
        uint256 okuMMultiplier,
        uint256 feeBps
    );
    event RequestRejected(uint256 indexed requestId, bytes32 reasonCode);
    event RequestCancelled(uint256 indexed requestId);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeesUpdated(uint256 oldTin, uint256 newTin, uint256 oldTout, uint256 newTout);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _okuM The OkuM token.
    /// @param _usdc USDC address. Must equal `_okuM.asset()`.
    /// @param _admin Receives the full module role set.
    /// @param _treasury Initial treasury address (funds fulfillment via allowance).
    function initialize(
        address _okuM,
        address _usdc,
        address _admin,
        address _treasury
    )
        public
        initializer
    {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (_treasury == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        IOkuM okuMToken = IOkuM(_okuM);
        if (okuMToken.asset() != _usdc) revert AssetMismatch(okuMToken.asset(), _usdc);

        SubscriptionStorage storage $ = _getSubscriptionStorage();
        $.okuM = okuMToken;
        $.usdc = IERC20(_usdc);
        $.treasury = _treasury;
        $.nextRequestId = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.SUB_UPGRADER, _admin);
        _grantRole(Roles.SUB_PAUSER, _admin);
        _grantRole(Roles.SUB_UNPAUSER, _admin);
        _grantRole(Roles.REQUEST_FULFILLER, _admin);
        _grantRole(Roles.SUB_FEE_MANAGER, _admin);
        _grantRole(Roles.SUB_TREASURY_MANAGER, _admin);
        _grantRole(Roles.SUB_SWEEPER, _admin);
        // Shared with OkuM — granted to admin at init; production wiring grants
        // this to the SubscriptionModule proxy itself post-deploy (it mints on
        // fulfillSubscription and burns its own escrowed balance on
        // fulfillRedemption).
        _grantRole(Roles.OKU_MINTER, _admin);
        _grantRole(Roles.OKU_BURNER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuM() external view returns (IOkuM) {
        return _getSubscriptionStorage().okuM;
    }

    function usdc() external view returns (IERC20) {
        return _getSubscriptionStorage().usdc;
    }

    function treasury() external view returns (address) {
        return _getSubscriptionStorage().treasury;
    }

    function tinBps() external view returns (uint256) {
        return _getSubscriptionStorage().tinBps;
    }

    function toutBps() external view returns (uint256) {
        return _getSubscriptionStorage().toutBps;
    }

    function totalEscrowedUsdc() external view returns (uint256) {
        return _getSubscriptionStorage().totalEscrowedUsdc;
    }

    function totalEscrowedOkuM() external view returns (uint256) {
        return _getSubscriptionStorage().totalEscrowedOkuM;
    }

    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _getSubscriptionStorage().requests[requestId];
    }

    function pendingRequestOf(address user, Direction direction) external view returns (uint256) {
        return _getSubscriptionStorage().pendingOf[user][direction];
    }

    // ============ ERC-7540-shaped views ============
    // Borrowed vocabulary, not claimed compliance — see `Constants.IID_ERC7540_*`.
    // Signatures match ERC-7540 exactly so a 7540-aware integrator can read our
    // pending state without a custom adapter.

    /// @notice Requested `assets` (USDC) in Pending state for `controller`.
    /// @dev ERC-7540 discriminates a request by `(requestId, controller)`. Pass
    ///      `requestId == 0` to look up whichever subscription request the
    ///      controller currently has pending — matching ERC-7540's aggregated
    ///      `requestId == 0` convention. Any other value is matched exactly and
    ///      must also belong to `controller`.
    ///      Never reverts, per spec.
    function pendingDepositRequest(
        uint256 requestId,
        address controller
    )
        external
        view
        returns (uint256 assets)
    {
        return _pendingAmount(requestId, controller, Direction.Subscribe);
    }

    /// @notice Requested `shares` (raw OkuM) in Pending state for `controller`.
    /// @dev See {pendingDepositRequest} for the `requestId == 0` convention.
    function pendingRedeemRequest(
        uint256 requestId,
        address controller
    )
        external
        view
        returns (uint256 shares)
    {
        return _pendingAmount(requestId, controller, Direction.Redeem);
    }

    /// @notice Always zero. There is no Claimable state in this module.
    /// @dev ERC-7540 models Pending -> Claimable -> Claimed, where the user pulls
    ///      the output via a Claim function. This module PUSHES the output to the
    ///      user inside `fulfillSubscription`, so a request goes straight from
    ///      Pending to settled and nothing is ever claimable. Present, and
    ///      hard-wired to zero, so a 7540-aware integrator gets a truthful answer
    ///      rather than a missing-function revert.
    function claimableDepositRequest(uint256, address) external pure returns (uint256) {
        return 0;
    }

    /// @notice Always zero. See {claimableDepositRequest}.
    function claimableRedeemRequest(uint256, address) external pure returns (uint256) {
        return 0;
    }

    function _pendingAmount(
        uint256 requestId,
        address controller,
        Direction direction
    )
        internal
        view
        returns (uint256)
    {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        uint256 pendingId = $.pendingOf[controller][direction];
        if (pendingId == 0) return 0;
        if (requestId != 0 && requestId != pendingId) return 0;
        return $.requests[pendingId].amountIn;
    }

    /// @dev Returns FALSE for every ERC-7540 and ERC-7575 interface ID. The
    ///      request/fulfill shape is deliberately pattern-aligned only; see
    ///      `Constants.IID_ERC7540_*` for the three blocking incompatibilities.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        if (
            interfaceId == Constants.IID_ERC7540_OPERATOR || interfaceId == Constants.IID_ERC7575
                || interfaceId == Constants.IID_ERC7540_DEPOSIT
                || interfaceId == Constants.IID_ERC7540_REDEEM
        ) {
            return false;
        }
        return super.supportsInterface(interfaceId);
    }

    // ============ Quotes (fee-inclusive, informational — NOT a price lock) ============

    function quoteSubscription(uint256 usdcAmount) external view returns (uint256) {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        (uint256 net,) = MathLib.applyFeeCeil(usdcAmount, $.tinBps);
        return $.okuM.convertToShares(net);
    }

    function quoteRedemption(uint256 okuMAmount) external view returns (uint256) {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        uint256 gross = $.okuM.convertToAssets(okuMAmount);
        (uint256 net,) = MathLib.applyFeeCeil(gross, $.toutBps);
        return net;
    }

    // ============ Request (permissionless, escrows the input) ============

    function requestSubscription(
        uint256 usdcAmount,
        uint256 minOkuMOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();
        requestId = _openRequest(Direction.Subscribe, usdcAmount, minOkuMOut);

        SubscriptionStorage storage $ = _getSubscriptionStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.totalEscrowedUsdc += usdcAmount;

        emit DepositRequest(msg.sender, msg.sender, requestId, msg.sender, usdcAmount);
    }

    function requestRedemption(
        uint256 okuMAmount,
        uint256 minUsdcOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        requestId = _openRequest(Direction.Redeem, okuMAmount, minUsdcOut);

        SubscriptionStorage storage $ = _getSubscriptionStorage();
        IERC20(address($.okuM)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        $.totalEscrowedOkuM += okuMAmount;

        emit RedeemRequest(msg.sender, msg.sender, requestId, msg.sender, okuMAmount);
    }

    function _openRequest(
        Direction direction,
        uint256 amountIn,
        uint256 minOut
    )
        internal
        returns (uint256 requestId)
    {
        if (amountIn > type(uint96).max) revert AmountExceedsRequestField(amountIn);
        if (minOut > type(uint96).max) revert AmountExceedsRequestField(minOut);

        SubscriptionStorage storage $ = _getSubscriptionStorage();
        uint256 existing = $.pendingOf[msg.sender][direction];
        if (existing != 0) revert AlreadyPending(existing);

        requestId = $.nextRequestId++;
        $.requests[requestId] = Request({
            user: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            amountIn: uint96(amountIn), // checked against type(uint96).max above
            // forge-lint: disable-next-line(unsafe-typecast)
            minOut: uint96(minOut), // checked against type(uint96).max above
            createdAt: uint40(block.timestamp),
            direction: direction,
            status: RequestStatus.Pending
        });
        $.pendingOf[msg.sender][direction] = requestId;
    }

    /// @notice Cancel a pending request after `Constants.MIN_CANCEL_DELAY`.
    /// @dev The delay prevents submit-and-cancel probing of fulfillment timing.
    ///      It does NOT prevent fulfillment-racing after the delay elapses — that
    ///      residual risk is accepted, not eliminated.
    function cancelRequest(uint256 requestId) external nonReentrant {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        Request storage req = $.requests[requestId];
        if (req.user != msg.sender) revert NotRequestOwner();
        if (req.status != RequestStatus.Pending) revert RequestNotPending();
        uint256 cancellableAt = uint256(req.createdAt) + Constants.MIN_CANCEL_DELAY;
        if (block.timestamp < cancellableAt) revert TooEarlyToCancel(cancellableAt);

        _refund(req);
        req.status = RequestStatus.Cancelled;
        $.pendingOf[req.user][req.direction] = 0;

        emit RequestCancelled(requestId);
    }

    /// @notice Reject a pending request. Immediate — no delay.
    /// @param reasonCode Opaque, resolved off-chain; no compliance detail on-chain.
    function rejectRequest(
        uint256 requestId,
        bytes32 reasonCode
    )
        external
        nonReentrant
        onlyRole(Roles.REQUEST_FULFILLER)
    {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        Request storage req = $.requests[requestId];
        if (req.status != RequestStatus.Pending) revert RequestNotPending();

        _refund(req);
        req.status = RequestStatus.Rejected;
        $.pendingOf[req.user][req.direction] = 0;

        emit RequestRejected(requestId, reasonCode);
    }

    function _refund(Request storage req) internal {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        if (req.direction == Direction.Subscribe) {
            $.totalEscrowedUsdc -= req.amountIn;
            $.usdc.safeTransfer(req.user, req.amountIn);
        } else {
            $.totalEscrowedOkuM -= req.amountIn;
            IERC20(address($.okuM)).safeTransfer(req.user, req.amountIn);
        }
    }

    // ============ Fulfillment (REQUEST_FULFILLER) ============
    // Pricing happens HERE, against the live M_oku — never at request time.

    function fulfillSubscription(uint256 requestId)
        external
        nonReentrant
        onlyRole(Roles.REQUEST_FULFILLER)
    {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        Request storage req = $.requests[requestId];
        if (req.status != RequestStatus.Pending) revert RequestNotPending();
        if (req.direction != Direction.Subscribe) revert WrongDirection();
        _checkNotExpired(req);

        uint256 usdcAmount = req.amountIn;
        (uint256 net,) = MathLib.applyFeeCeil(usdcAmount, $.tinBps);
        uint256 rawOut = $.okuM.convertToShares(net);
        if (rawOut == 0) revert AmountTooSmall();
        if (rawOut < req.minOut) revert SlippageExceeded(rawOut, req.minOut);

        $.totalEscrowedUsdc -= usdcAmount;
        req.status = RequestStatus.Fulfilled;
        $.pendingOf[req.user][Direction.Subscribe] = 0;

        // Full gross moves to treasury; OkuM minted is fee-reduced — the fee is
        // withheld by raising the collateral ratio, not forwarded to a recipient.
        $.usdc.safeTransfer($.treasury, usdcAmount);
        $.okuM.mint(req.user, rawOut);

        emit RequestFulfilled(requestId, usdcAmount, rawOut, $.okuM.uiMultiplier(), $.tinBps);
    }

    function fulfillRedemption(uint256 requestId)
        external
        nonReentrant
        onlyRole(Roles.REQUEST_FULFILLER)
    {
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        Request storage req = $.requests[requestId];
        if (req.status != RequestStatus.Pending) revert RequestNotPending();
        if (req.direction != Direction.Redeem) revert WrongDirection();
        _checkNotExpired(req);

        uint256 okuMAmount = req.amountIn;
        uint256 gross = $.okuM.convertToAssets(okuMAmount);
        (uint256 net,) = MathLib.applyFeeCeil(gross, $.toutBps);
        if (net == 0) revert AmountTooSmall();
        if (net < req.minOut) revert SlippageExceeded(net, req.minOut);

        uint256 available = $.usdc.allowance($.treasury, address(this));
        uint256 treasuryBalance = $.usdc.balanceOf($.treasury);
        if (treasuryBalance < available) available = treasuryBalance;
        if (available < net) revert InsufficientTreasuryAllowance(available, net);

        $.totalEscrowedOkuM -= okuMAmount;
        req.status = RequestStatus.Fulfilled;
        $.pendingOf[req.user][Direction.Redeem] = 0;

        $.okuM.burn(okuMAmount);
        $.usdc.safeTransferFrom($.treasury, req.user, net);

        emit RequestFulfilled(requestId, okuMAmount, net, $.okuM.uiMultiplier(), $.toutBps);
    }

    function _checkNotExpired(Request storage req) internal view {
        uint256 expiresAt = uint256(req.createdAt) + Constants.MAX_REQUEST_AGE;
        if (block.timestamp > expiresAt) revert RequestExpired(expiresAt);
    }

    // ============ Admin ============

    function setFees(uint256 newTin, uint256 newTout) external onlyRole(Roles.SUB_FEE_MANAGER) {
        if (newTin > Constants.MAX_FEE_BPS) revert FeeAboveMaximum(newTin, Constants.MAX_FEE_BPS);
        if (newTout > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(newTout, Constants.MAX_FEE_BPS);
        }
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        uint256 oldTin = $.tinBps;
        uint256 oldTout = $.toutBps;
        // forge-lint: disable-next-line(unsafe-typecast)
        $.tinBps = uint16(newTin); // checked against MAX_FEE_BPS (100) above
        // forge-lint: disable-next-line(unsafe-typecast)
        $.toutBps = uint16(newTout); // checked against MAX_FEE_BPS (100) above
        emit FeesUpdated(oldTin, newTin, oldTout, newTout);
    }

    function setTreasury(address newTreasury) external onlyRole(Roles.SUB_TREASURY_MANAGER) {
        if (newTreasury == address(0)) revert Errors.ZeroAddress();
        SubscriptionStorage storage $ = _getSubscriptionStorage();
        address old = $.treasury;
        $.treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    /// @notice Sweep a token accidentally sent to the module.
    /// @dev For `usdc` and `okuM`, capped at `balanceOf - Σ escrow` — provably
    ///      cannot touch a user's escrowed input. Refuses (does not revert the
    ///      whole call with a generic message) below that floor via a named
    ///      error so an operator can see exactly how much headroom exists.
    function sweepToken(
        address token,
        address to,
        uint256 amount
    )
        external
        onlyRole(Roles.SUB_SWEEPER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        SubscriptionStorage storage $ = _getSubscriptionStorage();

        uint256 available = IERC20(token).balanceOf(address(this));
        if (token == address($.usdc)) {
            available -= $.totalEscrowedUsdc;
        } else if (token == address($.okuM)) {
            available -= $.totalEscrowedOkuM;
        }
        if (amount > available) revert CannotSweepBelowEscrow(available, amount);

        IERC20(token).safeTransfer(to, amount);
        emit TokenSwept(token, to, amount);
    }

    // ============ Pause Management ============
    // Pause blocks new requests only — fulfillment, cancellation, and rejection
    // of already-pending requests remain callable so an incident does not trap
    // escrowed funds.

    function pause() external onlyRole(Roles.SUB_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.SUB_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.SUB_UPGRADER) {}
}
