// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockUSDT
/// @notice Test-only reserve mimicking Tether's legacy Ethereum `TetherToken` quirks:
///         `transfer`/`transferFrom`/`approve` return nothing, `approve` reverts when
///         changing one non-zero allowance to another, and an owner-settable fee
///         (`basisPointsRate`, capped by `maximumFee`) is taken from the amount sent.
/// @dev NOT FOR PRODUCTION DEPLOYMENT. Anyone can mint and set the fee.
contract MockUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    uint256 public basisPointsRate;
    uint256 public maximumFee;
    address public feeCollector = address(0xFEE);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setParams(uint256 newBasisPoints, uint256 newMaxFee) external {
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFee;
    }

    function fee(uint256 value) public view returns (uint256 f) {
        f = value * basisPointsRate / 10_000;
        if (f > maximumFee) f = maximumFee;
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "MockUSDT: allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        require(value == 0 || allowance[msg.sender][spender] == 0, "MockUSDT: approve race");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "MockUSDT: balance");
        uint256 f = fee(value);
        balanceOf[from] -= value;
        balanceOf[to] += value - f;
        emit Transfer(from, to, value - f);
        if (f > 0) {
            balanceOf[feeCollector] += f;
            emit Transfer(from, feeCollector, f);
        }
    }
}
