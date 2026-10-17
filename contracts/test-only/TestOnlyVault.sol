// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestOnlyReceiptToken} from "./TestOnlyTokens.sol";

/**
 * TEST-ONLY deposit vault for the TestOnly* mock ecosystem.
 * 1 receipt token = 1 share, no yield and no strategy.
 * It is NOT an official Pharos vault, holds no admin drain, and only ever
 * moves tokens for the caller (transferFrom/transfer to msg.sender).
 * Fault-injection hooks are restricted to the immutable test controller.
 */
contract TestOnlyVault {
    TestOnlyReceiptToken public immutable asset;
    address public immutable controller;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    bool public failNextDeposit;
    bool public failNextWithdraw;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 shares, uint256 assets);

    constructor(TestOnlyReceiptToken asset_, address controller_) {
        require(controller_ != address(0), "vault: zero controller");
        asset = asset_;
        controller = controller_;
    }

    /// @notice Test-only fault injection, restricted to the immutable test controller.
    function setFailNextDeposit(bool value) external {
        require(msg.sender == controller, "vault: not controller");
        failNextDeposit = value;
    }

    function setFailNextWithdraw(bool value) external {
        require(msg.sender == controller, "vault: not controller");
        failNextWithdraw = value;
    }

    function deposit(uint256 assets, uint256 minShares) external returns (uint256) {
        if (failNextDeposit) {
            failNextDeposit = false;
            revert("TEST_ONLY_VAULT_FORCED_FAILURE");
        }
        require(assets > 0, "vault: zero assets");
        uint256 shares = assets;
        require(shares >= minShares, "vault: slippage");
        require(asset.transferFrom(msg.sender, address(this), assets), "vault: transferFrom failed");
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, assets, shares);
        return shares;
    }

    function withdraw(uint256 shares, uint256 minAssets) external returns (uint256) {
        if (failNextWithdraw) {
            failNextWithdraw = false;
            revert("TEST_ONLY_WITHDRAW_FORCED_FAILURE");
        }
        require(shares > 0, "vault: zero shares");
        require(sharesOf[msg.sender] >= shares, "vault: insufficient shares");
        uint256 assets = shares;
        require(assets >= minAssets, "vault: slippage");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        require(asset.transfer(msg.sender, assets), "vault: transfer failed");
        emit Withdrawn(msg.sender, shares, assets);
        return assets;
    }
}
