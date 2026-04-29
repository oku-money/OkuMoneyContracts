// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "./INttManager.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../../lib/Roles.sol";
import {NttAdapterEvents} from "../../lib/events/NttAdapterEvents.sol";

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
 *      - uint256 destinationChain -> uint16 (Wormhole chain id)
 *      - address recipient        -> bytes32 (left-padded)
 *
 *      Chain-id mappings are supplied via the constructor so the adapter can be
 *      deployed against any combination of supported networks. Additional mappings
 *      may be added or overridden at runtime via `configureChainId`.
 *      Taken from https://docs.wormhole.com/wormhole/reference/constants
 */
contract NttAdapter is IBridgeAdapter, AccessControl, NttAdapterEvents {
    using SafeERC20 for IERC20;

    INttManager public immutable NTT_MANAGER;
    address public immutable TOKEN;
    address public immutable ROUTER;

    /// @notice EVM chain id -> Wormhole chain id mapping. Zero means "unsupported".
    mapping(uint256 => uint16) public wormholeChainId;

    error UnsupportedChain(uint256 chainId);
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidToken(address provided, address expected);
    error UnauthorizedCaller();
    error EthTransferFailed();
    error ZeroAddress();
    /// @dev Constructor / configureChainId received mismatched array lengths.
    error ChainIdLengthMismatch(uint256 evmIds, uint256 wormholeIds);

    /**
     * @param _nttManager Wormhole NTT Manager address
     * @param _token OkuMoney token address
     * @param _router OkuBridgeRouter address (sole authorized caller of `bridge`)
     * @param _admin Admin address (receives configurator + rescuer roles)
     * @param _evmChainIds EVM chain ids to pre-configure
     * @param _wormholeChainIds Corresponding Wormhole chain ids; same length as _evmChainIds
     */
    constructor(
        address _nttManager,
        address _token,
        address _router,
        address _admin,
        uint256[] memory _evmChainIds,
        uint16[] memory _wormholeChainIds
    ) {
        if (_nttManager == address(0)) revert ZeroAddress();
        if (_token == address(0)) revert ZeroAddress();
        if (_router == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_evmChainIds.length != _wormholeChainIds.length) {
            revert ChainIdLengthMismatch(_evmChainIds.length, _wormholeChainIds.length);
        }

        NTT_MANAGER = INttManager(_nttManager);
        TOKEN = _token;
        ROUTER = _router;

        // Apply caller-supplied chain mappings. The deployer is responsible for
        // sourcing the correct Wormhole chain ids from the Wormhole reference docs.
        for (uint256 i = 0; i < _evmChainIds.length; i++) {
            wormholeChainId[_evmChainIds[i]] = _wormholeChainIds[i];
            emit ChainIdConfigured(_evmChainIds[i], _wormholeChainIds[i]);
        }

        // Grant the full role set to admin (matches the unified role policy across the
        // rest of the codebase). Admin redistributes operational roles post-deploy.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.NTT_CONFIGURATOR, _admin);
        _grantRole(Roles.NTT_RESCUER, _admin);
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

    /// @notice Configure or override an EVM chain id -> Wormhole chain id mapping.
    function configureChainId(
        uint256 evmChainId,
        uint16 _wormholeChainId
    )
        external
        onlyRole(Roles.NTT_CONFIGURATOR)
    {
        wormholeChainId[evmChainId] = _wormholeChainId;
        emit ChainIdConfigured(evmChainId, _wormholeChainId);
    }

    /// @notice Withdraw stuck ETH (e.g. fee refunds from the NTT manager).
    function withdrawEth(address payable to) external onlyRole(Roles.NTT_RESCUER) {
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
        onlyRole(Roles.NTT_RESCUER)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(to, amount);
    }

    receive() external payable {}
}
