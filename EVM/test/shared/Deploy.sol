// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {USDOku} from "../../src/token/USDOku.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";
import {SubscriptionModule} from "../../src/subscription/SubscriptionModule.sol";

/**
 * @title Deploy
 * @notice UUPS proxy deployers for the four production proxies.
 * @dev Deploy ORDER MATTERS and mirrors `scripts/deploy/index.ts`:
 *      OkuM (owns `usdcDecimalMultiplier`) -> SubscriptionModule (cross-asserts
 *      against it) -> USDOku -> USDOkuWrapper (needs both tokens). USDOku must
 *      then be wired to the wrapper via `setWrapper`, which cannot happen at
 *      USDOku's `initialize` because the wrapper does not exist yet.
 */
library Deploy {
    function okuM(
        address admin,
        uint256 maxSupply,
        address asset
    )
        internal
        returns (OkuM proxy, OkuM impl)
    {
        impl = new OkuM();
        bytes memory data =
            abi.encodeCall(OkuM.initialize, ("Oku Money", "OkuM", admin, maxSupply, asset));
        proxy = OkuM(address(new ERC1967Proxy(address(impl), data)));
    }

    function subscriptionModule(
        address okuMAddr,
        address usdc,
        address admin,
        address treasury
    )
        internal
        returns (SubscriptionModule proxy, SubscriptionModule impl)
    {
        impl = new SubscriptionModule();
        bytes memory data =
            abi.encodeCall(SubscriptionModule.initialize, (okuMAddr, usdc, admin, treasury));
        proxy = SubscriptionModule(address(new ERC1967Proxy(address(impl), data)));
    }

    function usdOku(address admin) internal returns (USDOku proxy, USDOku impl) {
        impl = new USDOku();
        bytes memory data = abi.encodeCall(USDOku.initialize, ("Oku Dollar", "USDOku", admin));
        proxy = USDOku(address(new ERC1967Proxy(address(impl), data)));
    }

    function wrapper(
        address okuMAddr,
        address usdOkuAddr,
        address admin
    )
        internal
        returns (USDOkuWrapper proxy, USDOkuWrapper impl)
    {
        impl = new USDOkuWrapper();
        bytes memory data = abi.encodeCall(USDOkuWrapper.initialize, (okuMAddr, usdOkuAddr, admin));
        proxy = USDOkuWrapper(address(new ERC1967Proxy(address(impl), data)));
    }
}
