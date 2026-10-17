# Task 5 requirements evidence matrix

Date: **2026-10-18**. Commit: `b3fc8cafe9b795d0b745f130f0f32c9d30316bcd`.

This matrix maps each of the five Pharos Agent Arena **Saga Executor**
requirements to the implementing code (file + function), the tests that prove
it, a runnable demo command, and the saved evidence file. Nothing here is
claimed from documentation alone: every test and demo command listed was
executed on 2026-10-18, and the exact results are recorded in
[`verified-output.md` section 15](verified-output.md#iteration-8--task-5-requirements-completion).

Evidence layers, always labelled:

- **SIMULATED** — `npm run demo:success|failure|manual|unknown` (no wallet, no
  RPC, `sim_*` receipts, deterministic virtual clock);
- **LOCAL EVM (real transactions, disposable chainId 31337)** —
  `npm run demo:local`, `npm run demo:deploy-tooling`, `npm run demo:saga-tooling`;
- **ATLANTIC TESTNET (real transactions, chainId 688689, test-only mock
  contracts)** — the approved deployment + saga recorded in
  [`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).

Totals on the recorded run: **103/103 TypeScript tests** (`npm run verify`,
which also builds and runs the static safety gate), **16/16 Foundry tests**
(`forge test -vv`), **81 checks / 8 scenarios** (`npm run demo:saga-tooling`),
**4/4** scenarios (`npm run demo:local`), **6/6** scenarios
(`npm run demo:deploy-tooling`).

---

## Requirement 1 — At least 3 dependent steps, each receipt-verified before the next

Status: **PASS**

| Aspect | Evidence |
| --- | --- |
| Implementation | `src/executor/executor.ts` — `SagaExecutor.drive()` runs APPROVE → SWAP → DEPOSIT strictly in order; `executeStep()` persists `IN_FLIGHT` before submit, submits once, then calls `verifyStepReceipt()` and transitions only on `verification.ok`. `src/domain/states.ts` — `assertPrerequisites()` refuses to start a step unless the previous step is `SUCCEEDED` with `submissionState === 'VERIFIED'` and a receipt on file; `ALLOWED_TRANSITIONS` makes every other order illegal. `src/domain/receipts.ts` — `verifyStepReceipt()` re-checks receipt identity (sagaId, stepId, idempotency key, operation), layer-specific validity (simulated branding with no tx fields vs `chainId 688689`/`31337`, 32-byte tx hash, confirmations ≥ 1, explorer URL, non-empty postconditions) and the step's expected state change (approval allowance covers `amountIn`; swap `amountIn` matches the request with `amountOut > 0`; deposit shares > 0 for the request protocol). |
| Tests (pass) | `test/state-machine.test.ts`: "a step cannot start before its prerequisite has a verified receipt", "verified receipts satisfy prerequisites for later steps", "illegal transitions are rejected instead of skipping dependency states", "terminal states have no outgoing transitions". `test/executor-success.test.ts`: "successful three-step execution completes with verified simulated receipts", "each receipt passes the independent verifier before the state machine advances", "successful run records the exact legal state sequence", "decimal amounts propagate through SWAP and DEPOSIT deterministically". `test/local-anvil.test.ts`: "verifyStepReceipt rejects explorer links, wrong chains and missing warning text". |
| Failure/revert/unknown coverage | Receipt failure → no advance, no retry: `test/failure.test.ts` "a receipt that fails verification halts without advancing or retrying". On-chain revert → REVERTED, never retried: `test/testnet.test.ts` "a reverted transaction is recorded as REVERTED and never retried"; real local revert: `demo:local` scenario 2. Uncertain outcome → reconcile once, never resubmit: `test/failure.test.ts` "an unknown submission outcome is never retried and ends in manual recovery" and "a resolvable unknown submission is reconciled without resubmitting and the saga completes"; `test/testnet.test.ts` "a receipt timeout is an unknown outcome and is never resubmitted", "an ambiguous send error is unknown and never resubmitted", "reconcile recovers a broadcast transaction without resubmitting"; real-tx proof: `demo:local` scenario 4 (reconciled by idempotency key, no second send, journal `CONFIRMED`). |
| Demo | `npm run demo:success` → exit 0, `COMPLETED`, 17 audit events (run 2026-10-18); `npm run demo:local` → 4/4 scenarios with real local transactions. |
| Saved evidence | [`verified-output.md`](verified-output.md) §4.1 (full success audit), §14 (Atlantic run), §15 (fresh runs); [`local-anvil.md`](local-anvil.md) §4. |

## Requirement 2 — Explicit retry policy

Status: **PASS** (gas-price escalation deliberately not supported — see notes)

| Aspect | Evidence |
| --- | --- |
| Which transient errors are retryable | `src/domain/errors.ts` — `classifyError()`: any `SagaError` of kind `TRANSIENT`; errors with `retryable === true`; HTTP `429` or `>= 500`; connection codes `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `EPIPE`, `RATE_LIMITED`. **Everything else is permanent by default** — unknown errors are never retried. |
| Max attempts + backoff | `src/domain/retry.ts` — `assertRetryConfig()` bounds `maxAttempts` to 1–20 (default 3) and validates delays/factor; `RetryPolicy.schedule()`: `raw = min(maxDelayMs, baseDelayMs * factor^(attempt-1))`, `delay = round(raw/2 + (raw/2) * jitter)` (equal jitter, deterministic seeded source). Defaults: base 100 ms, max 1000 ms, factor 2. `src/executor/executor.ts` — `handleStepError()` schedules `RETRY_WAIT` only while `attemptsRemain()`, then applies the permanent-failure policy (`RETRY_EXHAUSTED`). |
| Gas-price/fee escalation | **Not supported, by design.** The gated runners read the gas price once per run and enforce a hard worst-case cost ceiling (0.02 PHRS saga / 0.05 PHRS deploy) before signing; there is no fee-bumping policy, so a gas spike is handled as a retry/stop, never by re-pricing an in-flight transaction. Documented in [`architecture.md`](architecture.md) and below in "Known limitations". |
| Dropped / pending transactions | `src/executor/executor.ts` — a receipt timeout or an ambiguous send error becomes `UNKNOWN_OUTCOME`; `reconcileStep()` queries the adapter once by idempotency key and either adopts the verified receipt (advance without resubmitting) or stops in `MANUAL_RECOVERY_REQUIRED`. `src/adapters/localAnvil.ts` journals the broadcast hash before reporting unknown; `src/persistence/testnetJournal.ts` and `src/testnet/saga/journal.ts` keep `INTENT`/`UNKNOWN` entries that block re-sends. |
| Permanent errors | `PERMANENT` kind (default for unclassified errors, `PermanentStepError`, dependency violations), on-chain reverts (`REVERTED`, never retried), and `VERIFICATION` failures (no compensation claim; manual recovery). |
| Duplicate/unknown prevention | `clientRequestId` + step-scoped idempotency keys (`<sagaId>:<STEP>:v1`), per-saga file locks + in-process keyed queue (`store.acquireLock`, `acquireKey`), simulated-ledger replay (`SimulatedLedger`), `INTENT`-before-send journals, reconcile-once semantics. |
| Tests (pass) | `test/retry.test.ts` (7): "exponential backoff is bounded and uses deterministic equal jitter", "seeded jitter is reproducible and stays in [0, 1)", "invalid retry policy values are rejected", "a transient SWAP failure is retried and then succeeds", "retry exhaustion stops APPROVE and never starts SWAP", "maximum retry count is configurable and honored exactly", "retry delays never exceed maxDelayMs". Plus `test/failure.test.ts` (unknown-outcome pair), `test/testnet.test.ts` (timeout/ambiguous/reconcile/unknown-revoke), `test/persistence.test.ts` "resume during RETRY_WAIT honours the persisted schedule and completes", `test/audit.test.ts` "timestamps are non-decreasing and retry waits advance virtual time". |
| Demo | `npm run demo:failure` — two visible `RETRY_SCHEDULED` events at **75 ms and 150 ms** (raw 100/200 ms, jitter 0.500) before the injected permanent failure; `npm run demo:unknown` — no retry, reconcile-once, `MANUAL_RECOVERY_REQUIRED`. |
| Saved evidence | [`verified-output.md`](verified-output.md) §4.2 (full failure audit), §15; this run's output. |

## Requirement 3 — Compensation / rollback path and demo

Status: **PASS** (simulated + real on-chain Anvil compensation; Atlantic compensation not exercised — no failure was injected in the approved test-only run)

| Aspect | Evidence |
| --- | --- |
| Implementation | `src/executor/executor.ts` — `failStep()` picks the configured action (`REVOKE_APPROVAL` for SWAP, `SIMULATED_UNWIND_SWAP` for DEPOSIT; `NONE` for APPROVE), handles disabled/unavailable policies, and moves to `COMPENSATING`; `runCompensation()` executes it once, verifies the compensation receipt via `verifyCompensationReceipt()`, and records `SUCCEEDED` / `FAILED` / `UNAVAILABLE` (failures land in `MANUAL_RECOVERY_REQUIRED` with both errors preserved). `src/adapters/simulated.ts` — `compensate()` (allowance → 0; reverse unwind trade; idempotent replay). `src/adapters/localAnvil.ts` — **real on-chain compensating transactions** on the disposable chain (USDC `approve(spender, 0)`; mock-swap `unwind()`), each receipt verified. `src/domain/receipts.ts` — `verifyCompensationReceipt()` (revoke must end with allowance 0; unwind token direction reversed; `compensatesStep` must name the original failed step). |
| Reverse dependency order | Compensation only ever targets the failed step's own dependency (revoke the approval made for SWAP; unwind the swap output that DEPOSIT failed to deposit); `APPROVE` failure needs none (`COMPENSATION: none -> not reached`), and later steps never start (`STEPS: ... deposit=PENDING/0` in `demo:manual`). |
| Never claims a rollback | Every compensation audit event states "a new simulated call / a new local transaction ... not a blockchain rollback", and the saga ends `FAILED`, not `COMPLETED`. `test/failure.test.ts` "adapter-reported unavailable compensation stops for manual recovery without a rollback claim". |
| Tests (pass) | `test/failure.test.ts`: "SWAP permanent failure executes configured simulated approval revocation", "compensation failure is recorded separately and leads to manual recovery", "SWAP failure with compensation disabled goes straight to manual recovery", "DEPOSIT permanent failure after SWAP executes configured simulated unwind", "DEPOSIT compensation failure preserves both failures and stops for manual recovery", "DEPOSIT failure with no safe compensation stops for manual recovery", "adapter-reported unavailable compensation stops for manual recovery without a rollback claim", "compensation receipt verification failure is a separate failure and needs manual recovery", "transient retry exhaustion on DEPOSIT also applies the compensation policy". Foundry: `testUnwindCompensationReturnsUsdc`, `testVaultWithdrawReturnsReceipts`, `testForcedSwapFailureLeavesStateUnchanged`, `testForcedVaultFailureLeavesReceiptsInWallet`, `testCompensationCannotBeSabotagedByAttacker`. |
| Demo | `npm run demo:failure` — compensation `SIMULATED_UNWIND_SWAP -> SUCCEEDED`, final `FAILED` (simulated); `npm run demo:manual` — compensation `REVOKE_APPROVAL -> FAILED` recorded separately, `MANUAL_RECOVERY_REQUIRED` (15 audit events); `npm run demo:local` — scenarios 2–3 execute **real on-chain compensating transactions** on Anvil (allowance revoked on-chain; unwind tx mined; balances re-read). |
| Saved evidence | [`verified-output.md`](verified-output.md) §4.2, §4.3, §15; [`local-anvil.md`](local-anvil.md) §4; Foundry results in [`local-anvil.md`](local-anvil.md) §4. |

## Requirement 4 — Durable state log (journal), restart/resume

Status: **PASS**

| Field required | Where it is recorded |
| --- | --- |
| Saga ID | `SagaRecord.id` (authoritative snapshot + every `AuditEvent.sagaId`); `TestnetJournalEntry.sagaId`; local/testnet saga journal keys (`saga:<planHash>:<order>:<name>`) |
| Plan hash | `SAGA_CREATED` audit data (`testnet.approvedPlan`); `TestnetJournalEntry.planHash`; saga-journal `entry.planHash` (bound to the approved hash before any send) |
| Current step + step status | `record.state` + `steps[].status` / `submissionState` (`NOT_SUBMITTED`/`IN_FLIGHT`/`UNKNOWN_OUTCOME`/`VERIFIED`); journal statuses `INTENT`/`BROADCAST`/`CONFIRMED`/`REVERTED`/`UNKNOWN` |
| Attempt count + timestamps | `steps[].attempts`, `startedAt`/`finishedAt`/`verifiedAt`; journal `recordedAt`/`updatedAt`; every audit event is timestamped with monotonic `seq` |
| Transaction hash + receipt status | `steps[].receipt` (`txHash`/`status`/`confirmations`/`postconditions`, or `simulatedTxRef` for the simulated layer); journal `entry.txHash` + `status`; audit `RECEIPT_VERIFIED` / `RECEIPT_VERIFICATION_FAILED` |
| Retry decisions | `steps[].retry` (`attempt`, `scheduledAt`, `delayMs`, `jitter`, `reason`) + audit `RETRY_SCHEDULED` / `RETRY_EXHAUSTED` |
| Compensation progress | `record.compensation` (`required`, `action`, `status`, `attempts`, `receipt`, `error`) + audit `COMPENSATION_STARTED` / `COMPENSATION_SUCCEEDED` / `COMPENSATION_FAILED` / `COMPENSATION_UNAVAILABLE` |
| Final state / manual recovery | `record.state` (`COMPLETED` / `FAILED` / `MANUAL_RECOVERY_REQUIRED`) + audit `SAGA_COMPLETED` / `SAGA_FAILED` / `MANUAL_RECOVERY_REQUIRED` |

| Aspect | Evidence |
| --- | --- |
| Implementation | `src/persistence/store.ts` — `SagaStore` (atomic JSON snapshot = source of truth; NDJSON audit mirror rewritten from the snapshot; per-saga `wx` lock files with stale detection); `src/persistence/atomic.ts` — `atomicWriteJson` (temp file + fsync + rename); `src/domain/audit.ts` — `appendAudit` (contiguous `seq`); `src/persistence/testnetJournal.ts`, `src/testnet/saga/journal.ts`, `src/persistence/localJournal.ts` — durable `INTENT`-before-send journals; `src/persistence/ledger.ts` — simulated idempotency ledger. |
| Restart / resume tests (pass) | `test/persistence.test.ts`: "saga state, receipts and audit survive an atomic save/load round trip", "resume after a crash following APPROVE verification does not re-run APPROVE", "resume after a crash between submission and receipt persistence reconciles without resubmitting", "resume after a crash before submission finds no receipt and requires manual recovery", "resume during RETRY_WAIT honours the persisted schedule and completes", "duplicate start with the same clientRequestId returns the existing saga", "a completed saga is a no-op when run again", "concurrent duplicate run invocations submit each step exactly once", "a saga can be created, inspected and resumed from a fresh executor". `test/audit.test.ts`: "the NDJSON audit mirror matches the authoritative snapshot for a failed saga". `test/cli.test.ts`: "CLI --no-run persists CREATED and a later run completes the same saga" (two separate processes). |
| Journal-status tests (pass) | `test/saga-tooling.test.ts` "saga journal round-trips entries and flags every non-resolved status"; `test/deploy-tooling.test.ts` "journal round-trips entries and flags every non-CONFIRMED status"; `test/local-anvil.test.ts` "LocalJournal persists an INTENT before any send and updates it atomically". |
| Demo | After any demo: `npm run cli -- inspect saga_demo_failure --state-dir .demo-state/failure` and `npm run cli -- audit saga_demo_failure --state-dir .demo-state/failure` (state file survives the process; audit mirror matches). `demo:local` scenario 4 resumes a real broadcast from the journal without a second send. The Atlantic journals show five `INTENT` → `CONFIRMED` transitions each for deployment and saga (`.local` journals, summarized in [`verified-output.md`](verified-output.md) §14). |
| Saved evidence | [`verified-output.md`](verified-output.md) §4.x (audit logs), §14 (Atlantic journals summary), §15; [`local-anvil.md`](local-anvil.md) §4. |

## Requirement 5 — Two reproducible demonstrations

Status: **PASS**

| Demo | Command | Recorded result (2026-10-18) | Saved output |
| --- | --- | --- | --- |
| A. Successful run | `npm run demo:success` | exit 0 — `FINAL STATE: COMPLETED`; `STEPS: approve=SUCCEEDED/1 swap=SUCCEEDED/1 deposit=SUCCEEDED/1`; every receipt verified (`RECEIPT_VERIFIED` ×3); postconditions checked (allowance covers 100; swap out 99.5 consumed by deposit; shares 97.005); `COMPENSATION: none -> not reached`; **17 audit events** | [`verified-output.md`](verified-output.md) §4.1 (full 17-event audit) + §15 |
| B. Forced-failure run | `npm run demo:failure` | exit 0 — deterministic injection (`deposit: transientFailures 2, permanentFailure true`); retries visible (`RETRY_SCHEDULED` at **75 ms / 150 ms**, `RETRY_WAIT` transitions); permanent failure on attempt 3 (`code=SIMULATED_PERMANENT_DEPOSIT`, `retryExhausted=false`); compensation `SIMULATED_UNWIND_SWAP -> SUCCEEDED` (explicitly "a new simulated call, not a blockchain rollback"); final `FAILED`, not `COMPLETED`; **30 audit events** showing the failure and recovery history | [`verified-output.md`](verified-output.md) §4.2 (full 30-event audit) + §15 |

On-chain variants of both demonstrations (real transactions, disposable chain):
`npm run demo:local` — scenario 1 is the success path, scenarios 2–3 are forced
on-chain reverts with real compensating transactions (4/4 PASS); the approved
Atlantic test-only run in [`verified-output.md`](verified-output.md) §14 is the
testnet execution record.

---

## Requirement status summary

| # | Requirement | Status |
| --- | --- | --- |
| 1 | ≥3 dependent steps, receipt-verified before the next | **PASS** |
| 2 | Explicit retry policy (classified, bounded, no blind resend of unknown outcomes) | **PASS** — gas-price escalation intentionally not supported; fixed gas price + hard worst-case ceiling, documented |
| 3 | Compensation/rollback path + demo | **PASS** — simulated and real on-chain (Anvil) compensation proven; Atlantic compensation not exercised (no failure injected in the approved run) |
| 4 | Durable state log + restart/resume/reconcile | **PASS** |
| 5 | Two reproducible demonstrations (success + forced failure) | **PASS** |

## Reproduction commands

```powershell
npm install
npm run verify                  # build + 103 tests + static safety gate
npm run demo:success            # Demo A  -> COMPLETED (17 audit events)
npm run demo:failure            # Demo B  -> FAILED + compensation SUCCEEDED (30 audit events)
npm run demo:manual             # compensation failure -> MANUAL_RECOVERY_REQUIRED
npm run demo:unknown            # unknown outcome -> reconcile once -> MANUAL_RECOVERY_REQUIRED
npm run cli -- inspect saga_demo_failure --state-dir .demo-state/failure
npm run cli -- audit saga_demo_failure --state-dir .demo-state/failure

# Optional local-chain (real transactions, chainId 31337 only; needs Foundry in WSL)
npm run demo:local              # 4/4 scenarios
npm run demo:deploy-tooling     # 6/6 scenarios
npm run demo:saga-tooling       # 81/81 checks, 8 scenarios
wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge test -vv'
```

## Known limitations (honest notes)

- **No fee escalation.** The policy is: fixed gas price read once per gated run,
  worst-case cost computed and capped before signing; a gas spike is a transient
  failure (retry within budget) or a stop — never a re-price of an in-flight
  transaction. There is no mempool fee-bumping.
- **Atlantic compensation is unexercised.** The approved Atlantic saga was a
  clean run (no injected failure), so on-chain compensation is proven on Anvil
  (`demo:local` scenarios 2–3, Foundry tests) and in simulation, not on Atlantic.
- **Two journal layers.** The core saga snapshot carries the saga id, steps,
  attempts, receipts, retry, compensation and final state; the plan hash lives in
  the plan approval, the `SAGA_CREATED` audit data and the gated
  deployment/saga journals (`TestnetJournalEntry.planHash`,
  saga-journal `entry.planHash`). The layers are linked by saga id and step keys.
- The Atlantic transactions target **test-only mock contracts**; they are not
  production protocols and the official USDC was never targeted.
