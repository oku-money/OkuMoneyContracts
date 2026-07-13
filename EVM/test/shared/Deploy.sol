// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";

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
    /// @param okuDollar_ OkuDollar vault address
    /// @param usdc_ USDC token address
    /// @param redemptionQueue_ RedemptionQueue address
    /// @param admin_ Admin address
    /// @return proxy The deployed proxy contract
    /// @return impl The implementation contract
    function deployLitePSM(
        address okuMoney_,
        address okuDollar_,
        address usdc_,
        address redemptionQueue_,
        address admin_
    )
        internal
        returns (LitePSM proxy, LitePSM impl)
    {
        impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (okuMoney_, okuDollar_, usdc_, redemptionQueue_, admin_)
        );
        proxy = LitePSM(address(new ERC1967Proxy(address(impl), initData)));
    }
}
