// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";

// Fixtures for the hardhat upgrade drill (test/hardhat/drill/upgradeDrill.test.ts).
// They exercise the REAL upgrade script; nothing here is deployed outside tests.

/// @dev Storage-compatible OkuMoney with one added view.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract OkuMoneyV2Mock is OkuMoney {
    function upgradeDrillVersion() external pure returns (uint256) {
        return 2;
    }
}

/// @dev Storage-compatible LitePSM with one added view.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract LitePSMV2Mock is LitePSM {
    function upgradeDrillVersion() external pure returns (uint256) {
        return 2;
    }
}

/// @dev A second compatible LitePSM, for the missing-manifest case.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract LitePSMV3Mock is LitePSM {
    function upgradeDrillVersion() external pure returns (uint256) {
        return 3;
    }
}

/// @dev Storage-INCOMPATIBLE LitePSM: same ERC-7201 namespace, fields reordered.
///      The upgrade script must refuse it before broadcasting anything.
contract LitePSMBadLayoutMock is Initializable, UUPSUpgradeable, AccessControlUpgradeable {
    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        IERC20 usdc;
        IOkuMoney okuMoney;
        IOkuDollar okuDollar;
        uint256 usdcDecimalMultiplier;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
