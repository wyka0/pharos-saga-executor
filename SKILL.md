---
name: pharos-saga-executor
description: >
  Run a resumable, receipt-verified APPROVE -> SWAP -> DEPOSIT workflow as one
  saga, with bounded retries, explicit compensation, and a timestamped audit
  log. Use when a user asks for a multi-step dependent Pharos transaction
  workflow, a safe approve/swap/deposit sequence, saga recovery, retry policy,
  compensation after a permanent step failure, or an inspectable state machine.
  SIMULATION by default. A separate, gated Pharos Atlantic testnet path is
  included but refuses to sign without an exact approved plan hash; it never
  touches mainnet. Under explicit plan-hash approvals, clearly labelled
  test-only mock contracts and a five-step demo saga were deployed and executed
  on Atlantic testnet (chainId 688689) - not a production protocol. A test-only
  local Anvil validation path (chainId 31337) is included as well.
  Trigger phrases: pharos saga, approve swap deposit, dependent
  transaction workflow, saga executor, resume a failed swap, compensate a
  failed deposit, manual recovery required, testnet approval plan.
version: 0.2.0
license: MIT
metadata:
  author: wyka0
  simulated: true
  testnet: atlantic-688689
  mainnet: never
  live_transaction_executed: true # test-only mocks on Atlantic testnet (chainId 688689); never mainnet
  node: ">=20"
---

# Pharos Saga Executor

A deterministic, resumable skill for a three-step dependent workflow:

```text
APPROVE -> verify receipt -> SWAP -> verify receipt -> DEPOSIT -> verify receipt
```

The default adapter is simulated. The official-protocol Atlantic testnet
adapter is still blocked by the missing verified protocol prerequisite; the
separately approved test-only mock deployment and saga have executed on
Atlantic (see below).

## Status and safety boundary (read this first)

> **Default path: SIMULATION ONLY.** No wallet, private key, RPC endpoint, signature,
> broadcast or confirmation is used by the demos. Simulated receipts are branded
> `simulated: true` and use `sim_*` references. The simulated proofs are not
> blockchain evidence.
>
> **Testnet path: Atlantic only (chainId 688689).** It requires an explicit plan
> hash approval plus a CLI confirmation gate. It rejects any other chain,
> including mainnet 1672. The **official-protocol** plan remains blocked (the
> wallet holds 20 test USDC, but no officially documented Atlantic DEX/router or
> vault exists) and that path has never sent a transaction. Separately, under
> explicit approvals, the gated runners deployed and executed a **test-only**
> mock deployment + five-step saga on Atlantic testnet - ten transactions, all
> confirmed - recorded in `docs/verified-output.md` section 14.
>
> **Local validation path: TEST-ONLY (chainId 31337).** `npm run demo:local`
> runs the real executor against a disposable local Anvil chain with clearly
> labelled `TestOnly*` mock contracts. `npm run demo:deploy-tooling` (six
> scenarios) and `npm run demo:saga-tooling` (eight scenarios) exercise the
> gated deployment and saga runners on the same kind of throwaway chains with
> no keys. These are real executions on throwaway chains, not simulation flags.
> The same runners were approved and executed against Atlantic testnet with the
> test-only mocks (deployment + saga, all confirmed) - `docs/verified-output.md`
> section 14; `docs/testnet-deployment-plan.md`,
> `docs/testnet-deployment-tooling.md`, `docs/testnet-saga-tooling.md`.

The skill must **never**:

- touch mainnet funds or mainnet RPC endpoints;
- claim that a transaction was sent, mined, confirmed or seen on-chain unless a
  real receipt was verified;
- ask for a private key, mnemonic, seed phrase, session token or `.env` secret in
  chat; testnet signing keys are read only from a user-controlled local env file;
- print, log or commit secret values;
- approve an unlimited allowance or an arbitrary spender;
- retry a submission whose outcome is unknown;
- describe compensation as a rollback;
- report a saga as `COMPLETED` when any step failed;
- call a simulated or mocked result "live testnet evidence".

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

Do not use it for mainnet, live trading, real funds, token price queries, or any
request that requires a mainnet wallet. The included testnet adapter is
Atlantic-only and read-only until a plan is explicitly approved.

## Inputs

| Input | Meaning | Default |
| --- | --- | --- |
| `fromToken` | token approved and swapped | `PROS` (simulated label) / `USDC` (testnet) |
| `toToken` | token received from swap | `USDC` (simulated label) |
| `depositToken` | token deposited; must match the swap output token | `USDC` |
| `amountIn` | positive decimal amount | `100` simulated / `0.01` testnet CLI |
| `owner` | simulated account label | `sim:demo-account` |
| `spender` | approval spender; testnet must be a configured verified protocol | `sim:pharos-router` |
| `protocol` / `depositTarget` | vault labels | `sim:pharos-vault` |
| `sagaId` | stable id; generated if omitted | generated |
| `clientRequestId` | optional saga-creation idempotency key | none |
| `retry.maxAttempts` | total attempts per step, 1–20 | `3` |
| `retry.baseDelayMs` / `maxDelayMs` / `backoffFactor` | backoff | `100` / `1000` / `2` |
| `compensationPolicy.onSwapFailure` | `REVOKE_APPROVAL` or `NONE` | `REVOKE_APPROVAL` |
| `compensationPolicy.onDepositFailure` | `SIMULATED_UNWIND_SWAP` or `NONE` | `SIMULATED_UNWIND_SWAP` |
| `scenario` | deterministic simulated fault preset | `success` |
| `adapterId` | `simulated`, `pharos-testnet` or `local-anvil` (test-only, chainId 31337) | `simulated` |
| `testnet` | verified network/token/protocol config (no secrets) | none |

All simulated token and account names are **labels**, not real addresses.
Testnet config uses real public addresses and documentation provenance strings.

## Workflow contract

1. `CREATED -> APPROVAL_PENDING` is persisted; then `APPROVE` runs.
2. The `APPROVE` receipt is verified independently. Only then does the saga
   become `APPROVED` and then `SWAP_PENDING`.
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
9. On testnet, an `INTENT` journal entry is written before send; a missing hash is
   an unknown outcome and is never resubmitted. An on-chain receipt must pass
   chain, tx, confirmation and postcondition checks before the next step.

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

# test-only real transactions on a disposable local Anvil chain (chainId 31337)
npm run demo:local

# six-scenario safety check of the gated deployment runner (local chains only)
npm run demo:deploy-tooling

# eight-scenario safety check of the gated saga runner (local chains only)
npm run demo:saga-tooling

# read-only Atlantic plans for the TestOnly* mocks; send nothing
npm run testnet:deploy-plan -- --env-file <local-env> --address <wallet-address>
npm run testnet:saga-plan -- --env-file <local-env> --address <wallet-address>

# ONLY after explicit approval of the plan hash - these SIGN AND BROADCAST:
# npm run testnet:deploy -- --mode atlantic --env-file <local-env> `
#   --address <wallet-address> --approve-plan <hash> --confirm-atlantic-testnet
# npm run testnet:saga -- --mode atlantic --env-file <local-env> `
#   --address <wallet-address> --approve-plan <hash> --confirm-atlantic-testnet

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

Gated testnet commands (Atlantic chainId 688689 only):

```powershell
# read-only: wallet/token/protocol readiness; no signing key read
npm run testnet:readiness -- --env-file <local-env> `
  --address <wallet-address> --token USDC --amount 0.01

# read-only: produce an exact plan and hash; sends nothing
npm run testnet:plan -- --env-file <local-env> `
  --address <wallet-address> --id saga_testnet_plan --token USDC --amount 0.01

# only after explicit review of the exact plan hash
npm run testnet:run -- <saga-id> --env-file <local-env> `
  --approval-hash <plan-hash> --confirm-atlantic-testnet
```

`--env-file` points to a user-controlled local file. Only variable **names** are
documented (`RPC_URL`, `PRIVATE_KEY`); values are never printed or committed.
`testnet:readiness` and `testnet:plan` do not read the signing key when
`--address` is supplied. `testnet:run` has two independent gates: the exact plan
hash and `--confirm-atlantic-testnet`.

At present the **official-protocol** plan is not executable (zero transactions)
because there is no verified Atlantic router/vault. The wallet holds 20 test
USDC, but there is still no verified spender, so that plan contains zero
transactions. Do not fabricate a live run; the only executed run is the
test-only mock deployment + saga recorded in `docs/verified-output.md` section
14.

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

`src/adapters/simulated.ts` and `src/adapters/pharosTestnet.ts` both implement
this interface. The testnet adapter:

- verifies `eth_chainId === 688689` before planning, sending or compensating;
- refuses mainnet and any unverified chain;
- requires an explicit `PlanApproval` hash that matches the current plan;
- writes an INTENT journal entry before broadcast;
- never resubmits an INTENT/BROADCAST/UNKNOWN key;
- preserves tx hashes and reconciles by idempotency key;
- returns a distinct `OnChainReceipt` type, never a simulated one;
- only supports `REVOKE_APPROVAL` compensation, and only with its own approved
  plan.

The executor, states, persistence format and audit format are unchanged.
`src/adapters/factory.ts` refuses any adapter id it does not know and requires
testnet client/journal dependencies for `pharos-testnet`.

## Outputs

- `state/sagas/<sagaId>.json` — authoritative snapshot
- `state/sagas/<sagaId>.audit.ndjson` — audit mirror
- `state/simulated-ledger.json` — idempotency ledger for simulated receipts
- `state/testnet-journal.json` — INTENT/BROADCAST/CONFIRMED/REVERTED/UNKNOWN
  journal for testnet transactions (public metadata only)
- CLI text or `--json` record containing state, steps, receipts, failure,
  compensation and the full audit log

Generated state is git-ignored and must not be committed.

## Verification

- `npm test` covers success, dependency enforcement, receipt verification,
  transient retry, retry exhaustion, permanent failure in each step,
  compensation success/failure, unavailable compensation, manual recovery,
  duplicate/idempotent execution, persistence/resume, illegal transitions,
  audit ordering, unknown outcomes, testnet readiness/plan gating, reverted and
  unknown sends, postconditions, read retries, mainnet rejection, local-anvil
  configuration/receipt/journal rules, the deploy tooling (plan hash, runtime
  verification, INTENT journal), the saga tooling (golden plan hash and
  calldata, journal semantics, deployment-journal address resolution) and
  safety (103 tests).
- `npm run verify` also builds and runs `scripts/check-safety.mjs`, which now
  also enforces that the local-anvil files never target Atlantic/mainnet, that
  the plan scripts have no send/sign path, and that the gated runners keep
  their invariants (INTENT journal, PHRS ceilings, confirmation flag,
  runtime-code verification, calldata-hash binding, official-USDC guard, lazy
  key load).
- Foundry (`contracts/test/*.t.sol`, 16 tests), the four-scenario local Anvil
  session, the six-scenario deploy-tooling check and the eight-scenario
  saga-tooling check are documented in
  [`docs/local-anvil.md`](docs/local-anvil.md) and
  [`docs/testnet-saga-tooling.md`](docs/testnet-saga-tooling.md).
- See [`docs/verified-output.md`](docs/verified-output.md) (section 14 is the
  executed Atlantic run), [`docs/testnet-readiness.md`](docs/testnet-readiness.md),
  [`docs/testnet-results.md`](docs/testnet-results.md),
  [`docs/testnet-deployment-plan.md`](docs/testnet-deployment-plan.md),
  [`docs/testnet-deployment-tooling.md`](docs/testnet-deployment-tooling.md) and
  [`docs/testnet-saga-tooling.md`](docs/testnet-saga-tooling.md) for exact
  commands and recorded results.
