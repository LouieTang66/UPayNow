// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

// LOCAL TEST FIXTURE ONLY. Unrestricted mint/block controls; never use as a real asset.
contract LocalToken {
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(string memory symbol_, uint8 decimals_) { symbol = symbol_; decimals = decimals_; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount); return true;
    }
}
