// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Shared per-order logic, with no token-dependent address or initialization.
/// @dev Only immutable hub can invoke sweeps. That fixed factory checks its
/// constructor-only token registry before choosing normal or manual collection.
/// No caller-chosen recipient, owner, arbitrary call or upgrade exists here.
contract ForwarderImpl {
    using SafeERC20 for IERC20;

    address public immutable hub;
    address public immutable payout;

    error OnlyHub();
    error InvalidToken();
    error NativeSendFailed();

    constructor(address payout_) {
        hub = msg.sender;
        payout = payout_;
    }

    modifier onlyHub() {
        if (msg.sender != hub) revert OnlyHub();
        _;
    }

    /// @notice Factory-authorized supported token, forwarded directly to payout.
    /// @dev One pre-transfer balance query; no net-receipt or post-balance checks.
    function sweepSettlementToken(address token) external onlyHub returns (uint256 amount) {
        amount = _sweepToken(token);
    }

    /// @notice Factory-authorized unsupported asset. Zero token means native coin.
    function sweepWrongToken(address token) external onlyHub returns (uint256 amount) {
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount != 0) {
                (bool ok,) = payout.call{value: amount}("");
                if (!ok) revert NativeSendFailed();
            }
        } else {
            amount = _sweepToken(token);
        }
    }

    function _sweepToken(address token) private returns (uint256 amount) {
        if (token.code.length == 0) revert InvalidToken();
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) IERC20(token).safeTransfer(payout, amount);
    }

    /// @dev Deployed clones need delegatecall gas; a 21,000-gas native transfer
    /// is not guaranteed to succeed. Normal invoice payment is by supported token.
    receive() external payable {}
}
