// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";

interface IOkuUSD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IAggregatorV3 {
    function latestAnswer() external view returns (int256);
    function latestTimestamp() external view returns (uint256);
}

/**
 * @title LitePSM
 * @notice Peg Stability Module for 1:1 USDC <-> OkuUSD swaps with zero slippage
 * @dev Includes PoR oracle checks and redemption queue for when buffer is depleted
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    IOkuUSD public okuUSD;
    IERC20 public usdc;
    RedemptionQueue public redemptionQueue;

    // Oracle configuration
    IAggregatorV3 public porOracle;
    uint256 public stalenessThreshold;
    bool public oracleEnabled;

    // Events
    event Swap(address indexed user, uint256 usdcIn, uint256 okuUSDOut);
    event Redeem(address indexed user, uint256 okuUSDIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuUSD,
        address _usdc,
        address _redemptionQueue,
        address admin
    ) public initializer {
        __AccessControl_init();
        __Pausable_init();

        okuUSD = IOkuUSD(_okuUSD);
        usdc = IERC20(_usdc);
        redemptionQueue = RedemptionQueue(_redemptionQueue);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);

        stalenessThreshold = 1 hours;
    }

    // ============ Swap Functions ============

    /**
     * @notice Swap USDC for OkuUSD at 1:1 rate
     * @param usdcAmount Amount of USDC to swap
     */
    function swap(uint256 usdcAmount) external whenNotPaused {
        require(usdcAmount > 0, "Amount must be positive");

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(usdcAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuUSD to user (1:1)
        okuUSD.mint(msg.sender, usdcAmount);

        emit Swap(msg.sender, usdcAmount, usdcAmount);
    }

    /**
     * @notice Redeem OkuUSD for USDC at 1:1 rate
     * @param okuUSDAmount Amount of OkuUSD to redeem
     */
    function redeem(uint256 okuUSDAmount) external whenNotPaused {
        require(okuUSDAmount > 0, "Amount must be positive");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= okuUSDAmount) {
            // Sufficient buffer - process immediately
            okuUSD.burn(msg.sender, okuUSDAmount);
            usdc.safeTransfer(msg.sender, okuUSDAmount);
            emit Redeem(msg.sender, okuUSDAmount, okuUSDAmount);
        } else {
            // Insufficient buffer - queue redemption
            redemptionQueue.enqueue(msg.sender, okuUSDAmount);
        }
    }

    /**
     * @notice Process queued redemptions (called by operator when buffer refilled)
     * @param maxEntries Maximum number of queue entries to process
     */
    function processQueue(uint256 maxEntries) external onlyRole(OPERATOR_ROLE) {
        redemptionQueue.processQueue(maxEntries, address(usdc), address(okuUSD));
        emit BufferRefilled(usdc.balanceOf(address(this)));
    }

    // ============ Oracle Management ============

    function configureOracle(
        address _oracle,
        uint256 _stalenessThreshold,
        bool _enabled
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        porOracle = IAggregatorV3(_oracle);
        stalenessThreshold = _stalenessThreshold;
        oracleEnabled = _enabled;
        emit OracleConfigured(_oracle, _stalenessThreshold, _enabled);
    }

    function _checkReserves(uint256 mintAmount) internal view {
        require(address(porOracle) != address(0), "Oracle not configured");

        int256 reserves = porOracle.latestAnswer();
        uint256 lastUpdate = porOracle.latestTimestamp();

        require(block.timestamp - lastUpdate < stalenessThreshold, "Stale oracle data");
        require(reserves >= 0, "Invalid oracle response");

        uint256 newSupply = okuUSD.totalSupply() + mintAmount;
        require(uint256(reserves) >= newSupply, "Exceeds reserves");
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function withdrawUSDC(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        usdc.safeTransfer(to, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
