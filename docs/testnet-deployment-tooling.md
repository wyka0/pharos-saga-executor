# Testnet deployment tooling (gated)

TEST-ONLY MOCK CONTRACTS. TESTNET ONLY. NOT MAINNET. NOT A PHAROS PROTOCOL.

This page documents the separate, gated deployment path for the four
`TestOnly*` mock contracts on Pharos Atlantic testnet (chainId 688689).
It complements `docs/testnet-deployment-plan.md` (the read-only plan) and
`docs/local-anvil.md` (the local saga demo).

## Files

| File | Role |
| --- | --- |
| `src/testnet/deployPlan.ts` | read-only shared plan core: steps, gas caps, artifact hashing, plan hash |
| `src/testnet/deploy/verify.ts` | pure helpers: runtime-code masking vs `immutableReferences`, intrinsic gas, loopback URL validation, log scrubbing |
| `src/testnet/deploy/journal.ts` | durable deployment journal (`INTENT` written before any send) |
| `src/testnet/deploy/runner.ts` | the only send path: gates + one send per step + receipt/bytecode/address verification |
| `scripts/testnet-deploy.ts` | gated CLI (`--mode atlantic` / `--mode local-anvil`) |
| `scripts/local-deploy-check.ts` | six-scenario Anvil safety check (`npm run demo:deploy-tooling`) |

Static guarantees enforced by `scripts/check-safety.mjs` and
`test/safety.test.ts`: the shared plan module contains no send/sign/secret
path, the runner journals `INTENT`, enforces the PHRS hard ceiling, requires
the explicit Atlantic confirmation flag and verifies deployed runtime code,
and the only script allowed to send (the CLI) is excluded from the
offline-simulation scan while still being checked for mainnet targets and
key literals.

## Order of operations (atlantic mode)

1. **Force rebuild** - `forge build --force` through WSL; any failure aborts
   before a single network call is made.
2. **Plan-hash gate** - the runner recomputes the plan core from the freshly
   built artifacts and refuses to continue unless it equals
   `--approve-plan <hash>`.
3. **Confirmation gate** - refuses to run without `--confirm-atlantic-testnet`.
4. **Chain guard** - refuses any chainId other than 688689.
5. **State re-read** - pending nonce, gas price and balance are read fresh;
   worst-case cost (total gas cap x gas price) must stay under the hard
   0.05 PHRS ceiling and be covered by the balance.
6. **Signer gate** - the signing key is loaded lazily *after* all of the above,
   immediately before the first send; the derived address must match the
   approved `--address`, otherwise the run stops without signing.
7. **Per step (4 deploys + 1 minter wiring):**
   - an `INTENT` journal entry is fsync-written before anything is signed;
   - exactly one send per step; no retries, no automatic resends;
   - receipt wait with timeout - a timeout is an **UNKNOWN** outcome and is
     never resent;
   - a reverted receipt stops the run (**REVERTED**);
   - success requires: status success, deterministic address match,
     non-empty runtime code, runtime code identical to the artifact outside
     the immutable slots, and controller / wiring getter checks.
8. **Summary** - addresses, total gas used, total wei spent, journal path.

## Failure semantics

| Outcome | Journal status | Runner behaviour |
| --- | --- | --- |
| send raises (ambiguous) | UNKNOWN | stop; never resent |
| receipt timeout | UNKNOWN | stop; never resent |
| on-chain revert | REVERTED | stop; never resent |
| address / bytecode / immutable mismatch | UNKNOWN | stop; never resent |
| unresolved journal entry for the same plan hash | - | refuses to touch that step |

Re-running with the same plan hash resumes only from `CONFIRMED` entries; an
unresolved entry blocks the step until a human reconciles it on-chain.

## Approval flow

1. `npm run testnet:deploy-plan -- --env-file <path> --address <deployer>`
   prints the plan hash (read-only; never reads the key).
2. Review the plan and approve the hash explicitly.
3. `npm run testnet:deploy -- --mode atlantic --env-file <path>
   --address <deployer> --approve-plan <hash> --confirm-atlantic-testnet`.

Nothing in this repository has been broadcast: the Atlantic run has not been
executed or authorized yet.

## Local tooling tests

`npm run demo:deploy-tooling` drives the exact same runner against disposable
Anvil chains (localhost only, node-signed unlocked accounts, no keys):

| Scenario | Injection | Expected behaviour |
| --- | --- | --- |
| A happy path | none | 4 deploys + wiring all CONFIRMED and verified; a second account can neither mint nor change settings |
| B wrong chain | chainId 5 | refusal before any send; no journal is even created |
| C forced revert | low gas for the receipt token | REVERTED entry; no further sends |
| D ambiguous outcome | `--no-mining` node + short timeout | UNKNOWN entry; exactly one broadcast; after mining still exactly one tx |
| E1 runtime-bytecode mismatch | corrupt runtime byte on the vault init code | the masked bytecode comparison stops the run before the wiring transaction |
| E2 tampered immutable slot | corrupt immutable-template byte | masked comparison ignores slots by design, so the getter checks catch the tampered `controller` value |

Results are recorded in `docs/local-anvil.md`.
