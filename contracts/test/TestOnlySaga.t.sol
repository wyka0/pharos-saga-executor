// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestOnlyUSDC, TestOnlyReceiptToken} from "../test-only/TestOnlyTokens.sol";
import {TestOnlySwap} from "../test-only/TestOnlySwap.sol";
import {TestOnlyVault} from "../test-only/TestOnlyVault.sol";

/**
 * TEST-ONLY local integration tests. These run against the EVM in Forge and
 * are also mirrored by the Anvil end-to-end demo. They are NOT Atlantic tests.
 */
contract TestOnlySagaTest is Test {
    TestOnlyUSDC internal usdc;
    TestOnlyReceiptToken internal receipt;
    TestOnlySwap internal swap;
    TestOnlyVault internal vault;

    address internal user = address(0xBEEF);
    uint256 internal constant ONE_USDC = 1_000_000; // 6 decimals

    function setUp() public {
        usdc = new TestOnlyUSDC(address(this));
        receipt = new TestOnlyReceiptToken(address(this));
        swap = new TestOnlySwap(usdc, receipt, 100, address(this)); // 1% test fee
        receipt.setMinter(address(swap), true); // controller wires the only minter (mirrors the deployment script)
        vault = new TestOnlyVault(receipt, address(this));
        usdc.mint(user, 100 * ONE_USDC);
    }

    function _approveSwap(uint256 amount) internal {
        vm.prank(user);
        usdc.approve(address(swap), amount);
    }

    function _swap(uint256 amount) internal returns (uint256 out) {
        vm.prank(user);
        out = swap.swapExactUsdcForReceipt(amount, 0);
    }

    function _deposit(uint256 assets) internal returns (uint256 shares) {
        vm.prank(user);
        receipt.approve(address(vault), assets);
        vm.prank(user);
        shares = vault.deposit(assets, 0);
    }

    function testHappyPathApproveSwapDeposit() public {
        _approveSwap(ONE_USDC);
        assertEq(usdc.allowance(user, address(swap)), ONE_USDC, "exact approval only");

        uint256 out = _swap(ONE_USDC);
        assertEq(out, 990_000, "1% test fee");
        assertEq(receipt.balanceOf(user), 990_000, "receipt balance");
        assertEq(usdc.balanceOf(user), 99 * ONE_USDC, "usdc spent");
        assertEq(usdc.allowance(user, address(swap)), 0, "allowance consumed");

        uint256 shares = _deposit(out);
        assertEq(shares, 990_000, "1:1 shares");
        assertEq(vault.sharesOf(user), 990_000, "vault shares");
        assertEq(receipt.balanceOf(address(vault)), 990_000, "vault assets");
        assertEq(receipt.balanceOf(user), 0, "receipt moved to vault");
    }

    function testSwapWithoutApprovalReverts() public {
        vm.prank(user);
        vm.expectRevert("ERC20: insufficient allowance");
        swap.swapExactUsdcForReceipt(ONE_USDC, 0);
    }

    function testSwapSlippageReverts() public {
        _approveSwap(ONE_USDC);
        vm.prank(user);
        vm.expectRevert("swap: slippage");
        swap.swapExactUsdcForReceipt(ONE_USDC, 990_001);
        assertEq(usdc.balanceOf(user), 100 * ONE_USDC, "no balance change");
    }

    function testForcedSwapFailureLeavesStateUnchanged() public {
        _approveSwap(ONE_USDC);
        swap.setFailNextSwap(true);

        vm.prank(user);
        vm.expectRevert("TEST_ONLY_SWAP_FORCED_FAILURE");
        swap.swapExactUsdcForReceipt(ONE_USDC, 0);

        assertEq(usdc.balanceOf(user), 100 * ONE_USDC, "usdc unchanged");
        assertEq(receipt.balanceOf(user), 0, "no receipt minted");
        assertTrue(swap.failNextSwap(), "flag remains set because the tx reverted");
        swap.setFailNextSwap(false);

        uint256 out = _swap(ONE_USDC);
        assertEq(out, 990_000, "retry succeeds after clearing the deterministic fault");
    }

    function testForcedVaultFailureLeavesReceiptsInWallet() public {
        _approveSwap(ONE_USDC);
        uint256 out = _swap(ONE_USDC);
        vm.prank(user);
        receipt.approve(address(vault), out);

        vault.setFailNextDeposit(true);
        vm.startPrank(user);
        vm.expectRevert("TEST_ONLY_VAULT_FORCED_FAILURE");
        vault.deposit(out, 0);
        vm.stopPrank();

        assertEq(receipt.balanceOf(user), out, "receipt still in wallet");
        assertEq(vault.sharesOf(user), 0, "no shares");
        assertTrue(vault.failNextDeposit(), "flag remains set because the tx reverted");
        vault.setFailNextDeposit(false);

        vm.prank(user);
        uint256 shares = vault.deposit(out, 0);
        assertEq(shares, out, "retry succeeds after clearing the deterministic fault");
    }

    function testUnwindCompensationReturnsUsdc() public {
        _approveSwap(ONE_USDC);
        uint256 out = _swap(ONE_USDC);
        uint256 before = usdc.balanceOf(user);

        vm.prank(user);
        uint256 usdcOut = swap.unwind(out, 0);

        assertEq(usdcOut, 980_100, "99% unwind rate");
        assertEq(usdc.balanceOf(user), before + usdcOut, "usdc returned");
        assertEq(receipt.balanceOf(user), 0, "receipt burned");
    }

    function testVaultWithdrawReturnsReceipts() public {
        _approveSwap(ONE_USDC);
        uint256 out = _swap(ONE_USDC);
        uint256 shares = _deposit(out);

        vm.prank(user);
        uint256 assets = vault.withdraw(shares, 0);

        assertEq(assets, out, "assets returned");
        assertEq(vault.sharesOf(user), 0, "shares burned");
        assertEq(receipt.balanceOf(user), out, "receipt returned");
    }
}
