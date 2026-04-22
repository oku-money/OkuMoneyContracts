// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "./INttManager.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../../lib/Roles.sol";

/**
 * @title NttAdapter
 * @notice Adapter integrating Wormhole NTT with OkuBridgeRouter.
 * @dev Translates the IBridgeAdapter calling convention to INttManager. The router
 *      pre-burns OkuMoney before invoking this adapter, so this contract only
 *      handles cross-chain message delivery — no token movement.
 *
 *      Roles:
 *      - DEFAULT_ADMIN_ROLE   — can grant/revoke other roles
 *      - NTT_CONFIGURATOR     — manage chain-id mappings
 *      - NTT_RESCUER          — withdraw stuck ETH/tokens
 *
 *      Conversions:
 *      - uint256 destinationChain → uint16 (Wormhole chain id)
 *      - address recipient        → bytes32 (left-padded)
 */
contract NttAdapter is IBridgeAdapter, AccessControl {
    using SafeERC20 for IERC20;

    INttManager public immutable NTT_MANAGER;
    address public immutable TOKEN;
    address public immutable ROUTER;

    bytes32 public constant NTT_CONFIGURATOR = Roles.NTT_CONFIGURATOR;
    bytes32 public constant NTT_RESCUER = Roles.NTT_RESCUER;

    /// @notice EVM chain id → Wormhole chain id mapping. Zero means "unsupported".
    mapping(uint256 => uint16) public wormholeChainId;

    event BridgeInitiated(
        uint256 amount, uint16 wormholeChainId, bytes32 recipient, uint64 sequence
    );
    event ChainIdConfigured(uint256 evmChainId, uint16 wormholeChainId);

    error UnsupportedChain(uint256 chainId);
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidToken(address provided, address expected);
    error UnauthorizedCaller();
    error EthTransferFailed();
    error ZeroAddress();

    constructor(address _nttManager, address _token, address _router, address _admin) {
        if (_nttManager == address(0)) revert ZeroAddress();
        if (_token == address(0)) revert ZeroAddress();
        if (_router == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        NTT_MANAGER = INttManager(_nttManager);
        TOKEN = _token;
        ROUTER = _router;

        // Pre-configure common chain mappings.
        // See: https://docs.wormhole.com/wormhole/reference/constants
        wormholeChainId[1] = 2; // Ethereum
        wormholeChainId[42_161] = 23; // Arbitrum
        wormholeChainId[10] = 24; // Optimism
        wormholeChainId[137] = 5; // Polygon
        wormholeChainId[8453] = 30; // Base
        wormholeChainId[43_114] = 6; // Avalanche

        // Grant the full role set to admin (matches the unified role policy across the
        // rest of the codebase). Admin redistributes operational roles post-deploy.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(NTT_CONFIGURATOR, _admin);
        _grantRole(NTT_RESCUER, _admin);
    }

    /**
     * @notice Send a cross-chain message via Wormhole NTT.
     * @dev Called by the router after it has burned the user's tokens. Tokens are
     *      not pulled here — this contract only emits the cross-chain message.
     */
    function bridge(
        address _token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        payable
        override
    {
        if (msg.sender != ROUTER) revert UnauthorizedCaller();
        if (_token != TOKEN) revert InvalidToken(_token, TOKEN);
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        uint16 wormholeDestChain = wormholeChainId[destinationChain];
        if (wormholeDestChain == 0) revert UnsupportedChain(destinationChain);

        bytes32 recipientBytes32 = bytes32(uint256(uint160(recipient)));

        uint64 sequence =
            NTT_MANAGER.transfer{value: msg.value}(amount, wormholeDestChain, recipientBytes32);

        emit BridgeInitiated(amount, wormholeDestChain, recipientBytes32, sequence);
    }

    /// @notice Configure or override an EVM chain id → Wormhole chain id mapping.
    function configureChainId(
        uint256 evmChainId,
        uint16 _wormholeChainId
    )
        external
        onlyRole(NTT_CONFIGURATOR)
    {
        wormholeChainId[evmChainId] = _wormholeChainId;
        emit ChainIdConfigured(evmChainId, _wormholeChainId);
    }

    /// @notice Withdraw stuck ETH (e.g. fee refunds from the NTT manager).
    function withdrawEth(address payable to) external onlyRole(NTT_RESCUER) {
        if (to == address(0)) revert ZeroAddress();
        (bool success,) = to.call{value: address(this).balance}("");
        if (!success) revert EthTransferFailed();
    }

    /// @notice Withdraw stuck tokens.
    function withdrawTokens(
        address _token,
        address to,
        uint256 amount
    )
        external
        onlyRole(NTT_RESCUER)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(to, amount);
    }

    receive() external payable {}
}
