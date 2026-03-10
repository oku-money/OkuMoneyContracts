// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuNote} from "../interfaces/IOkuNote.sol";

/**
 * @title OkuUSD
 * @notice Rebasing $1-pegged stablecoin with independent yield rate, backed by OkuNote reserves
 * @dev NOT an ERC-4626 vault. Custom rebasing token with its own shares/multiplier.
 *      Holds OkuNotes as reserves. Independent yield rate enables revenue extraction
 *      (note rate > USD rate) or forward-facing yield (USD rate > note rate).
 *
 *      Wrap/unwrap are price-aware: they use notePrice() and usdMultiplier() to convert
 *      between note token amounts and OkuUSD amounts at their respective dollar values.
 */
contract OkuUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ Roles ============

    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant USD_REBASER = keccak256("USD_REBASER");
    bytes32 public constant RESERVE_MANAGER = keccak256("RESERVE_MANAGER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");

    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    // ============ State ============

    IOkuNote public okuNote;

    // USD rebasing mechanism (mirrors OkuNote pattern)
    mapping(address => uint256) private _usdShares;
    uint256 private _totalUsdShares;
    uint256 internal _usdBaseMultiplier;
    uint256 public usdRatePerSecond;
    uint256 public usdLastAccrualTime;
    uint256 public usdRateEnd;
    uint256 public usdPendingRatePerSecond;

    // Collateralization
    uint256 public minCollateralRatio;

    // ============ Events ============

    event UsdRebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event UsdYieldRateUpdated(
        uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextUsdYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event ReservesDeposited(address indexed depositor, uint256 noteAmount);
    event SurplusWithdrawn(address indexed to, uint256 noteAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuNote,
        string memory name,
        string memory symbol,
        address admin,
        uint256 _minCollateralRatio
    )
        public
        initializer
    {
        require(_okuNote != address(0), "Zero address");
        require(_minCollateralRatio <= PRECISION, "Ratio exceeds 100%");

        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
        __AccessControl_init();
        __Pausable_init();

        okuNote = IOkuNote(_okuNote);
        minCollateralRatio = _minCollateralRatio;

        _usdBaseMultiplier = PRECISION;
        usdRatePerSecond = PRECISION;
        usdLastAccrualTime = block.timestamp;
        usdPendingRatePerSecond = PRECISION;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
        _grantRole(VAULT_PAUSER, admin);
        _grantRole(VAULT_UNPAUSER, admin);
    }

    // ============ USD Multiplier (Continuous Accrual) ============

    /**
     * @notice Computed USD multiplier with continuous yield accrual
     * @dev Same _rpow pattern as OkuNote.notePrice()
     */
    function usdMultiplier() public view returns (uint256) {
        uint256 rate = usdRatePerSecond;
        if (rate <= PRECISION) {
            if (usdRateEnd != 0 && block.timestamp > usdRateEnd) {
                uint256 pendingRate = usdPendingRatePerSecond;
                if (pendingRate > PRECISION) {
                    uint256 elapsedPending = block.timestamp - usdRateEnd;
                    return (_usdBaseMultiplier * _rpow(pendingRate, elapsedPending, PRECISION))
                        / PRECISION;
                }
            }
            return _usdBaseMultiplier;
        }

        uint256 base = _usdBaseMultiplier;

        if (usdRateEnd != 0 && block.timestamp > usdRateEnd) {
            uint256 elapsedCurrent = usdRateEnd - usdLastAccrualTime;
            if (elapsedCurrent > 0) {
                base = (base * _rpow(rate, elapsedCurrent, PRECISION)) / PRECISION;
            }
            uint256 pendingRate = usdPendingRatePerSecond;
            if (pendingRate > PRECISION) {
                uint256 elapsedPending = block.timestamp - usdRateEnd;
                if (elapsedPending > 0) {
                    base = (base * _rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return base;
        }

        uint256 elapsed = block.timestamp - usdLastAccrualTime;
        if (elapsed == 0) return base;
        return (base * _rpow(rate, elapsed, PRECISION)) / PRECISION;
    }

    function usdBaseMultiplier() public view returns (uint256) {
        return _usdBaseMultiplier;
    }

    function totalUsdShares() public view returns (uint256) {
        return _totalUsdShares;
    }

    function usdSharesOf(address account) public view returns (uint256) {
        return _usdShares[account];
    }

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply() public view override returns (uint256) {
        return (_totalUsdShares * usdMultiplier()) / PRECISION;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return (_usdShares[account] * usdMultiplier()) / PRECISION;
    }

    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        uint256 shares = (amount * PRECISION) / usdMultiplier();
        _transferUsdShares(msg.sender, to, shares);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        uint256 shares = (amount * PRECISION) / usdMultiplier();
        _transferUsdShares(from, to, shares);
        return true;
    }

    function _transferUsdShares(address from, address to, uint256 shares) internal {
        require(from != address(0), "Transfer from zero address");
        require(to != address(0), "Transfer to zero address");

        uint256 fromBalance = _usdShares[from];
        require(fromBalance >= shares, "Insufficient balance");

        _usdShares[from] = fromBalance - shares;
        _usdShares[to] += shares;

        emit Transfer(from, to, (shares * usdMultiplier()) / PRECISION);
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /**
     * @notice Wrap OkuNotes into OkuUSD (price-aware)
     * @dev usdMinted = noteAmount × notePrice() / usdMultiplier()
     *      100 note tokens at notePrice=$1.05, usdMultiplier=1.0 → 105 OkuUSD.
     *      The note's dollar value is converted to OkuUSD at the current usdMultiplier.
     * @param noteAmount Amount of OkuNote tokens to wrap
     * @param receiver Address to receive OkuUSD
     * @return usdMinted Amount of OkuUSD minted
     */
    function wrap(uint256 noteAmount, address receiver) external returns (uint256 usdMinted) {
        require(noteAmount > 0, "Amount must be positive");
        require(receiver != address(0), "Zero receiver");

        // Measure actual notes received (handles fee-on-transfer edge cases)
        uint256 balBefore = IERC20(address(okuNote)).balanceOf(address(this));
        IERC20(address(okuNote)).safeTransferFrom(msg.sender, address(this), noteAmount);
        uint256 actualReceived = IERC20(address(okuNote)).balanceOf(address(this)) - balBefore;

        // Price-aware: convert note token value to OkuUSD amount
        // usdMinted = actualReceived × notePrice / usdMultiplier
        uint256 price = okuNote.notePrice();
        uint256 mult = usdMultiplier();
        usdMinted = (actualReceived * price) / mult;

        // Calculate USD shares to mint (rounds DOWN — favors vault)
        uint256 sharesToMint = (usdMinted * PRECISION) / mult;
        require(sharesToMint > 0, "Amount too small");

        _totalUsdShares += sharesToMint;
        _usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
    }

    /**
     * @notice Unwrap OkuUSD back to OkuNotes (price-aware)
     * @dev notesReturned = usdAmount × usdMultiplier() / notePrice()
     *      105 OkuUSD at usdMultiplier=1.0, notePrice=$1.05 → 100 note tokens.
     *      Reverts if vault holds insufficient notes.
     * @param usdAmount Amount of OkuUSD to unwrap
     * @param receiver Address to receive OkuNotes
     * @return notesReturned Amount of OkuNote tokens returned
     */
    function unwrap(uint256 usdAmount, address receiver) external returns (uint256 notesReturned) {
        require(usdAmount > 0, "Amount must be positive");
        require(receiver != address(0), "Zero receiver");

        // Price-aware: convert OkuUSD amount to note token count
        // notesReturned = usdAmount × usdMultiplier / notePrice
        uint256 mult = usdMultiplier();
        uint256 price = okuNote.notePrice();
        notesReturned = (usdAmount * mult) / price;

        // Calculate USD shares to burn (rounds UP — favors vault)
        uint256 sharesToBurn = (usdAmount * PRECISION + mult - 1) / mult;
        require(_usdShares[msg.sender] >= sharesToBurn, "Insufficient balance");

        _usdShares[msg.sender] -= sharesToBurn;
        _totalUsdShares -= sharesToBurn;

        // Ensure vault has enough notes
        require(
            IERC20(address(okuNote)).balanceOf(address(this)) >= notesReturned,
            "Insufficient reserves"
        );

        IERC20(address(okuNote)).safeTransfer(receiver, notesReturned);

        emit Transfer(msg.sender, address(0), usdAmount);
    }

    // ============ Reserve Management ============

    /**
     * @notice Deposit notes without minting OkuUSD shares (top up reserves)
     * @dev Used when USD rate > note rate (vault undercollateralized).
     *      Since OkuNote is non-rebasing, note tokens are NOT dollar-denominated —
     *      their value depends on notePrice().
     * @param noteAmount Amount of OkuNote tokens to deposit
     */
    function depositReserves(uint256 noteAmount) external onlyRole(RESERVE_MANAGER) {
        require(noteAmount > 0, "Amount must be positive");
        IERC20(address(okuNote)).safeTransferFrom(msg.sender, address(this), noteAmount);
        emit ReservesDeposited(msg.sender, noteAmount);
    }

    /**
     * @notice Withdraw surplus notes without burning OkuUSD shares
     * @dev Used when USD rate < note rate (vault overcollateralized).
     *      Enforces collateralizationRatio() >= minCollateralRatio AFTER withdrawal.
     * @param noteAmount Amount of OkuNote tokens to withdraw
     */
    function withdrawSurplus(uint256 noteAmount) external onlyRole(RESERVE_MANAGER) {
        require(noteAmount > 0, "Amount must be positive");

        IERC20(address(okuNote)).safeTransfer(msg.sender, noteAmount);

        // Enforce collateralization floor AFTER withdrawal
        require(collateralizationRatio() >= minCollateralRatio, "Below minimum collateral ratio");

        emit SurplusWithdrawn(msg.sender, noteAmount);
    }

    // ============ Admin ============

    function setMinCollateralRatio(uint256 newRatio) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newRatio <= PRECISION, "Ratio exceeds 100%");
        uint256 oldRatio = minCollateralRatio;
        minCollateralRatio = newRatio;
        emit MinCollateralRatioUpdated(oldRatio, newRatio);
    }

    // ============ Collateralization Views (Price-Aware) ============

    /**
     * @notice Total note tokens held as reserves
     */
    function totalNoteReserves() public view returns (uint256) {
        return IERC20(address(okuNote)).balanceOf(address(this));
    }

    /**
     * @notice Total OkuUSD obligations (in dollar terms)
     */
    function totalUsdObligations() public view returns (uint256) {
        return totalSupply();
    }

    /**
     * @notice Price-aware collateralization ratio
     * @dev collateralizationRatio = (noteBalance × notePrice / PRECISION) × PRECISION / totalSupply
     *      The numerator converts note token count to dollar value via notePrice().
     *      The denominator (totalSupply) is already in dollar terms (usdShares × usdMultiplier).
     */
    function collateralizationRatio() public view returns (uint256) {
        uint256 obligations = totalUsdObligations();
        if (obligations == 0) return type(uint256).max;
        uint256 reservesDollarValue = (totalNoteReserves() * okuNote.notePrice()) / PRECISION;
        return (reservesDollarValue * PRECISION) / obligations;
    }

    /**
     * @notice Extractable surplus as note tokens (0 if undercollateralized)
     * @dev Calculates dollar surplus, then converts back to note tokens via notePrice()
     */
    function surplus() public view returns (uint256) {
        uint256 price = okuNote.notePrice();
        uint256 reservesDollarValue = (totalNoteReserves() * price) / PRECISION;
        uint256 obligations = totalUsdObligations();
        if (reservesDollarValue > obligations) {
            // Convert dollar surplus back to note token count
            uint256 dollarSurplus = reservesDollarValue - obligations;
            return (dollarSurplus * PRECISION) / price;
        }
        return 0;
    }

    // ============ Rate Management (USD_REBASER) ============

    function setUsdYieldRate(uint256 newRate, uint256 endTimestamp) external onlyRole(USD_REBASER) {
        require(newRate >= PRECISION, "Rate cannot be negative");
        require(newRate <= MAX_RATE, "Rate too high");
        require(endTimestamp == 0 || endTimestamp > block.timestamp, "End must be in the future");

        _usdBaseMultiplier = usdMultiplier();
        usdLastAccrualTime = block.timestamp;

        usdRatePerSecond = newRate;
        usdRateEnd = endTimestamp;
        usdPendingRatePerSecond = PRECISION;

        emit UsdYieldRateUpdated(newRate, endTimestamp, _usdBaseMultiplier);
    }

    function setNextUsdYieldRate(uint256 newRate) external onlyRole(USD_REBASER) {
        require(newRate >= PRECISION, "Rate cannot be negative");
        require(newRate <= MAX_RATE, "Rate too high");
        require(usdRateEnd != 0, "Current rate has no end");

        usdPendingRatePerSecond = newRate;

        emit NextUsdYieldRateSet(newRate, usdRateEnd);
    }

    /**
     * @notice Emergency override — snapshots computed multiplier, resets rate to zero yield
     */
    function updateUsdMultiplier(uint256 newMultiplier) external onlyRole(USD_REBASER) {
        uint256 currentMultiplier = usdMultiplier();
        require(newMultiplier >= currentMultiplier, "Multiplier cannot decrease");
        _usdBaseMultiplier = newMultiplier;
        usdRatePerSecond = PRECISION;
        usdRateEnd = 0;
        usdPendingRatePerSecond = PRECISION;
        usdLastAccrualTime = block.timestamp;
        emit UsdRebaseEvent(currentMultiplier, newMultiplier);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(VAULT_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(VAULT_UNPAUSER) {
        _unpause();
    }

    // ============ Exponentiation by Squaring (MakerDAO DSS) ============

    function _rpow(uint256 x, uint256 n, uint256 b) internal pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := b }
                default { z := 0 }
            }
            default {
                switch mod(n, 2)
                case 0 { z := b }
                default { z := x }
                let half := div(b, 2)
                for { n := div(n, 2) } n { n := div(n, 2) } {
                    let xx := mul(x, x)
                    if iszero(eq(div(xx, x), x)) { revert(0, 0) }
                    let xxRound := add(xx, half)
                    if lt(xxRound, xx) { revert(0, 0) }
                    x := div(xxRound, b)
                    if mod(n, 2) {
                        let zx := mul(z, x)
                        if and(iszero(iszero(x)), iszero(eq(div(zx, x), z))) {
                            revert(0, 0)
                        }
                        let zxRound := add(zx, half)
                        if lt(zxRound, zx) { revert(0, 0) }
                        z := div(zxRound, b)
                    }
                }
            }
        }
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    uint256[37] private __gap;
}
