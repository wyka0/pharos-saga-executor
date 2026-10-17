# Verified output

Verification date: **2026-10-17**
Project: `C:\pharos-saga-executor`
Platform: Windows 11, PowerShell 7, Node **v24.14.1**, npm **11.11.0**
Adapter: **simulated** (iteration 1) plus a **gated Atlantic testnet adapter** (iteration 2, read-only)

> ## Classification
>
> **Sections 1-8 are iteration 1:** deterministic simulation. No transaction hash,
> block number or explorer link exists there; no real transaction was sent and
> **no live on-chain saga had executed at that point** (the executed run is
> recorded in [section 14](#iteration-7--atlantic-saga-execution)).
>
> **Section 9 is iteration 2:** live **read-only** Atlantic testnet checks
> (chain id, balances, token metadata, plan generation). No transaction was
> signed or broadcast. The live plan is blocked and contains zero transactions.
>
> **Status addendum (2026-10-18, later iterations):** sections 10-13 extend this
> record with testnet iterations (read-only checks, local-chain runs and gated
> tooling records); **section 14 records the gated Atlantic testnet saga run
> that was explicitly approved and executed** - five confirmed transactions on
> chainId 688689 against the test-only mock contracts. No mainnet transaction
> was ever sent.
>
> The **test-only deployment** those contracts come from was itself explicitly
> approved and executed on 2026-10-17 (deployment plan hash
> `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`; five
> transactions, all CONFIRMED; deployment journal
> `.local/atlantic-deploy/deploy-journal.json`; total gas used 2,471,030 =
> 0.0247103 PHRS at 10 gwei), and the saga executed against it under the
> approved saga plan hash
> `8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f` - see
> [section 14](#iteration-7--atlantic-saga-execution).
>
> **Sections 1-13 are historical iteration records:** status lines and
> classification tables there (e.g. "no live transaction sent", "nothing
> signed or broadcast", "not deployed", "still 0", "none") describe their own
> iteration only and must not be read as the current state. The
> official-protocol adapter remains blocked (no officially documented Atlantic
> router/vault exists), and the mocks remain test-only: `TestOnlyUSDC` /
> `TestOnlyReceiptToken` (tUSDC / tSAGA) are not the official USDC
> (`0xcfC8...Fc8B`), which was never targeted.

## 1. Command summary

| Command | Exit | Recorded result |
| --- | ---: | --- |
| `npm install --no-fund --no-audit` | 0 | added 6 packages (TypeScript, tsx, @types/node and transitive dev tooling) |
| `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit`, no diagnostics |
| `npm test` | 0 | **61 tests, 61 pass, 0 fail**; 0 suites; 0 skipped; ~4.9 s |
| `npm run demo:success` | 0 | `PASS`; final state `COMPLETED`; all three simulated receipts verified |
| `npm run demo:failure` | 0 | `PASS`; transient retries at 75 ms and 150 ms, permanent DEPOSIT failure, simulated unwind succeeded, final state `FAILED` |
| `npm run demo:manual` | 0 | `PASS`; compensation failed, final state `MANUAL_RECOVERY_REQUIRED` |
| `npm run demo:unknown` | 0 | `PASS`; unknown SWAP outcome, no retry, final state `MANUAL_RECOVERY_REQUIRED` |
| `npm run verify` | 0 | build + 61 tests + static safety gate, all passed; 38 build files emitted |
| `npx --yes skills@1.7.2 add . --list` | 0 | local path validated; **1 skill found**: `pharos-saga-executor` (list only, not installed) |
| `npm run cli -- list ...` | 0 | one persisted simulated saga listed (see section 5) |

The final `npm run verify` summary was:

```text
> pharos-saga-executor@0.1.0 build
> tsc -p tsconfig.json

> pharos-saga-executor@0.1.0 test
> node --import tsx --test test/state-machine.test.ts test/executor-success.test.ts test/retry.test.ts test/failure.test.ts test/persistence.test.ts test/audit.test.ts test/cli.test.ts test/safety.test.ts

ℹ tests 61
ℹ suites 0
ℹ pass 61
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4914.1975

> pharos-saga-executor@0.1.0 check:safety
> node scripts/check-safety.mjs

SAFETY GATE PASSED - simulation-only project, no wallet/RPC/secrets, required files present.
```

## 2. Test breakdown

| File | Tests | Focus |
| --- | ---: | --- |
| `test/state-machine.test.ts` | 10 | required states, legal/illegal transitions, dependency guards, stable ids, config validation, swap-output/deposit-token invariant |
| `test/executor-success.test.ts` | 4 | successful three-step run, receipt verification, exact state sequence, decimal propagation |
| `test/retry.test.ts` | 7 | backoff/jitter, seeded jitter, validation, transient retry success, exhaustion, configurable max attempts, delay cap |
| `test/failure.test.ts` | 13 | permanent failure in every step, compensation success/failure/unavailable, manual recovery, unknown and invalid outcomes, reconciliation |
| `test/persistence.test.ts` | 9 | save/load, audit mirror, crash after step, crash after submit, crash before submit, retry-wait resume, duplicate starts/runs, listing |
| `test/audit.test.ts` | 7 | ordering, completeness, retry/compensation ordering, separate errors, mirror equality, duplicate runs, timestamps |
| `test/cli.test.ts` | 3 | start/inspect/list/audit, `--no-run` + resume, exit codes |
| `test/safety.test.ts` | 8 | no wallet/RPC/network code, no chain deps, ignore rules, license, required files, simulated branding, human output, ledger |
| **Total** | **61** | |

No test requires a wallet, network, real funds or real-time waiting. The suite
uses `VirtualClock` (sleep advances virtual time) and injected deterministic
jitter. CI-style command:

```powershell
npm test
```

## 3. Requirement -> test evidence

| Task requirement | Evidence |
| --- | --- |
| Successful three-step execution | `test/executor-success.test.ts`; demo 1 |
| Dependency enforcement | `test/state-machine.test.ts` ("a step cannot start before..."), executor `assertPrerequisites` |
| Receipt verification | `test/executor-success.test.ts`, `test/failure.test.ts` (invalid receipt) |
| Transient failure then retry success | `test/retry.test.ts` |
| Retry exhaustion | `test/retry.test.ts`, `test/failure.test.ts` |
| Permanent failure in each step | `test/failure.test.ts` (APPROVE, SWAP, DEPOSIT) |
| Compensation success | `test/failure.test.ts` (SWAP and DEPOSIT) |
| Compensation failure | `test/failure.test.ts` (SWAP and DEPOSIT) |
| Manual recovery when compensation is unavailable | `test/failure.test.ts` (policy NONE and adapter UNAVAILABLE) |
| Duplicate invocation / idempotency | `test/persistence.test.ts` (clientRequestId, concurrent runs, completed no-op) |
| Persistence and resume | `test/persistence.test.ts` (three crash windows + retry wait) |
| Illegal state transitions | `test/state-machine.test.ts` |
| Audit ordering and completeness | `test/audit.test.ts` |
| Unknown submission outcome | `test/failure.test.ts` (unresolvable), `test/failure.test.ts` (resolvable), `test/persistence.test.ts` (crash before receipt persistence) |
| No wallet/network/real funds | `test/safety.test.ts`, `scripts/check-safety.mjs` |

## 4. Demonstrated runs

### 4.1 Success: `npm run demo:success`

Final verified state: `COMPLETED`. Step order was `APPROVE, SWAP, DEPOSIT`.
The DEPOSIT input (`99.5`) equals the SWAP output. All three receipts are
simulated.

<details>
<summary>Full captured output (deterministic virtual timestamps)</summary>

```text

> pharos-saga-executor@0.1.0 demo:success
> tsx scripts/demo-success.ts

==============================================================================
PHAROS SAGA EXECUTOR - SUCCESS DEMONSTRATION
CLASSIFICATION: DEMONSTRATION / SIMULATED - not live blockchain evidence
SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.
==============================================================================
[PERSISTED] saga_demo_success state=CREATED stateDir=C:\pharos-saga-executor\.demo-state\success
==============================================================================
SAGA saga_demo_success
SIMULATED ADAPTER - NO WALLET, RPC, SIGNATURE, BROADCAST OR ON-CHAIN TRANSACTION WAS USED.
==============================================================================
State:       COMPLETED
Created:     2026-01-01T00:00:00.000Z
Updated:     2026-01-01T00:00:00.000Z
Completed:   2026-01-01T00:00:00.000Z
Revision:    11
Adapter:     simulated (simulated=true)
Scenario:    success
Request:     100 PROS -> USDC -> deposit USDC
Actors:      owner=sim:demo-account spender=sim:pharos-router protocol=sim:pharos-vault
Retry:       maxAttempts=3 base=100ms max=1000ms factor=2
Comp policy: swap=REVOKE_APPROVAL deposit=SIMULATED_UNWIND_SWAP
Evidence:    SIMULATED receipts only; no transaction hash, no explorer link, no on-chain confirmation.

STEPS (stable IDs and idempotency keys)
  APPROVE  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_10a5bd575e0dac8c6f16fd6207e1896f6d09f328 (SIMULATED)
           id=saga_demo_success:APPROVE idem=saga_demo_success:APPROVE:v1
  SWAP     SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_60626e137ef8e574fca2fd85eab43f08924d1ca7 (SIMULATED)
           id=saga_demo_success:SWAP idem=saga_demo_success:SWAP:v1
  DEPOSIT  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_fc4955535f343a1d521164369f4cfe07f6745e5e (SIMULATED)
           id=saga_demo_success:DEPOSIT idem=saga_demo_success:DEPOSIT:v1

FAILURE
  none

COMPENSATION / RECOVERY
  not reached

AUDIT LOG (17 events, ordered by seq)
#0001 2026-01-01T00:00:00.000Z INFO  SAGA_CREATED | Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled. | {"adapterId":"simulated","simulated":true,"disclaimer":"SIMULATED ONLY - no wallet was used and no on-chain transaction was sent or confirmed.","scenario":"success","retry":{"maxAttempts":3,"baseDelayMs":100,"maxDelayMs":1000,"backoffFactor":2},"compensationPolicy":{"onSwapFailure":"REVOKE_APPROVAL","onDepositFailure":"SIMULATED_UNWIND_SWAP"},"clientRequestId":"client_demo_success"}
#0002 2026-01-01T00:00:00.000Z INFO  SAGA_RUN_STARTED | Executor attached in state CREATED. Persisting before any step. | {"state":"CREATED","simulated":true}
#0003 2026-01-01T00:00:00.000Z INFO  TRANSITION CREATED -> APPROVAL_PENDING | Saga accepted. APPROVE is the only step that may start. | {"simulated":true}
#0004 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_success:APPROVE] | Starting simulated APPROVE attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"APPROVE","attempt":1,"idempotencyKey":"saga_demo_success:APPROVE:v1","maxAttempts":3,"simulated":true}
#0005 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_success:APPROVE] | APPROVE simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_10a5bd575e0dac8c6f16fd6207e1896f6d09f328","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"0","allowance":"100","spender":"sim:pharos-router","shares":null,"protocol":null},"simulated":true}
#0006 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_success:APPROVE] | APPROVE succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0007 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVAL_PENDING -> APPROVED | APPROVE verified. | {"step":"APPROVE","receiptKind":"STEP","simulated":true}
#0008 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVED -> SWAP_PENDING | APPROVE receipt verified. SWAP may now start. | {"prerequisite":"APPROVE"}
#0009 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_success:SWAP] | Starting simulated SWAP attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"SWAP","attempt":1,"idempotencyKey":"saga_demo_success:SWAP:v1","maxAttempts":3,"simulated":true}
#0010 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_success:SWAP] | SWAP simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_60626e137ef8e574fca2fd85eab43f08924d1ca7","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"99.5","allowance":null,"spender":null,"shares":null,"protocol":null},"simulated":true}
#0011 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_success:SWAP] | SWAP succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0012 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAP_PENDING -> SWAPPED | SWAP verified. | {"step":"SWAP","receiptKind":"STEP","simulated":true}
#0013 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAPPED -> DEPOSIT_PENDING | SWAP receipt verified. DEPOSIT may now start. | {"prerequisite":"SWAP"}
#0014 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_success:DEPOSIT] | Starting simulated DEPOSIT attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"DEPOSIT","attempt":1,"idempotencyKey":"saga_demo_success:DEPOSIT:v1","maxAttempts":3,"simulated":true}
#0015 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_success:DEPOSIT] | DEPOSIT simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_fc4955535f343a1d521164369f4cfe07f6745e5e","result":{"tokenIn":"USDC","tokenOut":"sim:pharos-vault:shares","amountIn":"99.5","amountOut":"97.51","allowance":null,"spender":null,"shares":"97.51","protocol":"sim:pharos-vault"},"simulated":true}
#0016 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_success:DEPOSIT] | DEPOSIT succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0017 2026-01-01T00:00:00.000Z INFO  TRANSITION DEPOSIT_PENDING -> COMPLETED | DEPOSIT verified. | {"step":"DEPOSIT","receiptKind":"STEP","simulated":true}
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: COMPLETED
STEPS: approve=SUCCEEDED/1 swap=SUCCEEDED/1 deposit=SUCCEEDED/1
COMPENSATION: none -> not reached
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - APPROVE -> SWAP -> DEPOSIT completed in order with verified simulated receipts.
```

</details>

### 4.2 Forced failure + compensation: `npm run demo:failure`

Deterministic sequence: DEPOSIT attempt 1 transient (75 ms retry), attempt 2
transient (150 ms retry), attempt 3 permanent. The simulated unwind swap then
succeeds. Final state is `FAILED`, with the original DEPOSIT failure preserved
and compensation recorded separately.

<details>
<summary>Full captured output (30 audit events)</summary>

```text

> pharos-saga-executor@0.1.0 demo:failure
> tsx scripts/demo-failure.ts

==============================================================================
PHAROS SAGA EXECUTOR - FORCED-FAILURE + COMPENSATION DEMONSTRATION
CLASSIFICATION: DEMONSTRATION / SIMULATED - deterministic injected failure, not live blockchain evidence
SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.
==============================================================================
[PERSISTED] saga_demo_failure state=CREATED stateDir=C:\pharos-saga-executor\.demo-state\failure
==============================================================================
SAGA saga_demo_failure
SIMULATED ADAPTER - NO WALLET, RPC, SIGNATURE, BROADCAST OR ON-CHAIN TRANSACTION WAS USED.
==============================================================================
State:       FAILED
Created:     2026-01-01T00:00:00.000Z
Updated:     2026-01-01T00:00:00.225Z
Completed:   -
Revision:    19
Adapter:     simulated (simulated=true)
Scenario:    failure
Request:     100 PROS -> USDC -> deposit USDC
Actors:      owner=sim:demo-account spender=sim:pharos-router protocol=sim:pharos-vault
Retry:       maxAttempts=3 base=100ms max=1000ms factor=2
Comp policy: swap=REVOKE_APPROVAL deposit=SIMULATED_UNWIND_SWAP
Evidence:    SIMULATED receipts only; no transaction hash, no explorer link, no on-chain confirmation.

STEPS (stable IDs and idempotency keys)
  APPROVE  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_f84cb91a12d341a1f29a26ec21db426925314a42 (SIMULATED)
           id=saga_demo_failure:APPROVE idem=saga_demo_failure:APPROVE:v1
  SWAP     SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_a863fb88913e530041945ae0934be5a347e43a12 (SIMULATED)
           id=saga_demo_failure:SWAP idem=saga_demo_failure:SWAP:v1
  DEPOSIT  FAILED       attempts=3 submission=NOT_SUBMITTED receipt=none last-retry=150ms@2026-01-01T00:00:00.225Z errors=3
           id=saga_demo_failure:DEPOSIT idem=saga_demo_failure:DEPOSIT:v1

FAILURE
  step=DEPOSIT kind=PERMANENT code=SIMULATED_PERMANENT_DEPOSIT attempts=3 retryExhausted=false
  message=Simulated permanent DEPOSIT failure (injected scenario "failure"). Nothing was submitted.
  at=2026-01-01T00:00:00.225Z

COMPENSATION / RECOVERY
  required=true action=SIMULATED_UNWIND_SWAP status=SUCCEEDED attempts=1
  note=Simulated unwind swap completed. The original failure remains on record.
  simulatedReceipt=sim_d448677f45bbb137b034a69384cebbb6afd846e1 (SIMULATED, not a rollback)

AUDIT LOG (30 events, ordered by seq)
#0001 2026-01-01T00:00:00.000Z INFO  SAGA_CREATED | Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled. | {"adapterId":"simulated","simulated":true,"disclaimer":"SIMULATED ONLY - no wallet was used and no on-chain transaction was sent or confirmed.","scenario":"failure","retry":{"maxAttempts":3,"baseDelayMs":100,"maxDelayMs":1000,"backoffFactor":2},"compensationPolicy":{"onSwapFailure":"REVOKE_APPROVAL","onDepositFailure":"SIMULATED_UNWIND_SWAP"},"clientRequestId":"client_demo_failure"}
#0002 2026-01-01T00:00:00.000Z INFO  SAGA_RUN_STARTED | Executor attached in state CREATED. Persisting before any step. | {"state":"CREATED","simulated":true}
#0003 2026-01-01T00:00:00.000Z INFO  TRANSITION CREATED -> APPROVAL_PENDING | Saga accepted. APPROVE is the only step that may start. | {"simulated":true}
#0004 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_failure:APPROVE] | Starting simulated APPROVE attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"APPROVE","attempt":1,"idempotencyKey":"saga_demo_failure:APPROVE:v1","maxAttempts":3,"simulated":true}
#0005 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_failure:APPROVE] | APPROVE simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_f84cb91a12d341a1f29a26ec21db426925314a42","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"0","allowance":"100","spender":"sim:pharos-router","shares":null,"protocol":null},"simulated":true}
#0006 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_failure:APPROVE] | APPROVE succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0007 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVAL_PENDING -> APPROVED | APPROVE verified. | {"step":"APPROVE","receiptKind":"STEP","simulated":true}
#0008 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVED -> SWAP_PENDING | APPROVE receipt verified. SWAP may now start. | {"prerequisite":"APPROVE"}
#0009 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_failure:SWAP] | Starting simulated SWAP attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"SWAP","attempt":1,"idempotencyKey":"saga_demo_failure:SWAP:v1","maxAttempts":3,"simulated":true}
#0010 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_failure:SWAP] | SWAP simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_a863fb88913e530041945ae0934be5a347e43a12","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"99.5","allowance":null,"spender":null,"shares":null,"protocol":null},"simulated":true}
#0011 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_failure:SWAP] | SWAP succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0012 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAP_PENDING -> SWAPPED | SWAP verified. | {"step":"SWAP","receiptKind":"STEP","simulated":true}
#0013 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAPPED -> DEPOSIT_PENDING | SWAP receipt verified. DEPOSIT may now start. | {"prerequisite":"SWAP"}
#0014 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_failure:DEPOSIT] | Starting simulated DEPOSIT attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"DEPOSIT","attempt":1,"idempotencyKey":"saga_demo_failure:DEPOSIT:v1","maxAttempts":3,"simulated":true}
#0015 2026-01-01T00:00:00.000Z WARN  STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT attempt 1 failed transiently: Simulated transient DEPOSIT failure on attempt 1 (injected scenario "failure"). Nothing was submitted. | {"step":"DEPOSIT","attempt":1,"kind":"TRANSIENT","code":"SIMULATED_TRANSIENT_DEPOSIT","simulated":true}
#0016 2026-01-01T00:00:00.000Z WARN  RETRY_SCHEDULED [saga_demo_failure:DEPOSIT] | Bounded retry scheduled for DEPOSIT attempt 2/3 after 75ms (exponential base 100ms, jitter 0.500). | {"step":"DEPOSIT","failedAttempt":1,"nextAttempt":2,"delayMs":75,"rawDelayMs":100,"jitter":0.5,"scheduledAt":"2026-01-01T00:00:00.075Z","simulated":true}
#0017 2026-01-01T00:00:00.000Z INFO  TRANSITION DEPOSIT_PENDING -> RETRY_WAIT | DEPOSIT waiting for a bounded retry. | {"step":"DEPOSIT","attempt":1,"scheduledAt":"2026-01-01T00:00:00.075Z"}
#0018 2026-01-01T00:00:00.075Z INFO  TRANSITION RETRY_WAIT -> DEPOSIT_PENDING | DEPOSIT retry window elapsed. | {"step":"DEPOSIT","nextAttempt":2,"waitedMs":75}
#0019 2026-01-01T00:00:00.075Z INFO  STEP_ATTEMPT [saga_demo_failure:DEPOSIT] | Starting simulated DEPOSIT attempt 2/3. No on-chain transaction is possible with this adapter. | {"step":"DEPOSIT","attempt":2,"idempotencyKey":"saga_demo_failure:DEPOSIT:v1","maxAttempts":3,"simulated":true}
#0020 2026-01-01T00:00:00.075Z WARN  STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT attempt 2 failed transiently: Simulated transient DEPOSIT failure on attempt 2 (injected scenario "failure"). Nothing was submitted. | {"step":"DEPOSIT","attempt":2,"kind":"TRANSIENT","code":"SIMULATED_TRANSIENT_DEPOSIT","simulated":true}
#0021 2026-01-01T00:00:00.075Z WARN  RETRY_SCHEDULED [saga_demo_failure:DEPOSIT] | Bounded retry scheduled for DEPOSIT attempt 3/3 after 150ms (exponential base 200ms, jitter 0.500). | {"step":"DEPOSIT","failedAttempt":2,"nextAttempt":3,"delayMs":150,"rawDelayMs":200,"jitter":0.5,"scheduledAt":"2026-01-01T00:00:00.225Z","simulated":true}
#0022 2026-01-01T00:00:00.075Z INFO  TRANSITION DEPOSIT_PENDING -> RETRY_WAIT | DEPOSIT waiting for a bounded retry. | {"step":"DEPOSIT","attempt":2,"scheduledAt":"2026-01-01T00:00:00.225Z"}
#0023 2026-01-01T00:00:00.225Z INFO  TRANSITION RETRY_WAIT -> DEPOSIT_PENDING | DEPOSIT retry window elapsed. | {"step":"DEPOSIT","nextAttempt":3,"waitedMs":150}
#0024 2026-01-01T00:00:00.225Z INFO  STEP_ATTEMPT [saga_demo_failure:DEPOSIT] | Starting simulated DEPOSIT attempt 3/3. No on-chain transaction is possible with this adapter. | {"step":"DEPOSIT","attempt":3,"idempotencyKey":"saga_demo_failure:DEPOSIT:v1","maxAttempts":3,"simulated":true}
#0025 2026-01-01T00:00:00.225Z ERROR STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT failed permanently: Simulated permanent DEPOSIT failure (injected scenario "failure"). Nothing was submitted. | {"step":"DEPOSIT","attempt":3,"kind":"PERMANENT","code":"SIMULATED_PERMANENT_DEPOSIT","simulated":true}
#0026 2026-01-01T00:00:00.225Z INFO  TRANSITION DEPOSIT_PENDING -> COMPENSATING | DEPOSIT failed permanently. Starting configured compensation SIMULATED_UNWIND_SWAP. | {"step":"DEPOSIT","action":"SIMULATED_UNWIND_SWAP","originalFailure":"SIMULATED_PERMANENT_DEPOSIT","simulated":true}
#0027 2026-01-01T00:00:00.225Z INFO  COMPENSATION_STARTED [saga_demo_failure:COMPENSATION:SIMULATED_UNWIND_SWAP] | Starting simulated compensation SIMULATED_UNWIND_SWAP for the original DEPOSIT failure. This is a new simulated call, not a blockchain rollback. | {"action":"SIMULATED_UNWIND_SWAP","originalStep":"DEPOSIT","simulated":true}
#0028 2026-01-01T00:00:00.225Z INFO  COMPENSATION_SUCCEEDED [saga_demo_failure:COMPENSATION:SIMULATED_UNWIND_SWAP] | Simulated compensation SIMULATED_UNWIND_SWAP succeeded. The original DEPOSIT failure is still recorded; nothing was rolled back. | {"action":"SIMULATED_UNWIND_SWAP","originalStep":"DEPOSIT","simulatedTxRef":"sim_d448677f45bbb137b034a69384cebbb6afd846e1","simulated":true}
#0029 2026-01-01T00:00:00.225Z ERROR SAGA_FAILED [saga_demo_failure:DEPOSIT] | Saga failed at DEPOSIT; compensation SIMULATED_UNWIND_SWAP succeeded. Outcome is FAILED, not COMPLETED. | {"originalFailure":"SIMULATED_PERMANENT_DEPOSIT","compensationStatus":"SUCCEEDED","simulated":true}
#0030 2026-01-01T00:00:00.225Z INFO  TRANSITION COMPENSATING -> FAILED | Compensation SIMULATED_UNWIND_SWAP succeeded; saga remains failed. | {"action":"SIMULATED_UNWIND_SWAP","originalStep":"DEPOSIT"}
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: FAILED
STEPS: approve=SUCCEEDED/1 swap=SUCCEEDED/1 deposit=FAILED/3
COMPENSATION: SIMULATED_UNWIND_SWAP -> SUCCEEDED
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - DEPOSIT failed transiently twice, retried with bounded jittered backoff, failed permanently on attempt 3, then executed the configured SIMULATED_UNWIND_SWAP. The saga is FAILED, not COMPLETED, and the original failure is preserved.
```

</details>

### 4.3 Compensation failure: `npm run demo:manual`

SWAP fails permanently, simulated approval revocation also fails, and the saga
stops in `MANUAL_RECOVERY_REQUIRED`. DEPOSIT was never attempted.

<details>
<summary>Full captured output</summary>

```text

> pharos-saga-executor@0.1.0 demo:manual
> tsx scripts/demo-manual-recovery.ts

==============================================================================
PHAROS SAGA EXECUTOR - MANUAL RECOVERY DEMONSTRATION
CLASSIFICATION: DEMONSTRATION / SIMULATED - injected compensation failure, not live blockchain evidence
SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.
==============================================================================
[PERSISTED] saga_demo_manual state=CREATED stateDir=C:\pharos-saga-executor\.demo-state\manual
==============================================================================
SAGA saga_demo_manual
SIMULATED ADAPTER - NO WALLET, RPC, SIGNATURE, BROADCAST OR ON-CHAIN TRANSACTION WAS USED.
==============================================================================
State:       MANUAL_RECOVERY_REQUIRED
Created:     2026-01-01T00:00:00.000Z
Updated:     2026-01-01T00:00:00.000Z
Completed:   -
Revision:    10
Adapter:     simulated (simulated=true)
Scenario:    manual-recovery
Request:     100 PROS -> USDC -> deposit USDC
Actors:      owner=sim:demo-account spender=sim:pharos-router protocol=sim:pharos-vault
Retry:       maxAttempts=3 base=100ms max=1000ms factor=2
Comp policy: swap=REVOKE_APPROVAL deposit=SIMULATED_UNWIND_SWAP
Evidence:    SIMULATED receipts only; no transaction hash, no explorer link, no on-chain confirmation.

STEPS (stable IDs and idempotency keys)
  APPROVE  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_bfb31dc80256232b49f7c5bd9db3306eab2b13f8 (SIMULATED)
           id=saga_demo_manual:APPROVE idem=saga_demo_manual:APPROVE:v1
  SWAP     FAILED       attempts=1 submission=NOT_SUBMITTED receipt=none errors=1
           id=saga_demo_manual:SWAP idem=saga_demo_manual:SWAP:v1
  DEPOSIT  PENDING      attempts=0 submission=NOT_SUBMITTED receipt=none
           id=saga_demo_manual:DEPOSIT idem=saga_demo_manual:DEPOSIT:v1

FAILURE
  step=SWAP kind=PERMANENT code=SIMULATED_PERMANENT_SWAP attempts=1 retryExhausted=false
  message=Simulated permanent SWAP failure (injected scenario "manual-recovery"). Nothing was submitted.
  at=2026-01-01T00:00:00.000Z

COMPENSATION / RECOVERY
  required=true action=REVOKE_APPROVAL status=FAILED attempts=1
  note=Simulated compensation REVOKE_APPROVAL failed under scenario "manual-recovery".
  compensationError=SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL: Simulated compensation REVOKE_APPROVAL failed. No state was rolled back.

AUDIT LOG (15 events, ordered by seq)
#0001 2026-01-01T00:00:00.000Z INFO  SAGA_CREATED | Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled. | {"adapterId":"simulated","simulated":true,"disclaimer":"SIMULATED ONLY - no wallet was used and no on-chain transaction was sent or confirmed.","scenario":"manual-recovery","retry":{"maxAttempts":3,"baseDelayMs":100,"maxDelayMs":1000,"backoffFactor":2},"compensationPolicy":{"onSwapFailure":"REVOKE_APPROVAL","onDepositFailure":"SIMULATED_UNWIND_SWAP"},"clientRequestId":"client_demo_manual"}
#0002 2026-01-01T00:00:00.000Z INFO  SAGA_RUN_STARTED | Executor attached in state CREATED. Persisting before any step. | {"state":"CREATED","simulated":true}
#0003 2026-01-01T00:00:00.000Z INFO  TRANSITION CREATED -> APPROVAL_PENDING | Saga accepted. APPROVE is the only step that may start. | {"simulated":true}
#0004 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_manual:APPROVE] | Starting simulated APPROVE attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"APPROVE","attempt":1,"idempotencyKey":"saga_demo_manual:APPROVE:v1","maxAttempts":3,"simulated":true}
#0005 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_manual:APPROVE] | APPROVE simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_bfb31dc80256232b49f7c5bd9db3306eab2b13f8","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"0","allowance":"100","spender":"sim:pharos-router","shares":null,"protocol":null},"simulated":true}
#0006 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_manual:APPROVE] | APPROVE succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0007 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVAL_PENDING -> APPROVED | APPROVE verified. | {"step":"APPROVE","receiptKind":"STEP","simulated":true}
#0008 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVED -> SWAP_PENDING | APPROVE receipt verified. SWAP may now start. | {"prerequisite":"APPROVE"}
#0009 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_manual:SWAP] | Starting simulated SWAP attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"SWAP","attempt":1,"idempotencyKey":"saga_demo_manual:SWAP:v1","maxAttempts":3,"simulated":true}
#0010 2026-01-01T00:00:00.000Z ERROR STEP_FAILED [saga_demo_manual:SWAP] | SWAP failed permanently: Simulated permanent SWAP failure (injected scenario "manual-recovery"). Nothing was submitted. | {"step":"SWAP","attempt":1,"kind":"PERMANENT","code":"SIMULATED_PERMANENT_SWAP","simulated":true}
#0011 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAP_PENDING -> COMPENSATING | SWAP failed permanently. Starting configured compensation REVOKE_APPROVAL. | {"step":"SWAP","action":"REVOKE_APPROVAL","originalFailure":"SIMULATED_PERMANENT_SWAP","simulated":true}
#0012 2026-01-01T00:00:00.000Z INFO  COMPENSATION_STARTED [saga_demo_manual:COMPENSATION:REVOKE_APPROVAL] | Starting simulated compensation REVOKE_APPROVAL for the original SWAP failure. This is a new simulated call, not a blockchain rollback. | {"action":"REVOKE_APPROVAL","originalStep":"SWAP","simulated":true}
#0013 2026-01-01T00:00:00.000Z ERROR COMPENSATION_FAILED [saga_demo_manual:COMPENSATION:REVOKE_APPROVAL] | Compensation REVOKE_APPROVAL failed: Simulated compensation REVOKE_APPROVAL failed under scenario "manual-recovery". | {"action":"REVOKE_APPROVAL","originalStep":"SWAP","error":{"kind":"PERMANENT","code":"SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL","message":"Simulated compensation REVOKE_APPROVAL failed. No state was rolled back.","at":"2026-01-01T00:00:00.000Z","attempt":1},"simulated":true}
#0014 2026-01-01T00:00:00.000Z ERROR MANUAL_RECOVERY_REQUIRED [saga_demo_manual:SWAP] | Compensation REVOKE_APPROVAL failed; manual recovery required. | {"action":"REVOKE_APPROVAL","originalStep":"SWAP","error":{"kind":"PERMANENT","code":"SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL","message":"Simulated compensation REVOKE_APPROVAL failed. No state was rolled back.","at":"2026-01-01T00:00:00.000Z","attempt":1},"simulated":true}
#0015 2026-01-01T00:00:00.000Z INFO  TRANSITION COMPENSATING -> MANUAL_RECOVERY_REQUIRED | Compensation REVOKE_APPROVAL failed; manual recovery required. | {"action":"REVOKE_APPROVAL","originalStep":"SWAP","error":{"kind":"PERMANENT","code":"SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL","message":"Simulated compensation REVOKE_APPROVAL failed. No state was rolled back.","at":"2026-01-01T00:00:00.000Z","attempt":1}}
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: MANUAL_RECOVERY_REQUIRED
STEPS: approve=SUCCEEDED/1 swap=FAILED/1 deposit=PENDING/0
COMPENSATION: REVOKE_APPROVAL -> FAILED
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - SWAP failed permanently, the configured simulated approval revocation also failed, and the saga stopped in MANUAL_RECOVERY_REQUIRED with both failures and all receipts preserved. Nothing was rolled back and DEPOSIT was never attempted.
```

</details>

### 4.4 Unknown submission outcome: `npm run demo:unknown`

SWAP's outcome is unknown and cannot be reconciled. The executor does **not**
resubmit and does **not** compensate. It records one reconciliation attempt and
stops in `MANUAL_RECOVERY_REQUIRED`.

<details>
<summary>Full captured output</summary>

```text

> pharos-saga-executor@0.1.0 demo:unknown
> tsx scripts/demo-unknown-outcome.ts

==============================================================================
PHAROS SAGA EXECUTOR - UNKNOWN SUBMISSION OUTCOME DEMONSTRATION
CLASSIFICATION: DEMONSTRATION / SIMULATED - injected unknown outcome, not live blockchain evidence
SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.
==============================================================================
[PERSISTED] saga_demo_unknown-outcome state=CREATED stateDir=C:\pharos-saga-executor\.demo-state\unknown-outcome
==============================================================================
SAGA saga_demo_unknown-outcome
SIMULATED ADAPTER - NO WALLET, RPC, SIGNATURE, BROADCAST OR ON-CHAIN TRANSACTION WAS USED.
==============================================================================
State:       MANUAL_RECOVERY_REQUIRED
Created:     2026-01-01T00:00:00.000Z
Updated:     2026-01-01T00:00:00.000Z
Completed:   -
Revision:    10
Adapter:     simulated (simulated=true)
Scenario:    unknown-outcome
Request:     100 PROS -> USDC -> deposit USDC
Actors:      owner=sim:demo-account spender=sim:pharos-router protocol=sim:pharos-vault
Retry:       maxAttempts=3 base=100ms max=1000ms factor=2
Comp policy: swap=REVOKE_APPROVAL deposit=SIMULATED_UNWIND_SWAP
Evidence:    SIMULATED receipts only; no transaction hash, no explorer link, no on-chain confirmation.

STEPS (stable IDs and idempotency keys)
  APPROVE  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_6eb7999d4098ca19868ca3b603e211ef2bc9e2d6 (SIMULATED)
           id=saga_demo_unknown-outcome:APPROVE idem=saga_demo_unknown-outcome:APPROVE:v1
  SWAP     FAILED       attempts=1 submission=UNKNOWN_OUTCOME receipt=none errors=1
           id=saga_demo_unknown-outcome:SWAP idem=saga_demo_unknown-outcome:SWAP:v1
  DEPOSIT  PENDING      attempts=0 submission=NOT_SUBMITTED receipt=none
           id=saga_demo_unknown-outcome:DEPOSIT idem=saga_demo_unknown-outcome:DEPOSIT:v1

FAILURE
  step=SWAP kind=UNKNOWN_OUTCOME code=UNKNOWN_SUBMISSION_OUTCOME attempts=1 retryExhausted=false
  message=SWAP outcome is unknown and unreconciled.
  at=2026-01-01T00:00:00.000Z

COMPENSATION / RECOVERY
  not reached

AUDIT LOG (14 events, ordered by seq)
#0001 2026-01-01T00:00:00.000Z INFO  SAGA_CREATED | Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled. | {"adapterId":"simulated","simulated":true,"disclaimer":"SIMULATED ONLY - no wallet was used and no on-chain transaction was sent or confirmed.","scenario":"unknown-outcome","retry":{"maxAttempts":3,"baseDelayMs":100,"maxDelayMs":1000,"backoffFactor":2},"compensationPolicy":{"onSwapFailure":"REVOKE_APPROVAL","onDepositFailure":"SIMULATED_UNWIND_SWAP"},"clientRequestId":"client_demo_unknown-outcome"}
#0002 2026-01-01T00:00:00.000Z INFO  SAGA_RUN_STARTED | Executor attached in state CREATED. Persisting before any step. | {"state":"CREATED","simulated":true}
#0003 2026-01-01T00:00:00.000Z INFO  TRANSITION CREATED -> APPROVAL_PENDING | Saga accepted. APPROVE is the only step that may start. | {"simulated":true}
#0004 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_unknown-outcome:APPROVE] | Starting simulated APPROVE attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"APPROVE","attempt":1,"idempotencyKey":"saga_demo_unknown-outcome:APPROVE:v1","maxAttempts":3,"simulated":true}
#0005 2026-01-01T00:00:00.000Z INFO  RECEIPT_VERIFIED [saga_demo_unknown-outcome:APPROVE] | APPROVE simulated receipt verified; dependency requirement satisfied. | {"simulatedTxRef":"sim_6eb7999d4098ca19868ca3b603e211ef2bc9e2d6","result":{"tokenIn":"PROS","tokenOut":"USDC","amountIn":"100","amountOut":"0","allowance":"100","spender":"sim:pharos-router","shares":null,"protocol":null},"simulated":true}
#0006 2026-01-01T00:00:00.000Z INFO  STEP_SUCCEEDED [saga_demo_unknown-outcome:APPROVE] | APPROVE succeeded in the simulated adapter. | {"attempt":1,"simulated":true}
#0007 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVAL_PENDING -> APPROVED | APPROVE verified. | {"step":"APPROVE","receiptKind":"STEP","simulated":true}
#0008 2026-01-01T00:00:00.000Z INFO  TRANSITION APPROVED -> SWAP_PENDING | APPROVE receipt verified. SWAP may now start. | {"prerequisite":"APPROVE"}
#0009 2026-01-01T00:00:00.000Z INFO  STEP_ATTEMPT [saga_demo_unknown-outcome:SWAP] | Starting simulated SWAP attempt 1/3. No on-chain transaction is possible with this adapter. | {"step":"SWAP","attempt":1,"idempotencyKey":"saga_demo_unknown-outcome:SWAP:v1","maxAttempts":3,"simulated":true}
#0010 2026-01-01T00:00:00.000Z ERROR STEP_FAILED [saga_demo_unknown-outcome:SWAP] | SWAP submission outcome is UNKNOWN: Simulated SWAP submission outcome is unknown and cannot be resolved (injected scenario). No retry is safe. | {"step":"SWAP","attempt":1,"kind":"UNKNOWN_OUTCOME","code":"SIMULATED_UNKNOWN_SWAP","simulated":true}
#0011 2026-01-01T00:00:00.000Z INFO  RECONCILIATION_ATTEMPTED [saga_demo_unknown-outcome:SWAP] | SWAP outcome unknown; querying the adapter by idempotency key. No resubmission. | {"step":"SWAP","idempotencyKey":"saga_demo_unknown-outcome:SWAP:v1","reason":"Submission outcome unknown after adapter error.","simulated":true}
#0012 2026-01-01T00:00:00.000Z WARN  RECONCILIATION_RESULT [saga_demo_unknown-outcome:SWAP] | SWAP could not be reconciled. No simulated SWAP receipt exists for this idempotency key. The outcome cannot be proven; resubmission is unsafe. | {"step":"SWAP","found":false,"detail":"No simulated SWAP receipt exists for this idempotency key. The outcome cannot be proven; resubmission is unsafe.","simulated":true}
#0013 2026-01-01T00:00:00.000Z ERROR MANUAL_RECOVERY_REQUIRED [saga_demo_unknown-outcome:SWAP] | SWAP outcome is unknown and unreconciled. | {"step":"SWAP","idempotencyKey":"saga_demo_unknown-outcome:SWAP:v1","note":"No automatic retry and no compensation were attempted because the submission outcome is unknown.","simulated":true}
#0014 2026-01-01T00:00:00.000Z INFO  TRANSITION SWAP_PENDING -> MANUAL_RECOVERY_REQUIRED | SWAP outcome is unknown and unreconciled. | {"step":"SWAP","idempotencyKey":"saga_demo_unknown-outcome:SWAP:v1","note":"No automatic retry and no compensation were attempted because the submission outcome is unknown."}
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: MANUAL_RECOVERY_REQUIRED
STEPS: approve=SUCCEEDED/1 swap=FAILED/1 deposit=PENDING/0
COMPENSATION: none -> not reached
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - SWAP outcome was unknown, reconciliation found no receipt, and the executor stopped in MANUAL_RECOVERY_REQUIRED without resubmitting or compensating.
```

</details>

## 5. CLI demonstration

```powershell
npm run cli -- list --state-dir .demo-state/success
```

Actual output:

```text

> pharos-saga-executor@0.1.0 cli
> tsx src/cli.ts list --state-dir .demo-state/success

SAGA ID                                        STATE                     REQUEST
--------------------------------------------------------------------------------------------------------------
saga_demo_success                              COMPLETED                 100 PROS->USDC updated=2026-01-01T00:00:00.000Z

1 saga(s). All runs use the simulated adapter.
```

`test/cli.test.ts` additionally verifies:

- `start --scenario success --json` returns a `COMPLETED` record with simulated receipts;
- `inspect` prints state and audit text, with no `0x` transaction hash;
- `list` includes the saga;
- `audit` prints the ordered log;
- `start --no-run` persists `CREATED`, then `run` completes it;
- a failed saga exits **3**, an unknown id exits **6**, and bad usage exits **64**.

## 6. Safety verification

Static gate output (all PASS):

- 24 executable TypeScript files scanned; no `PRIVATE_KEY`, `privateKey`,
  `mnemonic`, raw-transaction call, wallet constructor, `http://`, `https://`
  or `fetch(` present;
- no runtime dependencies; no ethers/viem/web3/wagmi/hardhat;
- `.gitignore` covers `node_modules/`, `dist/`, `state/`, `.demo-state/`,
  `.local/`, `.env`;
- no `.env` and no `.env.example` exist;
- MIT license carries `Copyright (c) 2026 wyka0`;
- `SKILL.md` has YAML front matter, name, description and simulation boundary.

Runtime evidence that no live transaction is claimed:

- every receipt has `simulated: true`, `network: "simulated"`, a `sim_*` ref,
  and `evidence.noOnChainTransaction: true`;
- receipt verifier rejects `simulated:false`, `0x` references, `txHash`,
  `transactionHash`, `blockNumber`, `blockHash` and explorer URLs;
- CLI text includes "SIMULATED receipts only; no transaction hash, no explorer
  link, no on-chain confirmation";
- no RPC URL or signing library is imported anywhere in `src/` or `scripts/`.

## 7. Known gaps / honest limitations

1. **No live or testnet proof.** The first iteration is deliberately simulated.
   There is no transaction hash to submit, and none is fabricated.
2. **Hosted skill registration is not exposed.** `ai.pharos.xyz` documents only
   the official installable GitHub skill; no custom upload/registration endpoint
   was found. This repo is installable locally with the `skills` CLI.
3. **Simulated ledger is single-process.** Concurrent multi-process writers to
   the simulated ledger are not supported.
4. **Compensation is attempted once.** It is not automatically retried, because
   a compensation may be non-idempotent.
5. **Conservative crash handling.** A crash after persisting `IN_FLIGHT` but
   before calling the adapter escalates to manual recovery rather than assuming
   nothing happened.
6. **Target GitHub repository does not exist yet.** Per instructions, no remote
   was created and nothing was pushed. See the final report for the manual step.

## 8. Reproduction

```powershell
cd C:\pharos-saga-executor
npm install
npm run typecheck
npm test
npm run demo:success
npm run demo:failure
npm run demo:manual
npm run demo:unknown
npm run verify
```

The demos use a fixed virtual clock (`2026-01-01T00:00:00.000Z`), fixed ids,
fresh state directories and deterministic jitter, so their timestamps and
receipt references are reproducible.

Generated `.demo-state/`, `state/`, `dist/` and `node_modules/` must not be
committed.

---

# Iteration 2 — Atlantic testnet adapter (read-only phase)

Date: **2026-10-17**
Status: **no live transaction sent**. The testnet plan is blocked and contains
zero transactions. See [testnet-readiness.md](testnet-readiness.md) and
[testnet-results.md](testnet-results.md).

> **Update (2026-10-18):** this section is the iteration-2 record. "No live
> transaction sent", the zero counts in 9.3.1/9.5 and the "none" classification
> in 9.6 were accurate then; they are superseded by the later executed
> test-only workflow - see
> [section 14](#iteration-7--atlantic-saga-execution). The official-protocol
> plan described here is **still** blocked (no officially documented Atlantic
> router/vault).

## 9.1 Baseline preservation

Before the extension:

```text
npm run verify -> build + 61/61 tests + safety gate, exit 0
git status     -> clean
HEAD           -> 15d867925dd192f7802c5fd730f6deb239b46bf8
```

All 61 original simulation tests still pass after the testnet changes.

## 9.2 Final verification

```text
npm run verify
```

Recorded result:

```text
ℹ tests 80
ℹ pass 80
ℹ fail 0
ℹ duration_ms 72592.8604
PASS  25 simulation files are free of wallet/RPC/network code
PASS  10 testnet files are isolated from mainnet and contain no key literals
PASS  only viem is declared as a runtime dependency
PASS  no generated state, secrets or dependencies are tracked
SAFETY GATE PASSED - simulation stays offline; testnet path is gated and mainnet-free.
```

Test distribution: 10 state machine + 4 success + 7 retry + 13 failure +
9 persistence + 7 audit + 4 CLI + 9 safety + 17 testnet = **80**.

## 9.3 Initial readiness result (pre-funding)

This capture predates the external 20 USDC funding transfer, so its USDC balance
is zero. The post-funding check is in section 9.3.1.

Command (no signing key read; `--address` used):

```powershell
npm run testnet:readiness -- `
  --env-file <local-env-file> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness --token USDC --amount 0.01
```

Actual result:

```text
PHAROS ATLANTIC TESTNET READINESS (READ-ONLY)
Network:     atlantic-testnet (chainId 688689, expected 688689)
RPC host:    https://atlantic.dplabs-internal.com/<redacted-path>
Block:       31540254
Wallet:      0xE2B8651178ade144003537eA509E37877dba40bb
Native:      0.542613955838483504 PHRS
Explorer:    https://atlantic.pharosscan.xyz/
Faucet:      documented=false url=none
             Official docs mention a Pharos faucet for native PHRS but publish no URL.
             No documented faucet exists for testnet USDC/USDT/WETH/WPHRS.

Tokens:
  USDC 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B code=true verified=true decimals=6 balance=0
  USDT 0xE7E84B8B4f39C507499c40B4ac199B050e2882d5 code=true verified=true decimals=6 balance=0
  WBTC 0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4 code=true verified=true decimals=18 balance=0
  WETH 0x7d211F77525ea39A0592794f793cC1036eEaccD5 code=true verified=true decimals=18 balance=0
  WPHRS 0x838800b758277CC111B2d48Ab01e5E164f8E9471 code=true verified=true decimals=18 balance=0

Capabilities:
  APPROVE available=false
    - No verified swap or deposit contract is configured, so there is no justified approval spender
    - Wallet holds 0 USDC, less than the requested 0.01
  SWAP    available=false
    - No verified swap/router contract is configured. Official Pharos docs list only token,
      deployment and Permit2 canonical contracts on Atlantic testnet.
  DEPOSIT available=false
    - No verified deposit/vault contract is configured. Official Pharos docs list no deployed
      lending or vault protocol on Atlantic testnet.

No transaction was signed or broadcast.
```

### 9.3.1 Post-funding verification (read-only)

The wallet received 20 USDC from an external transfer. Verified independently by
JSON-RPC and the explorer:

| Check | Result |
| --- | --- |
| `eth_chainId` | **688689** |
| Latest block | `31543563` |
| Wallet | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| Native balance | `542613955838483504` wei = **0.542613955838483504 PHRS** |
| USDC code / symbol / decimals | present (1,798 bytes) / `USDC` / `6` |
| USDC total supply | `100108237887829` raw |
| USDC wallet balance | `20000000` raw = **20 USDC** |
| Funding transaction | `0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b` |
| Funding block / time | `31543356` / `2026-10-17T17:01:25Z` |
| Funding from / to | `0x4cf51364a6d88ba64bcdb93f444b05d1cf4f00e3` → USDC contract |
| Funding receipt | **success**, one `Transfer` log of `20000000` raw to the wallet |
| Explorer | <https://atlantic.pharosscan.xyz/tx/0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b> |
| Explorer API | status `1`, method `Transfer`, block `31543356` |

The funding transaction was sent externally; this project did not sign or
broadcast it. All project-originated transaction counts below remain zero.

## 9.4 Transaction plan result

Command (read-only):

```powershell
npm run testnet:plan -- `
  --env-file <local-env-file> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness `
  --id saga_testnet_usdc_approve_plan `
  --token USDC --amount 0.01
```

Actual result:

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

Blocked reasons:
  - No verified swap or deposit contract is configured, so there is no justified
    approval spender. Refusing to approve an arbitrary address.
```

Because the plan is not executable, there is no transaction to approve. The
`testnet:run` command was **not** invoked. No key was read by readiness/planning.

A post-funding re-check for **1 USDC** produced the same blocked plan hash
(`6d2be1d...`), still with `Transactions (0)`. The balance is no longer a blocker;
the missing verified spender/protocol is.

## 9.5 Gas and transaction evidence

| Metric | Result |
| --- | --- |
| Transactions signed by this project | **0** |
| Transactions broadcast by this project | **0** |
| Project transaction hashes | **none** |
| Gas spent by this project | **0** |
| Project explorer links | **none** |
| External funding transaction | `0x9e4834...76370b`, success, fee `0.00018637775 PHRS` |

*Iteration-2 record: the "by this project" counts above were accurate then and
are superseded by the later executed test-only workflow - see
[section 14](#iteration-7--atlantic-saga-execution).*

A separate read-only `eth_estimateGas` for a hypothetical 0.01 USDC
`approve(Permit2, amount)` returned 71,377 gas at 10 gwei (0.00071377 PHRS at
gas price; 0.00142754 PHRS at the adapter's 2x ceiling). This was **not** a
proposed or executed transaction and Permit2 is not used as a protocol spender.

## 9.6 Classification

| Artifact | Classification |
| --- | --- |
| `testnet:readiness` output | **LIVE READ-ONLY** chain data; no transaction |
| `testnet:plan` output | **LIVE READ-ONLY** plan; executable=false, zero transactions |
| `0x9e4834...76370b` | **EXTERNAL LIVE TESTNET TRANSFER** (20 USDC funding); not sent by this project |
| `test/testnet.test.ts` | **MOCKED** chain client, offline |
| `npm run demo:*` | **SIMULATED** adapter, offline |
| Project-originated transaction hash | **none** *(iteration 2; superseded - see [section 14](#iteration-7--atlantic-saga-execution))* |

No mocked or simulated result is presented as live testnet evidence.

## 10. Iteration 3 (Task 5 continuation): local test-only validation and deployment plan

Iteration 3 adds a real execution path on a **disposable local chain** and
prepares (does not execute) an Atlantic deployment plan. No Atlantic or mainnet
transaction was sent by this iteration either.

> **Update (2026-10-18):** this section is the iteration-3 record. The plan was
> prepared only at this point and was later explicitly approved and executed -
> see [section 14](#iteration-7--atlantic-saga-execution); the "not deployed"
> rows in 10.6 are superseded.

### 10.1 Foundry environment

Foundry already existed inside WSL Ubuntu; it was not on the Windows side.

```text
/home/wyka/.foundry/bin/forge --version -> forge 1.2.3-stable (a813a2cee7dd4926e7c56fd8a785b54f32e0d10f 2025-06-08)
/home/wyka/.foundry/bin/anvil --version -> anvil 1.2.3-stable (same commit)
```

No PATH or shell startup file was modified. Commands were invoked with absolute
paths through `wsl.exe -d Ubuntu -- ...`.

### 10.2 Foundry tests

```powershell
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge test -vv'
```

Result: **8 tests passed, 0 failed** across 2 suites
(`TestOnlySagaTest` = 7, `DeploymentGasTest` = 1).

> Superseded by [section 11](#iteration-4--contract-hardening-f-1--gated-deployment-tooling):
> after the F-1 hardening the suite is **16 tests** and every gas number below
> changed.

Measured deployment gas (also written to `snapshots/DeploymentGasTest.json`):

| Contract | Deploy gas (local EVM) |
| --- | ---: |
| `TestOnlyUSDC` | 497,738 |
| `TestOnlyReceiptToken` | 568,661 |
| `TestOnlySwap` | 484,536 |
| `TestOnlyVault` | 421,507 |
| **Total** | **1,972,442** |

### 10.3 Local Anvil end-to-end session

```powershell
npm run demo:local
```

The script starts Anvil in WSL on chainId **31337**, deploys the four
`TestOnly*` contracts from `out/`, and drives the real `SagaExecutor` through
four scenarios using the `local-anvil` adapter:

| Scenario | Result | Key assertions |
| --- | --- | --- |
| APPROVE -> SWAP -> DEPOSIT success | PASS | 3 real local txs; exact 1 tUSDC spent; receipt tokens 0; vault shares 0.99; swap allowance consumed |
| forced SWAP revert | PASS | permanent failure, `attempts = 1`, `REVOKE_APPROVAL` compensation succeeded, allowance 0 |
| forced DEPOSIT revert | PASS | `SIMULATED_UNWIND_SWAP` compensation succeeded, receipt tokens burned, net cost 19,900 raw |
| unknown SWAP outcome | PASS | reconciled by idempotency key, `sendCount = 3` (no resubmission), journal `CONFIRMED` |

Local transactions are real (receipts have `simulated: false`,
`network: "local-anvil"`, real tx hashes, `explorerUrl: null`) but exist only on
the throwaway chain and are reset on every run. Full details:
[`local-anvil.md`](local-anvil.md).

### 10.4 Atlantic deployment plan (READ-ONLY, nothing sent)

```powershell
npm run testnet:deploy-plan -- --env-file C:\temp-secrets\.env --address 0xE2B8651178ade144003537eA509E37877dba40bb
```

Observed at plan time: chainId 688689, block 31544865, pending nonce 13,
gas price 10 gwei, PHRS balance 0.542613955838483504, USDC 20.0.

- Total gas cap: **2,800,000** across 4 deployments
- Maximum planned spend at 10 gwei: **0.028 PHRS** (operator ceiling 0.05 PHRS)
- Stable plan hash: `cf458108d271c3a3f9cc9b7daa96de37bf499405cf2b8e39d5ef975bc540d691`
- Predicted CREATE addresses are explicitly marked as predictions; no address is
  claimed as deployed.

> Superseded by [section 11.4](#114-atlantic-deployment-plan-regenerated-read-only-nothing-sent):
> the contracts changed (F-1 hardening + minter-wiring transaction), so this v1
> hash is void and must never be approved.

The plan script has no send/sign/broadcast path and never references the signing
key; `npm run verify` fails if that changes. Full plan:
[`testnet-deployment-plan.md`](testnet-deployment-plan.md).

### 10.5 Final verification (iteration 3)

```text
> npm run verify
build: tsc -p tsconfig.json (exit 0)
tests: 87 tests, 87 pass, 0 fail, 0 skipped (~33.9 s)
safety gate: SAFETY GATE PASSED - simulation stays offline; testnet path is gated and mainnet-free.
exit code 0
```

The original 61 simulation tests remain green; 19 testnet tests, 6 local-anvil
offline tests and 1 additional isolation test bring the total to 87.
`scripts/check-safety.mjs` additionally enforces local-anvil isolation from
Atlantic/mainnet and the read-only property of the deployment plan script.

### 10.6 Classification (iteration 3)

> **Update (2026-10-18):** this table is the iteration-3 record. Its last two
> rows are superseded: the test-only contracts were deployed on 2026-10-17 -
> see [section 14](#iteration-7--atlantic-saga-execution).

| Artifact | Classification |
| --- | --- |
| `npm run demo:local` transactions | **REAL transactions on a disposable local chain (chainId 31337)**; not testnet evidence |
| Foundry tests + gas snapshot | **LOCAL EVM**, offline |
| `npm run testnet:deploy-plan` output | **LIVE READ-ONLY** Atlantic chain data; no transaction |
| `TestOnly*` on Atlantic | **not deployed** (nonexistent until an approved separate task) *(superseded - deployed 2026-10-17; see [section 14](#iteration-7--atlantic-saga-execution))* |
| Atlantic/mainnet transactions by this project | **still 0** *(iteration 3; the approved test-only Atlantic deployment and saga ran later - see [section 14](#iteration-7--atlantic-saga-execution); mainnet remains 0)* |

Local success is never presented as Atlantic evidence, and predicted addresses
are never presented as deployed addresses.

---

# Iteration 4 — contract hardening (F-1) + gated deployment tooling

Date: **2026-10-18**
Status: **nothing signed or broadcast.** The Atlantic deployment remains
unauthorized; the plan below is prepared for explicit approval only.

> **Update (2026-10-18):** this section is the iteration-4 record. The status
> line above was accurate for that iteration only: the plan was later
> explicitly approved and executed, and the approved saga followed - see
> [section 14](#iteration-7--atlantic-saga-execution) and the note at 11.6.

## 11.1 Contract hardening (F-1)

The `TestOnly*` mocks now store the deployer as an immutable `controller`:
mint, burn, `setMinter` and every fault hook are restricted to it, the swap
constructor makes no external call, and the receipt token's minter is wired by
an explicit fifth transaction. Unauthorized callers and sabotage attempts are
covered by 8 dedicated Foundry tests and by live checks in the local demos
(second account; both attempts revert on-chain).

## 11.2 Foundry verification (final run)

```text
forge build --force -> Compiler run successful (26 files, Solc 0.8.24)

Ran 3 test suites: 16 tests passed, 0 failed, 0 skipped (16 total tests)
  TestOnlyAuth.t.sol      8/8  (unauthorized callers, sabotage, wiring, zero-controller)
  TestOnlySaga.t.sol      7/7
  DeploymentGas.t.sol     1/1
```

Measured execution gas (final):

| Step | Gas |
| --- | ---: |
| `TestOnlyUSDC` deploy | 557,441 |
| `TestOnlyReceiptToken` deploy | 611,864 |
| `TestOnlySwap` deploy | 518,281 |
| `TestOnlyVault` deploy | 478,683 |
| `WireMinter` call | 23,592 |
| **Total** | **2,189,861** |

## 11.3 Gated deployment tooling

New artifacts: shared plan core (`src/testnet/deployPlan.ts`), verification
helpers (`src/testnet/deploy/verify.ts`), durable INTENT journal
(`src/testnet/deploy/journal.ts`), the gated runner
(`src/testnet/deploy/runner.ts`, the only send path), the CLI
(`scripts/testnet-deploy.ts`) and a six-scenario Anvil safety check
(`scripts/local-deploy-check.ts`). The formula: force-rebuild -> plan-hash
gate -> confirmation flag -> chain guard -> nonce/gas/balance re-read + 0.05
PHRS ceiling -> lazy key load -> INTENT journal -> exactly one send -> receipt
+ deployed bytecode + immutable getter + address verification; ambiguous
outcomes are never resent and any mismatch stops the run.

Recorded final result of `npm run demo:deploy-tooling` (**6/6 scenarios
PASS**):

| Scenario | Result |
| --- | --- |
| A happy path | COMPLETE; 4 deploys + wiring all CONFIRMED; 5/5 journal entries; predicted = actual addresses; unauthorized `setMinter`/`mint` from a second account revert on-chain |
| B wrong chain (5) | refused before any send; no journal file created |
| C forced revert | REVERTED entry for the receipt token; exactly 2 sends; no further steps |
| D ambiguous outcome | UNKNOWN entry; exactly 1 broadcast; after mining the block holds exactly 1 tx; never resubmitted |
| E1 runtime-bytecode mismatch | `deployed bytecode differs from the approved artifact outside immutable slots`; stopped before the wiring tx |
| E2 tampered immutable slot | getter check catches `controller mismatch` (masked comparison ignores slots by design) |

## 11.4 Atlantic deployment plan (regenerated, READ-ONLY, nothing sent)

Observed at plan time: chainId 688689, block 31546237, pending nonce 13, gas
price 10 gwei, PHRS balance 0.542613955838483504, USDC 20.0.

- Total gas cap: **3,400,000** across 5 transactions (4 deploys + wiring)
- Maximum planned spend at 10 gwei: **0.034 PHRS** (operator ceiling 0.05 PHRS;
  implies a maximum executable gas price of ~14.7 gwei)
- Stable plan hash (v2 — supersedes the iteration-3 v1 hash, which must never
  be approved): `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`
- Per-step init-code hashes, constructor args and caps:
  [`testnet-deployment-plan.md`](testnet-deployment-plan.md).
- Predicted CREATE addresses remain predictions; no address is claimed as
  deployed.

## 11.5 Final verification (iteration 4)

```text
> npm run verify
build: tsc -p tsconfig.json (exit 0)
tests: 95 tests, 95 pass, 0 fail, 0 skipped (~33.7 s)
safety gate: SAFETY GATE PASSED - simulation stays offline; testnet path is gated and mainnet-free.
exit code 0
```

Test distribution: 10 state machine + 4 success + 7 retry + 13 failure +
9 persistence + 7 audit + 4 CLI + 9 safety + 17 testnet + 6 local-anvil +
8 deploy-tooling = **95**. The 61 original simulation tests remain green.

Additional recorded runs (final):

- `forge build --force`: compiler run successful, 26 files, Solc 0.8.24.
- `forge test -vv`: 16/16 pass (see 11.2).
- `npm run demo:local`: 4/4 scenarios PASS with the hardened contracts and the
  explicit minter-wiring transaction.
- `npm run demo:deploy-tooling`: 6/6 scenarios PASS (see 11.3).

## 11.6 Classification (iteration 4)

> **Update (2026-10-18):** this table is the iteration-4 record. Its last two
> rows and the paragraph below it are superseded: the plan was explicitly
> approved and executed on 2026-10-17 and the approved saga followed - see
> [section 14](#iteration-7--atlantic-saga-execution).

| Artifact | Classification |
| --- | --- |
| `demo:deploy-tooling` transactions | **REAL transactions on disposable local chains (chainId 31337 / test chainId 5)**; not testnet evidence |
| Foundry tests + gas numbers | **LOCAL EVM**, offline |
| `npm run testnet:deploy-plan` output | **LIVE READ-ONLY** Atlantic chain data; no transaction |
| `TestOnly*` on Atlantic | **not deployed** (nonexistent until an approved separate task) *(superseded - deployed 2026-10-17; see [section 14](#iteration-7--atlantic-saga-execution))* |
| Atlantic/mainnet transactions by this project | **still 0** *(iteration 4; the approved test-only Atlantic deployment and saga ran later - see [section 14](#iteration-7--atlantic-saga-execution); mainnet remains 0)* |

The gated runner has never been executed against Atlantic; only its local mode
(`--mode local-anvil`) has run. The Atlantic mode requires the new plan hash
to be explicitly approved first, and no such approval has been given.

*The paragraph above is the iteration-4 record; the Atlantic mode of the gated
runner **was** later approved and executed (2026-10-17) - see
[section 14](#iteration-7--atlantic-saga-execution).*

# Iteration 5 — gated `TestOnly*` saga tooling (saga runner)

The five-step saga tooling was added on top of the deployment tooling. The
four `TestOnly*` contracts are live on Atlantic and were re-verified read-only
in this iteration: deployed runtime code at all four addresses matches the
fresh artifacts (immutables masked), the artifact hashes match the deployment
journal, and the wiring getters pass (`quote(1000000) == 990000`,
`feeBps == 100`, minter set, pairwise-distinct contracts, `tUSDC !=` official
USDC). No transaction was signed or broadcast by this iteration.

## 12.1 Files

| File | Role |
| --- | --- |
| `src/testnet/sagaPlan.ts` | read-only plan core: 5 steps, calldata, gas caps (total 840000), plan hash, deploy-journal address resolution |
| `src/testnet/saga/verify.ts` | shared read-only checks: runtime code, wiring, per-step pre/postconditions, end-of-saga battery |
| `src/testnet/saga/journal.ts` | durable saga journal (INTENT written before any send) |
| `src/testnet/saga/runner.ts` | the only send path: gates + one send per step + receipt/calldata-hash/postcondition verification |
| `scripts/testnet-saga.ts` | gated CLI (`--mode atlantic` / `--mode local-anvil`) |
| `scripts/testnet-saga-plan.ts` | read-only plan printer with bounded retry on transient RPC throttling |
| `scripts/local-saga-check.ts` | eight-scenario Anvil safety check |
| `test/saga-tooling.test.ts` | golden hash + calldata tests, hash binding, resolver, journal |

## 12.2 Golden verification

The module reproduces the reviewed plan byte-for-byte:

```text
plan hash fresh:   8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f
plan hash reviewed:8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f
CORE BYTE-IDENTITY: PASS
calldata MintTusdc / ApproveTusdcToSwap / SwapTusdcForReceipt /
ApproveReceiptToVault / DepositReceiptToVault: PASS (5/5)
```

`test/saga-tooling.test.ts` pins this hash, all five calldata strings, the
invariants (order, targets, amounts, caps, ceiling) and the hash-binding
properties. It also proves the deployment-journal resolver refuses any
unresolved deployment entry.

## 12.3 Live read-only plan (Atlantic, nothing sent)

`npm run testnet:saga-plan -- --env-file <path> --address <deployer>
--expect-plan 8faa2e69…720f`:

- chainId 688689, live block, pending nonce and gas price re-read;
- pre-state: all tUSDC/tSAGA balances and allowances 0, no shares, swap empty,
  official USDC balance 20.000000 (unchanged expectation);
- worst case: 840000 gas x 10 gwei = 0.0084 PHRS, under the 0.02 PHRS ceiling,
  covered by the 0.5179… PHRS balance;
- plan hash MATCH.

## 12.4 Verification runs

```text
forge build --force: 26 files, Solc 0.8.24, compiler run successful
forge test -vv: 16/16 pass (7 saga + 8 auth + 1 deployment-gas)
npm test: 102 tests, 102 pass, 0 fail, 0 skipped (~23.2 s)
npm run verify: build + tests + safety gate PASS (exit 0)
```

Test distribution: 95 previous + 7 saga-tooling = **102**. The safety gate now
also covers the saga plan script (no send path), the saga runner (INTENT,
ceiling, confirmation flag, runtime code, calldata hash, official-USDC guard,
never-resend) and the saga CLI (confirmation flag, approve hash, lazy key).

## 12.5 Local tooling check (`npm run demo:saga-tooling`)

Eight scenarios, **81/81 checks PASS** on disposable Anvil chains
(chainId 31337/5, loopback only, no keys):

| Scenario | Result |
| --- | --- |
| A happy path (mint required) | 5 real local txs, all CONFIRMED, journal nonces consecutive, every on-chain input hash matches the journal, full end-state battery holds (shares 990000, supply 990000, swap 1000000 tUSDC) |
| A2 pre-funded (seed 1.000000) | mint skipped (4 txs, no MintTusdc entry, no nonce consumed); a re-run sends nothing and still reports COMPLETE |
| B wrong chain (chainId 5) | refused before any send, no journal created |
| C forced swap revert | third entry REVERTED, stops, allowance/balance untouched |
| D automine off + 2.5 s timeout | exactly one broadcast, UNKNOWN entry; after mining, the re-run refuses to resend and the journal is unchanged |
| E altered calldata on approve | receipt input hash mismatch caught, entry UNKNOWN, stops (flipped byte reached the chain: allowance 1000001) |
| F postcondition break on mint | drift caught (balance 1000001 vs expected 1000000), entry UNKNOWN, stops |
| G pre-existing 123456 tUSDC | refused before any send, no journal, balance untouched |

Also re-run and preserved: `demo:success`, `demo:failure`, `demo:manual`,
`demo:unknown` all PASS; `demo:local` 4/4 PASS; `demo:deploy-tooling`
6/6 PASS. Foundry tests unchanged and green.

## 12.6 Classification (iteration 5)

> **Update (2026-10-18):** this table is the iteration-5 record. Its last row
> ("The saga run itself") and the paragraph below the table are superseded: the
> plan hash was explicitly approved and the Atlantic saga executed - see
> [section 14](#iteration-7--atlantic-saga-execution).

| Artifact | Classification |
| --- | --- |
| `demo:saga-tooling` / deploy-tooling transactions | **REAL transactions on disposable local chains (chainId 31337/5)**; not testnet evidence |
| Foundry tests + gas numbers | **LOCAL EVM**, offline |
| `npm run testnet:saga-plan` output | **LIVE READ-ONLY** Atlantic chain data; no transaction |
| Atlantic transactions from this iteration | **0** (nothing signed or broadcast) |
| The saga run itself | **not executed**; requires explicit approval of the plan hash above (superseded - see [section 14](#iteration-7--atlantic-saga-execution)) |

The gated saga runner has never run against Atlantic; only its local mode has
run. The Atlantic mode refuses to send unless its freshly rebuilt plan hash
matches the explicitly approved hash.

# Iteration 6 — pre-execution review (mint policy clarification)

Date: **2026-10-18**. Status: **nothing signed or broadcast.** The Atlantic
saga run remains unauthorized pending explicit approval of the plan hash.

> **Update (2026-10-18):** this section is preserved as the iteration-6
> pre-execution review record. The status above is superseded: the plan hash was
> explicitly approved and the saga executed on Atlantic testnet - see
> [section 14](#iteration-7--atlantic-saga-execution).

## 13.1 Mint step: discrepancy resolved, plan hash unchanged

The mint step was described with different strictness in two places: the
byte-frozen plan core carries the descriptive string `skip if tUSDC
balanceOf(controller) >= 1000000; mint exactly 1.000000 tUSDC otherwise`,
while the runner enforces three exact branches. The review removed the
ambiguity by pinning the enforced policy explicitly (a runner comment plus a
"Mint step policy (exact)" section in `docs/testnet-saga-tooling.md`) without
touching the hashed core:

- balance exactly `0` -> sends `mint(deployer, 1000000)` (exactly 1.000000);
- balance exactly `1000000` -> step skipped (no transaction, no nonce
  consumed, no journal entry);
- any other balance -> run stops before any signing, broadcast or journal
  write.

The exact check is implemented in `src/testnet/saga/runner.ts`, outside the
hashed plan core; the core's `conditional` string is descriptive only and
never drives what is sent. The core was not modified, so the plan hash is
unchanged and still reproduces byte-for-byte:

```text
fresh hash:    8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f
reviewed hash: 8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f
PLAN HASH: PASS
CORE BYTE-IDENTITY: PASS
calldata MintTusdc / ApproveTusdcToSwap / SwapTusdcForReceipt /
ApproveReceiptToVault / DepositReceiptToVault: PASS (5/5)
```

Non-vacuous coverage of the three branches (real runner, disposable Anvil):
scenario A (zero balance -> five confirmed transactions, journaled nonces,
per-transaction input hashes, full end battery), A2 (exactly 1.000000 -> mint
skipped, 4 txs, no MintTusdc entry; a re-run sends nothing), G (123456 ->
stop before any send, no journal file created, balance untouched). A new unit
test additionally pins that no step target, spender, calldata or core byte
embeds the official USDC address; only the four TestOnly* contracts are ever
targeted.

## 13.2 Verification runs (all re-run in this iteration)

```text
forge build --force: 26 files, Solc 0.8.24, compiler run successful
forge test -vv: 16 tests passed, 0 failed, 0 skipped (3 suites)
npm run verify: build exit 0; 103 tests, 103 pass, 0 fail, 0 skipped (~23.0 s); SAFETY GATE PASSED
npm run demo:saga-tooling: 81/81 checks, 8 scenarios PASS
npm run demo:local: 4/4 PASS; npm run demo:deploy-tooling: 6/6 PASS
demo:success / demo:failure / demo:manual / demo:unknown: PASS
gated CLI: no args -> usage, exit 1; atlantic without --confirm-atlantic-testnet
-> refusal, exit 1 (no key read, no send)
```

## 13.3 Live read-only preflight (nothing sent)

`npm run testnet:saga-plan -- --env-file <path> --address <deployer>
--expect-plan 8faa2e69…720f`: block 31550491; chainId 688689; pending nonce 18;
gas price 10 gwei; PHRS balance 0.517903655838483504; all four contracts
re-verified (runtime code immutables-masked, artifact hashes vs the deployment
journal, full wiring); pre-state all zero; official USDC 20.000000 (unchanged
expectation); worst case 840000 gas x 10 gwei = 0.0084 PHRS under the 0.02
ceiling and covered by the balance; plan hash MATCH.

## 13.4 Classification (iteration 6)

| Artifact | Classification |
| --- | --- |
| local demos / Foundry results | **LOCAL EVM on disposable chains** (chainId 31337/5); not testnet evidence |
| `npm run testnet:saga-plan` output | **LIVE READ-ONLY** Atlantic chain data; no key, no transaction |
| Atlantic transactions from this iteration | **0** (nothing signed or broadcast) |
| The saga run itself | **not executed**; requires explicit approval of the plan hash above (superseded - see [section 14](#iteration-7--atlantic-saga-execution)) |

---

# Iteration 7 — Atlantic saga execution

Date: **2026-10-18**. Run window (journal timestamps, UTC): first `INTENT`
written `2026-10-17T21:29:30Z`, last step confirmed `2026-10-17T21:29:53Z` -
all five transactions completed within that window. Status: **executed and
confirmed on Atlantic testnet (chainId 688689)**. Nothing on mainnet, and no
transaction has been signed or broadcast since.

## 14.1 Authorization and pre-send gates

The saga ran only through the gated runner, after the operator explicitly
approved the reviewed plan hash. Every gate passed before the first signature:

```text
approved plan hash (--approve-plan): 8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f
fresh hash at run time (rebuilt):    8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f  -> MATCH
chainId:                             688689
deployer:                            0xE2B8651178ade144003537eA509E37877dba40bb
pending nonce before the run:        18
gas price:                           10000000000 wei (10 gwei)
PHRS balance before the run:         0.517903655838483504
journal:                             .local/atlantic-saga/saga-journal.json
```

- `forge build --force` (WSL) succeeded; the freshly rebuilt plan core
  serialized to exactly the approved hash, or the runner would have refused.
- The Atlantic confirmation flag was required; the chain guard refused any
  chain other than 688689.
- Worst-case cost (840000 gas x 10 gwei = 0.0084 PHRS) was under the 0.02 PHRS
  operator ceiling and covered by the balance.
- Mint policy, exact branch: the tUSDC deployer balance was exactly `0`, so the
  run sent `mint(deployer, 1000000)` - exactly 1.000000 tUSDC. The skip branch
  was not taken; any other balance would have stopped the run before signing.
- Deployed runtime code (immutables masked) and artifact hashes at all four
  deployment-journal addresses were re-verified; wiring getters (`quote`,
  `feeBps`, minter, controllers) were re-checked; the official USDC guard was
  loaded read-only (deployer baseline 20.000000, which must remain unchanged).
- The signing key was read from the env file only after every gate passed,
  immediately before the first send, and is never printed or journaled.

Only the five reviewed steps ran, and only against the four `TestOnly*`
contracts.

## 14.2 The five transactions

Targets (test-only mocks deployed for this exercise; the mock swap and mock
vault are **not production protocols**, and tUSDC is **not** official USDC):

| Contract | Address |
| --- | --- |
| `TestOnlyUSDC` (tUSDC, test-only mock token) | `0x623F3575241827eb5aAb5592834632Ed67BB114C` |
| `TestOnlyReceiptToken` (tSAGA, test-only mock token) | `0xCA7c0D2474f3868bbBa0902d33918b35Dad90b19` |
| `TestOnlySwap` (mock swap) | `0xcF74d803da1C57CeE6Bb727B9646fDb42126414D` |
| `TestOnlyVault` (mock vault) | `0xa16085FFC63F3BaB3D2c26b22Dc44B7421cEB64b` |

All five transactions (every receipt status is `success`; effective gas price
10 gwei for all five; the explorer links are constructed from the transaction
hashes - the run verified receipts by JSON-RPC, not via the explorer):

| # | Step | Nonce | Transaction hash (explorer link) | Block | Gas used | Receipt | Journal |
| ---: | --- | ---: | --- | ---: | ---: | --- | --- |
| 1 | `MintTusdc` | 18 | [`0x04ef1fdc19cd67516543d3d20a90308bbc530d512ebd6b2635dabcb1e3b31826`](https://atlantic.pharosscan.xyz/tx/0x04ef1fdc19cd67516543d3d20a90308bbc530d512ebd6b2635dabcb1e3b31826) | 31550624 | 68339 | success | `CONFIRMED` |
| 2 | `ApproveTusdcToSwap` | 19 | [`0x9f80a560a12f53828a2496afd465d753f2640f1eec879b4001111a3f29fcc633`](https://atlantic.pharosscan.xyz/tx/0x9f80a560a12f53828a2496afd465d753f2640f1eec879b4001111a3f29fcc633) | 31550628 | 46116 | success | `CONFIRMED` |
| 3 | `SwapTusdcForReceipt` | 20 | [`0x2421f98dbc7b09d91bedf5eb8e469c529bf044d1f7f6713667f5a2d3234615e2`](https://atlantic.pharosscan.xyz/tx/0x2421f98dbc7b09d91bedf5eb8e469c529bf044d1f7f6713667f5a2d3234615e2) | 31550635 | 106280 | success | `CONFIRMED` |
| 4 | `ApproveReceiptToVault` | 21 | [`0xdbff90bab93168e804e6c9bbf519be3a200fec94fd51ebc5fb1178baaba89fd5`](https://atlantic.pharosscan.xyz/tx/0xdbff90bab93168e804e6c9bbf519be3a200fec94fd51ebc5fb1178baaba89fd5) | 31550642 | 46139 | success | `CONFIRMED` |
| 5 | `DepositReceiptToVault` | 22 | [`0x9d775fbc18be69719ae73818c8c2eefc29ddb2092ecae8f480eda9fd31803693`](https://atlantic.pharosscan.xyz/tx/0x9d775fbc18be69719ae73818c8c2eefc29ddb2092ecae8f480eda9fd31803693) | 31550646 | 98749 | success | `CONFIRMED` |

`INTENT` was fsync-written before every send; exactly one send per step; no
resends were needed; no `UNKNOWN` or `REVERTED` entry exists. Every mined
transaction input re-hashed to its journaled calldata sha256 before acceptance:

```text
MintTusdc              0e5b386ed6337f155c40d68bfbcbac2faa4bf712c10231e1f7bbd31230c16096
ApproveTusdcToSwap     567eaea931464b499d5a54a868823970706c47b45b5bc0eac9f219be52ca3269
SwapTusdcForReceipt    66a57394f3b1916d4a8a7e5761731e127d951e2fbf66868c89a88d38e79655bd
ApproveReceiptToVault  c8feceb07d1e6f90cd0c1fcffdd50c3c230fc37e1552d0dc3c0cb99767f5e922
DepositReceiptToVault  52de68233080c98a23523a4a7f389046d9aa868c3386ba238092a31ffb8a1999
```

An independent read-only post-run check re-fetched all five transactions and
receipts from chain and re-read every final postcondition: all matched
(status `success`, sender = deployer, target = the expected contract, input
hash match, full end-state battery below).

## 14.3 Final verified state

Re-read from chain after the run (read-only):

| Check | Expected | Observed |
| --- | --- | ---: |
| `tUSDC.balanceOf(deployer)` | `0` | `0` |
| `tUSDC.allowance(deployer, TestOnlySwap)` | `0` | `0` |
| `tSAGA.balanceOf(deployer)` | `0` | `0` |
| `tSAGA.allowance(deployer, TestOnlyVault)` | `0` | `0` |
| `vault.sharesOf(deployer)` (vault shares) | `990000` | `990000` |
| `vault.totalShares()` | `990000` | `990000` |
| `tSAGA.balanceOf(vault)` (tSAGA held by the vault) | `990000` | `990000` |
| `tSAGA.totalSupply()` | `990000` | `990000` |
| `tUSDC.balanceOf(TestOnlySwap)` (tUSDC held by the swap) | `1000000` | `1000000` |
| official USDC `balanceOf(deployer)` | `20000000` raw = 20.000000 USDC (unchanged) | `20000000` raw |

- Pending nonce after the run: **23** (18 + 5). Exactly five transactions were
  sent; nothing else.
- Official USDC is the canonical testnet token
  `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B`; it was loaded read-only as a
  guard, appears in no calldata, and its deployer balance is unchanged at
  **20 USDC**. tUSDC and tSAGA are test-only mock tokens, not official USDC,
  and only the four `TestOnly*` contracts were ever targeted.

## 14.4 Gas and cost

| Metric | Value |
| --- | --- |
| Total gas used (5 transactions) | **365623** (plan cap 840000) |
| Effective gas price | 10 gwei (10000000000 wei) |
| Total spent | **0.00365623 PHRS** (3656230000000000 wei; operator ceiling 0.02 PHRS) |
| PHRS balance before the run | 0.517903655838483504 |
| PHRS balance after the run | **0.514247425838483504** |
| Pending nonce | 18 -> 23 |

## 14.5 Classification (iteration 7)

| Artifact | Classification |
| --- | --- |
| The five transactions above | **LIVE ATLANTIC TESTNET transactions (chainId 688689)** signed by the project deployer against **test-only mock contracts**; not mainnet; not production protocols |
| `TestOnlySwap` / `TestOnlyVault` | **test-only mocks** - a mock swap and a mock vault, not a DEX and not a yield protocol |
| tUSDC (`0x623F...114C`) / tSAGA (`0xCA7c...0b19`) | **test-only mock tokens**; distinct from official USDC |
| Official USDC (`0xcfC8...Fc8B`) | **unchanged at 20 USDC**; read-only guard; never targeted |
| `.local/atlantic-saga/saga-journal.json` | durable run record; public transaction metadata only (no keys) |
| Mainnet transactions | **none** |
| Local demos + Foundry results (sections 10-13) | LOCAL EVM on disposable chains; unchanged history |

## 14.6 Verification runs (after this documentation change)

No contract, plan or source file was modified for this record. The following
were re-run after the documentation update (no Atlantic transaction was signed
or broadcast by any of them):

```text
npm run verify: build exit 0; 103 tests, 103 pass, 0 fail, 0 skipped (~18.5 s); SAFETY GATE PASSED
forge test -vv: 16 tests passed, 0 failed, 0 skipped (3 suites)
npm run demo:saga-tooling: 81/81 checks, 8 scenarios PASS
```

`demo:saga-tooling` re-drove the same runner against disposable local Anvil
chains only (chainId 31337/5, loopback): scenario A repeated the full happy
path locally (5 confirmed local transactions, identical end-state battery),
A2 re-proved the skip and never-resend semantics, and B/C/D/E/F/G re-proved
every refusal and stop path.
