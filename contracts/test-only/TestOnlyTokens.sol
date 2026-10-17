// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestOnlyERC20} from "./TestOnlyERC20.sol";

/**
 * TEST-ONLY mock USDC for Anvil. 6 decimals, freely mintable.
 * This is NOT the official Pharos USDC contract.
 */
contract TestOnlyUSDC is TestOnlyERC20 {
    constructor() TestOnlyERC20("Test Only USD Coin", "tUSDC", 6) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/**
 * TEST-ONLY receipt token minted by TestOnlySwap. Not an official asset.
 */
contract TestOnlyReceiptToken is TestOnlyERC20 {
    mapping(address => bool) public minters;

    constructor() TestOnlyERC20("Test Only Saga Receipt", "tSAGA", 6) {}

    function setMinter(address minter, bool allowed) external {
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
