# Reviewer guide — Task 5 submission

This is the short path for reviewing the **Saga Executor** submission.

> ## What is and is not real
>
> - **The demos are simulated.** They do not use a wallet, private key, RPC
>   endpoint, signature, broadcast or real funds. Every receipt is branded
>   `simulated: true` and uses a `sim_*` reference.
> - **A live on-chain saga has now executed - on Atlantic testnet only.** The
>   approved saga plan
>   `8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f` was
>   executed on **Pharos Atlantic Testnet, chain ID 688689**, against the
>   deployed `TestOnly*` mock contracts; **all five transactions were
>   confirmed**. This is a testnet run using test-only contracts and tokens -
>   not a mainnet deployment and not a production protocol execution.
>   Transaction hashes, receipts, final postconditions and gas totals:
>   [`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).
> - The separate **official-protocol** Atlantic testnet adapter is still
>   **read-only and blocked** at the readiness stage: the wallet holds 20 test
>   USDC, but no officially documented Atlantic router/vault exists and that
>   plan is blocked at the spender check. The executed saga above does not use
>   this path; it targets the test-only mock contracts instead. See
>   [`testnet-readiness.md`](testnet-readiness.md).
> - **Test-only local validation was added.** Clearly labelled `TestOnly*` mock
>   contracts and a disposable local Anvil chain (chainId 31337) run the real
>   executor with real local transactions (`npm run demo:local`). Safety checks
>   of the gated deployment runner (`npm run demo:deploy-tooling`, six
>   scenarios) and of the gated saga runner (`npm run demo:saga-tooling`, eight
>   scenarios) run on the same kind of throwaway chains. This local validation
>   is not Atlantic or mainnet evidence; the only live run is the test-only
>   Atlantic execution above.
> - **The Atlantic test-only deployment is executed.** The deployment plan
>   (hash `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`)
>   was approved and the gated deployment runner deployed the four `TestOnly*`
>   mock contracts and the minter wiring - five transactions, all confirmed.
>   The approved saga above then ran against them. See
>   [`testnet-deployment-tooling.md`](testnet-deployment-tooling.md),
>   [`testnet-deployment-plan.md`](testnet-deployment-plan.md) and
>   [`testnet-saga-tooling.md`](testnet-saga-tooling.md).

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
# 103 tests + build + static safety gate
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

# Optional gated deploy-tooling check (local chains only): 6 scenarios,
# wrong-chain refusal, forced revert, ambiguous outcome, bytecode mismatch
npm run demo:deploy-tooling

# Optional gated saga-tooling check (local chains only): 8 scenarios,
# plan-hash gate, INTENT journal, no resend, calldata-hash binding
npm run demo:saga-tooling

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

The full requirement-by-requirement matrix — implementation file + function,
test names, demo command and saved evidence file for each of the five Arena
requirements — is [`requirements-matrix.md`](requirements-matrix.md).

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
| Atlantic test-only execution (deployment + saga, all confirmed) | `docs/verified-output.md` section 14, `docs/testnet-saga-tooling.md`, `docs/testnet-deployment-tooling.md` |
| Gated deployment safety (plan-hash gate, INTENT journal, no resend, bytecode verification) | `npm run demo:deploy-tooling`, `docs/testnet-deployment-tooling.md` |
| Gated saga safety (plan-hash gate, INTENT journal, no resend, calldata-hash binding) | `npm run demo:saga-tooling`, `docs/testnet-saga-tooling.md` |
| Simulation honesty | `test/safety.test.ts`, `scripts/check-safety.mjs` |
| Skill packaging | `SKILL.md`, `npx skills ... --list` |

## 6. Current verification result

```text
npm run verify
103 tests, 103 pass, 0 fail
SAFETY GATE PASSED
exit code 0
```

The original 61 simulation tests remain green; the suite later grew to 80 with
the gated testnet adapter, then to 87 with local-anvil coverage, then to 95
with the deploy-tooling tests, and to **103** with the saga-tooling tests
(8 new offline tests), while keeping every earlier test passing. On top of
that: **16 Foundry tests** pass locally (7 saga + 8 authorization + 1 gas
measurement), the **4-scenario local Anvil session** (`npm run demo:local`)
passes, the **6-scenario deploy-tooling check** (`npm run demo:deploy-tooling`)
passes, and the **8-scenario saga-tooling check** (`npm run demo:saga-tooling`)
passes. The executed test-only Atlantic run (five confirmed transactions) is
recorded in
[`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).

## 7. Submission status

| Item | Status |
| --- | --- |
| Code and tests | complete locally |
| Simulation demos | all four PASS |
| Skill packaging | validated; 1 skill discovered |
| GitHub repo | **published** — `https://github.com/wyka0/pharos-saga-executor` (main @ `b3fc8cafe9b795d0b745f130f0f32c9d30316bcd`, pushed 2026-10-18) |
| Live on-chain saga | **executed on Pharos Atlantic Testnet (chainId 688689)** - all five transactions confirmed; test-only contracts; see `verified-output.md` section 14 |
| Test-only local chain validation | added and passing (chainId 31337, clearly labelled mocks) |
| Foundry toolchain | available in WSL Ubuntu (1.2.3-stable), documented in `docs/local-anvil.md` |
| Atlantic test-only deployment | **executed** - four `TestOnly*` mock contracts + minter wiring deployed (five transactions, all confirmed) |
| Gated deployment tooling | implemented and locally tested (6/6 scenarios); **executed against Atlantic** (deployment above) |
| Gated saga tooling | implemented and locally tested (8 scenarios, 81 checks); **executed against Atlantic** (5/5 CONFIRMED) |
| Video | optional, not produced |
| Agent Arena submission | **not submitted** — submission requires GitHub sign-in on the task page; no public submission record exists |

## 8. Remaining blockers

1. **Agent Arena submission is not yet made.** Submission requires signing in
   with GitHub on the task page
   (`https://pharos-agent-arena.vercel.app/tasks/saga-executor`); the repository
   link is ready: `https://github.com/wyka0/pharos-saga-executor`.
2. **No officially documented Atlantic protocol exists.** No Atlantic
   router/vault is listed by Pharos, so the official-protocol adapter plan
   remains blocked at the spender check and no protocol proof link exists; no
   tx hash is fabricated. The live evidence is the separately approved
   test-only deployment and saga (chainId 688689) - see section 14 of
   [`verified-output.md`](verified-output.md#iteration-7--atlantic-saga-execution).
3. **Testnet-only scope.** The executed runs used `TestOnly*` mock contracts
   and test tokens on Atlantic testnet; a mainnet deployment and a production
   protocol execution remain out of scope and were never approved. (The
   deployment plan
   `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806` and the
   saga plan
   `8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f`
   were explicitly approved and executed through their gated runners.)
4. Optional +50 video is not produced.

No mainnet deployment or Agent Arena submission was performed; the repository is
published on GitHub (main @ `b3fc8cafe9b795d0b745f130f0f32c9d30316bcd`), and the
only on-chain activity is the test-only Atlantic execution recorded in
[`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).
