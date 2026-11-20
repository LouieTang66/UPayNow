// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {ForwarderFactory} from "../src/ForwarderFactory.sol";

/// @dev Local-only proof that the constructor clears the transient guard before
/// returning: construction and first collection occur in one transaction.
contract CompatibilityHarness {
    event ConstructedAndCollected(address factory, uint256 amount);

    function constructAndCollect(address payout, address token) external returns (address factory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        ForwarderFactory deployed = new ForwarderFactory(payout, tokens);
        uint256 amount = deployed.collect(keccak256("same-transaction-constructor-guard-clear"), token);
        require(amount == 0);
        emit ConstructedAndCollected(address(deployed), amount);
        return address(deployed);
    }
}
