---
name: pharos-saga-executor
description: >
  Run a resumable, receipt-verified APPROVE -> SWAP -> DEPOSIT workflow as one
  saga, with bounded retries, explicit compensation, and a timestamped audit
  log. Use when a user asks for a multi-step dependent Pharos transaction
  workflow, a safe approve/swap/deposit sequence, saga recovery, retry policy,
  compensation after a permanent step failure, or an inspectable state machine.
  SIMULATION ONLY in this release: it never uses a wallet and never sends a
  transaction. Trigger phrases: pharos saga, approve swap deposit, dependent
  transaction workflow, saga executor, resume a failed swap, compensate a
  failed deposit, manual recovery required.
version: 0.1.0
license: MIT
metadata:
  author: wyka0
  simulated: true
  network: none
  node: ">=20"
---

# Pharos Saga Executor

A deterministic, resumable skill for a three-step dependent workflow:

```text
APPROVE -> verify simulated receipt -> SWAP -> verify simulated receipt -> DEPOSIT -> verify simulated receipt
```

## Status and safety boundary (read this first)

> **This release is simulation-only.** `adapterId` is fixed to `simulated`.
> No wallet, private key, RPC endpoint, signature, broadcast or confirmation is
> used. Every receipt is branded `simulated: true`, `network: "simulated"`, uses
> a `sim_*` reference, and carries a disclaimer. No `0x` transaction hash or
> explorer link is produced.

The skill must **never**:

- claim that a transaction was sent, mined, confirmed or seen on-chain;
- ask for a private key, mnemonic, seed phrase, session token or `.env` secret;
- retry a submission whose outcome is unknown;
- describe compensation as a rollback;
- report a saga as `COMPLETED` when any step failed.

The hosted `ai.pharos.xyz` environment has no documented custom-skill
registration endpoint. This skill is installed into a local supported agent
(the `skills` CLI supports OpenCode) or invoked through its CLI. See
[`docs/environment.md`](docs/environment.md) for the actual inspection findings.

## When to use

- A user wants an approve/swap/deposit flow with verification between steps.
- A workflow needs pause/resume after a crash, with persisted state.
- A user asks how a transient failure is retried and a permanent failure is
  compensated.
- A reviewer wants a deterministic success and forced-failure demonstration.

Do not use it for live trading, real funds, token price queries, or any request
that requires a wallet. Use a verified testnet adapter only after one exists and
has been reviewed.

## Inputs

| Input | Meaning | Default |
| --- | --- | --- |
| `fromToken` | token approved and swapped | `PROS` (simulated label) |
| `toToken` | token received from swap | `USDC` (simulated label) |
| `depositToken` | token deposited; must match the swap output token | `USDC` |
| `amountIn` | positive decimal amount in simulated units | `100` |
| `owner` | simulated account label | `sim:demo-account` |
| `spender` | simulated approval spender | `sim:pharos-router` |
| `protocol` / `depositTarget` | simulated vault labels | `sim:pharos-vault` |
| `sagaId` | stable id; generated if omitted | generated |
| `clientRequestId` | optional saga-creation idempotency key | none |
| `retry.maxAttempts` | total attempts per step, 1–20 | `3` |
| `retry.baseDelayMs` | exponential backoff base | `100` |
| `retry.maxDelayMs` | backoff ceiling | `1000` |
| `retry.backoffFactor` | exponent | `2` |
| `compensationPolicy.onSwapFailure` | `REVOKE_APPROVAL` or `NONE` | `REVOKE_APPROVAL` |
| `compensationPolicy.onDepositFailure` | `SIMULATED_UNWIND_SWAP` or `NONE` | `SIMULATED_UNWIND_SWAP` |
| `scenario` | deterministic injected-fault preset | `success` |

All token and account names are **simulation labels**, not real addresses.

## Workflow contract

1. `CREATED -> APPROVAL_PENDING` is persisted; then `APPROVE` runs.
2. The `APPROVE` simulated receipt is verified independently. Only then does the
   saga become `APPROVED` and then `SWAP_PENDING`.
3. `SWAP` runs with the same stable idempotency key on every attempt. Its
   receipt is verified before `SWAPPED -> DEPOSIT_PENDING`.
4. `DEPOSIT` consumes the exact amount received from the verified swap. Its
   receipt is verified before `COMPLETED`.
5. A transient failure enters `RETRY_WAIT`, waits for the computed delay, then
   returns to the same pending step. Retries are bounded by `maxAttempts`.
6. A permanent `APPROVE` failure goes to `FAILED`; `SWAP`/`DEPOSIT` never start.
7. A permanent `SWAP` failure may run simulated approval revocation. A permanent
   `DEPOSIT` failure may run a simulated unwind swap (a **new trade**, not a
   rollback). If compensation is absent, unsupported, or fails, the saga goes to
   `MANUAL_RECOVERY_REQUIRED`.
8. An unknown submission outcome is reconciled once by idempotency key. If it
   cannot be proven, the saga goes to `MANUAL_RECOVERY_REQUIRED` with no retry
   and no compensation.

## Commands

From the skill repository:

```powershell
npm install
npm test

# fully successful simulated run
npm run demo:success

# deterministic transient retries -> permanent DEPOSIT failure -> simulated compensation
npm run demo:failure

# compensation failure -> MANUAL_RECOVERY_REQUIRED
npm run demo:manual

# unknown submission outcome -> no retry -> manual recovery
npm run demo:unknown

# build + tests + static safety scan
npm run verify
```

CLI:

```powershell
npm run cli -- start --id saga_my_run --amount 42
npm run cli -- inspect saga_my_run
npm run cli -- list
npm run cli -- audit saga_my_run
npm run cli -- run saga_my_run
```

Use `--state-dir <path>` to choose the persisted state directory (default
`./state`, git-ignored). Use `--json` for one machine-readable record.

## Install as a skill

Install the local directory into OpenCode:

```powershell
npx skills add . -a opencode -y
```

Or, after the repository is published:

```powershell
npx skills add https://github.com/wyka0/pharos-saga-executor -a opencode -y
```

The `skills` CLI copies/symlinks `SKILL.md` and the repository so the agent can
load this skill on demand. This is **not** a registration in the hosted
`ai.pharos.xyz` chat; that workflow is undocumented (see
[`docs/environment.md`](docs/environment.md)).

## Adapter boundary

The state machine depends only on `ChainAdapter`:

```ts
submit(step, context): Promise<Receipt>
reconcile(step, context): Promise<{ receipt, detail }>
supportsCompensation(action): boolean
compensate(context): Promise<CompensationResult>
```

`src/adapters/simulated.ts` is the only implementation. A future testnet adapter
must be idempotent by key, must throw `UnknownSubmissionOutcomeError` for
post-submission ambiguity, must reconcile before resubmitting, and must verify
its own receipts. The executor, states, persistence and audit format do not need
to change. `src/adapters/factory.ts` refuses any adapter id it does not know.

## Outputs

- `state/sagas/<sagaId>.json` — authoritative snapshot
- `state/sagas/<sagaId>.audit.ndjson` — audit mirror
- `state/simulated-ledger.json` — idempotency ledger for simulated receipts
- CLI text or `--json` record containing state, steps, receipts, failure,
  compensation and the full audit log

Generated state is git-ignored and must not be committed.

## Verification

- `npm test` covers success, dependency enforcement, receipt verification,
  transient retry, retry exhaustion, permanent failure in each step,
  compensation success/failure, unavailable compensation, manual recovery,
  duplicate/idempotent execution, persistence/resume, illegal transitions,
  audit ordering, unknown outcomes and safety.
- `npm run verify` also builds and runs `scripts/check-safety.mjs`.
- See [`docs/verified-output.md`](docs/verified-output.md) for exact commands
  and recorded results.
