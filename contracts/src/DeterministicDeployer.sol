// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {ForwarderFactory} from "./ForwarderFactory.sol";

/// @dev Fixed CREATE2 initcode; deployer is bound during construction, not supplied
/// by a caller. Remains deployed: no SELFDESTRUCT or reusable CREATE capability.
contract FactoryCreationProxy {
    address private immutable _deployer;
    bool private _used;

    error OnlyDeployer();
    error AlreadyUsed();
    error CreationFailed();

    constructor() { _deployer = msg.sender; }

    function deploy(bytes memory initCode) external returns (address created) {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (_used) revert AlreadyUsed();
        _used = true;
        assembly ("memory-safe") {
            created := create(0, add(initCode, 32), mload(initCode))
        }
        if (created == address(0)) revert CreationFailed();
    }
}

/// @notice Cross-chain deterministic, opt-in deployment of the unmodified v3
/// factory. Deploy this root via ERC-2470 with identical initcode and salt.
/// @dev No owner, fee, constructor arguments, upgrade or funds-handling surface.
/// Token addresses may differ between chains; array order is part of config.
contract DeterministicDeployer {
    bytes32 private constant _VERSION = keccak256("upaynow.factory.create3.v1");

    event FactoryDeployed(address indexed payout, address indexed factory);
    error OnlyPayout();
    error ConfigurationMismatch();
    error AddressMismatch();

    function _salt(address payout) private pure returns (bytes32) {
        return keccak256(abi.encode(_VERSION, payout));
    }

    function _proxy(address payout) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), _salt(payout),
            keccak256(type(FactoryCreationProxy).creationCode)
        )))));
    }

    function predictFactory(address payout) public view returns (address) {
        // RLP([proxy, 1]): a contract's first CREATE uses nonce 1.
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"d694", _proxy(payout), hex"01"
        )))));
    }

    /// @notice Payout must submit this transaction itself (including smart wallets).
    /// An existing factory is reused only for the exact, ordered token list.
    /// Failed creation rolls back both proxy creation and its consumed flag.
    function deploy(address payout, address[] calldata tokens) external returns (address factory) {
        if (msg.sender != payout) revert OnlyPayout();
        factory = predictFactory(payout);
        if (factory.code.length != 0) {
            ForwarderFactory existing = ForwarderFactory(factory);
            if (existing.payout() != payout) revert ConfigurationMismatch();
            address[] memory configured = existing.getSettlementTokens();
            if (keccak256(abi.encode(configured)) != keccak256(abi.encode(tokens))) {
                revert ConfigurationMismatch();
            }
            return factory;
        }
        FactoryCreationProxy proxy = new FactoryCreationProxy{salt: _salt(payout)}();
        address created = proxy.deploy(abi.encodePacked(
            type(ForwarderFactory).creationCode, abi.encode(payout, tokens)
        ));
        if (created != factory) revert AddressMismatch();
        emit FactoryDeployed(payout, factory);
    }
}
