// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public shouldFailTransfer;
    address public reentrancyTarget;
    bytes public reentrancyCalldata;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFailTransfer(bool fail) external {
        shouldFailTransfer = fail;
    }

    function setReentrancy(address target, bytes memory data) external {
        reentrancyTarget = target;
        reentrancyCalldata = data;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (shouldFailTransfer) return false;
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");

        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);

        if (reentrancyTarget != address(0)) {
            address target = reentrancyTarget;
            bytes memory data = reentrancyCalldata;
            reentrancyTarget = address(0);
            (bool success, ) = target.call(data);
            require(success, "Reentrancy failed");
        }

        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        if (shouldFailTransfer) return false;
        require(balanceOf[sender] >= amount, "ERC20: transfer amount exceeds balance");
        if (allowance[sender][msg.sender] != type(uint256).max) {
            require(allowance[sender][msg.sender] >= amount, "ERC20: insufficient allowance");
            allowance[sender][msg.sender] -= amount;
        }

        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(sender, recipient, amount);

        return true;
    }
}
