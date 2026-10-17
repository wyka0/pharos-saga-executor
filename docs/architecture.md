# Architecture

## 1. Scope and safety boundary

The first iteration is a **simulated saga executor**. It performs the three
dependent steps `APPROVE -> SWAP -> DEPOSIT` against a deterministic in-process
adapter. It never:

- reads a private key, mnemonic, wallet file or session token;
- opens an RPC connection or any HTTP connection;
- signs, broadcasts or confirms a transaction;
- claims that a simulated receipt is live blockchain evidence.

Every simulated receipt is branded with `simulated: true`, `network: "simulated"`,
a `sim_*` reference, and a disclaimer. The verifier rejects a receipt with a real
transaction hash field, a `0x` reference, or `simulated` not equal to `true`.

The state machine is isolated from the adapter through `ChainAdapter`, so a
reviewed testnet adapter can be added later without changing the states,
persistence format, executor, audit log or CLI.

## 2. State machine

```text
                         +-------------+
                         |   CREATED   |
                         +------+------+
                                |
                                v
                       APPROVAL_PENDING
                         |          |
             verified    |          | permanent fail
                         v          v
                      APPROVED    FAILED
                         |
                         v
                     SWAP_PENDING
                       |    |     |
            verified   |    |     | permanent fail
                       v    |     v
                    SWAPPED |  COMPENSATING
                       |    |     |
                       v    |     +--> FAILED (compensation ok)
                 DEPOSIT_PENDING   +--> MANUAL_RECOVERY_REQUIRED
                       |    |
            verified   |    | permanent fail
                       v    v
                   COMPLETED  COMPENSATING
                                 |
                                 +--> FAILED / MANUAL_RECOVERY_REQUIRED

  Any pending step --transient error--> RETRY_WAIT --window elapsed--> same pending step
  Any pending step --unknown outcome--> MANUAL_RECOVERY_REQUIRED (after reconcile)
```

The complete transition table is in `src/domain/states.ts` and is enforced by
`assertTransition`. Illegal transitions throw `IllegalTransitionError`; they are
never silently repaired.

| From | Allowed to |
| --- | --- |
| `CREATED` | `APPROVAL_PENDING`, `FAILED` |
| `APPROVAL_PENDING` | `APPROVED`, `RETRY_WAIT`, `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `APPROVED` | `SWAP_PENDING`, `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `SWAP_PENDING` | `SWAPPED`, `RETRY_WAIT`, `COMPENSATING`, `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `SWAPPED` | `DEPOSIT_PENDING`, `COMPENSATING`, `MANUAL_RECOVERY_REQUIRED` |
| `DEPOSIT_PENDING` | `COMPLETED`, `RETRY_WAIT`, `COMPENSATING`, `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `RETRY_WAIT` | `APPROVAL_PENDING`, `SWAP_PENDING`, `DEPOSIT_PENDING`, `COMPENSATING`, `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `COMPENSATING` | `FAILED`, `MANUAL_RECOVERY_REQUIRED` |
| `COMPLETED` | none (terminal) |
| `FAILED` | none (terminal) |
| `MANUAL_RECOVERY_REQUIRED` | none (terminal) |

`COMPLETED` means all three simulated steps succeeded. `FAILED` means the saga
did not complete; if compensation ran successfully, that fact is recorded in
`compensation.status` but **does not turn failure into success**. `MANUAL_...`
means no automatic action is safe.

### Dependency enforcement

`assertPrerequisites(record, step)` runs before every submission attempt:

- `APPROVE`: no prerequisite.
- `SWAP`: `APPROVE` must be `SUCCEEDED`, `submissionState === "VERIFIED"`, and
  have a persisted simulated receipt.
- `DEPOSIT`: `SWAP` must satisfy the same conditions.

A pending state is not enough. A step cannot start merely because the saga
reached `SWAP_PENDING`; the receipt must verify.

## 3. Execution loop

`SagaExecutor.drive()` is a bounded loop over the persisted state:

1. `CREATED -> APPROVAL_PENDING` is persisted before the first attempt.
2. `APPROVAL_PENDING` executes `APPROVE`.
3. After receipt verification, the step is persisted as succeeded and the saga
   transitions to `APPROVED` in the same atomic snapshot.
4. The loop transitions `APPROVED -> SWAP_PENDING`, then executes `SWAP`.
5. `SWAPPED -> DEPOSIT_PENDING`, then `DEPOSIT`.
6. `DEPOSIT` verification transitions to `COMPLETED`.

The loop has a hard `maxLoopIterations` guard (default 200). In addition, each
step has `retry.maxAttempts` (validated 1–20), so retries cannot run forever.

### Submission sequence (every attempt)

1. Check dependency and expected state.
2. Increment `attempts`, set `status = IN_PROGRESS` and
   `submissionState = IN_FLIGHT`.
3. Append `STEP_ATTEMPT` and **persist**.
4. Call `adapter.submit()` with the stable idempotency key.
5. Independently verify the returned receipt:
   - receipt version and kind;
   - simulated branding and disclaimer;
   - saga id, step id, idempotency key and operation;
   - `sim_*` reference and absence of real tx fields;
   - step-specific result (allowance, output amount, shares).
6. Persist the receipt, `SUCCEEDED`, `VERIFIED`, and the next state together.
7. Only then may the next step start.

If verification fails, the executor records the invalid receipt as untrusted
evidence and stops. It does not advance and does not retry.

## 4. Error classification and retry policy

| Class | Examples in this build | Behaviour |
| --- | --- | --- |
| `TRANSIENT` | injected simulated timeout/gas-spike style error | bounded exponential backoff |
| `PERMANENT` | injected simulated permanent revert | no retry; compensation policy |
| `UNKNOWN_OUTCOME` | response lost after submission | no resubmission; reconcile once; then manual |
| `VERIFICATION` | malformed/mismatched receipt | no advance, no retry; manual |
| `INTERNAL` | illegal state / invariant break | manual, evidence preserved |

Unknown errors are treated as permanent, not retried. Only `SagaError` kinds,
`retryable: true`, HTTP 429/5xx or a small set of network error codes are
classified transient. This is deliberately conservative.

### Backoff

```text
raw   = min(maxDelayMs, baseDelayMs * backoffFactor^(attempt - 1))
delay = round(raw/2 + (raw/2) * jitter)      jitter in [0,1)
```

- `attempt` is the attempt that just failed (1-based).
- With the default `base=100ms`, `factor=2`, `jitter=0.5`:
  `75ms`, `150ms`, `300ms`, ... capped by `maxDelayMs`.
- The jitter source is injectable; tests and demos use deterministic sources.
- `maxAttempts` is checked after each failure. On the last attempt there is no
  further retry; the failure is passed to the permanent-failure policy with
  `retryExhausted=true` when the budget was consumed by transient errors.

The clock is injectable. `VirtualClock.sleep()` advances time instead of waiting,
so the whole suite runs without real retry delays.

## 5. Compensation and recovery

There is **no global rollback**. A blockchain transaction that is confirmed
cannot be erased. Compensation is an explicit, new action, and is labelled as
such even in simulation.

| Original failure | Configured policy | Result |
| --- | --- | --- |
| `APPROVE` permanent or retry-exhausted | none needed | `FAILED`; `SWAP` and `DEPOSIT` never start |
| `SWAP` permanent/retry-exhausted | `REVOKE_APPROVAL` | `COMPENSATING`; a simulated approval revocation is attempted. Success ⇒ `FAILED` + `compensation.SUCCEEDED`; failure/unavailable ⇒ `MANUAL_RECOVERY_REQUIRED` |
| `SWAP` permanent | `NONE` | `MANUAL_RECOVERY_REQUIRED`; `compensation.SKIPPED`; no action |
| `DEPOSIT` permanent/retry-exhausted | `SIMULATED_UNWIND_SWAP` | `COMPENSATING`; a simulated **new trade** swaps back. Success ⇒ `FAILED` + compensation success; failure/unavailable ⇒ manual |
| `DEPOSIT` permanent | `NONE` | manual recovery; no action |
| Any step, unknown outcome | no compensation | reconcile once; if unresolved, manual; never retry/resubmit |
| Any step, invalid receipt | no compensation | manual; outcome is not proven |

Compensation success is recorded in `compensation.status` and its own receipt.
The original step failure remains in `record.failure`. The compensation error is
recorded separately in `compensation.error`. A compensation receipt carries
`receiptKind: "COMPENSATION"`, the original step name, and a note explicitly
saying it is a new call, not a rollback.

## 6. Persistence and crash safety

```text
<stateDir>/
  sagas/<sagaId>.json            authoritative snapshot (atomic temp+fsync+rename)
  sagas/<sagaId>.audit.ndjson    audit mirror rebuilt from the snapshot on save
  locks/<sagaId>.lock            per-saga execution lock
  simulated-ledger.json          idempotency ledger for simulated receipts
```

- The JSON snapshot contains the state, steps, receipts, errors, retry schedule,
  failure, compensation and the full timestamped audit log.
- The NDJSON mirror is rewritten from the snapshot after each save. The snapshot
  remains authoritative.
- Writes use a temporary file, `fsync`, rename, and best-effort directory sync.
- A per-saga file lock uses `open(..., "wx")`; stale locks older than 5 minutes
  can be reclaimed. Locks are released in `finally`.
- An in-process keyed queue serialises duplicate `runSaga()` calls for the same
  saga. A second concurrent caller waits, then sees the advanced state.
- `startSaga` uses a short global `__start__` lock so two callers with the same
  `clientRequestId` cannot create two records.

### Crash windows

| Crash point | Persisted state | Resume behaviour |
| --- | --- | --- |
| After verified step persisted | next pending/verified state | step is skipped; dependencies checked; run continues |
| After `IN_FLIGHT` persisted, before submission | pending + `IN_FLIGHT` | reconcile by idempotency key; no receipt ⇒ manual (conservative) |
| After adapter submission, before receipt persisted | pending + `IN_FLIGHT` | reconcile finds the simulated ledger receipt, verifies it, advances without resubmitting |
| During retry wait | `RETRY_WAIT` + `scheduledAt` | remaining virtual/real delay is honoured, then the same step retries |
| During compensation | `COMPENSATING` + pending compensation | inspect only; the CLI does not automatically repeat compensation |

The last point is deliberate: compensation is a non-idempotent action unless the
adapter can prove otherwise. This implementation does not automatically repeat a
compensation whose outcome was not persisted.

## 7. Idempotency and duplicate prevention

- Saga id is stable once created and is persisted.
- Step id: `<sagaId>:<STEP>`.
- Step idempotency key: `<sagaId>:<STEP>:v1`.
- `clientRequestId` is an optional saga-creation idempotency key; a duplicate
  start returns the existing record with `created=false`.
- `runSaga()` on a terminal saga is a no-op.
- Concurrent duplicate runs are serialised by the keyed queue and file lock.
- A retry reuses the same idempotency key. The simulated adapter's ledger returns
  the same receipt instead of creating a new simulated effect.
- A persisted `IN_FLIGHT` step is never resubmitted; it is reconciled first.

## 8. Audit log

Each event contains `seq`, ISO timestamp, type, level, `sagaId`, optional
`stepId`, `from`/`to` for transitions, a message and structured data. Sequence
numbers start at 1 and are contiguous. Timestamps are non-decreasing.

Types:

```text
SAGA_CREATED, SAGA_RUN_STARTED, TRANSITION,
STEP_ATTEMPT, STEP_SUCCEEDED, STEP_FAILED,
RETRY_SCHEDULED, RETRY_EXHAUSTED,
RECEIPT_VERIFIED, RECEIPT_VERIFICATION_FAILED,
RECONCILIATION_ATTEMPTED, RECONCILIATION_RESULT,
COMPENSATION_STARTED, COMPENSATION_SUCCEEDED,
COMPENSATION_FAILED, COMPENSATION_UNAVAILABLE,
MANUAL_RECOVERY_REQUIRED, SAGA_COMPLETED, SAGA_FAILED, INTERNAL_ERROR
```

The log includes state transitions, step outcomes, retry attempts and delays,
error kind/code/message/attempt, reconciliation results, and compensation
outcomes. `docs/verified-output.md` records the checks that assert ordering and
completeness.

## 9. Adapter seam and the Atlantic testnet adapter

`ChainAdapter` (`src/adapters/types.ts`) is the only interface the executor sees:

```ts
submit(step, context): Promise<ProofReceipt>
reconcile(step, context): Promise<{ receipt, detail }>
supportsCompensation(action): boolean
compensate(context): Promise<CompensationResult>
```

`ProofReceipt` is a discriminated union: `SimulatedReceipt` (`simulated: true`)
and `OnChainReceipt` (`simulated: false`, `network: "atlantic-testnet"`). The
verifier dispatches on the type and rejects a receipt that mixes their fields.

### Simulation adapter

`src/adapters/simulated.ts` remains the default. It has no network, wallet or
signing code and is covered by the original 61 tests.

### Testnet adapter

`src/adapters/pharosTestnet.ts` implements the same interface with these
additional guarantees:

1. **Network guard** — every plan/submit/compensate reads `eth_chainId` and
   refuses anything except **688689**. Mainnet RPC/chain id is absent from the
   testnet module.
2. **Approval gate** — `submit` requires a `PlanApproval` whose `planHash` equals
   the recomputed canonical plan hash (which excludes wall-clock `createdAt`).
   The CLI additionally requires `--confirm-atlantic-testnet`.
3. **Capability gate** — planning is blocked if the token is not in the verified
   registry, the spender is not a configured verified protocol, the balance is
   insufficient, an allowance already exists, or no verified protocol exists.
4. **Journal** — an `INTENT` entry is written before send, then `BROADCAST`,
   `CONFIRMED`, `REVERTED` or `UNKNOWN`. An `INTENT` with no hash is never
   resubmitted.
5. **Single-shot send** — 4 read-only attempts exist for reads/planning, but no
   send is ever retried. A timeout or ambiguous send is `UNKNOWN`.
6. **Receipt verification** — chain id, tx hash, block, success status,
   confirmations, explorer URL, gas fields, and an allowance postcondition are
   checked before the saga advances.
7. **Compensation** — only `REVOKE_APPROVAL` is implemented, and it requires its
   own approved plan. `SIMULATED_UNWIND_SWAP` is unavailable on testnet because
   no verified DEX exists.
8. **Preflight** — token metadata, balance, current allowance, gas estimate and
   max fee are read before the intent is written.

At the time of writing, all live capabilities of this adapter were blocked:
the wallet had zero test ERC-20s and no official Atlantic router/vault exists.
The adapter reports that rather than targeting a random contract. The wallet
was later externally funded with 20 of the official testnet USDC (still never
used as a saga target), and a **separate test-only workflow** (the deployed
`TestOnly*` mocks plus the gated deploy and saga runners) has since executed
on Atlantic - five confirmed deployment transactions and a five-transaction
saga, recorded in
[`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution) -
while this adapter path stays blocked: there is still no officially documented
Atlantic router/vault. `TestOnlyUSDC`/`TestOnlyReceiptToken` (tUSDC/tSAGA) are
not the official USDC, and the official USDC address was never targeted.

## 10. CLI and API

- Library entry: `src/index.ts`.
- CLI: `src/cli.ts` (`start`, `run`, `inspect`, `list`, `audit`,
  `testnet:readiness`, `testnet:plan`, `testnet:run`).
- State directory: `--state-dir`, or `PHAROS_SAGA_STATE_DIR`, default `./state`
  (git-ignored).
- Demos use fixed ids, a fixed virtual clock, deterministic jitter and fresh
  `.demo-state/<name>` directories.
- Testnet commands require `--env-file`; only variable names are documented.
  Readiness/planning accept `--address` and do not read the signing key.
- `testnet:run` requires both the exact plan hash and
  `--confirm-atlantic-testnet`; it has never been invoked in this work. The
  executed test-only Atlantic workflow uses the separate `testnet:deploy` and
  `testnet:saga` runners instead - see
  [`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).

## 11. Known limitations

- At the time of writing, no live testnet transaction had been executed, and
  APPROVE/SWAP/DEPOSIT were blocked by the then-zero test token balance and the
  absence of verified Atlantic protocols. Since then the separate
  **test-only workflow** (mock contracts plus the gated deploy and saga
  runners) has executed on Atlantic - five confirmed deployment transactions
  and a five-transaction saga, recorded in
  [`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).
  The **official-protocol adapter path remains blocked**: there is still no
  officially documented Atlantic router/vault; the mocks are test-only
  (tUSDC/tSAGA are not the official USDC, which was never targeted).
- The simulated ledger and the testnet journal are single-process; concurrent
  multi-process writers are not supported.
- Compensation is attempted once and is not automatically retried.
- A crash after `IN_FLIGHT` (simulation) or `INTENT` (testnet) is conservatively
  treated as unknown and escalates to manual recovery.
- The testnet journal is not automatically pruned.
- Hosted `ai.pharos.xyz` custom-skill registration is undocumented, so the skill
  is distributed as an installable repository rather than registered in the
  hosted chat.
