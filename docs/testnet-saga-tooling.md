# Testnet saga tooling (gated)

TEST-ONLY MOCK SAGA. TESTNET ONLY. NOT MAINNET. NOT A PHAROS PROTOCOL.

This page documents the gated five-step saga runner that exercises the deployed
`TestOnly*` mock contracts on Pharos Atlantic testnet (chainId 688689):
mint exactly 1.000000 tUSDC (skipped only when the balance is already exactly
1.000000; any other balance stops the run before signing) -> approve 1 tUSDC to
the swap -> swap for exactly 0.990000 tSAGA (min out enforced by the rate) ->
approve 0.99 tSAGA to the vault -> deposit 0.99 tSAGA. It complements
`docs/testnet-deployment-tooling.md` (the deployment path) and
`docs/local-anvil.md` (the local saga demo). The official USDC token is never
targeted: its address is loaded as a read-only guard and its deployer balance
must remain unchanged.

## Files

| File | Role |
| --- | --- |
| `src/testnet/sagaPlan.ts` | read-only shared plan core: steps, calldata, gas caps, plan hash, deploy-journal address resolution |
| `src/testnet/saga/verify.ts` | shared read-only checks: runtime code, wiring, per-step pre/postconditions, end-of-saga battery |
| `src/testnet/saga/journal.ts` | durable saga journal (`INTENT` written before any send) |
| `src/testnet/saga/runner.ts` | the only send path: gates + one send per step + receipt/calldata-hash/postcondition verification |
| `scripts/testnet-saga.ts` | gated CLI (`--mode atlantic` / `--mode local-anvil`) |
| `scripts/testnet-saga-plan.ts` | read-only plan printer (`npm run testnet:saga-plan`); never reads a key |
| `scripts/local-saga-check.ts` | eight-scenario Anvil safety check (`npm run demo:saga-tooling`) |

Static guarantees enforced by `scripts/check-safety.mjs` and
`test/safety.test.ts`: the shared plan module contains no send/sign/secret
path, the runner journals `INTENT`, enforces the 0.02 PHRS ceiling, requires
the explicit Atlantic confirmation flag, verifies deployed runtime code,
binds every receipt to the journaled calldata hash, and keeps the official
USDC guard. Addresses are resolved from the durable deployment journal, never
from flags.

## Reviewed plan (approved and executed)

The reviewed plan hash is
`8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f`
for deployer `0xE2B8651178ade144003537eA509E37877dba40bb` and the four
CONFIRMED deployment-journal contracts. The runner refuses to send anything
unless its freshly rebuilt plan serializes to exactly the approved hash.

This hash was explicitly approved and executed against Atlantic testnet
(chainId 688689): all five steps were confirmed in five transactions
(blocks 31550624-31550646, total gas 365623, 0.00365623 PHRS spent). The full
execution record - transaction hashes, nonces, blocks, receipts, journal
statuses and the final verified state - is in
[verified-output.md section 14](verified-output.md#iteration-7--atlantic-saga-execution).

| # | Step | Target | Gas cap | Notes |
| --- | --- | --- | --- | --- |
| 1 | MintTusdc | tUSDC | 150000 | conditional: balance exactly 0 mints exactly 1.000000; exactly 1.000000 skips; any other balance stops before signing |
| 2 | ApproveTusdcToSwap | tUSDC | 120000 | exact 1.000000 tUSDC allowance |
| 3 | SwapTusdcForReceipt | swap | 200000 | min receipt out 0.990000 (contract-enforced rate) |
| 4 | ApproveReceiptToVault | tSAGA | 120000 | exact 0.990000 tSAGA allowance |
| 5 | DepositReceiptToVault | vault | 250000 | exact 0.990000 tSAGA, min shares 0.99 |

Total gas cap: 840000. Absolute operator ceiling: 0.02 PHRS
(`SAGA_CEILING_WEI`), re-checked against the live gas price before every run.

## Mint step policy (exact)

The mint step has exactly two approved pre-states; anything else stops the run
before a signature, broadcast or journal write:

| tUSDC balance at the check | Behaviour |
| --- | --- |
| `0` | sends `mint(deployer, 1000000)` - exactly 1.000000 tUSDC |
| exactly `1000000` | step skipped: no transaction, no nonce consumed, no journal entry |
| any other value | run stops; re-run the plan and re-review before doing anything else |

The `conditional` string stored inside the hashed plan core describes only the
skip case. It is part of the byte-frozen approved core (changing it would
change the plan hash) and never drives what is sent. The strict three-branch
check above is enforced by `src/testnet/saga/runner.ts` outside the hashed plan
core, so enforcing it leaves the reviewed plan hash unchanged.

## Order of operations (atlantic mode)

1. **Force rebuild** - `forge build --force` through WSL; any failure aborts
   before a single network call is made.
2. **Plan-hash gate** - the runner recomputes the plan core from the freshly
   built artifacts and the journal-resolved addresses and refuses to continue
   unless it equals `--approve-plan <hash>`.
3. **Confirmation gate** - refuses to run without `--confirm-atlantic-testnet`.
4. **Chain guard** - refuses any chainId other than 688689.
5. **State re-read** - pending nonce, gas price and balance are read fresh;
   worst-case cost (840000 gas x gas price) must stay under the 0.02 PHRS
   ceiling and be covered by the balance.
6. **Contract verification** - deployed runtime code at all four addresses is
   compared with fresh artifacts (immutables masked) and the artifact hashes
   must match the deployment journal; wiring getters (quote, feeBps, minters,
   controllers) are re-checked; the official USDC guard is loaded.
7. **Per step:**
   - per-step preconditions are re-read (balances, allowances, shares);
   - an `INTENT` journal entry (nonce, gas, target, calldata hash) is
     fsync-written before anything is signed;
   - exactly one send per step; no retries, no automatic resends;
   - receipt wait with timeout - a timeout is an **UNKNOWN** outcome and is
     never resent;
   - the mined transaction input must hash to the journaled calldata hash;
   - per-step postconditions and, at the end, the full battery (tUSDC/tSAGA
     balances and allowances at zero, 0.99 vault shares, totalShares, supply,
     swap balance, official USDC unchanged).
8. **Summary** - per-step outcomes, total gas used, total wei spent, journal
   path.

## Resume semantics

- Only `CONFIRMED` entries are skipped (and consume their nonce).
- If step 1 has no journal entry but step 2 does, a previous run resolved the
  mint as skipped: the mint is skipped again without sending. This prevents a
  re-mint after a mint-skip run.
- Any `INTENT`/`BROADCAST`/`REVERTED`/`UNKNOWN` entry blocks the step until a
  human reconciles it on-chain; the runner never resends and never silently
  restarts.
- Any precondition, calldata-hash, postcondition or cost mismatch stops the
  run with instructions to re-run the plan and re-review.

## Approval flow

1. `npm run testnet:saga-plan -- --env-file <path> --address <deployer>`
   prints the live plan (chain state, wiring, calldata, end state, cost) and
   the plan hash; read-only, never reads the key.
2. Review the plan and approve the hash explicitly.
3. `npm run testnet:saga -- --mode atlantic --env-file <path>
   --address <deployer> --approve-plan <hash> --confirm-atlantic-testnet`.

**Execution status:** the plan hash above was explicitly approved and the saga
was executed against Atlantic testnet; all five transactions are CONFIRMED
(record: [verified-output.md section 14](verified-output.md#iteration-7--atlantic-saga-execution)).

## Local tooling tests

`npm run demo:saga-tooling` drives the exact same runner against disposable
Anvil chains (localhost only, node-signed unlocked accounts, no keys,
chainId 31337):

| Scenario | Injection | Expected behaviour |
| --- | --- | --- |
| A happy path | none | 5 transactions, all CONFIRMED, inputs hash-match the journal, full end-state battery holds |
| A2 pre-funded | seed exactly 1.000000 tUSDC | mint skipped (4 transactions, no entry); re-run sends nothing and reports COMPLETE |
| B wrong chain | chainId 5 | refusal before any send; no journal is created |
| C forced revert | `setFailNextSwap(true)` | third entry REVERTED; stops; allowance and balance untouched |
| D ambiguous outcome | `anvil_setAutomine(false)` + short timeout | one broadcast, UNKNOWN entry; after mining the re-run refuses the unresolved entry |
| E altered calldata | final-byte flip on the approve | receipt input hash mismatch caught; entry UNKNOWN; stops |
| F postcondition break | extra conflicting mint after the receipt | postcondition drift caught; entry UNKNOWN; stops |
| G changed pre-state | pre-existing 123456 tUSDC | refusal before any send; no journal; balance untouched |

The unit tests in `test/saga-tooling.test.ts` pin the golden plan hash and all
five calldata strings, hash-binding properties, journal semantics and the
deployment-journal address resolution.

Results are recorded in `docs/verified-output.md`, including the executed
Atlantic run ([section 14](verified-output.md#iteration-7--atlantic-saga-execution)).
