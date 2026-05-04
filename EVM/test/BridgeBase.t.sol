// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {OkuBridge} from "../src/bridge/OkuBridge.sol";
import {OkuBridgeRouter} from "../src/bridge/OkuBridgeRouter.sol";
import {MockBridgeAdapter} from "./mocks/MockBridgeAdapter.sol";
import {MockNttManager} from "./mocks/MockNttManager.sol";
import {Deploy} from "./shared/Deploy.sol";
import {TestConstants} from "./shared/Constants.sol";

/**
 * @title BridgeBaseTest
 * @notice Extended base test with bridge-specific setup
 * @dev Extends BaseTest with OkuBridge, OkuBridgeRouter, and mock adapters.
 *      Use this base for all bridge-related tests.
 */
abstract contract BridgeBaseTest is BaseTest {
    // ============ Bridge Contracts ============

    OkuBridge public okuBridge;
    OkuBridge public okuBridgeImpl;
    OkuBridgeRouter public bridgeRouter;
    OkuBridgeRouter public bridgeRouterImpl;

    // ============ Mock Adapters ============

    MockBridgeAdapter public mockAdapter;
    MockNttManager public mockNttManager;

    // ============ Chain IDs ============

    uint256 public constant OPTIMISM_CHAIN_ID = TestConstants.OPTIMISM_CHAIN_ID;
    uint256 public constant ARBITRUM_CHAIN_ID = TestConstants.ARBITRUM_CHAIN_ID;
    uint256 public constant BASE_CHAIN_ID = TestConstants.BASE_CHAIN_ID;
    uint256 public constant SOLANA_MAINNET_CHAIN_ID = TestConstants.SOLANA_MAINNET_CHAIN_ID;
    uint256 public constant SOLANA_DEVNET_CHAIN_ID = TestConstants.SOLANA_DEVNET_CHAIN_ID;
    uint256 public constant UNSUPPORTED_CHAIN_ID = TestConstants.UNSUPPORTED_CHAIN_ID;

    // ============ EIP-712 Constants ============

    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // ============ Setup ============

    function setUp() public virtual override {
        super.setUp();
        _initOrchestrator();
        _deployBridgeContracts();
        _setupBridgeRoles();
    }

    function _deployBridgeContracts() internal {
        // Deploy OkuBridge with default EVM chains
        (okuBridge, okuBridgeImpl) =
            Deploy.deployOkuBridge(address(okuMoney), orchestratorSigner, feeRecipient, admin);

        // Deploy OkuBridgeRouter
        (bridgeRouter, bridgeRouterImpl) = Deploy.deployOkuBridgeRouter(
            address(okuDollar), address(okuMoney), address(okuBridge), admin
        );

        // Deploy mock adapters — the mocks themselves call okuMoney.mint(), so they need
        // MINTER role + allowance granted below in _setupBridgeRoles.
        mockAdapter = new MockBridgeAdapter(address(okuMoney));
        mockNttManager = new MockNttManager(address(okuMoney));
    }

    function _setupBridgeRoles() internal {
        vm.startPrank(admin);

        // Grant OkuBridge MINTER role on OkuMoney
        okuMoney.grantRole(OKUM_MINTER, address(okuBridge));

        // Grant OkuBridgeRouter MINTER role on OkuMoney (for adapter path burns)
        okuMoney.grantRole(OKUM_MINTER, address(bridgeRouter));

        // Grant MINTER role to mock adapters so their completeBridge() helpers can mint
        // on the simulated destination chain.
        okuMoney.grantRole(OKUM_MINTER, address(mockAdapter));
        okuMoney.grantRole(OKUM_MINTER, address(mockNttManager));

        // Grant two-step refund roles
        okuBridge.grantRole(BRIDGE_REFUND_INITIATOR, refundInitiator);
        okuBridge.grantRole(BRIDGE_REFUND_CONFIRMER, refundConfirmer);

        // Register mock adapter
        bridgeRouter.configureAdapter(address(mockAdapter), true);

        vm.stopPrank();

        // Grant minter allowances for bridge contracts + mocks
        vm.startPrank(allowanceManager);
        okuMoney.configureMinterAllowance(address(okuBridge), MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(bridgeRouter), MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(mockAdapter), MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(mockNttManager), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Bridge Helper Functions ============

    /// @notice Sign a bridge request with the orchestrator private key
    function _signBridgeRequest(OkuBridge.BridgeRequest memory request)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.amount,
                request.nonce,
                request.deadline
            )
        );

        bytes32 digest = okuBridge.hashTypedDataV4(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(orchestratorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Approve bridge and call bridgeBurn
    function _approveBridgeBurn(
        address user,
        uint256 destChainId,
        address recipient,
        uint256 amount
    )
        internal
        returns (bytes32 requestId)
    {
        vm.startPrank(user);
        okuMoney.approve(address(okuBridge), amount);
        requestId = okuBridge.bridgeBurn(destChainId, bytes32(uint256(uint160(recipient))), amount);
        vm.stopPrank();
    }

    /// @notice Mint tokens and execute bridge burn
    function _mintAndBridge(
        address user,
        uint256 amount,
        uint256 destChainId,
        address recipient
    )
        internal
        returns (bytes32 requestId, OkuBridge.BridgeRequest memory request)
    {
        _mintOkuMoney(user, amount);

        vm.startPrank(user);
        okuMoney.approve(address(okuBridge), amount);
        requestId = okuBridge.bridgeBurn(destChainId, bytes32(uint256(uint160(recipient))), amount);
        vm.stopPrank();

        // Construct expected request (amount = netAmount, what destination will mint)
        uint256 nonce = okuBridge.outboundNonce(destChainId) - 1;
        (, uint256 netAmount) = okuBridge.quoteFee(amount);
        request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: user,
            recipient: bytes32(uint256(uint160(recipient))),
            amount: netAmount,
            nonce: nonce,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
    }

    /// @notice Execute both steps of the two-step refund flow
    function _twoStepRefund(OkuBridge.BridgeRequest memory request) internal {
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);
        vm.prank(refundConfirmer);
        okuBridge.confirmRefund(request);
    }

    /// @notice Create a bridge request for minting on current chain
    function _createBridgeMintRequest(
        address sender,
        address recipient,
        uint256 amount,
        uint256 sourceChainId
    )
        internal
        view
        returns (OkuBridge.BridgeRequest memory)
    {
        return OkuBridge.BridgeRequest({
            sourceChainId: sourceChainId,
            destChainId: block.chainid,
            sender: sender,
            recipient: bytes32(uint256(uint160(recipient))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
    }

    /// @notice Create a Solana recipient (32-byte pubkey)
    /// @dev Returns a bytes32 that represents a valid Solana pubkey format
    function _createSolanaRecipient(uint256 seed) internal pure returns (bytes32) {
        // Generate a pseudo-random 32-byte Solana pubkey
        // Solana pubkeys are 32 bytes, but when used in EVM bridging,
        // only the full 32 bytes are meaningful (not truncated to 20 bytes)
        return keccak256(abi.encodePacked("solana_pubkey", seed));
    }

    /// @notice Add Solana chain support to the bridge
    function _enableSolanaChain(bool mainnet) internal {
        uint256 chainId = mainnet ? SOLANA_MAINNET_CHAIN_ID : SOLANA_DEVNET_CHAIN_ID;
        vm.prank(admin);
        okuBridge.addSupportedChain(chainId);
    }
}
