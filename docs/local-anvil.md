# Local Anvil Test-Only Validation

**Classification: TEST-ONLY, LOCAL, DISPOSABLE CHAIN (chainId 31337).**
This page documents the local Foundry/Anvil work added for Task 5. Nothing on
this page is Atlantic testnet or mainnet evidence; no real funds are involved.

## 1. Environment report

OpenCode runs on Windows (PowerShell 5.1). Foundry was already installed
**inside WSL Ubuntu**, not on the Windows side, which is why the Windows CMD
returned "forge not recognized". The environments do not share a PATH.

| Item | Result |
| --- | --- |
| Shell used for all Foundry work | WSL Ubuntu, via `wsl.exe -d Ubuntu -- ...` |
| Foundry location | `/home/wyka/.foundry/bin/` |
| `forge --version` | `forge 1.2.3-stable` (commit `a813a2cee7dd4926e7c56fd8a785b54f32e0d10f`, 2025-06-08) |
| `anvil --version` | `anvil 1.2.3-stable` (same commit) |
| `cast --version` | `cast 1.2.3-stable` (same commit) |
| `foundryup` | present at `/home/wyka/.foundry/bin/foundryup` |
| Windows Foundry | not installed; not required by this project |

No PATH or shell startup file was modified. Foundry is always invoked by its
absolute WSL path. Note: `/home/wyka/.bash_profile` line 3 references a missing
`/home/wyka/.wasmedge/env`; it is unrelated to Foundry and was left untouched.
The demo invokes WSL with an explicit binary path, so it does not depend on
that profile line.

### Command quoting warning

When calling WSL from this Windows environment, do **not** write
`export PATH=$PATH` or other unquoted `$PATH` expansions in a one-liner: the
Windows PATH contains `(x86)` and Bash then fails with
`syntax error near unexpected token '('`. Use absolute paths instead:

```powershell
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge build'
```

## 2. Test-only contracts

All contracts are clearly labelled and live under `contracts/test-only/`.
They are not official Pharos contracts and must never be presented as such.

| Contract | Purpose | Notes |
| --- | --- | --- |
| `TestOnlyERC20.sol` | minimal ERC-20 base | no external dependencies |
| `TestOnlyTokens.sol` (`TestOnlyUSDC`, `TestOnlyReceiptToken`) | 6-decimal test USDC and 6-decimal receipt token | separate from the official Atlantic USDC address |
| `TestOnlySwap.sol` | fixed-rate swap with 1% fee, `unwind()` reverse path, fault hooks | `setFailNextSwap`, `setFailNextUnwind` |
| `TestOnlyVault.sol` | 1:1 share vault with deposit/withdraw, fault hooks | `setFailNextDeposit`, `setFailNextWithdraw` |

The official Pharos USDC address is only configured for the Atlantic adapter
(`src/testnet/config.ts`). The local adapter has its own config type
(`LocalAnvilConfig`) and refuses any chain other than 31337 and any RPC host
other than `127.0.0.1`/`localhost`.

## 3. Exact commands

Build and run the Foundry unit tests (WSL, absolute paths):

```powershell
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge build'
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge test -vv'
```

Run the end-to-end local session (starts Anvil itself, deploys the contracts,
runs four scenarios through the real `SagaExecutor`, then stops Anvil):

```powershell
npm run demo:local
```

Optional overrides: `LOCAL_ANVIL_RPC` (use an already-running node, no
spawn/kill), `LOCAL_ANVIL_PORT` (default 8546), `ANVIL_BIN`, `WSL_DISTRO`.

## 4. Observed results

Foundry unit tests (`forge test -vv`):

```text
Ran 1 test for contracts/test/DeploymentGas.t.sol:DeploymentGasTest
[PASS] testDeploymentGas()
  TestOnlyUSDC deploy gas: 497738
  TestOnlyReceiptToken deploy gas: 568661
  TestOnlySwap deploy gas: 484536
  TestOnlyVault deploy gas: 421507
  Total deploy gas: 1972442
Suite result: ok. 1 passed; 0 failed; 0 skipped

Ran 7 tests for contracts/test/TestOnlySaga.t.sol:TestOnlySagaTest
[PASS] testForcedSwapFailureLeavesStateUnchanged()
[PASS] testForcedVaultFailureLeavesReceiptsInWallet()
[PASS] testHappyPathApproveSwapDeposit()
[PASS] testSwapSlippageReverts()
[PASS] testSwapWithoutApprovalReverts()
[PASS] testUnwindCompensationReturnsUsdc()
[PASS] testVaultWithdrawReturnsReceipts()
Suite result: ok. 7 passed; 0 failed; 0 skipped

Ran 2 test suites: 8 tests passed, 0 failed, 0 skipped
```

End-to-end local session (`npm run demo:local`):

| Scenario | Result | Verified invariants |
| --- | --- | --- |
| 1. APPROVE -> SWAP -> DEPOSIT success | PASS | 3 local txs, USDC spent exactly 1, receipt tokens 0, vault shares 0.99, swap allowance consumed |
| 2. forced SWAP revert | PASS | no retry (`attempts = 1`), saga FAILED, `REVOKE_APPROVAL` compensation succeeded, allowance 0 |
| 3. forced DEPOSIT revert | PASS | saga FAILED, `SIMULATED_UNWIND_SWAP` compensation succeeded, receipt tokens burned, net cost 19,900 raw (1% twice) |
| 4. unknown SWAP outcome | PASS | reconciled by idempotency key, `sendCount = 3` (no resubmission), journal `CONFIRMED` |

Representative deployment addresses from a clean Anvil run (disposable,
recreated on every run; do not reuse):

```text
usdc    0x5FbDB2315678afecb367f032d93F642f64180aa3
receipt 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
swap    0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
vault   0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
```

## 5. Safety properties exercised

- **No secrets.** The demo uses Anvil's unlocked account 0 through
  `eth_sendTransaction`; no private key or mnemonic is read, stored or printed.
- **Bounded allowances.** Approvals are exact amounts. The only vault
  allowance is a documented 0.99 tSAGA test precondition (see below).
- **No blind resubmission.** Scenario 4 injects an unknown outcome after a
  real send; the executor reconciles the hash and never sends a second time.
- **Deterministic failure handling.** A reverting local transaction is
  classified permanent, not transient; compensation is a new transaction, not
  a blockchain rollback.
- **Chain isolation.** `LocalAnvilAdapter` refuses any `chainId != 31337`;
  `validateLocalAnvilConfig` accepts only `http://127.0.0.1` or
  `http://localhost` endpoints. The Atlantic adapter and the official USDC
  address are untouched and remain behind the plan-hash approval gate.

### Known modelling gap (documented, test-only)

The three-step saga has a single APPROVE for the swap spender. The test vault
additionally pulls tSAGA with `transferFrom`, so the demo grants an exact
0.99 tSAGA allowance to the mock vault as a harness precondition before each
depositing scenario. This is test scaffolding, not an unlimited approval and
not a claim that the three-step model covers vault allowances.

## 6. Files

| Path | Role |
| --- | --- |
| `foundry.toml` | local-only Foundry config; only RPC endpoint is `http://127.0.0.1:8545` |
| `contracts/test-only/*.sol` | clearly labelled mocks |
| `contracts/test/TestOnlySaga.t.sol` | 7 Foundry tests |
| `contracts/test/DeploymentGas.t.sol` | local deployment-gas measurement for the Atlantic plan |
| `scripts/local-anvil.ts` | 4-scenario end-to-end demo (npm run demo:local) |
| `src/adapters/localAnvil.ts` | local-only adapter, chain guard, journal, no resubmission |
| `src/persistence/localJournal.ts` | local journal with INTENT-before-send |
| `test/local-anvil.test.ts` | offline config/receipt/journal tests |

State written by the demo goes to `.demo-state/local-anvil/<scenario>/` and is
git-ignored. Foundry output goes to `out/` and `cache/` and is git-ignored.
