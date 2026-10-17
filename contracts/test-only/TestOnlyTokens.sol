// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestOnlyERC20} from "./TestOnlyERC20.sol";

/**
 * TEST-ONLY mock USDC (6 decimals, symbol tUSDC) for the disposable test
 * ecosystem (local Anvil and the clearly-labelled Atlantic testnet deployment).
 * This is NOT the official Pharos USDC contract and must never be presented as
 * one.
 *
 * Authorization: `controller` is immutable and fixed at deployment. Only the
 * controller can mint or burn; arbitrary callers cannot create supply or burn
 * balances.
 */
contract TestOnlyUSDC is TestOnlyERC20 {
    address public immutable controller;

    constructor(address controller_) TestOnlyERC20("Test Only USD Coin", "tUSDC", 6) {
        require(controller_ != address(0), "usdc: zero controller");
        controller = controller_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == controller, "usdc: not controller");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == controller, "usdc: not controller");
        _burn(from, amount);
    }
}

/**
 * TEST-ONLY receipt token (6 decimals, symbol tSAGA) minted by TestOnlySwap.
 * Not an official asset.
 *
 * Authorization: `controller` is immutable. Only the controller may change the
 * minter set, so arbitrary callers can never grant themselves mint/burn rights.
 * The gated deployment script wires TestOnlySwap as the only minter after both
 * contracts exist; before that wiring every swap operation reverts safely.
 */
contract TestOnlyReceiptToken is TestOnlyERC20 {
    address public immutable controller;
    mapping(address => bool) public minters;

    constructor(address controller_) TestOnlyERC20("Test Only Saga Receipt", "tSAGA", 6) {
        require(controller_ != address(0), "receipt: zero controller");
        controller = controller_;
    }

    function setMinter(address minter, bool allowed) external {
        require(msg.sender == controller, "receipt: not controller");
        minters[minter] = allowed;
    }

    function mint(address to, uint256 amount) external {
        require(minters[msg.sender], "receipt: not minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(minters[msg.sender], "receipt: not minter");
        _burn(from, amount);
    }
}
