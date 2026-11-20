// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

interface IDeterministicDeployer {
    function deploy(address payout, address[] calldata tokens) external returns (address);
}

/// @dev Smart-wallet payout submits its own deployment twice in one transaction.
contract CrosschainPayout {
    function deployTwice(address root, address[] calldata tokens) external returns (address factory) {
        factory = IDeterministicDeployer(root).deploy(address(this), tokens);
        require(IDeterministicDeployer(root).deploy(address(this), tokens) == factory, "not idempotent");
    }
}
