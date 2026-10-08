// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title ReentrancyGuardUpgradeable
 * @notice Upgradeable version of OpenZeppelin's ReentrancyGuard
 * @dev Adapted from OpenZeppelin Contracts v5.x. Uses the SAME ERC-7201 slot as OZ's
 *      `ReentrancyGuard`, so switching needs no storage migration. Call
 *      `__ReentrancyGuard_init()` in the inheriting initializer.
 */
abstract contract ReentrancyGuardUpgradeable is Initializable {
    using StorageSlot for bytes32;

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REENTRANCY_GUARD_STORAGE =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    /// @dev Guard states. Non-zero values, so each entry/exit is a cheap
    ///      nonzero-to-nonzero storage write rather than a zero-to-nonzero one.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /// @notice A `nonReentrant` function was called again before it returned.
    error ReentrancyGuardReentrantCall();

    /// @dev Sets NOT_ENTERED; must be called in the inheriting initializer.
    function __ReentrancyGuard_init() internal onlyInitializing {
        __ReentrancyGuard_init_unchained();
    }

    /// @dev Writes the initial NOT_ENTERED state (no parent initializers to run).
    function __ReentrancyGuard_init_unchained() internal onlyInitializing {
        _reentrancyGuardStorageSlot().getUint256Slot().value = NOT_ENTERED;
    }

    /// @dev Rejects a call that re-enters any `nonReentrant` function of this contract
    ///      while one is still executing: marks ENTERED before the body, NOT_ENTERED after.
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    /// @dev Revert if already inside a guarded call; otherwise mark ENTERED.
    function _nonReentrantBefore() private {
        if (_reentrancyGuardEntered()) {
            revert ReentrancyGuardReentrantCall();
        }
        _reentrancyGuardStorageSlot().getUint256Slot().value = ENTERED;
    }

    /// @dev Mark the guarded call as finished.
    function _nonReentrantAfter() private {
        _reentrancyGuardStorageSlot().getUint256Slot().value = NOT_ENTERED;
    }

    /// @dev True while a `nonReentrant` function is executing.
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _reentrancyGuardStorageSlot().getUint256Slot().value == ENTERED;
    }

    /// @dev The storage slot holding the guard state. `virtual` to match OZ's
    ///      signature; no contract in this repo overrides it.
    function _reentrancyGuardStorageSlot() internal pure virtual returns (bytes32) {
        return REENTRANCY_GUARD_STORAGE;
    }
}
