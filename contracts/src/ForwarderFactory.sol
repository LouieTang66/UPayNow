// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ForwarderImpl} from "./ForwarderImpl.sol";

/// @title upaynow self-hosted merchant factory
/// @notice One deployment permanently binds a payout and a supported-token list.
/// One order has one address regardless of the token selected for collection.
/// Funds flow from clones directly to payout, never through this factory.
/// No owner, fees, holds, pause, token-list setter, upgrade or recovery exists.
/// @dev Pricing, payment currency selection and mixed-payment policy are off-chain.
contract ForwarderFactory is ReentrancyGuardTransient {
    uint8 public constant SALT_VERSION = 3;

    address public immutable payout;
    address public immutable implementation;
    bytes32 public immutable forwarderCodehash;
    // Populated only during construction; no runtime mutation or upgrade path.
    mapping(address => bool) public isSupportedToken;
    address[] private _settlementTokens;
    mapping(address => bool) public isForwarder;

    struct CollectRequest {
        bytes32 orderIdHash;
        address token;
    }

    event ForwarderDeployed(bytes32 indexed orderIdHash, address indexed forwarder);
    /// @dev Requested amount for this token, not net receipts or payment status.
    event Collected(
        bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amount
    );
    /// @dev Bounded error prefix, not full error data or gas-exhaustion isolation.
    event CollectFailed(
        bytes32 indexed orderIdHash, address indexed forwarder, address indexed token,
        bytes4 reasonSelector, uint256 returnDataSize
    );
    /// @dev Never a normal invoice-payment verdict. Zero token means native coin.
    event WrongTokenCollected(
        bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amountSent
    );

    error InvalidPayout();
    error InvalidSettlementToken();
    error EmptySettlementTokens();
    error DuplicateSettlementToken(address token);
    error UnsupportedSettlementToken(address token);
    error UnknownForwarder();
    error AddressMismatch();
    error OnlySelf();
    error EmptyBatch();
    error SettlementTokenProtected();
    error InvalidToken();

    /// @dev Execute and clear the same transient guard as collection at deployment.
    constructor(address payout_, address[] memory settlementTokens_) nonReentrant {
        if (payout_ == address(0) || payout_ == address(this)) revert InvalidPayout();
        uint256 n = settlementTokens_.length;
        if (n == 0) revert EmptySettlementTokens();
        for (uint256 i; i < n; ++i) {
            address token = settlementTokens_[i];
            if (token == payout_) revert InvalidPayout();
            if (token.code.length == 0) revert InvalidSettlementToken();
            if (isSupportedToken[token]) revert DuplicateSettlementToken(token);
            isSupportedToken[token] = true;
            _settlementTokens.push(token);
        }
        payout = payout_;
        address impl = address(new ForwarderImpl(payout_));
        if (payout_ == impl) revert InvalidPayout();
        implementation = impl;
        forwarderCodehash = keccak256(
            abi.encodePacked(bytes10(0x363d3d373d3d3d363d73), impl, bytes15(0x5af43d82803e903d91602b57fd5bf3))
        );
    }

    function getSettlementTokens() external view returns (address[] memory) {
        return _settlementTokens;
    }

    function computeSalt(bytes32 orderIdHash) public view returns (bytes32) {
        // No selected token: one address per order for this factory's fixed list.
        return keccak256(abi.encode(SALT_VERSION, orderIdHash, payout));
    }

    function predictAddress(bytes32 orderIdHash) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, computeSalt(orderIdHash));
    }

    /// @notice Permissionless, idempotent deployment with no initialization race.
    function deploy(bytes32 orderIdHash) public returns (address forwarder) {
        forwarder = predictAddress(orderIdHash);
        if (forwarder == payout) revert InvalidPayout();
        if (forwarder.code.length == 0) {
            address created = Clones.cloneDeterministic(implementation, computeSalt(orderIdHash));
            if (created != forwarder) revert AddressMismatch();
            isForwarder[forwarder] = true;
            emit ForwarderDeployed(orderIdHash, forwarder);
        } else if (!isForwarder[forwarder] || forwarder.codehash != forwarderCodehash) {
            revert UnknownForwarder();
        }
    }

    /// @notice Sweep only the selected supported token, always to fixed payout.
    function collect(bytes32 orderIdHash, address token) external nonReentrant returns (uint256 amount) {
        amount = _collect(orderIdHash, token);
    }

    /// @notice Best-effort batch of (order, token) pairs, including repeated orders.
    /// Empty sweeps count as successful attempts, not paid orders. No fixed count
    /// or per-item gas cap. Ordinary failures are isolated if outer gas permits;
    /// gas exhaustion can still prevent later items or revert the whole batch.
    function collectBatch(CollectRequest[] calldata requests)
        external nonReentrant returns (uint256 succeeded, uint256 failed)
    {
        uint256 n = requests.length;
        if (n == 0) revert EmptyBatch();
        for (uint256 i; i < n; ++i) {
            CollectRequest calldata request = requests[i];
            bytes memory payload = abi.encodeCall(this.collectBatchItem, (request.orderIdHash, request.token));
            bool ok;
            uint256 size;
            bytes4 selector;
            assembly ("memory-safe") {
                ok := call(gas(), address(), 0, add(payload, 32), mload(payload), 0, 0)
                size := returndatasize()
                if and(iszero(ok), iszero(lt(size, 4))) {
                    returndatacopy(0, 0, 4)
                    selector := mload(0)
                }
            }
            if (ok) {
                ++succeeded;
            } else {
                ++failed;
                emit CollectFailed(request.orderIdHash, predictAddress(request.orderIdHash), request.token, selector, size);
            }
        }
    }

    /// @dev Per-pair rollback boundary, callable only by the guarded batch itself.
    function collectBatchItem(bytes32 orderIdHash, address token) external returns (uint256 amount) {
        if (msg.sender != address(this)) revert OnlySelf();
        amount = _collect(orderIdHash, token);
    }

    /// @notice Manual unsupported-token/native sweep, always to fixed payout.
    /// Every supported token is protected and must use the normal collection path.
    function collectWrongToken(bytes32 orderIdHash, address token) external nonReentrant returns (uint256 amountSent) {
        if (isSupportedToken[token]) revert SettlementTokenProtected();
        if (token != address(0) && token.code.length == 0) revert InvalidToken();
        address forwarder = deploy(orderIdHash);
        amountSent = ForwarderImpl(payable(forwarder)).sweepWrongToken(token);
        if (amountSent != 0) emit WrongTokenCollected(orderIdHash, forwarder, token, amountSent);
    }

    function _collect(bytes32 orderIdHash, address token) private returns (uint256 amount) {
        if (!isSupportedToken[token]) revert UnsupportedSettlementToken(token);
        address forwarder = deploy(orderIdHash);
        amount = ForwarderImpl(payable(forwarder)).sweepSettlementToken(token);
        if (amount != 0) emit Collected(orderIdHash, forwarder, token, amount);
    }
}
