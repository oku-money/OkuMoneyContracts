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
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OkuMoneyEvents} from "../lib/events/OkuMoneyEvents.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token (ticker `OkuM`) backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation
 *      tracked by a stored `okuMMultiplier` written discretely by an orchestrator via
 *      `setOkuMMultiplier()` or `distributeYield()`.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMMultiplier() is a separate view function for pricing — used by PSM and vault.
 *
 *      The minter-allowance design (per-minter cap in `minterAllowance`, decremented on
 *      `mint`) is modeled on Circle's FiatToken minter-controller pattern.
 *      Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 *      See Constants.sol for terminology legend.
 *
 *      Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 *      See https://eips.ethereum.org/EIPS/eip-7201
 */
contract OkuMoney is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    OkuMoneyEvents,
    IOkuMoney
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        // Dollar value per token multiplier (starts at 1e18 = $1.00, written by OKUM_REBASER)
        uint256 okuMMultiplier;
        // Minter allowance system (Circle FiatToken pattern; see contract NatSpec for source)
        mapping(address => uint256) minterAllowance;
        // Supply cap in token units
        uint256 maxSupply;
        // Blacklist
        mapping(address => bool) isBlacklisted;
        // Block number of last yield distribution. Used by YieldSandwichGuard consumers
        // (OkuDollar, LitePSM) to block PSM/vault operations in the same block as a
        // distribution and prevent sandwich attacks on the multiplier write.
        uint256 lastYieldDistributionBlock;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoney")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUMONEY_STORAGE_LOCATION =
        0xa46c29efb747c5ba816fcb25c64c7053e640ad72653ff106cdc2a03e8238d100;

    function _getOkuMoneyStorage() private pure returns (OkuMoneyStorage storage $) {
        assembly {
            $.slot := OKUMONEY_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, MultiplierCannotDecrease) live in lib/Errors.sol.
    error ZeroSupply();
    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    /// @dev Multiplier ceiling defense-in-depth — caps the dollar-value-per-token
    ///      at `Constants.MAX_MULTIPLIER` (= $1,000,000) so a compromised
    ///      `OKUM_REBASER` key cannot push the multiplier into a region where
    ///      downstream multiplications (PSM mint/redeem, OkuDollar wrap/unwrap)
    ///      lose precision or overflow. Mirrors the explicit `MAX_OKU_M_PRICE`
    ///      guard on the SVM side.
    error MultiplierTooHigh();
    /// @dev Mirrors SVM `LitePsmError::YieldTooSmall`. Prevents a tiny yieldAmount
    ///      that truncates to zero per-token from stamping `lastYieldDistributionBlock`
    ///      without actually moving the multiplier (wasting the sandwich-lock window).
    error YieldTooSmall();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name ERC-20 name
    /// @param symbol ERC-20 symbol (canonical ticker is `OkuM`)
    /// @param _admin Admin address (receives the full role set; see role-grant policy below)
    /// @param initialMaxSupply Initial supply cap
    /// @dev Admin is granted every role at deployment. Operators are expected to
    ///      redistribute operational roles to multisigs, hot wallets, and bridge
    ///      contracts post-deploy. The other contracts in the suite follow the same
    ///      policy and link back here for the canonical description.
    function initialize(
        string memory name,
        string memory symbol,
        address _admin,
        uint256 initialMaxSupply
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
        __AccessControl_init();
        __Pausable_init();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        $.okuMMultiplier = Constants.PRECISION;
        $.maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKUM_UPGRADER, _admin);
        _grantRole(Roles.OKUM_PAUSER, _admin);
        _grantRole(Roles.OKUM_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_MINTER, _admin);
        _grantRole(Roles.OKUM_REBASER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKUM_CAP_MANAGER, _admin);
        _grantRole(Roles.OKUM_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC20 + IOkuMoney Overrides ============
    // ERC20Upgradeable and IOkuMoney both declare these functions; explicit override
    // specifiers satisfy the Solidity compiler's diamond-inheritance requirement.

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IOkuMoney)
        returns (uint256)
    {
        return super.balanceOf(account);
    }

    function totalSupply() public view override(ERC20Upgradeable, IOkuMoney) returns (uint256) {
        return super.totalSupply();
    }

    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IOkuMoney)
        returns (bool)
    {
        return super.transfer(to, amount);
    }

    // ============ Storage Accessor Views ============

    function minterAllowance(address minter_) public view returns (uint256) {
        return _getOkuMoneyStorage().minterAllowance[minter_];
    }

    function maxSupply() public view returns (uint256) {
        return _getOkuMoneyStorage().maxSupply;
    }

    function isBlacklisted(address account) public view returns (bool) {
        return _getOkuMoneyStorage().isBlacklisted[account];
    }

    function lastYieldDistributionBlock() public view returns (uint256) {
        return _getOkuMoneyStorage().lastYieldDistributionBlock;
    }

    // ============ Multiplier Logic ============

    /// @notice Stored OkuM multiplier (dollar value per token, 1e18 = $1.00)
    /// @dev Written by OKUM_REBASER via {setOkuMMultiplier} or {distributeYield}.
    ///      Never decreases. balanceOf() is unaffected; the multiplier is consumed by
    ///      the PSM and vault for pricing.
    function okuMMultiplier() public view returns (uint256) {
        return _getOkuMoneyStorage().okuMMultiplier;
    }

    /// @notice Directly override the stored multiplier
    /// @param newMultiplier New multiplier value (must be >= current and <= MAX_MULTIPLIER)
    /// @dev The `<= Constants.MAX_MULTIPLIER` ceiling is defense-in-depth: even
    ///      with a compromised `OKUM_REBASER` key, the multiplier cannot be
    ///      pushed into a region that would distort the PSM and vault math.
    ///      Mirrors the explicit `MAX_OKU_M_PRICE` guard on the SVM side.
    function setOkuMMultiplier(uint256 newMultiplier) external onlyRole(Roles.OKUM_REBASER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 currentMultiplier = $.okuMMultiplier;
        if (newMultiplier < currentMultiplier) revert Errors.MultiplierCannotDecrease();
        if (newMultiplier > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();
        $.lastYieldDistributionBlock = block.number;
        $.okuMMultiplier = newMultiplier;
        emit OkuMMultiplierUpdated(currentMultiplier, newMultiplier, totalSupply());
    }

    /// @notice Distribute realized dollar yield across all token holders
    /// @dev Increases okuMMultiplier by yieldAmount / totalSupply.
    ///      yieldAmount is dollar-denominated (18 decimals).
    ///      E.g., $1000 yield on 10000 tokens -> +$0.10/token.
    ///
    ///      Enforces the same `MAX_MULTIPLIER` ceiling as `setOkuMMultiplier`.
    ///      The check runs against the freshly-computed `newMultiplier`, so a
    ///      single huge `yieldAmount` cannot bypass it.
    /// @param yieldAmount Dollar yield to distribute (18 decimals)
    function distributeYield(uint256 yieldAmount) external onlyRole(Roles.OKUM_REBASER) {
        uint256 supply = totalSupply();
        if (supply == 0) revert ZeroSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldMultiplier = $.okuMMultiplier;
        uint256 yieldPerToken = yieldAmount * Constants.PRECISION / supply;
        // Reject yields that truncate to zero per token. A zero increment would stamp
        // `lastYieldDistributionBlock` without moving the multiplier, wasting the
        // sandwich-lock slot. Mirrors SVM `LitePsmError::YieldTooSmall`.
        if (yieldPerToken == 0) revert YieldTooSmall();
        uint256 newMultiplier = oldMultiplier + yieldPerToken;
        if (newMultiplier > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();
        $.lastYieldDistributionBlock = block.number;
        $.okuMMultiplier = newMultiplier;
        emit YieldDistributed(yieldAmount, oldMultiplier, newMultiplier, supply);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @dev Blocks blacklisted owners or spenders from using a pre-signed permit.
    ///      Intentionally not pause-gated — approvals are allowed while paused.
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
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /// @dev Pause blocks peer-to-peer transfers; mint has its own whenNotPaused;
    ///      burn always proceeds. Blacklist applies to the non-zero side(s).
    function _update(address from, address to, uint256 amount) internal override {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);

        uint256 dollarValue = MathLib.okuMToDollars(amount, $.okuMMultiplier);
        emit TransferValue(from, to, amount, dollarValue);
    }

    // ============ Minting & Burning ============

    /// @notice Mint raw tokens to an address
    /// @dev Creates raw tokens; minting 100 tokens at okuMMultiplier=$1.05 creates $105 of value.
    ///      The PSM handles USDC <-> OkuM conversion using okuMMultiplier(). See contract
    ///      NatSpec for the Circle FiatToken minter-allowance source reference.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        unchecked {
            $.minterAllowance[msg.sender] -= amount;
        }

        _mint(to, amount);
    }

    /// @notice Burn raw tokens from caller. Allowed while paused.
    function burn(uint256 amount) external onlyRole(Roles.OKUM_MINTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

    function configureMinterAllowance(
        address minter_,
        uint256 allowance
    )
        external
        onlyRole(Roles.OKUM_ALLOWANCE_MANAGER)
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldAllowance = $.minterAllowance[minter_];
        $.minterAllowance[minter_] = allowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, allowance);
    }

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKUM_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(Roles.OKUM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.OKUM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.OKUM_UPGRADER)
    {}
}
