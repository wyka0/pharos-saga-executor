// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestOnlyUSDC, TestOnlyReceiptToken} from "../test-only/TestOnlyTokens.sol";
import {TestOnlySwap} from "../test-only/TestOnlySwap.sol";
import {TestOnlyVault} from "../test-only/TestOnlyVault.sol";

/**
 * TEST-ONLY authorization tests.
 *
 * They prove that arbitrary callers cannot mint supply, change the minter set,
 * toggle fault hooks, burn somebody else's tokens, or sabotage the unwind
 * compensation, and that every restricted control belongs to the immutable
 * test controller wired at deployment.
 */
contract TestOnlyAuthTest is Test {
    TestOnlyUSDC internal usdc;
    TestOnlyReceiptToken internal receipt;
    TestOnlySwap internal swap;
    TestOnlyVault internal vault;

    uint256 internal constant ONE_USDC = 1_000_000; // 6 decimals
    address internal user = address(0xBEEF);
    address internal attacker = address(0xBAD);

    function setUp() public {
        usdc = new TestOnlyUSDC(address(this));
        receipt = new TestOnlyReceiptToken(address(this));
        swap = new TestOnlySwap(usdc, receipt, 100, address(this));
        receipt.setMinter(address(swap), true);
        vault = new TestOnlyVault(receipt, address(this));
        usdc.mint(user, 100 * ONE_USDC);
    }

    function testControllersAndWiringAreCorrect() public view {
        assertEq(usdc.controller(), address(this), "usdc controller");
        assertEq(receipt.controller(), address(this), "receipt controller");
        assertEq(swap.controller(), address(this), "swap controller");
        assertEq(vault.controller(), address(this), "vault controller");
        assertEq(address(swap.usdc()), address(usdc), "swap.usdc wiring");
        assertEq(address(swap.receipt()), address(receipt), "swap.receipt wiring");
        assertEq(swap.feeBps(), 100, "swap fee bps");
        assertEq(address(vault.asset()), address(receipt), "vault.asset wiring");
        assertTrue(receipt.minters(address(swap)), "swap is the only wired minter");
        assertFalse(receipt.minters(address(this)), "controller is not itself a minter");
        assertFalse(receipt.minters(attacker), "attacker is not a minter");
    }

    function testZeroControllerRejected() public {
        vm.expectRevert("usdc: zero controller");
        new TestOnlyUSDC(address(0));
        vm.expectRevert("receipt: zero controller");
        new TestOnlyReceiptToken(address(0));
        vm.expectRevert("swap: zero controller");
        new TestOnlySwap(usdc, receipt, 100, address(0));
        vm.expectRevert("vault: zero controller");
        new TestOnlyVault(receipt, address(0));
    }

    function testAttackerCannotMintOrBurnMockUsdc() public {
        vm.startPrank(attacker);
        vm.expectRevert("usdc: not controller");
        usdc.mint(attacker, ONE_USDC);
        vm.expectRevert("usdc: not controller");
        usdc.burn(user, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(attacker), 0, "no supply for the attacker");
    }

    function testAttackerCannotGrantThemselvesMinterOrRemoveSwapMinter() public {
        vm.startPrank(attacker);
        vm.expectRevert("receipt: not controller");
        receipt.setMinter(attacker, true);
        vm.expectRevert("receipt: not controller");
        receipt.setMinter(address(swap), false);
        vm.stopPrank();
        assertTrue(receipt.minters(address(swap)), "swap stays the minter");
        assertFalse(receipt.minters(attacker), "attacker gained nothing");
    }

    function testAttackerCannotMintOrBurnReceiptTokens() public {
        vm.startPrank(attacker);
        vm.expectRevert("receipt: not minter");
        receipt.mint(attacker, ONE_USDC);
        vm.stopPrank();

        vm.prank(user);
        usdc.approve(address(swap), ONE_USDC);
        vm.prank(user);
        swap.swapExactUsdcForReceipt(ONE_USDC, 0);

        vm.startPrank(attacker);
        vm.expectRevert("receipt: not minter");
        receipt.burn(user, 1);
        vm.stopPrank();
        assertEq(receipt.balanceOf(user), 990_000, "holder balance untouched");
    }

    function testAttackerCannotToggleFaultHooks() public {
        vm.startPrank(attacker);
        vm.expectRevert("swap: not controller");
        swap.setFailNextSwap(true);
        vm.expectRevert("swap: not controller");
        swap.setFailNextUnwind(true);
        vm.expectRevert("vault: not controller");
        vault.setFailNextDeposit(true);
        vm.expectRevert("vault: not controller");
        vault.setFailNextWithdraw(true);
        vm.stopPrank();
        assertFalse(swap.failNextSwap(), "no fault was injected");
        assertFalse(swap.failNextUnwind(), "no fault was injected");
        assertFalse(vault.failNextDeposit(), "no fault was injected");
        assertFalse(vault.failNextWithdraw(), "no fault was injected");
    }

    function testCompensationCannotBeSabotagedByAttacker() public {
        // happy-path prefix: approve, swap, vault approval
        vm.prank(user);
        usdc.approve(address(swap), ONE_USDC);
        vm.prank(user);
        uint256 out = swap.swapExactUsdcForReceipt(ONE_USDC, 0);
        vm.prank(user);
        receipt.approve(address(vault), out);

        // attacker tries everything in their power against the mock ecosystem
        vm.startPrank(attacker);
        vm.expectRevert("receipt: not controller");
        receipt.setMinter(attacker, true); // cannot mint tSAGA for a drain
        vm.expectRevert("receipt: not controller");
        receipt.setMinter(address(swap), false); // cannot break unwind's burn
        vm.expectRevert("swap: not controller");
        swap.setFailNextUnwind(true); // cannot force unwind to revert
        vm.expectRevert("usdc: not controller");
        usdc.burn(address(swap), 1); // cannot strip the swap's inventory
        vm.stopPrank();

        // attacker calling unwind without receipt tokens moves nothing
        vm.prank(attacker);
        vm.expectRevert("ERC20: insufficient balance");
        swap.unwind(1_000, 0);

        // deposit fails (controller fault) and the compensation unwind still works
        vault.setFailNextDeposit(true);
        vm.prank(user);
        vm.expectRevert("TEST_ONLY_VAULT_FORCED_FAILURE");
        vault.deposit(out, 0);
        vault.setFailNextDeposit(false);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        uint256 back = swap.unwind(out, 0);
        assertEq(back, 980_100, "compensation unwind rate");
        assertEq(usdc.balanceOf(user), before + back, "compensation returned the mock USDC");
    }

    function testSwapCannotMintBeforeControllerWiresTheMinter() public {
        TestOnlyReceiptToken fresh = new TestOnlyReceiptToken(address(this));
        TestOnlySwap freshSwap = new TestOnlySwap(usdc, fresh, 100, address(this));

        vm.prank(user);
        usdc.approve(address(freshSwap), ONE_USDC);
        vm.prank(user);
        vm.expectRevert("receipt: not minter");
        freshSwap.swapExactUsdcForReceipt(ONE_USDC, 0);

        fresh.setMinter(address(freshSwap), true);
        vm.prank(user);
        uint256 out = freshSwap.swapExactUsdcForReceipt(ONE_USDC, 0);
        assertEq(out, 990_000, "swap works once the controller wires the minter");
        assertEq(fresh.balanceOf(user), 990_000, "receipt minted after wiring");
    }
}
