# Verified output

Verification date: **2026-10-17**
Project: `C:\pharos-saga-executor`
Platform: Windows 11, PowerShell 7, Node **v24.14.1**, npm **11.11.0**
Adapter: **simulated only** (no wallet, no RPC, no network, no real funds)

> ## Classification
>
> Everything in this file is a **deterministic simulation**. No transaction hash,
> block number or explorer link exists. The demos are demonstrations of the state
> machine, not live blockchain evidence. No real transaction was sent or confirmed.

## 1. Command summary

| Command | Exit | Recorded result |
| --- | ---: | --- |
| `npm install --no-fund --no-audit` | 0 | added 6 packages (TypeScript, tsx, @types/node and transitive dev tooling) |
| `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit`, no diagnostics |
| `npm test` | 0 | **61 tests, 61 pass, 0 fail**; 0 suites; 0 skipped; ~5.4 s |
| `npm run demo:success` | 0 | `PASS`; final state `COMPLETED`; all three simulated receipts verified |
| `npm run demo:failure` | 0 | `PASS`; transient retries at 75 ms and 150 ms, permanent DEPOSIT failure, simulated unwind succeeded, final state `FAILED` |
| `npm run demo:manual` | 0 | `PASS`; compensation failed, final state `MANUAL_RECOVERY_REQUIRED` |
| `npm run demo:unknown` | 0 | `PASS`; unknown SWAP outcome, no retry, final state `MANUAL_RECOVERY_REQUIRED` |
| `npm run verify` | 0 | build + 61 tests + static safety gate, all passed; 38 build files emitted |
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
ℹ duration_ms 5298.5622

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
