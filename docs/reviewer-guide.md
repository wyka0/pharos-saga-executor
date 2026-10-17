# Reviewer guide — Task 5 submission

This is the short path for reviewing the **Saga Executor** submission.

> ## What is and is not real
>
> - **The demos are simulated.** They do not use a wallet, private key, RPC
>   endpoint, signature, broadcast or real funds. Every receipt is branded
>   `simulated: true` and uses a `sim_*` reference.
> - **No live on-chain saga has executed.** There is no transaction hash to open
>   on an explorer, and none is claimed.
> - The separate Atlantic testnet adapter is **read-only and blocked** at the
>   readiness stage: the wallet holds 20 test USDC, but no official Atlantic
>   router/vault exists and the plan is blocked at the spender check. See
>   [`testnet-readiness.md`](testnet-readiness.md).
> - **Test-only local validation was added.** Clearly labelled `TestOnly*` mock
>   contracts and a disposable local Anvil chain (chainId 31337) run the real
>   executor with real local transactions (`npm run demo:local`). This is not
>   Atlantic or mainnet evidence.
> - **An Atlantic deployment plan is prepared but not executed.** No `TestOnly*`
>   contract has been deployed to Atlantic; nothing was signed or broadcast. See
>   [`testnet-deployment-plan.md`](testnet-deployment-plan.md).

## 1. Requirements

- Node.js **20+** (verified on Node 24.14.1)
- npm
- No wallet, API key, `.env`, RPC endpoint or network access

```powershell
cd C:\pharos-saga-executor
npm install
```

## 2. Five-minute reproduction

```powershell
# 87 tests + build + static safety gate
npm run verify

# Success: APPROVE -> SWAP -> DEPOSIT
npm run demo:success

# Forced failure: 2 transient retries then permanent DEPOSIT failure,
# followed by the configured simulated unwind compensation
npm run demo:failure

# Compensation itself fails -> MANUAL_RECOVERY_REQUIRED
npm run demo:manual

# Unknown submission outcome -> no retry, no compensation, manual recovery
npm run demo:unknown

# Optional test-only local chain validation (requires Foundry in WSL):
# real local transactions, 4 scenarios, chainId 31337 only
npm run demo:local

# Optional read-only Atlantic deployment plan (no signing, no broadcast)
npm run testnet:deploy-plan -- --env-file <local-env> --address <wallet-address>
```

Expected terminal states:

| Command | Final state | What it proves |
| --- | --- | --- |
| `npm run demo:success` | `COMPLETED` | all three dependent steps verified in order |
| `npm run demo:failure` | `FAILED` | bounded retry, permanent failure, simulated compensation success |
| `npm run demo:manual` | `MANUAL_RECOVERY_REQUIRED` | compensation failure is recorded separately |
| `npm run demo:unknown` | `MANUAL_RECOVERY_REQUIRED` | unknown outcome is not blindly retried |

Each demo prints the full state and timestamped audit log. Exact captured logs
are in [`verified-output.md`](verified-output.md).

## 3. Inspect persisted state and audit

The demos write to git-ignored `.demo-state/<name>/`:

```powershell
npm run cli -- list --state-dir .demo-state/success
npm run cli -- inspect saga_demo_success --state-dir .demo-state/success
npm run cli -- audit saga_demo_success --state-dir .demo-state/success
npm run cli -- inspect saga_demo_failure --state-dir .demo-state/failure
```

Look for:

- `State: COMPLETED` only after all three receipts verify;
- `RETRY_SCHEDULED` events with 75 ms and 150 ms deterministic delays in the
  failure demo;
- `TRANSITION DEPOSIT_PENDING -> COMPENSATING` and
  `COMPENSATION_SUCCEEDED` after the permanent failure;
- `MANUAL_RECOVERY_REQUIRED` when compensation fails or an outcome is unknown;
- no `COMPLETED` state for a failed saga;
- no `0x` transaction hash and no explorer link in simulated receipts.

## 4. Skill packaging

`SKILL.md` has valid YAML front matter and is recognized by the `skills` CLI.
Validated without installing globally:

```powershell
npx --yes skills@1.7.2 add . --list
# Local path validated
# Found 1 skill: pharos-saga-executor
```

Install into OpenCode from this local directory:

```powershell
npx skills add . -a opencode -y
```

After the GitHub repository is published:

```powershell
npx skills add https://github.com/wyka0/pharos-saga-executor -a opencode -y
```

The hosted `ai.pharos.xyz` surface has no documented custom-skill registration
endpoint; installation is local via the `skills` CLI. See
[`environment.md`](environment.md).

## 5. Requirement map

| Requirement | Evidence |
| --- | --- |
| Three dependent receipt-verified steps | success demo + `test/executor-success.test.ts` |
| Transient retry policy | 75/150 ms retries in `demo:failure`; `test/retry.test.ts` |
| Compensation/recovery path | `demo:failure`, `demo:manual`, `test/failure.test.ts` |
| State log at all times | timestamped audit in every demo; `test/audit.test.ts` |
| Success + forced-failure demonstration | `demo:success`, `demo:failure` |
| Persistence/resume | `test/persistence.test.ts` |
| Duplicate/idempotent execution | `test/persistence.test.ts` |
| No blind retry of unknown outcome | `demo:unknown`, `test/failure.test.ts` |
| Real transaction path (test-only local chain) | `npm run demo:local`, `contracts/test/*.t.sol`, `docs/local-anvil.md` |
| Atlantic deployment prepared without sending | `npm run testnet:deploy-plan`, `docs/testnet-deployment-plan.md`, plan hash |
| Simulation honesty | `test/safety.test.ts`, `scripts/check-safety.mjs` |
| Skill packaging | `SKILL.md`, `npx skills ... --list` |

## 6. Current verification result

```text
npm run verify
87 tests, 87 pass, 0 fail
SAFETY GATE PASSED
exit code 0
```

The original 61 simulation tests remain green; the suite later grew to 80 with
the gated testnet adapter, then to **87** with local-anvil coverage (6 offline
local tests, 1 additional isolation test) while keeping every earlier test
passing. On top of that: **8 Foundry tests** pass locally and the **4-scenario
local Anvil session** (`npm run demo:local`) passes.

## 7. Submission status

| Item | Status |
| --- | --- |
| Code and tests | complete locally |
| Simulation demos | all four PASS |
| Skill packaging | validated; 1 skill discovered |
| GitHub repo | **not published** (`api.github.com/repos/wyka0/pharos-saga-executor` → 404) |
| Live on-chain saga | **none executed** (Atlantic swap/vault still missing) |
| Test-only local chain validation | added and passing (chainId 31337, clearly labelled mocks) |
| Foundry toolchain | available in WSL Ubuntu (1.2.3-stable), documented in `docs/local-anvil.md` |
| Atlantic deployment plan | prepared, read-only, **not executed**; awaiting explicit hash approval |
| Video | optional, not produced |
| Agent Arena submission | not submitted |

## 8. Remaining blockers

1. **GitHub publication** is required for the repository link. The local remote
   is configured but nothing has been pushed.
2. **No live Atlantic proof link exists.** The live plan is blocked by the
   missing official Atlantic router/vault; no tx hash is fabricated. The only
   real transactions so far are on a disposable local Anvil chain.
3. **Atlantic deployment is not approved.** The plan hash
   `cf458108d271c3a3f9cc9b7daa96de37bf499405cf2b8e39d5ef975bc540d691` requires
   separate explicit approval, and a reviewed deploy script does not exist yet.
4. Optional +50 video is not produced.

No deployment, push or Agent Arena submission was performed.
