// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Arbitrum's system precompile at address 100 (0x64).
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/**
 * @title L2BlockNumber
 * @notice The block height that advances once per L2 block on every supported chain.
 * @dev On Arbitrum One and Arbitrum Sepolia `block.number` is an estimate of the PARENT
 *      chain's block number, so many L2 blocks share one value; the L2 height is only
 *      available from `ArbSys.arbBlockNumber()`. Ethereum, Optimism, Base and BSC report
 *      their own height in `block.number`.
 *
 *      Used wherever "this block" must mean one L2 block: the `lastOverrideBlock` stamp
 *      (cyfrin audit #11), its same-block fence (#12), the guard that reads it, and the
 *      `OkuMMultiplierUpdated` event. The writer and the readers MUST all use this
 *      function, or the stamp and the comparison would disagree on Arbitrum.
 *
 *      Keyed by chain id so no other chain's address-100 contract is ever called. An
 *      Arbitrum-family chain added later (e.g. Nova, 42170) must be added to
 *      {_isArbitrum}, or it silently keeps the parent-chain estimate.
 *
 *      The precompile is read with a low-level staticcall that falls back to
 *      `block.number` if it returns nothing. That never happens on a real Arbitrum chain;
 *      it exists because a Hardhat fork of Arbitrum reports chain id 42161 without
 *      emulating the precompile, and the fallback keeps those local runs working.
 */
library L2BlockNumber {
    uint256 private constant ARBITRUM_ONE = 42_161;
    uint256 private constant ARBITRUM_SEPOLIA = 421_614;

    address private constant ARB_SYS = address(100);

    /// @notice Current L2 block height.
    function current() internal view returns (uint256) {
        if (_isArbitrum(block.chainid)) {
            (bool ok, bytes memory ret) =
                ARB_SYS.staticcall(abi.encodeCall(IArbSys.arbBlockNumber, ()));
            if (ok && ret.length == 32) return abi.decode(ret, (uint256));
        }
        return block.number;
    }

    function _isArbitrum(uint256 chainId) private pure returns (bool) {
        return chainId == ARBITRUM_ONE || chainId == ARBITRUM_SEPOLIA;
    }
}
