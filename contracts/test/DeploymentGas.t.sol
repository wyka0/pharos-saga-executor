// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestOnlyUSDC, TestOnlyReceiptToken} from "../test-only/TestOnlyTokens.sol";
import {TestOnlySwap} from "../test-only/TestOnlySwap.sol";
import {TestOnlyVault} from "../test-only/TestOnlyVault.sol";

/**
 * TEST-ONLY gas measurement for the Atlantic deployment plan.
 * This test never deploys outside the local EVM.
 */
contract DeploymentGasTest is Test {
    function testDeploymentGas() public {
        vm.startSnapshotGas("TestOnlyUSDC");
        TestOnlyUSDC usdc = new TestOnlyUSDC(address(this));
        uint256 gasUsdc = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlyReceiptToken");
        TestOnlyReceiptToken receipt = new TestOnlyReceiptToken(address(this));
        uint256 gasReceipt = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlySwap");
        TestOnlySwap swap = new TestOnlySwap(usdc, receipt, 100, address(this));
        uint256 gasSwap = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlyVault");
        new TestOnlyVault(receipt, address(this));
        uint256 gasVault = vm.stopSnapshotGas();

        vm.startSnapshotGas("WireMinter");
        receipt.setMinter(address(swap), true);
        uint256 gasWire = vm.stopSnapshotGas();

        assertGt(gasUsdc, 0);
        assertGt(gasReceipt, 0);
        assertGt(gasSwap, 0);
        assertGt(gasVault, 0);
        assertGt(gasWire, 0);

        emit log_named_uint("TestOnlyUSDC deploy gas", gasUsdc);
        emit log_named_uint("TestOnlyReceiptToken deploy gas", gasReceipt);
        emit log_named_uint("TestOnlySwap deploy gas", gasSwap);
        emit log_named_uint("TestOnlyVault deploy gas", gasVault);
        emit log_named_uint("WireMinter gas", gasWire);
        emit log_named_uint(
            "Total deployment gas",
            gasUsdc + gasReceipt + gasSwap + gasVault + gasWire
        );
    }
}
