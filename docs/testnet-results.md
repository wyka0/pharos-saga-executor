# Testnet results — Atlantic adapter (read-only phase)

Date: **2026-10-17**
Network: **Pharos Atlantic Testnet, chainId 688689**
Wallet: **`0xE2B8651178ade144003537eA509E37877dba40bb`**
Project: `C:\pharos-saga-executor`

> ## Status: NOT APPROVED / NOT EXECUTED
>
> This project has not signed, broadcast or confirmed any transaction.
> The wallet was separately funded with **20 USDC** by an external testnet
> transfer whose receipt is verified below. That funding transaction was not sent
> by this project.
> The live APPROVE, SWAP and DEPOSIT steps are all **blocked** by the missing
> verified protocol prerequisite documented in
> [testnet-readiness.md](testnet-readiness.md).
> Everything below is either a real read-only network check, an external funding
> transaction, or an offline/mocked test.

## 1. Implementation summary

| Concern | Implementation |
| --- | --- |
| Adapter | `src/adapters/pharosTestnet.ts` — implements the existing `ChainAdapter` |
| Chain client | `src/testnet/viemTestnetClient.ts` — viem public/wallet clients, chain fixed to 688689 |
| Planning/readiness | `src/testnet/planner.ts` — read-only, capability-gated planning and readiness |
| Journal | `src/persistence/testnetJournal.ts` — INTENT → BROADCAST → CONFIRMED/REVERTED/UNKNOWN |
| Receipts | `OnChainReceipt` is a separate type from `SimulatedReceipt`; `src/domain/receipts.ts` verifies both distinctly |
| CLI | `testnet:readiness`, `testnet:plan`, gated `testnet:run` in `src/cli.ts` |
| Network guard | every plan/submit/compensate checks `eth_chainId === 688689`; no mainnet RPC or chain id is present |
| Read retries | 4 attempts with 250/500/1000 ms backoff, only for reads and planning |
| Send retries | **none**; sends are single-shot and journalled |
| Approval gate | `submit()` requires an explicit `PlanApproval` whose hash equals the current plan hash |
| Compensation | only `REVOKE_APPROVAL` is implemented; unwind swap is unavailable |

### Why live SWAP/DEPOSIT are unavailable

Official Pharos docs list **no deployed Atlantic DEX/router or vault/lending
protocol**. The canonical contracts are deployment/wallet infrastructure only.
The adapter refuses to target a random contract or invent calldata. That is an
explicit capability blocker, not a failed transaction.

## 2. Actual transaction plan

Command (read-only; no signing key read; `--address` used):

```powershell
npm run testnet:plan -- `
  --env-file <local-env-file> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness `
  --id saga_testnet_usdc_approve_plan `
  --token USDC --amount 0.01 `
  --spender 0x0000000000000000000000000000000000000000
```

Observed output:

```text
TRANSACTION PLAN - PHAROS ATLANTIC TESTNET ONLY
NOTHING HAS BEEN SIGNED OR BROADCAST. Approval is required.
Plan hash:   6d2be1d2f0146b6fd6f29f593976fb24037548bc55eec6743691893927dd7507
Network:     atlantic-testnet (chainId 688689)
RPC host:    https://atlantic.dplabs-internal.com/<redacted-path>
Wallet:      0xE2B8651178ade144003537eA509E37877dba40bb
Nonce:       13
Step:        APPROVE
Executable:  false
Max cost:    0 wei (0 PHRS)

Transactions (0):

Expected postconditions:

Blocked reasons:
  - No verified swap or deposit contract is configured, so there is no justified
    approval spender. Refusing to approve an arbitrary address.

To execute exactly this plan, an operator must explicitly re-run with:
  --approval-hash 6d2be1d2f0146b6fd6f29f593976fb24037548bc55eec6743691893927dd7507 --confirm-atlantic-testnet
No transaction is sent by this planning command.
```

**Approval status:** not approved. The plan is not executable (`Transactions (0)`),
so there is nothing to approve or sign. The hash is recorded for audit only.
The `testnet:run` command was never invoked.

### 2.1 Post-funding plan re-check (1 USDC)

After the wallet received 20 USDC, the plan was re-generated read-only for
**1 USDC** with the same default testnet config (no verified protocol):

```text
Plan hash:   6d2be1d2f0146b6fd6f29f593976fb24037548bc55eec6743691893927dd7507
Step:        APPROVE
Executable:  false
Transactions (0):
Blocked reasons:
  - No verified swap or deposit contract is configured, so there is no justified
    approval spender. Refusing to approve an arbitrary address.
```

The balance is no longer a blocker. The sole remaining blocker is the absence of
a verified spender/protocol. No transaction was signed or broadcast.

## 3. Live operations tested

| Operation | Live result |
| --- | --- |
| `eth_chainId` | **688689** (correct Atlantic testnet) |
| `eth_blockNumber` | 31,543,563 at post-funding check |
| Native balance | `542613955838483504` wei = 0.542613955838483504 PHRS |
| USDC contract | code present (1,798 bytes), `symbol()` = USDC, `decimals()` = 6 |
| USDC total supply | `100108237887829` raw |
| Token balances | **20 USDC**; USDT/WBTC/WETH/WPHRS 0 |
| Funding transaction | `0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b`, block 31543356, success, one `Transfer` log of 20 USDC to the wallet |
| Transactions sent by this project | **None** |
| Gas spent by this project | **0** |

Funding explorer link:
<https://atlantic.pharosscan.xyz/tx/0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b>

### Hypothetical gas (not executed)

For context only, a read-only `eth_estimateGas` for an `approve(Permit2, 0.01
USDC)` call (Permit2 is only used as a gas-estimation example, not as an approved
protocol spender) returned:

```text
approve gas estimate: 71,377
gas price:            10 gwei
cost at gas price:    0.00071377 PHRS
2x safety ceiling:    0.00142754 PHRS
```

This is **not** a proposed transaction. The live plan above contains zero
transactions because no verified protocol spender exists, even though the wallet
now holds 20 USDC.

## 4. Mocked and simulated failure testing

| Scenario | Layer | Result |
| --- | --- | --- |
| Reverted testnet transaction | mocked `TestnetClient` | `PermanentStepError TESTNET_TX_REVERTED`; journal `REVERTED`; no resend |
| Receipt timeout | mocked `TestnetClient` | `UnknownSubmissionOutcomeError TESTNET_RECEIPT_TIMEOUT`; journal `UNKNOWN`; no resend |
| Ambiguous send error | mocked `TestnetClient` | `UnknownSubmissionOutcomeError TESTNET_SEND_UNKNOWN`; journal `UNKNOWN`; no resend |
| Confirmed tx, false postcondition | mocked `TestnetClient` | unknown outcome, manual reconciliation; never marked SUCCESS |
| Wrong chain (1672) | mocked `TestnetClient` | readiness `ok=false`; planning refuses before any send |
| No approval | adapter | `PermanentStepError PLAN_APPROVAL_REQUIRED`; zero send calls |
| Wrong approval hash | adapter | `PermanentStepError PLAN_HASH_MISMATCH`; zero send calls |
| No verified protocol | adapter | plan `executable=false`; zero send calls |
| Transient read failures | mocked `TestnetClient` | 4 read attempts, then success; zero send calls |

The original simulated-adapter demos remain unchanged and passing.

## 5. Test results

```text
npm test       -> 80 tests, 80 pass, 0 fail, 0 skipped (~73 s)
npm run verify -> build + 80 tests + safety gate (see exact run below)
```

Breakdown:

| File | Tests |
| --- | ---: |
| `test/state-machine.test.ts` | 10 |
| `test/executor-success.test.ts` | 4 |
| `test/retry.test.ts` | 7 |
| `test/failure.test.ts` | 13 |
| `test/persistence.test.ts` | 9 |
| `test/audit.test.ts` | 7 |
| `test/cli.test.ts` | 4 |
| `test/safety.test.ts` | 9 |
| `test/testnet.test.ts` | 17 |
| **Total** | **80** |

The 61 original tests still pass; the additions are the testnet adapter,
approval-gate, on-chain receipt, journal and safety-isolation tests.

## 6. Receipt and recovery semantics

- `SimulatedReceipt` and `OnChainReceipt` are distinct types. A simulated receipt
  cannot pass the on-chain verifier and an on-chain receipt cannot pass the
  simulated verifier.
- On-chain receipts require: chainId 688689, `simulated: false`, a 32-byte tx
  hash, a block number/hash, success status, at least one confirmation, the
  Atlantic explorer URL, gas used/price, and postconditions.
- An `INTENT` journal entry is written **before** send. If the process dies
  before a hash is returned, the outcome is unknown and the key is never
  resubmitted.
- A `BROADCAST` hash is preserved. Timeout, ambiguous send and postcondition
  mismatch all become `UNKNOWN`, not success and not a retry.
- A reverted receipt is `REVERTED`; APPROVE then fails without downstream steps.
- `REVOKE_APPROVAL` compensation is implemented but requires its own approved plan;
  it is not automatically authorized by the APPROVE approval.
- Unwind swap compensation is unavailable because no verified DEX exists.

## 7. Secrets and repository hygiene

- No private key, seed phrase, keystore or session token is in the repository.
- Readiness/planning commands use `--address` and `requireSigning: false`; they do
  not read the key value.
- The local env file is outside the repository; only its variable names appear in
  documentation (`RPC_URL`, `PRIVATE_KEY`, `GOVERNOR_ADDRESS`, `PHAROS_API_KEY`).
- The RPC URL's path is redacted in all output because it may contain a provider
  key.
- `.env`, `.local/`, `state/`, `.demo-state/`, `dist/`, `node_modules/` and the
  testnet journal are git-ignored.
- The safety gate scans simulation files for network/wallet code and testnet
  files for mainnet targets/key literals.

## 8. Limitations / manual recovery

1. **No live saga operation was possible.** The wallet has gas and 20 test USDC,
   but no verified swap/deposit protocol exists, so the plan remains
   non-executable.
2. **No transaction plan is executable.** The plan contains zero transactions and
   `executable=false`.
3. **No deployment was performed.** Deploying a test-only DEX/vault would require
   a separate explicit approval and is outside this task.
4. **Unknown outcomes require manual recovery.** The adapter never resubmits.
5. **The testnet journal is single-process.** Cross-process concurrent writers are
   not supported.
6. **The local RPC path may contain a provider key.** It is read from the local env
   and redacted; it is never persisted.
7. **RPC rate limits.** The public endpoint returns `cu limit exceeded` under
   bursts; read-only checks retry with backoff and may still report a token-read
   warning.

## 9. Exact verification command and result

```powershell
npm run verify
```

Result: **PASS** — TypeScript build, 87/87 tests, and the static safety gate
(see [verified-output.md](verified-output.md) for the full recorded run).

## 10. What is required next

To proceed beyond readiness, one of these must happen with explicit approval:

1. **Provide a verified protocol.** A documented Atlantic swap/router and
   vault/deposit address set with provenance and ABI is required. The token
   funding prerequisite is now satisfied (20 USDC).
2. **Or explicitly authorize a separate task to deploy test-only contracts.**
   That plan is described in section 11.

Only then can `testnet:plan` produce an executable plan. That plan must be
reviewed (network, addresses, token amount, allowance, calldata, gas, maximum
cost, postconditions) and its exact hash approved before `testnet:run` may sign
or broadcast. No such approval exists yet.

## 11. Test-only deployment plan (PREPARED, NOT EXECUTED)

The plan originally proposed here has been **prepared in full, compiled and
locally validated**, but still **not executed**. The current state:

- Foundry was found and used in **WSL Ubuntu** (`/home/wyka/.foundry/bin`,
  version 1.2.3-stable); it was not installed on the Windows side.
- Four clearly labelled test-only contracts exist under `contracts/test-only/`:
  `TestOnlyUSDC`, `TestOnlyReceiptToken`, `TestOnlySwap` (1% test fee,
  `unwind()` reverse path) and `TestOnlyVault` (1:1 shares). Fault hooks make
  failures deterministic.
- Eight Foundry tests pass locally, including deployment-gas measurement.
- A **four-scenario local Anvil session** (`npm run demo:local`) runs the real
  executor with real local transactions: success, forced SWAP revert with
  `REVOKE_APPROVAL`, forced DEPOSIT revert with `SIMULATED_UNWIND_SWAP`, and an
  unknown SWAP outcome reconciled without resubmission. See
  [local-anvil.md](local-anvil.md).
- A **read-only Atlantic deployment plan** was produced from live chain state:
  [testnet-deployment-plan.md](testnet-deployment-plan.md).
  - Plan hash: `cf458108d271c3a3f9cc9b7daa96de37bf499405cf2b8e39d5ef975bc540d691`
  - 4 deployments (USDC mock, receipt token, swap, vault), measured deploy gas
    **1,972,442**, total gas cap **2,800,000**
  - Maximum planned spend at the observed 10 gwei: **0.028 PHRS** (operator
    ceiling 0.05 PHRS; wallet holds 0.5426 PHRS)
  - Predicted CREATE addresses are explicitly marked as predictions, valid only
    if the pending nonce (13) does not move first.

### Status of the original constraints

| Original requirement | Current state |
| --- | --- |
| Test-only contracts, clearly named | Done (`contracts/test-only/`, labelled in code and docs) |
| No mainnet / no real funds | Enforced (chain guards; safety gate) |
| No unlimited approvals | Exact, bounded allowances only |
| Exact plan hash approval before signing | Plan hash produced; **no approval requested yet; nothing signed** |
| No blind resend after unknown | Proven on local Anvil (`sendCount` unchanged after reconcile) |

### What is still required before Atlantic deployment

1. Explicit user approval of the exact plan hash above.
2. Review of the plan document, including constructor arguments, gas caps,
   predicted addresses and the 0.05 PHRS ceiling.
3. A separate, reviewed execution task with a dedicated deployment script
   (INTENT journal before each send, no retry on ambiguous outcomes, receipt
   verification, actual-address recording). That script does not exist yet.

No `TestOnly*` contract has been deployed to Atlantic. No transaction has been
sent by this project.
