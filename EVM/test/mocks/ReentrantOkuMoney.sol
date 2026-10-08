// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantOkuMoney
 * @notice Test-only mock that simulates a malicious OkuMoney with a reentrant
 *         callback on `burn()`. Used to verify that `nonReentrant` guards on
 *         LitePSM block cross-function reentrancy.
 * @dev NOT FOR PRODUCTION. Implements the IOkuMoney surface with a configurable
 *      reentrant callback. When `reentrantTarget` is set, `burn()` calls back
 *      into the target with `reentrantCalldata` before completing.
 */
contract ReentrantOkuMoney is ERC20 {
    uint256 public okuMMultiplier = 1e18;
    uint256 public lastOverrideBlock;
    mapping(address => uint256) public minterAllowance;
    mapping(address => bool) public isBlacklisted;

    address public reentrantTarget;
    bytes public reentrantCalldata;

    constructor() ERC20("ReentrantOkuMoney", "rOkuM") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Configure the reentrant callback that fires on `burn()`.
    /// @param target Address to call back into (e.g. LitePSM).
    /// @param data Calldata for the reentrant call.
    function setReentrantCallback(address target, bytes calldata data) external {
        reentrantTarget = target;
        reentrantCalldata = data;
    }

    /// @notice Burns tokens and, if configured, calls back into `reentrantTarget`.
    /// @dev The callback propagates the revert so the outer `nonReentrant`-guarded
    ///      function also reverts. This models the worst-case scenario where a
    ///      malicious token forces the entire transaction to fail.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        if (reentrantTarget != address(0)) {
            // Attempt reentrant call -- should be blocked by nonReentrant on the caller.
            // Propagate the revert so the outer call also reverts.
            (bool ok, bytes memory ret) = reentrantTarget.call(reentrantCalldata);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    function setOkuMMultiplier(uint256 newMultiplier) external {
        okuMMultiplier = newMultiplier;
    }

    /// @notice Stamps the sandwich-guard block, mirroring the real
    ///         `OkuMoney.setOkuMMultiplier` discrete override.
    /// @dev Lets guard tests stamp `lastOverrideBlock` without moving the multiplier.
    function stampYieldBlock() external {
        lastOverrideBlock = block.number;
    }

    function configureMinterAllowance(address minter_, uint256 allowance_) external {
        minterAllowance[minter_] = allowance_;
    }
}
