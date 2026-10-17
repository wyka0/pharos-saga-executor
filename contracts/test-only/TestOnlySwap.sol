// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestOnlyUSDC, TestOnlyReceiptToken} from "./TestOnlyTokens.sol";

/**
 * TEST-ONLY fixed-rate swap for the TestOnly* mock ecosystem.
 *
 * - pulls tUSDC with transferFrom(msg.sender, ...) ONLY (never another wallet)
 * - mints tSAGA at a fixed rate (default 99%)
 * - unwind: burns the caller's tSAGA and returns tUSDC from this contract's own
 *   balance at the same rate
 *
 * It is NOT an official Pharos protocol, has no oracle, no admin drain and no
 * arbitrary external calls. Fault-injection hooks are restricted to the
 * immutable test controller. The tSAGA minter role is NOT wired here: the
 * gated deployment script calls TestOnlyReceiptToken.setMinter(swap, true)
 * after both contracts exist, so this constructor performs no cross-contract
 * calls at all.
 */
contract TestOnlySwap {
    TestOnlyUSDC public immutable usdc;
    TestOnlyReceiptToken public immutable receipt;
    uint256 public immutable feeBps;
    address public immutable controller;

    bool public failNextSwap;
    bool public failNextUnwind;

    event Swapped(address indexed user, uint256 usdcIn, uint256 receiptOut);
    event Unwound(address indexed user, uint256 receiptIn, uint256 usdcOut);

    constructor(
        TestOnlyUSDC usdc_,
        TestOnlyReceiptToken receipt_,
        uint256 feeBps_,
        address controller_
    ) {
        require(feeBps_ <= 1_000, "fee too high");
        require(controller_ != address(0), "swap: zero controller");
        usdc = usdc_;
        receipt = receipt_;
        feeBps = feeBps_;
        controller = controller_;
    }

    /// @notice Test-only fault injection, restricted to the immutable test controller.
    function setFailNextSwap(bool value) external {
        require(msg.sender == controller, "swap: not controller");
        failNextSwap = value;
    }

    function setFailNextUnwind(bool value) external {
        require(msg.sender == controller, "swap: not controller");
        failNextUnwind = value;
    }

    function quote(uint256 usdcIn) public view returns (uint256) {
        return (usdcIn * (10_000 - feeBps)) / 10_000;
    }

    function swapExactUsdcForReceipt(uint256 usdcIn, uint256 minReceiptOut) external returns (uint256) {
        if (failNextSwap) {
            failNextSwap = false;
            revert("TEST_ONLY_SWAP_FORCED_FAILURE");
        }
        require(usdcIn > 0, "swap: zero input");
        uint256 out = quote(usdcIn);
        require(out >= minReceiptOut, "swap: slippage");
        require(usdc.transferFrom(msg.sender, address(this), usdcIn), "swap: transferFrom failed");
        receipt.mint(msg.sender, out);
        emit Swapped(msg.sender, usdcIn, out);
        return out;
    }

    function unwind(uint256 receiptIn, uint256 minUsdcOut) external returns (uint256) {
        if (failNextUnwind) {
            failNextUnwind = false;
            revert("TEST_ONLY_UNWIND_FORCED_FAILURE");
        }
        require(receiptIn > 0, "unwind: zero input");
        uint256 out = quote(receiptIn);
        require(out >= minUsdcOut, "unwind: slippage");
        receipt.burn(msg.sender, receiptIn);
        require(usdc.transfer(msg.sender, out), "unwind: transfer failed");
        emit Unwound(msg.sender, receiptIn, out);
        return out;
    }
}
