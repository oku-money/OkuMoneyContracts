// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";

import {TestConstants} from "./Constants.sol";

/**
 * @title Deploy
 * @notice Proxy deployment helpers for all OkuMoney contracts
 * @dev Use these helpers to deploy UUPS proxies with consistent initialization.
 */
library Deploy {
    /// @notice Deploy OkuMoney with UUPS proxy
    /// @param admin_ Admin address (receives DEFAULT_ADMIN_ROLE)
    /// @param maxSupply_ Maximum token supply
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployOkuMoney(
        address admin_,
        uint256 maxSupply_
    )
        internal
        returns (OkuMoney proxy, OkuMoney impl)
    {
        impl = new OkuMoney();
        bytes memory initData =
            abi.encodeCall(OkuMoney.initialize, ("OkuMoney", "OkuM", admin_, maxSupply_));
        proxy = OkuMoney(address(new ERC1967Proxy(address(impl), initData)));
    }

    /// @notice Deploy OkuMoney with default max supply
    function deployOkuMoney(address admin_) internal returns (OkuMoney proxy, OkuMoney impl) {
        return deployOkuMoney(admin_, TestConstants.MAX_SUPPLY);
    }

    /// @notice Deploy OkuDollar vault with UUPS proxy
    /// @param okuMoney_ OkuMoney token address
    /// @param admin_ Admin address
    /// @param minCollateralRatio_ Minimum collateral ratio (e.g., 95e16 = 95%)
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployOkuDollar(
        address okuMoney_,
        address admin_,
        uint256 minCollateralRatio_
    )
        internal
        returns (OkuDollar proxy, OkuDollar impl)
    {
        impl = new OkuDollar();
        bytes memory initData = abi.encodeCall(
            OkuDollar.initialize, (okuMoney_, "OkuDollar", "usdOku", admin_, minCollateralRatio_)
        );
        proxy = OkuDollar(address(new ERC1967Proxy(address(impl), initData)));
    }

    /// @notice Deploy OkuDollar with default collateral ratio
    function deployOkuDollar(
        address okuMoney_,
        address admin_
    )
        internal
        returns (OkuDollar proxy, OkuDollar impl)
    {
        return deployOkuDollar(okuMoney_, admin_, TestConstants.MIN_COLLATERAL_RATIO);
    }

    /// @notice Deploy RedemptionQueue with UUPS proxy
    /// @param okuMoney_ OkuMoney token address
    /// @param usdc_ USDC token address (used for decimal multiplier resolution)
    /// @param admin_ Admin address
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployRedemptionQueue(
        address okuMoney_,
        address usdc_,
        address admin_
    )
        internal
        returns (RedemptionQueue proxy, RedemptionQueue impl)
    {
        impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (okuMoney_, usdc_, admin_));
        proxy = RedemptionQueue(address(new ERC1967Proxy(address(impl), initData)));
    }

    /// @notice Deploy LitePSM with UUPS proxy
    /// @param okuMoney_ OkuMoney token address
    /// @param usdOku_ OkuDollar vault address
    /// @param usdc_ USDC token address
    /// @param redemptionQueue_ RedemptionQueue address
    /// @param admin_ Admin address
    /// @param stalenessThreshold_ PoR oracle staleness threshold (seconds)
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployLitePSM(
        address okuMoney_,
        address usdOku_,
        address usdc_,
        address redemptionQueue_,
        address admin_,
        uint256 stalenessThreshold_
    )
        internal
        returns (LitePSM proxy, LitePSM impl)
    {
        impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (okuMoney_, usdOku_, usdc_, redemptionQueue_, admin_, stalenessThreshold_)
        );
        proxy = LitePSM(address(new ERC1967Proxy(address(impl), initData)));
    }

    /// @notice Deploy LitePSM with default staleness threshold (1 hour)
    function deployLitePSM(
        address okuMoney_,
        address usdOku_,
        address usdc_,
        address redemptionQueue_,
        address admin_
    )
        internal
        returns (LitePSM proxy, LitePSM impl)
    {
        return deployLitePSM(
            okuMoney_,
            usdOku_,
            usdc_,
            redemptionQueue_,
            admin_,
            TestConstants.DEFAULT_STALENESS_THRESHOLD
        );
    }

    /// @notice Build the default OkuBridge.InitConfig used by tests.
    function defaultBridgeConfig() internal pure returns (OkuBridge.InitConfig memory) {
        return OkuBridge.InitConfig({
            minBridgeAmount: TestConstants.DEFAULT_MIN_BRIDGE_AMOUNT,
            maxBridgeAmount: TestConstants.DEFAULT_MAX_BRIDGE_AMOUNT,
            feeBps: TestConstants.DEFAULT_BRIDGE_FEE,
            bridgeDeadline: TestConstants.DEFAULT_BRIDGE_DEADLINE
        });
    }

    /// @notice Deploy OkuBridge with UUPS proxy
    /// @param okuMoney_ OkuMoney token address
    /// @param authorizedSigner_ Orchestrator signer address
    /// @param feeRecipient_ Fee recipient address
    /// @param admin_ Admin address
    /// @param initialChains_ Array of supported chain IDs
    /// @param config_ Initial limits / fee / deadline parameters
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployOkuBridge(
        address okuMoney_,
        address authorizedSigner_,
        address feeRecipient_,
        address admin_,
        uint256[] memory initialChains_,
        OkuBridge.InitConfig memory config_
    )
        internal
        returns (OkuBridge proxy, OkuBridge impl)
    {
        impl = new OkuBridge();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (okuMoney_, authorizedSigner_, feeRecipient_, admin_, initialChains_, config_)
        );
        proxy = OkuBridge(address(new ERC1967Proxy(address(impl), initData)));
    }

    /// @notice Deploy OkuBridge with default config
    function deployOkuBridge(
        address okuMoney_,
        address authorizedSigner_,
        address feeRecipient_,
        address admin_,
        uint256[] memory initialChains_
    )
        internal
        returns (OkuBridge proxy, OkuBridge impl)
    {
        return deployOkuBridge(
            okuMoney_,
            authorizedSigner_,
            feeRecipient_,
            admin_,
            initialChains_,
            defaultBridgeConfig()
        );
    }

    /// @notice Deploy OkuBridge with default EVM chains and default config
    function deployOkuBridge(
        address okuMoney_,
        address authorizedSigner_,
        address feeRecipient_,
        address admin_
    )
        internal
        returns (OkuBridge proxy, OkuBridge impl)
    {
        uint256[] memory chains = new uint256[](3);
        chains[0] = TestConstants.OPTIMISM_CHAIN_ID;
        chains[1] = TestConstants.ARBITRUM_CHAIN_ID;
        chains[2] = TestConstants.BASE_CHAIN_ID;
        return deployOkuBridge(okuMoney_, authorizedSigner_, feeRecipient_, admin_, chains);
    }

    /// @notice Deploy OkuBridgeRouter with UUPS proxy
    function deployOkuBridgeRouter(
        address usdOku_,
        address okuMoney_,
        address okuBridge_,
        address admin_
    )
        internal
        returns (OkuBridgeRouter proxy, OkuBridgeRouter impl)
    {
        impl = new OkuBridgeRouter();
        bytes memory initData =
            abi.encodeCall(OkuBridgeRouter.initialize, (usdOku_, okuMoney_, okuBridge_, admin_));
        proxy = OkuBridgeRouter(address(new ERC1967Proxy(address(impl), initData)));
    }
}
