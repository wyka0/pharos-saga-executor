# Testnet deployment tooling (gated)

TEST-ONLY MOCK CONTRACTS. TESTNET ONLY. NOT MAINNET. NOT A PHAROS PROTOCOL.

This page documents the separate, gated deployment path for the four
`TestOnly*` mock contracts on Pharos Atlantic testnet (chainId 688689).
It complements `docs/testnet-deployment-plan.md` (the read-only plan) and
`docs/local-anvil.md` (the local saga demo).

> **Status (2026-10-18): executed.** This gated path was approved and used on
> 2026-10-17: the four `TestOnly*` mock contracts plus the minter wiring are
> deployed (five transactions, all **CONFIRMED**; deployment plan hash
> `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`;
> deployment journal `.local/atlantic-deploy/deploy-journal.json`). The
> approved five-step saga then ran against these contracts - see
> [verified-output.md section 14](verified-output.md#iteration-7--atlantic-saga-execution).
> The tooling description below is unchanged and still accurate; the only
> superseded sentence is the pre-execution note in "Approval flow", labeled
> there. Test-only mocks only: tUSDC/tSAGA are not the official USDC
> (`0xcfC8...Fc8B`), which was never targeted.

## The five deployment transactions

The approved plan hash
`7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806` was
executed through the gated runner on **2026-10-17** (first `INTENT`
`2026-10-17T19:04:08Z`, last step confirmed `2026-10-17T19:04:25Z`): four
contract deployments plus the receipt-token minter wiring call - five
transactions, all `CONFIRMED` in the deployment journal
`.local/atlantic-deploy/deploy-journal.json` (a local, uncommitted record of
public transaction metadata only). Every receipt status is `success` -
`CONFIRMED` is only recorded after the receipt status, the deterministic
address, the runtime code and the getter checks pass - and the effective gas
price is 10 gwei for all five. The explorer links below are **constructed from
the recorded transaction hashes**; the gated runner verified receipts by
JSON-RPC, not via the explorer.

| # | Step | Kind | Nonce | Transaction hash (explorer link) | Block | Gas used | Receipt | Deployed contract | Journal |
| ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- | --- |
| 1 | `TestOnlyUSDC` | deploy | 13 | [`0xe888a4fb4c4041750b5a11c6e492f0345058e597bbcd70c4c46ac296e333b845`](https://atlantic.pharosscan.xyz/tx/0xe888a4fb4c4041750b5a11c6e492f0345058e597bbcd70c4c46ac296e333b845) | 31546759 | 625548 | success | `0x623F3575241827eb5aAb5592834632Ed67BB114C` | `CONFIRMED` |
| 2 | `TestOnlyReceiptToken` | deploy | 14 | [`0x5cb10014fb8fca1b92c39b8afc0483e7460a93ff86820bf0ac7ee3c73dcc6490`](https://atlantic.pharosscan.xyz/tx/0x5cb10014fb8fca1b92c39b8afc0483e7460a93ff86820bf0ac7ee3c73dcc6490) | 31546763 | 684262 | success | `0xCA7c0D2474f3868bbBa0902d33918b35Dad90b19` | `CONFIRMED` |
| 3 | `TestOnlySwap` | deploy | 15 | [`0x2e6820d2cc7ca4bec8c5c7d958cf6765252ccea36f8931286b7754753e534e06`](https://atlantic.pharosscan.xyz/tx/0x2e6820d2cc7ca4bec8c5c7d958cf6765252ccea36f8931286b7754753e534e06) | 31546767 | 580188 | success | `0xcF74d803da1C57CeE6Bb727B9646fDb42126414D` | `CONFIRMED` |
| 4 | `TestOnlyVault` | deploy | 16 | [`0xd662b5a5c767e1f0cf996183bcdbd4757109e9a52f4890d74756876de1b4ae21`](https://atlantic.pharosscan.xyz/tx/0xd662b5a5c767e1f0cf996183bcdbd4757109e9a52f4890d74756876de1b4ae21) | 31546772 | 536807 | success | `0xa16085FFC63F3BaB3D2c26b22Dc44B7421cEB64b` | `CONFIRMED` |
| 5 | `WireMinter` | wire | 17 | [`0x6e9e0b2550945503626c4bb4128cf7b07be6c142e2b7cf9ea9d6c985fe24bdbc`](https://atlantic.pharosscan.xyz/tx/0x6e9e0b2550945503626c4bb4128cf7b07be6c142e2b7cf9ea9d6c985fe24bdbc) | 31546776 | 44225 | success | `none` (wiring call) | `CONFIRMED` |

Total gas used by the five transactions: **2,471,030** - **0.0247103 PHRS**
(24710300000000000 wei at 10 gwei), within the plan's 0.05 PHRS operator
ceiling. The four deployed addresses are the plan's predicted CREATE
addresses; each deployment receipt was verified for status, deterministic
address, non-empty runtime code identical to the built artifact (immutable
slots masked) and the controller getters. `INTENT` was fsync-written before
every send; exactly one send per step; no resends were needed; no `UNKNOWN` or
`REVERTED` entry exists.

Rows 1-4 are the four contract deployments; row 5 sent only the wiring call -
it deployed no contract and made `TestOnlySwap` the minter of
`TestOnlyReceiptToken` (getters verified: swap is the minter, the controller is
not). All five transactions are **test-only mock activity** on Atlantic
testnet (chainId 688689): a mock token pair (tUSDC / tSAGA), a mock swap and a
mock vault - **no official protocol was deployed**, and the official USDC
token (`0xcfC8...Fc8B`) was never targeted.

The approved five-step saga then ran against these contracts - five more
confirmed transactions - recorded in
[`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution).

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

Nothing in this repository had been broadcast at the time of writing: the
Atlantic run had not yet been executed or authorized.

> **Update (2026-10-18):** this sentence is the pre-execution record; it is
> superseded - the plan hash was explicitly approved and the gated runner
> executed all five deployment transactions on 2026-10-17, all CONFIRMED (see
> the status note at the top of this page and
> [`verified-output.md` section 14](verified-output.md#iteration-7--atlantic-saga-execution)).

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
