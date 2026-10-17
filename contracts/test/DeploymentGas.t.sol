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
        TestOnlyUSDC usdc = new TestOnlyUSDC();
        uint256 gasUsdc = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlyReceiptToken");
        TestOnlyReceiptToken receipt = new TestOnlyReceiptToken();
        uint256 gasReceipt = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlySwap");
        new TestOnlySwap(usdc, receipt, 100);
        uint256 gasSwap = vm.stopSnapshotGas();

        vm.startSnapshotGas("TestOnlyVault");
        new TestOnlyVault(receipt);
        uint256 gasVault = vm.stopSnapshotGas();

        assertGt(gasUsdc, 0);
        assertGt(gasReceipt, 0);
        assertGt(gasSwap, 0);
        assertGt(gasVault, 0);

        emit log_named_uint("TestOnlyUSDC deploy gas", gasUsdc);
        emit log_named_uint("TestOnlyReceiptToken deploy gas", gasReceipt);
        emit log_named_uint("TestOnlySwap deploy gas", gasSwap);
        emit log_named_uint("TestOnlyVault deploy gas", gasVault);
        emit log_named_uint("Total deploy gas", gasUsdc + gasReceipt + gasSwap + gasVault);
    }
}
