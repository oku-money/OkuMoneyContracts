// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Independently verifies that every ERC-7201 namespaced-storage slot
///         hash matches its documented derivation.  A wrong constant would
///         cause silent storage corruption on a UUPS proxy.
contract ERC7201SlotTest is Test {
    /// @dev Canonical ERC-7201 derivation:
    ///      keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))
    function _erc7201Slot(string memory namespace) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(uint256(keccak256(bytes(namespace))) - 1))
                & ~bytes32(uint256(0xff));
    }

    function test_OkuMoney_StorageLocation() public pure {
        assertEq(
            _erc7201Slot("okumoney.storage.OkuMoney"),
            0xa46c29efb747c5ba816fcb25c64c7053e640ad72653ff106cdc2a03e8238d100
        );
    }

    function test_OkuDollar_StorageLocation() public pure {
        assertEq(
            _erc7201Slot("okumoney.storage.OkuDollar"),
            0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900
        );
    }

    function test_LitePSM_StorageLocation() public pure {
        assertEq(
            _erc7201Slot("okumoney.storage.LitePSM"),
            0x3513f3377f3ae2495699e5bd066d9c7b1ec04346bbec81953fcd75e4450d9100
        );
    }

    function test_ReentrancyGuard_StorageLocation() public pure {
        assertEq(
            _erc7201Slot("openzeppelin.storage.ReentrancyGuard"),
            0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00
        );
    }
}
