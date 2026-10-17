# Pharos Saga Executor

A deterministic, resumable **APPROVE -> SWAP -> DEPOSIT** saga executor, packaged
as an installable agent skill for the Pharos Agent Arena task
[**Saga Executor**](https://pharos-agent-arena.vercel.app/tasks/saga-executor)
(Hard / SkillEngine / 200 points).

> ## Simulation notice
>
> **This first iteration uses a simulated adapter only.** No wallet was used, no
> private key exists in this repository, no RPC endpoint is contacted, and **no
> on-chain transaction was sent or confirmed**. Every receipt is branded
> `simulated: true`, `network: "simulated"` and uses a `sim_*` reference. There is
> no transaction hash or explorer link to verify, and none is claimed.
>
> The simulated compensation is also clearly labelled: it is a new simulated
> call, **not a blockchain rollback**.

- Node.js 20+ (verified on Node 24.14.1)
- Zero runtime dependencies, zero network calls
- State machine, retry policy, compensation, persistence, CLI and tests
- 61 automated tests, all offline

---

## Contents

- [Why this design](#why-this-design)
- [Rubric coverage](#rubric-coverage)
- [Quick start](#quick-start)
- [Example 1: successful saga](#example-1-successful-saga)
- [Example 2: forced failure + compensation](#example-2-forced-failure--compensation)
- [Example 3: inspect/list persisted sagas](#example-3-inspectlist-persisted-sagas)
- [State machine](#state-machine)
- [Retry and recovery rules](#retry-and-recovery-rules)
- [CLI](#cli)
- [Persistence](#persistence)
- [Skill packaging and environment](#skill-packaging-and-environment)
- [Tests and verification](#tests-and-verification)
- [Safety](#safety)
- [Limitations](#limitations)
- [License](#license)

---

## Why this design

A blockchain transaction cannot be globally rolled back after confirmation. This
project therefore implements **honest compensation**, never a fake rollback:

- if `APPROVE` fails, nothing downstream starts;
- if `SWAP` fails, the selected adapter may revoke the simulated approval;
- if `DEPOSIT` fails after a successful swap, the adapter may perform a new
  simulated unwind trade;
- if no safe action exists, the saga stops in `MANUAL_RECOVERY_REQUIRED` with all
  evidence intact;
- a submission with an unknown outcome is **never retried blindly** — it is
  reconciled by idempotency key, then escalated if it cannot be proven.

## Rubric coverage

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| 3 dependent steps, each verified before the next | `src/domain/states.ts`, `src/executor/executor.ts` | `test/state-machine.test.ts`, `test/executor-success.test.ts` |
| Retry policy for transient failures | `src/domain/retry.ts`, `RETRY_WAIT` state | `test/retry.test.ts` |
| Compensation path and demo | `failStep` / `runCompensation`, `npm run demo:failure` | Example 2, `test/failure.test.ts` |
| State log at any time | persisted `state` + full `audit` array and NDJSON mirror | `inspect`, `audit`, `test/audit.test.ts` |
| Successful run and forced-failure run | `npm run demo:success`, `npm run demo:failure` | Examples 1 and 2 |
| Required states and illegal transition rejection | `ALLOWED_TRANSITIONS`, `assertTransition` | `test/state-machine.test.ts` |
| Persist and resume interrupted runs | atomic `SagaStore`, per-saga lock, reconciliation | `test/persistence.test.ts` |
| Stable saga/step ids | `<sagaId>`, `<sagaId>:<STEP>`, `<sagaId>:<STEP>:v1` keys | `test/state-machine.test.ts` |
| Duplicate execution prevention | `clientRequestId`, keyed queue, file lock, ledger | `test/persistence.test.ts` |
| Timestamped audit log | `AuditEvent` with contiguous `seq` | `test/audit.test.ts` |
| Transient vs permanent errors | `classifyError`, `FailureKind` | `test/retry.test.ts`, `test/failure.test.ts` |
| Bounded retries + exponential backoff + jitter | `RetryPolicy.schedule` (max 20 attempts) | `test/retry.test.ts` |
| Configurable max retries | `--max-attempts`, persisted `config.retry` | `test/retry.test.ts` |
| No infinite loops | attempt budget + drive-loop guard | `RetryPolicy`, `maxLoopIterations` |
| Compensation success/failure recorded separately | `compensation.status`, `compensation.error` | `test/failure.test.ts`, `test/audit.test.ts` |
| Manual recovery when no safe compensation | `NONE`, `UNAVAILABLE`, compensation failure | `test/failure.test.ts`, `npm run demo:manual` |
| Unknown submission outcome | `UnknownSubmissionOutcomeError` + reconcile-once | `test/failure.test.ts`, `test/persistence.test.ts`, `npm run demo:unknown` |
| Never claim simulated = live | receipt verifier, CLI text, safety tests | `test/safety.test.ts`, `scripts/check-safety.mjs` |
| Deterministic clock and jitter in tests | `VirtualClock`, injectable `JitterSource` | `test/helpers.ts` |

## Quick start

```powershell
npm install
npm test
npm run demo:success
npm run demo:failure
npm run verify
```

Additional demos:

```powershell
npm run demo:manual    # compensation itself fails -> MANUAL_RECOVERY_REQUIRED
npm run demo:unknown   # unknown submission outcome -> no retry -> manual recovery
```

No wallet, API key, RPC endpoint or `.env` file is required.

## Example 1: successful saga

Command:

```powershell
npm run demo:success
```

Actual output (the complete 17-event audit is reproduced in
[`docs/verified-output.md`](docs/verified-output.md); the middle is elided here
only for readability):

```text
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
#0001 ... SAGA_CREATED | Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled. | ...
#0002 ... SAGA_RUN_STARTED | Executor attached in state CREATED. Persisting before any step. | ...
#0003 ... TRANSITION CREATED -> APPROVAL_PENDING | Saga accepted. APPROVE is the only step that may start. | ...
#0004 ... STEP_ATTEMPT [saga_demo_success:APPROVE] | Starting simulated APPROVE attempt 1/3. No on-chain transaction is possible with this adapter. | ...
#0005 ... RECEIPT_VERIFIED [saga_demo_success:APPROVE] | APPROVE simulated receipt verified; dependency requirement satisfied. | ...
#0006 ... STEP_SUCCEEDED [saga_demo_success:APPROVE] | APPROVE succeeded in the simulated adapter. | ...
#0007 ... TRANSITION APPROVAL_PENDING -> APPROVED | APPROVE verified. | ...
#0008 ... TRANSITION APPROVED -> SWAP_PENDING | APPROVE receipt verified. SWAP may now start. | ...
#0009 ... STEP_ATTEMPT [saga_demo_success:SWAP] | Starting simulated SWAP attempt 1/3. ... | ...
#0010 ... RECEIPT_VERIFIED [saga_demo_success:SWAP] | SWAP simulated receipt verified; ... | ...
#0011 ... STEP_SUCCEEDED [saga_demo_success:SWAP] | SWAP succeeded in the simulated adapter. | ...
#0012 ... TRANSITION SWAP_PENDING -> SWAPPED | SWAP verified. | ...
#0013 ... TRANSITION SWAPPED -> DEPOSIT_PENDING | SWAP receipt verified. DEPOSIT may now start. | ...
#0014 ... STEP_ATTEMPT [saga_demo_success:DEPOSIT] | Starting simulated DEPOSIT attempt 1/3. ... | ...
#0015 ... RECEIPT_VERIFIED [saga_demo_success:DEPOSIT] | DEPOSIT simulated receipt verified; dependency requirement satisfied. | ...
#0016 ... STEP_SUCCEEDED [saga_demo_success:DEPOSIT] | DEPOSIT succeeded in the simulated adapter. | ...
#0017 ... TRANSITION DEPOSIT_PENDING -> COMPLETED | DEPOSIT verified. | ...
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: COMPLETED
STEPS: approve=SUCCEEDED/1 swap=SUCCEEDED/1 deposit=SUCCEEDED/1
COMPENSATION: none -> not reached
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - APPROVE -> SWAP -> DEPOSIT completed in order with verified simulated receipts.
```

The swap output (`99.5 USDC`) is the exact input consumed by `DEPOSIT`; the
approval allowance (`100`) covers the requested amount. These are checked by both
the executor and the test suite.

## Example 2: forced failure + compensation

Command:

```powershell
npm run demo:failure
```

The scenario is deterministic: `DEPOSIT` fails transiently on attempts 1 and 2,
then fails permanently on attempt 3. The configured `SIMULATED_UNWIND_SWAP` is
executed and succeeds. The saga is `FAILED`, **not** `COMPLETED`.

Actual output (verbatim key lines; the full 30-event audit is in
[`docs/verified-output.md`](docs/verified-output.md)):

```text
==============================================================================
PHAROS SAGA EXECUTOR - FORCED-FAILURE + COMPENSATION DEMONSTRATION
CLASSIFICATION: DEMONSTRATION / SIMULATED - deterministic injected failure, not live blockchain evidence
SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.
==============================================================================
[PERSISTED] saga_demo_failure state=CREATED stateDir=C:\pharos-saga-executor\.demo-state\failure
...
State:       FAILED
Scenario:    failure
Request:     100 PROS -> USDC -> deposit USDC
Comp policy: swap=REVOKE_APPROVAL deposit=SIMULATED_UNWIND_SWAP
...
  APPROVE  SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_f84cb91a12d341a1f29a26ec21db426925314a42 (SIMULATED)
  SWAP     SUCCEEDED    attempts=1 submission=VERIFIED receipt=sim_a863fb88913e530041945ae0934be5a347e43a12 (SIMULATED)
  DEPOSIT  FAILED       attempts=3 submission=NOT_SUBMITTED receipt=none last-retry=150ms@2026-01-01T00:00:00.225Z errors=3

FAILURE
  step=DEPOSIT kind=PERMANENT code=SIMULATED_PERMANENT_DEPOSIT attempts=3 retryExhausted=false
  message=Simulated permanent DEPOSIT failure (injected scenario "failure"). Nothing was submitted.
  at=2026-01-01T00:00:00.225Z

COMPENSATION / RECOVERY
  required=true action=SIMULATED_UNWIND_SWAP status=SUCCEEDED attempts=1
  note=Simulated unwind swap completed. The original failure remains on record.
  simulatedReceipt=sim_d448677f45bbb137b034a69384cebbb6afd846e1 (SIMULATED, not a rollback)

AUDIT LOG (30 events, ordered by seq)
#0015 ... WARN  STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT attempt 1 failed transiently: ...
#0016 ... WARN  RETRY_SCHEDULED [saga_demo_failure:DEPOSIT] | Bounded retry scheduled for DEPOSIT attempt 2/3 after 75ms (exponential base 100ms, jitter 0.500). | ...
#0017 ... INFO  TRANSITION DEPOSIT_PENDING -> RETRY_WAIT | DEPOSIT waiting for a bounded retry. | ...
#0018 ... INFO  TRANSITION RETRY_WAIT -> DEPOSIT_PENDING | DEPOSIT retry window elapsed. | ...
#0019 ... INFO  STEP_ATTEMPT [saga_demo_failure:DEPOSIT] | Starting simulated DEPOSIT attempt 2/3. ... | ...
#0020 ... WARN  STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT attempt 2 failed transiently: ...
#0021 ... WARN  RETRY_SCHEDULED [saga_demo_failure:DEPOSIT] | Bounded retry scheduled for DEPOSIT attempt 3/3 after 150ms (exponential base 200ms, jitter 0.500). | ...
#0022 ... INFO  TRANSITION DEPOSIT_PENDING -> RETRY_WAIT | DEPOSIT waiting for a bounded retry. | ...
#0023 ... INFO  TRANSITION RETRY_WAIT -> DEPOSIT_PENDING | DEPOSIT retry window elapsed. | ...
#0024 ... INFO  STEP_ATTEMPT [saga_demo_failure:DEPOSIT] | Starting simulated DEPOSIT attempt 3/3. ... | ...
#0025 ... ERROR STEP_FAILED [saga_demo_failure:DEPOSIT] | DEPOSIT failed permanently: ... | ...
#0026 ... INFO  TRANSITION DEPOSIT_PENDING -> COMPENSATING | DEPOSIT failed permanently. Starting configured compensation SIMULATED_UNWIND_SWAP. | ...
#0027 ... INFO  COMPENSATION_STARTED [saga_demo_failure:COMPENSATION:SIMULATED_UNWIND_SWAP] | Starting simulated compensation SIMULATED_UNWIND_SWAP for the original DEPOSIT failure. This is a new simulated call, not a blockchain rollback. | ...
#0028 ... INFO  COMPENSATION_SUCCEEDED [saga_demo_failure:COMPENSATION:SIMULATED_UNWIND_SWAP] | Simulated compensation SIMULATED_UNWIND_SWAP succeeded. The original DEPOSIT failure is still recorded; nothing was rolled back. | ...
#0029 ... ERROR SAGA_FAILED [saga_demo_failure:DEPOSIT] | Saga failed at DEPOSIT; compensation SIMULATED_UNWIND_SWAP succeeded. Outcome is FAILED, not COMPLETED. | ...
#0030 ... INFO  TRANSITION COMPENSATING -> FAILED | Compensation SIMULATED_UNWIND_SWAP succeeded; saga remains failed. | ...
==============================================================================
Reminder: simulated receipts are NOT live blockchain evidence.
==============================================================================

FINAL STATE: FAILED
STEPS: approve=SUCCEEDED/1 swap=SUCCEEDED/1 deposit=FAILED/3
COMPENSATION: SIMULATED_UNWIND_SWAP -> SUCCEEDED
FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.

DEMO RESULT: PASS - DEPOSIT failed transiently twice, retried with bounded jittered backoff, failed permanently on attempt 3, then executed the configured SIMULATED_UNWIND_SWAP. The saga is FAILED, not COMPLETED, and the original failure is preserved.
```

`retryExhausted=false` is intentional and precise here: the retry budget was not
exhausted by transient errors; the third attempt hit the **injected permanent**
error. Retry exhaustion by transient errors is covered separately by
`test/retry.test.ts` (`RETRY_EXHAUSTED`, `retryExhausted=true`).

For a compensation that itself fails, run `npm run demo:manual`; the saga ends in
`MANUAL_RECOVERY_REQUIRED`, with `failure` (SWAP) and `compensation.error`
(revoke failure) recorded separately.

## Example 3: inspect/list persisted sagas

Command (after Example 1 has created the state directory):

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

Inspect the same saga with its full state and audit log:

```powershell
npm run cli -- inspect saga_demo_success --state-dir .demo-state/success
npm run cli -- audit saga_demo_success --state-dir .demo-state/success
```

## State machine

```text
CREATED -> APPROVAL_PENDING -> APPROVED -> SWAP_PENDING -> SWAPPED -> DEPOSIT_PENDING -> COMPLETED

Any pending step --transient--> RETRY_WAIT --> same pending step
Any pending step --permanent--> compensation -> FAILED | MANUAL_RECOVERY_REQUIRED
Any pending step --unknown----> reconcile once -> advance | MANUAL_RECOVERY_REQUIRED
```

All eleven required states are defined: `CREATED`, `APPROVAL_PENDING`,
`APPROVED`, `SWAP_PENDING`, `SWAPPED`, `DEPOSIT_PENDING`, `COMPLETED`,
`RETRY_WAIT`, `COMPENSATING`, `FAILED`, `MANUAL_RECOVERY_REQUIRED`.

`COMPLETED`, `FAILED` and `MANUAL_RECOVERY_REQUIRED` have no outgoing edges.
Illegal transitions throw and are never persisted. Every valid transition is
persisted before the executor continues. See
[`docs/architecture.md`](docs/architecture.md) for the full table.

## Retry and recovery rules

| Situation | Behaviour |
| --- | --- |
| Transient failure | `RETRY_WAIT`; delay `min(max, base * factor^(n-1))` with equal jitter; bounded by `maxAttempts` |
| Retry budget exhausted | permanent-failure policy; `retryExhausted=true` |
| `APPROVE` permanent failure | `FAILED`; `SWAP`/`DEPOSIT` never start; no compensation needed |
| `SWAP` permanent failure | `REVOKE_APPROVAL` (if configured and supported) -> `FAILED`; otherwise/manual on failure |
| `DEPOSIT` permanent failure | `SIMULATED_UNWIND_SWAP` (if configured and supported) -> `FAILED`; otherwise/manual on failure |
| Compensation succeeds | `FAILED` with `compensation.status=SUCCEEDED`; original failure preserved |
| Compensation fails/unavailable | `MANUAL_RECOVERY_REQUIRED`; both errors preserved |
| Unknown submission outcome | reconcile by key; never resubmit; unresolved -> `MANUAL_RECOVERY_REQUIRED` |
| Invalid receipt | no advance, no retry, no compensation; `MANUAL_RECOVERY_REQUIRED` |

The default is `maxAttempts=3`, `baseDelayMs=100`, `maxDelayMs=1000`,
`backoffFactor=2`. With deterministic jitter `0.5` the first two delays are 75 ms
and 150 ms. All of this is configurable; `maxAttempts` is validated to 1–20.

## CLI

```powershell
npm run cli -- start [options]       # create (and by default run) a saga
npm run cli -- run <sagaId>          # resume/run a persisted saga
npm run cli -- inspect <sagaId>      # state, steps, failure, compensation, full audit
npm run cli -- list                  # all known sagas
npm run cli -- audit <sagaId>        # audit log only
```

Useful options:

```text
--id <id>  --client-request-id <id>  --scenario <name>  --no-run
--amount <decimal>  --from <token>  --to <token>  --deposit-token <token>
--max-attempts <1-20>  --base-delay-ms <n>  --max-delay-ms <n>  --backoff-factor <n>
--compensation-swap revoke|none  --compensation-deposit unwind|none
--state-dir <path>  --json
```

Exit codes: `0` completed, `3` failed, `4` manual recovery required, `5` busy,
`6` not found, `64` usage/configuration, `70` internal error.

Scenarios: `success`, `failure`, `approval-failure`, `manual-recovery`,
`compensation-unavailable`, `unknown-outcome`, `resolvable-unknown`,
`verification-failure`.

## Persistence

```text
<stateDir>/
  sagas/<sagaId>.json              authoritative snapshot
  sagas/<sagaId>.audit.ndjson      audit mirror
  locks/<sagaId>.lock              per-saga execution lock
  simulated-ledger.json            simulated idempotency ledger
```

Snapshots are written atomically (temp file + fsync + rename). The default state
directory is `./state`; demos use `.demo-state/`. Both are git-ignored. A saga can
be inspected while stopped (`--no-run`), resumed with `run`, and safely re-run:
terminal sagas are no-ops, and concurrent duplicate runs submit each step once.

## Skill packaging and environment

The Pharos environment exposes four hosted agent types and a Skill Engine page
whose only distribution path is an installable GitHub skill (YAML front matter +
`SKILL.md`). No custom-skill upload/registration endpoint is documented or
exposed by `ai.pharos.xyz`. The full evidence is in
[`docs/environment.md`](docs/environment.md).

Install this repository as a skill (OpenCode):

```powershell
npx skills add . -a opencode -y
```

After publication:

```powershell
npx skills add https://github.com/wyka0/pharos-saga-executor -a opencode -y
```

This project does not create a website, because the observed environment does
not require one.

## Tests and verification

```powershell
npm install
npm run typecheck
npm test
npm run verify
```

`npm test` covers:

- successful three-step execution;
- dependency enforcement;
- receipt verification;
- transient failure followed by successful retry;
- retry exhaustion;
- permanent failure in each step;
- compensation success, failure and unavailability;
- manual recovery;
- duplicate invocation and idempotency;
- persistence and resume (including two crash windows);
- illegal state transitions;
- audit ordering and completeness;
- unknown submission outcome handling;
- static safety checks.

The suite uses `VirtualClock`, fixed jitter and temporary state directories, so
it needs no wallet, live network, real funds or real-time retry waits. Exact test
counts and command output are recorded in
[`docs/verified-output.md`](docs/verified-output.md).

## Safety

- No wallet, private key, mnemonic, seed phrase, session token or `.env` is used.
- No RPC endpoint, HTTP request, signing library or chain SDK is imported by
  `src/` or `scripts/`.
- Simulated receipts cannot pass verification if they contain `simulated:false`,
  a `0x` transaction reference, `txHash`, `transactionHash`, `blockNumber`,
  `blockHash` or an explorer URL.
- The CLI and demos always print the simulation disclaimer; they never call a
  simulated result "confirmed on-chain".
- Generated state and dependencies are excluded by `.gitignore` and checked by
  `scripts/check-safety.mjs`.

## Limitations

- Simulated adapter only. No testnet/mainnet evidence is produced or implied.
- The simulated ledger is serialised within one process; concurrent writers from
  multiple processes are not supported.
- Compensation is attempted once and is not automatically retried.
- A crash after persisting `IN_FLIGHT` but before submission is conservatively
  escalated to manual recovery, even though the simulator could theoretically
  know that nothing was submitted.
- Custom skills cannot be registered in the hosted `ai.pharos.xyz` chat because
  that workflow is undocumented; install the skill into a supported local agent.

## License

MIT © 2026 wyka0. See [`LICENSE`](LICENSE).
