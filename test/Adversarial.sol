// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {MockToken} from "./MockToken.sol";

/// @dev Transfer-result and callback fixtures only, never production code.
/// No transfer-tax, rebasing, lying-success or gas-exhaustion token model.
contract TransferTestToken is MockToken {
    mapping(address => bool) public returnFalse;
    address public callbackFrom;
    address public callbackTarget;
    bytes public callbackData;
    bool public lastCallbackSucceeded;

    function setReturnFalse(address from, bool value) external { returnFalse[from] = value; }
    function setCallback(address from, address target, bytes calldata data) external {
        callbackFrom = from;
        callbackTarget = target;
        callbackData = data;
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        if (returnFalse[msg.sender]) return false;
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        if (msg.sender == callbackFrom) {
            (lastCallbackSucceeded,) = callbackTarget.call(callbackData);
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev ERC-20 style token returning no boolean, like older deployed tokens.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Payout contract fixture for native transfer failure and reentrancy.
contract PayoutReceiver {
    bool public rejectNative;
    bool public lastCallbackSucceeded;
    address public target;
    bytes public data;
    function configure(bool reject, address target_, bytes calldata data_) external {
        rejectNative = reject;
        target = target_;
        data = data_;
    }
    receive() external payable {
        require(!rejectNative, "native rejected");
        if (target != address(0)) (lastCallbackSucceeded,) = target.call(data);
    }
}

/// @dev External clone with the same runtime is not a registered factory order.
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
contract ForeignCloner {
    function clone(address implementation, bytes32 salt) external returns (address) {
        return Clones.cloneDeterministic(implementation, salt);
    }
    function predict(address implementation, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }
}
