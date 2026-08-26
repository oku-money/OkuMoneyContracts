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
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {Roles} from "../lib/Roles.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";

/// @dev The wrapper view the solvency check reads. Declared locally to avoid a
///      circular import with the wrapper.
interface ISolvencySource {
    function realizedBacking() external view returns (uint256);
}

/**
 * @title USDOku
 * @notice The rebasing dollar wrapper — 1 USDOku = $1.00, always; yield arrives
 *         as balance growth.
 *
 * @dev **Rebasing share ledger over a continuous declared index (`M_usd`).**
 *
 *      A holder's balance is `shares * usdOkuIndex() / 1e18` and grows every
 *      second with no transfer to observe. That breaks AMM pools, balance
 *      snapshots and most lending markets — USDOku is *never* intended for
 *      those venues; OkuM is the composable leg. The compensation: a rebasing
 *      `balanceOf` displays correctly in every wallet ever written, with zero
 *      integration work. USDOku exists to cover the gap while ERC-8056 wallet
 *      support lands, and is expected to be deprecated (see README, "USDOku is
 *      transitional").
 *
 *      `M_usd` is the *declared, forward-looking, smoothed* payout rate — the
 *      Aave liquidity-index / sDAI `chi` pattern:
 *
 *      ```
 *      usdOkuIndex() = baseIndex * rpow(ratePerSecond, elapsed, 1e18) / 1e18
 *      elapsed       = min(block.timestamp, rateEnd) - lastAccrualTime
 *      ```
 *
 *      `M_usd` is NOT dollars per share to the outside world and NEVER prices a
 *      conversion: the wrapper converts OkuM <-> USDOku at `M_oku`, the realized
 *      index. `M_usd` only determines how fast a USDOku balance grows.
 *
 *      Because `M_usd` may run ahead of realized backing, the declared
 *      liability (`totalSupply()`) can exceed the wrapper's backing — by
 *      design, bounded by `MAX_SOLVENCY_GAP_BPS`, checked at every rate write
 *      against a projection to `rateEnd`.
 *
 *      NO ERC-8056, deliberately: `balanceOf` already returns dollars, and an
 *      8056 multiplier on top would be a second scaling factor over an
 *      already-scaled balance — an aware wallet would apply it twice.
 *
 *      The inherited OZ `_update` (and with it the stock `_balances` ledger) is
 *      hard-reverted so it can never be written (stETH/aToken pattern);
 *      transfers move shares. Allowances remain stock OZ, dollar-denominated.
 *
 *      Storage uses ERC-7201 namespaced storage. See https://eips.ethereum.org/EIPS/eip-7201
 */
contract USDOku is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IUSDOku
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.USDOku
    struct USDOkuStorage {
        /// @dev The invariant ledger. `balanceOf = shares * M_usd / 1e18`.
        mapping(address => uint256) shares;
        uint256 totalShares;
        /// @dev `M_usd` anchor, snapshotted at the last rate write.
        uint256 baseIndex;
        /// @dev Compound per-second rate. `PRECISION` == no yield.
        uint256 ratePerSecond;
        /// @dev Timestamp `baseIndex` was snapshotted at.
        uint256 lastAccrualTime;
        /// @dev Accrual halts here. Mandatory, bounded by `MAX_RATE_DURATION`.
        uint256 rateEnd;
        mapping(address => bool) isBlacklisted;
        /// @dev The USDOkuWrapper proxy — read for `realizedBacking()` in the
        ///      solvency check. Zero = fail-closed for any rate write while
        ///      liability is outstanding (unreachable in practice: the wrapper
        ///      is the only minter).
        address solvencySource;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.USDOku")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant USDOKU_STORAGE_LOCATION =
        0xe244738c4870fb11359f7bdc9af3db99c1dc9ff2fda67cb0afd4e0d472bede00;

    function _getUSDOkuStorage() private pure returns (USDOkuStorage storage $) {
        assembly {
            $.slot := USDOKU_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @notice A rate below `PRECISION` was supplied — the index never decreases.
    error IndexCannotDecrease();
    /// @notice Annualized rate exceeded `Constants.MAX_IMPLIED_APR`.
    error RateAboveMaximum(uint256 impliedAprBps, uint256 maxAprBps);
    /// @notice `endTimestamp` was zero or not strictly in the future.
    error RateEndNotInFuture();
    /// @notice `endTimestamp - block.timestamp` exceeded `Constants.MAX_RATE_DURATION`.
    error RateDurationTooLong(uint256 requested, uint256 maximum);
    /// @notice The index projected to `rateEnd` would exceed `Constants.MAX_MULTIPLIER`.
    error IndexAboveMaximum(uint256 projected, uint256 maximum);
    /// @notice The liability projected to `rateEnd` would outrun realized backing
    ///         by more than `MAX_SOLVENCY_GAP_BPS`.
    /// @dev This is the check that makes the declared rate honest: you cannot
    ///      promise a rate the realized backing plus buffer cannot fund. Because
    ///      `M_oku` is monotone, a step landing after this check only increases
    ///      backing — the projection is conservative, which is why the rate
    ///      write needs no sync gating.
    error SolvencyGapExceeded(uint256 projectedGapBps, uint256 maxGapBps);
    /// @notice A conversion produced zero shares — the amount is below index dust.
    error AmountTooSmall();
    /// @notice The stock OZ ledger is unreachable on a share-ledger token.
    error UseSharesLedger();

    // ============ Events ============

    /// @notice Emitted on every rate write.
    /// @param snapshotIndex `baseIndex` after re-anchoring, so an indexer can
    ///        reconstruct the trajectory from events alone.
    event UsdOkuRateSet(uint256 oldRate, uint256 newRate, uint256 rateEnd, uint256 snapshotIndex);
    /// @notice The guardian froze the index.
    event UsdOkuAccrualHalted(uint256 atIndex);
    /// @notice The solvency source (wrapper proxy) was wired.
    event SolvencySourceSet(address indexed oldSource, address indexed newSource);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the USDOku proxy.
    /// @param name_ ERC-20 name (canonical: "USD Oku").
    /// @param symbol_ ERC-20 symbol (canonical: "USDOku" — no prefix).
    /// @param _admin Receives the full role set; redistributes post-deploy.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _admin
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();

        USDOkuStorage storage $ = _getUSDOkuStorage();
        $.baseIndex = Constants.PRECISION;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKU_UPGRADER, _admin);
        _grantRole(Roles.OKU_PAUSER, _admin);
        _grantRole(Roles.OKU_UNPAUSER, _admin);
        _grantRole(Roles.OKU_MINTER, _admin);
        _grantRole(Roles.OKU_BURNER, _admin);
        _grantRole(Roles.OKU_RATE_SETTER, _admin);
        _grantRole(Roles.OKU_GUARDIAN, _admin);
        _grantRole(Roles.OKU_BLACKLISTER, _admin);
        _grantRole(Roles.OKU_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKU_CAP_MANAGER, _admin);
    }

    // ============ The index (M_usd) ============

    /// @inheritdoc IUSDOku
    function usdOkuIndex() public view returns (uint256) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        uint256 rateEnd_ = $.rateEnd;
        uint256 until = block.timestamp < rateEnd_ ? block.timestamp : rateEnd_;
        uint256 last = $.lastAccrualTime;
        if (until <= last) return $.baseIndex;
        return _compound($.baseIndex, $.ratePerSecond, until - last);
    }

    /// @notice Index anchor snapshotted at the last rate write.
    function baseIndex() external view returns (uint256) {
        return _getUSDOkuStorage().baseIndex;
    }

    /// @notice Compound per-second accrual rate (`PRECISION` == no yield).
    function ratePerSecond() external view returns (uint256) {
        return _getUSDOkuStorage().ratePerSecond;
    }

    /// @notice Timestamp the anchor was snapshotted at.
    function lastAccrualTime() external view returns (uint256) {
        return _getUSDOkuStorage().lastAccrualTime;
    }

    /// @notice Accrual halt boundary.
    function rateEnd() external view returns (uint256) {
        return _getUSDOkuStorage().rateEnd;
    }

    /// @notice Nominal annualized rate currently in force, in basis points.
    function impliedAprBps() external view returns (uint256) {
        return _impliedAprBps(_getUSDOkuStorage().ratePerSecond);
    }

    /// @notice The wrapper proxy the solvency check reads backing from.
    function solvencySource() external view returns (address) {
        return _getUSDOkuStorage().solvencySource;
    }

    // ============ Rate authority ============

    /// @notice Set the declared smoothed rate and its halt boundary.
    /// @param newRatePerSecond Compound per-second rate (`1e18` == no yield).
    /// @param endTimestamp Accrual halts here. Mandatory, strictly future,
    ///        within `MAX_RATE_DURATION`.
    /// @dev Snapshots `baseIndex = usdOkuIndex()` and re-anchors, so calling
    ///      this before `rateEnd` extends accrual with NO GAP AND NO STEP —
    ///      which is why no separate pending-rate staging field exists, and why
    ///      this write needs no sandwich guard: a rate change moves only the
    ///      slope, never the value.
    ///
    ///      NOT pause-gated (incident zeroing must always work) and NOT
    ///      sync-gated: the solvency projection reads current `M_oku`-derived
    ///      backing, and since `M_oku` is monotone any in-flight step only
    ///      increases backing — the check is conservative mid-tick.
    function setUsdOkuRate(
        uint256 newRatePerSecond,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKU_RATE_SETTER)
    {
        if (newRatePerSecond < Constants.PRECISION) revert IndexCannotDecrease();

        uint256 apr = _impliedAprBps(newRatePerSecond);
        if (apr > Constants.MAX_IMPLIED_APR) {
            revert RateAboveMaximum(apr, Constants.MAX_IMPLIED_APR);
        }

        if (endTimestamp <= block.timestamp) revert RateEndNotInFuture();
        uint256 duration = endTimestamp - block.timestamp;
        if (duration > Constants.MAX_RATE_DURATION) {
            revert RateDurationTooLong(duration, Constants.MAX_RATE_DURATION);
        }

        USDOkuStorage storage $ = _getUSDOkuStorage();
        uint256 currentIndex = usdOkuIndex();
        uint256 oldRate = $.ratePerSecond;

        // Project to the new rateEnd and bound BEFORE committing, so neither
        // ceiling can be breached mid-segment by the passage of time alone.
        uint256 projected = _compound(currentIndex, newRatePerSecond, duration);
        if (projected > Constants.MAX_MULTIPLIER) {
            revert IndexAboveMaximum(projected, Constants.MAX_MULTIPLIER);
        }
        _checkProjectedSolvency($, projected);

        $.baseIndex = currentIndex;
        $.lastAccrualTime = block.timestamp;
        $.ratePerSecond = newRatePerSecond;
        $.rateEnd = endTimestamp;

        emit UsdOkuRateSet(oldRate, newRatePerSecond, endTimestamp, currentIndex);
    }

    /// @notice Freeze the index at its current value, immediately.
    /// @dev No timelock — the guardian's emergency lever against a compromised
    ///      rate setter. Monotone-safe. Not pause-gated. Pulls `rateEnd` to
    ///      `now` so the halted state reads unambiguously as "nothing pending".
    function haltUsdOkuAccrual() external onlyRole(Roles.OKU_GUARDIAN) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        uint256 frozen = usdOkuIndex();
        $.baseIndex = frozen;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp;
        emit UsdOkuAccrualHalted(frozen);
    }

    /// @notice Wire the solvency source (the USDOkuWrapper proxy).
    /// @dev Cold policy; the wrapper address is fixed post-deploy in practice.
    function setSolvencySource(address newSource) external onlyRole(Roles.OKU_CAP_MANAGER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        address old = $.solvencySource;
        $.solvencySource = newSource;
        emit SolvencySourceSet(old, newSource);
    }

    /// @dev Reverts if the liability projected to `rateEnd` would outrun current
    ///      realized backing by more than `MAX_SOLVENCY_GAP_BPS` (in bps of
    ///      backing, rounded up — conservative).
    function _checkProjectedSolvency(USDOkuStorage storage $, uint256 projectedIndex) private view {
        uint256 shares_ = $.totalShares;
        if (shares_ == 0) return; // No liability, nothing to outrun.

        uint256 projectedLiability =
            Math.mulDiv(shares_, projectedIndex, Constants.PRECISION, Math.Rounding.Ceil);

        address source = $.solvencySource;
        uint256 backing = source == address(0) ? 0 : ISolvencySource(source).realizedBacking();

        if (projectedLiability <= backing) return;
        uint256 gap = projectedLiability - backing;
        if (backing == 0) {
            revert SolvencyGapExceeded(type(uint256).max, Constants.MAX_SOLVENCY_GAP_BPS);
        }
        uint256 gapBps = Math.mulDiv(gap, Constants.BASIS_POINTS, backing, Math.Rounding.Ceil);
        if (gapBps > Constants.MAX_SOLVENCY_GAP_BPS) {
            revert SolvencyGapExceeded(gapBps, Constants.MAX_SOLVENCY_GAP_BPS);
        }
    }

    // ============ Rebasing ledger ============

    /// @inheritdoc IUSDOku
    function sharesOf(address account) public view returns (uint256) {
        return _getUSDOkuStorage().shares[account];
    }

    /// @inheritdoc IUSDOku
    function totalShares() public view returns (uint256) {
        return _getUSDOkuStorage().totalShares;
    }

    /// @notice Dollar balance: `shares * M_usd / 1e18`. Grows with no transfer.
    /// @dev MAX-SEND RULE: never compute a transfer amount from this — it moves
    ///      between the read and the transaction. Compute from `sharesOf`.
    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IERC20)
        returns (uint256)
    {
        return MathLib.toUiAmount(_getUSDOkuStorage().shares[account], usdOkuIndex());
    }

    /// @notice The declared liability: `totalShares * M_usd / 1e18`, in dollars.
    function totalSupply() public view override(ERC20Upgradeable, IERC20) returns (uint256) {
        return MathLib.toUiAmount(_getUSDOkuStorage().totalShares, usdOkuIndex());
    }

    /// @notice Transfer `amount` dollars. Moves `floor(amount * 1e18 / M_usd)` shares.
    /// @dev The `Transfer` event carries the effective post-flooring dollar
    ///      amount, which may be up to 1 wei below `amount`.
    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        uint256 index = usdOkuIndex();
        uint256 shares_ = MathLib.fromUiAmount(amount, index);
        _transferShares(msg.sender, to, shares_);
        emit Transfer(msg.sender, to, MathLib.toUiAmount(shares_, index));
        return true;
    }

    /// @notice Transfer `amount` dollars from `from`. Allowance is spent in the
    ///         caller-supplied dollar amount (stock OZ, dollar-denominated).
    /// @dev The moved value is the floored effective amount (≤ 1 wei less than
    ///      the allowance debit, in the protocol's favour).
    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        uint256 index = usdOkuIndex();
        uint256 shares_ = MathLib.fromUiAmount(amount, index);
        _transferShares(from, to, shares_);
        emit Transfer(from, to, MathLib.toUiAmount(shares_, index));
        return true;
    }

    function _transferShares(address from, address to, uint256 shares_) internal whenNotPaused {
        if (from == address(0) || to == address(0)) revert Errors.ZeroAddress();
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();

        uint256 fromShares = $.shares[from];
        if (fromShares < shares_) revert Errors.InsufficientBalance();
        unchecked {
            $.shares[from] = fromShares - shares_;
        }
        $.shares[to] += shares_;
    }

    /// @dev Defensive: the stock OZ ledger must never be written on a
    ///      share-ledger token. Every path that could reach it is overridden
    ///      above; this converts a future refactor bug into a loud revert.
    function _update(address, address, uint256) internal pure override {
        revert UseSharesLedger();
    }

    /// @dev Blocks blacklisted owners or spenders from using a pre-signed permit.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        public
        virtual
        override
    {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Mint / burn (wrapper-only) ============

    /// @inheritdoc IUSDOku
    /// @dev Called by the wrapper on `wrap`. Floors the share credit, so the
    ///      recipient's balance may read up to 1 wei below `usdOkuAmount` —
    ///      rounding against the caller, in the protocol's favour.
    function mint(
        address to,
        uint256 usdOkuAmount
    )
        external
        onlyRole(Roles.OKU_MINTER)
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();

        uint256 index = usdOkuIndex();
        sharesMinted = MathLib.fromUiAmount(usdOkuAmount, index);
        if (sharesMinted == 0) revert AmountTooSmall();

        $.totalShares += sharesMinted;
        $.shares[to] += sharesMinted;

        emit Transfer(address(0), to, MathLib.toUiAmount(sharesMinted, index));
    }

    /// @inheritdoc IUSDOku
    /// @dev Called by the wrapper on `unwrap`, share-denominated so it burns
    ///      exactly what `transferFrom` delivered — no dust. Allowed while
    ///      paused (exit-path parity with `OkuM.burn`)... except that reaching
    ///      it requires a `transferFrom`, which pause blocks; the exemption
    ///      matters only for balances already sitting on the wrapper.
    function burnShares(uint256 shares_) external onlyRole(Roles.OKU_BURNER) {
        if (shares_ == 0) revert Errors.ZeroAmount();
        USDOkuStorage storage $ = _getUSDOkuStorage();
        uint256 held = $.shares[msg.sender];
        if (held < shares_) revert Errors.InsufficientBalance();
        unchecked {
            $.shares[msg.sender] = held - shares_;
            $.totalShares -= shares_;
        }
        emit Transfer(msg.sender, address(0), MathLib.toUiAmount(shares_, usdOkuIndex()));
    }

    // ============ Blacklist (works while paused) ============

    function blacklist(address account) external onlyRole(Roles.OKU_BLACKLISTER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKU_UNBLACKLISTER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    /// @notice Whether `account` is blacklisted.
    function isBlacklisted(address account) external view returns (bool) {
        return _getUSDOkuStorage().isBlacklisted[account];
    }

    // ============ Pause ============

    /// @notice Pause transfers, minting and (transitively) unwrapping.
    function pause() external onlyRole(Roles.OKU_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.OKU_UNPAUSER) {
        _unpause();
    }

    // ============ Internal: math ============

    /// @dev `base * rate^elapsed`. Identity at `elapsed == 0` or a no-yield rate.
    ///      Does NOT clamp at `MAX_MULTIPLIER` — the setter proves the
    ///      projection to `rateEnd` is in bounds before committing, and every
    ///      later evaluation is a strictly smaller case of a computation that
    ///      already succeeded.
    function _compound(uint256 base, uint256 rate, uint256 elapsed) private pure returns (uint256) {
        if (elapsed == 0 || rate <= Constants.PRECISION) return base;
        return Math.mulDiv(
            base,
            MathLib.rpow(rate, elapsed, Constants.PRECISION),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    /// @dev Nominal (simple) annualization of a per-second rate, in bps.
    function _impliedAprBps(uint256 rate) private pure returns (uint256) {
        if (rate <= Constants.PRECISION) return 0;
        uint256 excess = rate - Constants.PRECISION;
        return Math.mulDiv(
            excess * Constants.SECONDS_PER_YEAR,
            Constants.BASIS_POINTS,
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKU_UPGRADER) {}
}
