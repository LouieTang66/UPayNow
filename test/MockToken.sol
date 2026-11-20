// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

/// @dev Local test double. Not evidence of live USDT integration.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
