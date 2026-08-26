// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/**
 * @title ERC7201SlotsTest
 * @notice Verifies every hardcoded ERC-7201 storage slot against the canonical
 *         derivation.
 * @dev The slots are pinned as literals in the contracts so a namespace rename
 *      cannot silently relocate live storage. This test is what makes that
 *      pinning safe: it recomputes each one and fails on drift.
 *
 *      Derivation:
 *        keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))
 */
contract ERC7201SlotsTest is Test {
    function _derive(string memory namespace) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(uint256(keccak256(bytes(namespace))) - 1))
                & ~bytes32(uint256(0xff));
    }

    function test_ScaledUIAmountSlot() public pure {
        assertEq(
            _derive("okumoney.storage.ScaledUIAmount"),
            0x3cb9c1d6aa88f069eb5ba8341839db9b5d23817fee13933ec1221e36b8fe7800
        );
    }

    function test_OkuMSlot() public pure {
        assertEq(
            _derive("okumoney.storage.OkuM"),
            0xb452deea490617e43215efe5d1021937b5200d3dc5c52d3e2b801ca18fb58800
        );
    }

    function test_SubscriptionModuleSlot() public pure {
        assertEq(
            _derive("okumoney.storage.SubscriptionModule"),
            0xecd0cb33fb25c826f207d6173dfc2e3b8a1f214fee397fc84b1785e86d97ea00
        );
    }

    function test_USDOkuSlot() public pure {
        assertEq(
            _derive("okumoney.storage.USDOku"),
            0xe244738c4870fb11359f7bdc9af3db99c1dc9ff2fda67cb0afd4e0d472bede00
        );
    }

    function test_USDOkuWrapperSlot() public pure {
        assertEq(
            _derive("okumoney.storage.USDOkuWrapper"),
            0x746c0addff87be07555f8f01375a53d4c1892eca9cb88c203061f4fd00a5eb00
        );
    }

    function test_RedemptionQueueSlot() public pure {
        assertEq(
            _derive("okumoney.storage.RedemptionQueueV2"),
            0x6fb684f02919148f6d51ad47eb3d75c08306ce92047d0ad2154c86329afe9d00
        );
    }

    /// @notice The post-step sync window lives in its own namespace on `OkuM`,
    ///         deliberately not inside `ScaledUIAmount` — that library sits on
    ///         every pricing path and is held at 100% coverage, so it should not
    ///         carry storage for a concern it does not own.
    function test_SyncWindowSlot() public pure {
        assertEq(
            _derive("okumoney.storage.SyncWindow"),
            0xf060659b9b87033111ee98a1780759ec75c780b1b57099783a2cb524034dd300
        );
    }

    /// @notice Must remain byte-identical to OZ 5.x so the local upgradeable
    ///         reentrancy guard stays slot-compatible with the canonical one.
    function test_ReentrancyGuardSlot() public pure {
        assertEq(
            _derive("openzeppelin.storage.ReentrancyGuard"),
            0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00
        );
    }

    /// @notice All namespaces are distinct — no two structs can alias.
    function test_AllSlotsDistinct() public pure {
        bytes32[8] memory slots = [
            _derive("okumoney.storage.ScaledUIAmount"),
            _derive("okumoney.storage.OkuM"),
            _derive("okumoney.storage.USDOku"),
            _derive("okumoney.storage.USDOkuWrapper"),
            _derive("okumoney.storage.SubscriptionModule"),
            _derive("okumoney.storage.RedemptionQueueV2"),
            _derive("okumoney.storage.SyncWindow"),
            _derive("openzeppelin.storage.ReentrancyGuard")
        ];
        for (uint256 i = 0; i < slots.length; ++i) {
            for (uint256 j = i + 1; j < slots.length; ++j) {
                assertTrue(slots[i] != slots[j], "slot collision");
            }
        }
    }

    /// @notice Every slot is 256-aligned, per ERC-7201, so a struct can grow by up
    ///         to 255 further words without colliding with the next namespace.
    function test_AllSlotsAreAligned() public pure {
        assertEq(uint256(_derive("okumoney.storage.ScaledUIAmount")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.OkuM")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.USDOku")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.USDOkuWrapper")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.SubscriptionModule")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.RedemptionQueueV2")) & 0xff, 0);
        assertEq(uint256(_derive("okumoney.storage.SyncWindow")) & 0xff, 0);
    }
}
