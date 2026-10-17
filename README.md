# Pharos Saga Executor

A deterministic, resumable **APPROVE -> SWAP -> DEPOSIT** saga executor, packaged
as an installable agent skill for the Pharos Agent Arena task
[**Saga Executor**](https://pharos-agent-arena.vercel.app/tasks/saga-executor)
(Hard / SkillEngine / 200 points).

> ## Simulation and testnet notice
>
> **The default adapter is still simulation-only.** No wallet is used by the demo
> path, no private key exists in this repository, and **no on-chain transaction
> was sent or confirmed** by the simulations. Every simulated receipt is branded
> `simulated: true`, uses a `sim_*` reference, and has no transaction hash or
> explorer link.
>
> The **official-protocol** Atlantic testnet adapter is still read-only and
> **blocked**: the wallet holds 20 test USDC, but no officially documented
> DEX/router or vault exists on Atlantic, and that path has never signed or
> broadcast anything. The external 20 USDC funding transfer is verified in
> [`docs/testnet-results.md`](docs/testnet-results.md).
>
> Simulated compensation is clearly labelled as a new simulated call, **not a
> blockchain rollback**.
>
> **Local test-only validation (chainId 31337):** the saga executor has also
> been run end-to-end against a disposable local Anvil chain with clearly
> labelled `TestOnly*` mock contracts. All four scenarios pass with real local
> transactions, bounded allowances and no blind resubmission. See
> [`docs/local-anvil.md`](docs/local-anvil.md). This is **not** Atlantic or
> mainnet evidence.
>
> **Test-only Atlantic execution (2026-10-17, under two explicit plan-hash
> approvals):** the gated runners deployed the four clearly labelled `TestOnly*`
> mock contracts plus the minter wiring (deployment plan hash
> `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`; five
> transactions, all CONFIRMED) and then ran the five-step saga against them
> (saga plan hash
> `8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f`; five
> transactions, all CONFIRMED; 0.00365623 PHRS total). These are **testnet runs
> against test-only mocks** - not mainnet, not production protocols, and **not**
> the official USDC (`0xcfC8...Fc8B`), which was never targeted. Full record:
> [`docs/verified-output.md` section 14](docs/verified-output.md#iteration-7--atlantic-saga-execution).

- Node.js 20+ (verified on Node 24.14.1)
- Simulation path has no wallet, RPC or network calls; `viem` is used only by the
  gated testnet adapter and the local/testnet read-only tooling
- State machine, retry policy, compensation, persistence, CLI and tests
- **103 offline automated tests**, plus **16 Foundry contract tests** and three
  local safety sessions: a **4-scenario Anvil saga demo** (`npm run demo:local`),
  a **6-scenario deploy-tooling check** (`npm run demo:deploy-tooling`) and an
  **8-scenario saga-tooling check** (`npm run demo:saga-tooling`)

---

## Contents

- [Why this design](#why-this-design)
- [Reviewer quick path](#reviewer-quick-path)
- [Rubric coverage](#rubric-coverage)
- [Quick start](#quick-start)
- [Example 1: successful saga](#example-1-successful-saga)
- [Example 2: forced failure + compensation](#example-2-forced-failure--compensation)
- [Example 3: inspect/list persisted sagas](#example-3-inspectlist-persisted-sagas)
- [State machine](#state-machine)
- [Retry and recovery rules](#retry-and-recovery-rules)
- [CLI](#cli)
- [Persistence](#persistence)
- [Testnet readiness (read-only)](#testnet-readiness-read-only)
- [Local Anvil validation (test-only)](#local-anvil-validation-test-only)
- [Atlantic deployment and saga execution (test-only)](#atlantic-deployment-and-saga-execution-test-only)
- [Gated Atlantic deployment tooling (test-only)](#gated-atlantic-deployment-tooling-test-only)
- [Gated Atlantic saga tooling (test-only)](#gated-atlantic-saga-tooling-test-only)
- [Skill packaging and environment](#skill-packaging-and-environment)
- [Tests and verification](#tests-and-verification)
- [Safety](#safety)
- [Limitations](#limitations)
- [License](#license)

---

## Reviewer quick path

For the Task 5 submission review, run:

```powershell
npm install
npm run verify
npm run demo:success
npm run demo:failure
npm run demo:manual
npm run demo:unknown
```

Expected: **103 tests pass**, then four simulation demos ending in `COMPLETED`,
`FAILED` (compensation success), `MANUAL_RECOVERY_REQUIRED` (compensation
failure), and `MANUAL_RECOVERY_REQUIRED` (unknown outcome).

Optional local-only extra (requires Foundry in WSL, see
[`docs/local-anvil.md`](docs/local-anvil.md)); it never touches Atlantic:

```powershell
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge test -vv'
npm run demo:local
npm run demo:deploy-tooling
npm run demo:saga-tooling
```

Optional read-only Atlantic deployment plan (requires the local env file and
the public deployer address; nothing is signed):

```powershell
npm run testnet:deploy-plan -- --env-file C:\temp-secrets\.env --address 0xE2B8651178ade144003537eA509E37877dba40bb
```

The full reviewer checklist, expected states, audit markers, and submission
blockers are in [`docs/reviewer-guide.md`](docs/reviewer-guide.md). The
requirement-by-requirement evidence matrix (implementation functions, test
names, demo commands, evidence files) is in
[`docs/requirements-matrix.md`](docs/requirements-matrix.md).

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

A full requirement-by-requirement matrix (implementation, tests, demos,
evidence) is in [`docs/requirements-matrix.md`](docs/requirements-matrix.md).

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
| Real local chain execution, test-only | `LocalAnvilAdapter`, `TestOnly*` contracts, state guard 31337 | `npm run demo:local`, `contracts/test/*.t.sol` |
| Atlantic test-only deployment, executed under approval | gated runner, read-only plan + stable plan hash, bytecode/runtime verification, INTENT journal, PHRS ceiling | `docs/testnet-deployment-plan.md`, `docs/testnet-deployment-tooling.md`, `npm run demo:deploy-tooling` |
| Atlantic test-only saga, executed under approval | gated five-step runner, plan-hash gate, INTENT journal, calldata-hash binding, no resend | `docs/verified-output.md` section 14, `docs/testnet-saga-tooling.md`, `npm run demo:saga-tooling` |

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

## Testnet readiness (read-only)

A separate `PharosTestnetAdapter` exists behind the same `ChainAdapter` interface.
It is **not approved and has not sent any transaction**. The verified facts:

| Item | Value |
| --- | --- |
| Network | Atlantic testnet, chainId **688689** |
| RPC | official `https://atlantic.dplabs-internal.com` (configured host matches) |
| Explorer | `https://atlantic.pharosscan.xyz/` |
| Wallet | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| Native balance | 0.542613955838483504 PHRS |
| Test ERC-20 balances | **20 USDC**; other four tokens **0** |
| Verified tokens | USDC, USDT, WBTC, WETH, WPHRS (code + symbol + decimals checked) |
| Swap/router | **none documented/deployed on Atlantic** |
| Deposit/vault | **none documented/deployed on Atlantic** |
| Faucet | native PHRS mentioned without URL; no test-ERC-20 faucet documented |

Capabilities reported by the adapter:

```text
APPROVE available=false  (no verified spender; wallet has 20 USDC)
SWAP    available=false  (no verified router)
DEPOSIT available=false  (no verified vault)
```

Read-only commands (no signing key read by readiness/planning):

```powershell
npm run testnet:readiness -- --env-file <local-env> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness --token USDC --amount 0.01

npm run testnet:plan -- --env-file <local-env> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness --id saga_testnet_usdc_approve_plan `
  --token USDC --amount 0.01
```

The resulting plan is `executable=false` with **zero transactions** and the
blocked reason "No verified swap or deposit contract is configured". No
transaction hash exists.

`testnet:run` has two independent gates: the exact `--approval-hash` printed by
the plan **and** `--confirm-atlantic-testnet`. It also re-checks the live chain ID
and the plan hash before the adapter can sign. It has not been run.

This blocked plan is the **official-protocol** path. The separately approved
**test-only mock** deployment and saga (see the notice above) were executed on
Atlantic testnet and are recorded in
[`docs/verified-output.md` section 14](docs/verified-output.md#iteration-7--atlantic-saga-execution).

Full findings: [`docs/testnet-readiness.md`](docs/testnet-readiness.md).
Execution/approval status: [`docs/testnet-results.md`](docs/testnet-results.md).

## Local Anvil validation (test-only)

Because Atlantic currently has no official swap/router or vault, the real
transaction path was exercised on a disposable local chain instead:

```powershell
npm run demo:local   # starts Anvil in WSL, deploys TestOnly* contracts, runs 4 scenarios
```

- chainId **31337** only; the adapter refuses any other chain and any RPC host
  other than `127.0.0.1`/`localhost`;
- real local transactions (no simulation flags), Anvil's unlocked account signs
  them, so **no private key is needed, read or printed**;
- scenarios: success (APPROVE -> SWAP -> DEPOSIT), forced SWAP revert with
  `REVOKE_APPROVAL`, forced DEPOSIT revert with `SIMULATED_UNWIND_SWAP`, and an
  injected unknown SWAP outcome that is reconciled **without a second send**;
- allowances are exact and bounded; no unlimited approvals.

Details, exact commands and observed output:
[`docs/local-anvil.md`](docs/local-anvil.md).

## Atlantic deployment and saga execution (test-only)

A read-only plan for deploying the four clearly labelled `TestOnly*` contracts
to Atlantic testnet was prepared for review:

```powershell
npm run testnet:deploy-plan -- --env-file <local-env> --address 0xE2B8651178ade144003537eA509E37877dba40bb
```

It reads memoized chain state (block, balances, pending nonce, gas price) and
compiled artifact hashes, then prints per-contract gas estimates, gas caps,
predicted CREATE addresses and a stable plan hash. The script has no send or
sign path (enforced by the safety gate) and never reads the private key.

- Plan hash (v2, after the F-1 contract hardening):
  `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`
- Five transactions: 4 deployments + the explicit minter-wiring call
- Total gas cap **3,400,000**; maximum planned spend at 10 gwei: **0.034 PHRS**,
  operator ceiling **0.05 PHRS**
- Full plan: [`docs/testnet-deployment-plan.md`](docs/testnet-deployment-plan.md)

**Executed (2026-10-17):** the plan hash was explicitly approved and the gated
runner executed all five deployment transactions - nonces 13-17, total gas
**2,471,030** (**0.0247103 PHRS** at 10 gwei), all **CONFIRMED**. The four
`TestOnly*` contracts were deployed exactly at the predicted CREATE addresses
and the minter was wired (deployment journal
`.local/atlantic-deploy/deploy-journal.json`). The approved five-step saga plan
(`8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f`) then ran
against them - nonces 18-22, total gas **365,623** (**0.00365623 PHRS**), all
**CONFIRMED**. Both runs are test-only mock activity on chainId 688689: no
mainnet deployment, no production protocol, and the official USDC was never
targeted.

## Gated Atlantic deployment tooling (test-only)

The deployment path is a separate gated runner (with the saga runner below, the
only code that can send). **Executed status:** the approved plan hash was run on
2026-10-17; all five deployment transactions are CONFIRMED - see
[`docs/verified-output.md` section 14](docs/verified-output.md#iteration-7--atlantic-saga-execution).

- `scripts/testnet-deploy.ts` — CLI; atlantic mode requires
  `--approve-plan <hash>` **and** `--confirm-atlantic-testnet`, force-rebuilds
  the contracts, re-verifies every artifact hash, re-reads chainId / nonce /
  gas price / balance, enforces the 0.05 PHRS ceiling, journals `INTENT`
  before every send, verifies every receipt, deployed bytecode and address,
  and never resends an ambiguous outcome;
- `scripts/local-deploy-check.ts` — the same runner against disposable local
  chains; recorded **6/6 scenarios PASS**: happy path (plus on-chain
  authorization checks), wrong-chain refusal, forced revert, ambiguous
  outcome (never resent), runtime-bytecode mismatch, and tampered immutable
  slot.

Full details: [`docs/testnet-deployment-tooling.md`](docs/testnet-deployment-tooling.md).

## Gated Atlantic saga tooling (test-only)

The saga path is a second gated runner with its own shared plan core:

- `src/testnet/sagaPlan.ts` + `src/testnet/saga/` - read-only plan core, shared
  read-only verification, durable journal and the only saga send path;
- `scripts/testnet-saga-plan.ts` - read-only plan printer
  (`npm run testnet:saga-plan`); never reads a key;
- `scripts/testnet-saga.ts` - gated CLI (`npm run testnet:saga`). Atlantic mode
  requires `--approve-plan <hash>` **and** `--confirm-atlantic-testnet`,
  resolves the contract addresses from the deployment journal (never from
  flags), force-rebuilds the contracts, re-verifies runtime code and wiring,
  enforces the 0.02 PHRS ceiling, journals `INTENT` before every send,
  hash-binds each mined input to its journaled calldata, and never resends an
  ambiguous outcome;
- `scripts/local-saga-check.ts` - eight-scenario local safety check
  (`npm run demo:saga-tooling`): 81/81 checks - happy path, mint-skip, wrong
  chain, forced revert, ambiguous outcome, altered calldata, broken
  postcondition, changed pre-state.

The approved plan hash
`8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f` was
**executed on Atlantic testnet** - all five transactions CONFIRMED
([record](docs/verified-output.md#iteration-7--atlantic-saga-execution)). Full
details: [`docs/testnet-saga-tooling.md`](docs/testnet-saga-tooling.md).

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
- testnet adapter readiness, plan gating, on-chain receipt verification, journal
  outcomes, reverted/timeout/ambiguous sends, postcondition failure, read retries,
  mainnet rejection, and partial-stop behaviour;
- local-anvil configuration gating, local receipt verification (no explorer
  links, chainId 31337 only), bounded vault allowance rules, and the durable
  local journal (INTENT before send);
- saga-tooling golden values and semantics: the approved plan hash and all five
  calldata strings, plan-hash binding, deployment-journal address resolution,
  journal statuses (INTENT/UNKNOWN block re-runs) and the official-USDC
  exclusion;
- static safety checks, including isolation of the local-anvil files from
  Atlantic/mainnet targets, read-only assertions on both plan scripts, the
  deployment-tooling invariants (INTENT journal before sends, PHRS hard
  ceiling, mandatory confirmation flag, runtime-code verification, lazy key
  load), and the saga-tooling invariants (plan-hash gate, INTENT journal,
  0.02 PHRS ceiling, confirmation flag, calldata-hash binding, no resend,
  official-USDC guard).

The suite uses `VirtualClock`, fixed jitter, a fake testnet client and temporary
state directories, so it needs no wallet, live network, real funds or real-time
retry waits. Exact test counts and command output are recorded in
[`docs/verified-output.md`](docs/verified-output.md).

The separate Foundry suite (`contracts/test/*.t.sol`, 16 tests) and the local
safety sessions - the four-scenario saga demo (`npm run demo:local`), the
six-scenario deploy-tooling check (`npm run demo:deploy-tooling`) and the
eight-scenario saga-tooling check (`npm run demo:saga-tooling`) - are
documented in [`docs/local-anvil.md`](docs/local-anvil.md) and
[`docs/testnet-saga-tooling.md`](docs/testnet-saga-tooling.md).

## Safety

- The simulation path uses no wallet, private key, mnemonic, seed phrase, session
  token, `.env`, RPC endpoint or signing library.
- The official-protocol testnet adapter is Atlantic-only (chainId 688689), never
  targets mainnet, and cannot sign without an explicit plan-hash approval plus
  the CLI confirmation gate; it has never sent a transaction and its plan stays
  blocked.
- The gated deployment and saga runners are the only code with a send path. They
  sign only when the freshly rebuilt plan matches an explicitly approved hash
  (plus the `--confirm-atlantic-testnet` gate), journal `INTENT` before every
  send, and never resend an ambiguous outcome. The only transactions this
  project has ever sent are the approved **test-only** Atlantic deployment and
  saga recorded in
  [`docs/verified-output.md` section 14](docs/verified-output.md#iteration-7--atlantic-saga-execution).
- Simulated receipts cannot pass verification if they contain `simulated:false`,
  a `0x` transaction reference, `txHash`, `transactionHash`, `blockNumber`,
  `blockHash` or an explorer URL.
- On-chain receipts are a separate type and require a real testnet tx hash,
  success status, confirmations, explorer URL and postconditions.
- The simulation CLI and demos print the simulation disclaimer; the testnet CLI
  prints the Atlantic-testnet disclaimer and never calls a simulated result
  on-chain.
- Generated state and dependencies are excluded by `.gitignore` and checked by
  `scripts/check-safety.mjs`.

## Limitations

- **Official-protocol** live testnet execution is currently **blocked**: no
  officially documented Atlantic swap/router or vault exists, so that plan
  contains zero transactions.
- The real transaction path is exercised on disposable local Anvil chains
  (`TestOnly*` mocks, chainId 31337) **and** on Atlantic testnet through the
  approved test-only deployment and saga. None of it is production or
  official-protocol integration; the mocks are not a DEX and not a vault.
- The Atlantic test-only deployment **was executed** (2026-10-17): the four
  `TestOnly*` contracts and the minter wiring are deployed at the addresses
  predicted by the approved plan, and the approved five-step saga ran against
  them (all five transactions CONFIRMED). These remain test-only mocks on a
  testnet; nothing was deployed to mainnet.
- No mainnet adapter exists. Mainnet is explicitly rejected.
- The simulated ledger is serialised within one process; the testnet journal is
  also single-process.
- Compensation is attempted once and is not automatically retried; testnet
  unwind compensation is unavailable without a verified DEX.
- A crash after an `INTENT` journal write without a hash is treated as unknown and
  requires manual recovery.
- A crash after persisting `IN_FLIGHT` but before submission is conservatively
  escalated to manual recovery, even though the simulator could theoretically
  know that nothing was submitted.
- Custom skills cannot be registered in the hosted `ai.pharos.xyz` chat because
  that workflow is undocumented; install the skill into a supported local agent.

## License

MIT © 2026 wyka0. See [`LICENSE`](LICENSE).
