# Atlantic Testnet Deployment Plan (Prepared, NOT Executed)

**Status: PREPARED FOR REVIEW. NOTHING WAS SIGNED OR BROADCAST.**
**Classification: TEST-ONLY MOCK CONTRACTS on Pharos Atlantic testnet (chainId 688689).
Not a Pharos protocol, not mainnet, no real funds.**

This page is the Phase 3 deliverable: a concrete deployment plan for the four
clearly-labelled `TestOnly*` contracts, produced by a read-only script
(`scripts/testnet-deploy-plan.ts`). It is **not** an execution authorization.

## 1. How this plan was produced

```powershell
npm run testnet:deploy-plan -- --env-file C:\temp-secrets\.env --address 0xE2B8651178ade144003537eA509E37877dba40bb
```

The script is read-only by construction: it never references `PRIVATE_KEY`,
never signs and has no send path. The safety gate fails the build if that
changes. It reads:

- chain id, block number, gas price, pending nonce (read-only RPC);
- PHRS and USDC balances of the public deployer address;
- compiled init-code hashes from `out/` (Foundry build artifacts).

## 2. Observed state at plan time

| Item | Value |
| --- | --- |
| Chain id | 688689 (Pharos Atlantic testnet) |
| Block | 31544865 |
| RPC host | `atlantic.dplabs-internal.com` (path redacted) |
| Deployer (public) | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| PHRS balance | 0.542613955838483504 |
| USDC balance | 20.000000 (20000000 raw, 6 decimals) |
| Pending nonce | 13 |
| Gas price | 10 gwei (10000000000 wei) |
| Maximum PHRS expenditure | 0.028 PHRS at the current gas price |
| Absolute operator ceiling | 0.05 PHRS |

The values above are a snapshot. A future execution run must re-read them and
abort if the nonce moved, the gas price exceeds the ceiling, or an artifact
hash differs.

## 3. Contracts to deploy (in this exact order)

All sources live under `contracts/test-only/`. `bytecodeSha256` is the SHA-256
of the compiled init bytecode (`bytecode.object` in the Foundry artifact).

| # | Contract | Source | Constructor args | Init code | Measured deploy gas | Gas cap | bytecodeSha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `TestOnlyUSDC` | `TestOnlyTokens.sol` | none | 2597 B | 497,738 | 700,000 | `bedc97b16c4488f10951d7dade68106432fdab81f681707d2d052f010716bf71` |
| 2 | `TestOnlyReceiptToken` | `TestOnlyTokens.sol` | none | 2960 B | 568,661 | 800,000 | `f1308694d570695b5cac917b2b9681e6e41b74e74f7912986abb0bedd8a24fc9` |
| 3 | `TestOnlySwap` | `TestOnlySwap.sol` | `(usdc, receiptToken, 100)` | 2529 B | 484,536 | 700,000 | `e630cdbd45ab505f723c9c2264fac660a1afe21e9c1079fc28d37692c982d87c` |
| 4 | `TestOnlyVault` | `TestOnlyVault.sol` | `(receiptToken)` | 2084 B | 421,507 | 600,000 | `8cf3649a863ce1443ccdc13c6eb7fa8897d92342bfadd8a5c5bc27f24368b4c5` |

`measured deploy gas` was measured locally with
`contracts/test/DeploymentGas.t.sol` (`forge test --match-test testDeploymentGas -vv`).
The constructor of `TestOnlySwap` also calls `receipt.setMinter(swap, true)`;
that cost is included.

**Gas totals**

- Measured deploy execution gas (4 contracts): **1,972,442**
- Total gas cap with per-tx safety margins (4 transactions): **2,800,000**
- At 10 gwei this caps the spend at **0.028 PHRS**; the operator ceiling is
  **0.05 PHRS** regardless of gas-price movement.

## 4. Intended addresses (predicted, not final)

`CREATE` addresses are deterministic from the deployer and nonce at execution
time. With pending nonce 13 at plan time they would be:

| # | Contract | Predicted address |
| --- | --- | --- |
| 1 | `TestOnlyUSDC` | `0x623F3575241827eb5aAb5592834632Ed67BB114C` |
| 2 | `TestOnlyReceiptToken` | `0xCA7c0D2474f3868bbBa0902d33918b35Dad90b19` |
| 3 | `TestOnlySwap` | `0xcF74d803da1C57CeE6Bb727B9646fDb42126414D` |
| 4 | `TestOnlyVault` | `0xa16085FFC63F3BaB3D2c26b22Dc44B7421cEB64b` |

These are **predictions, not deployment evidence**. Any transaction sent from
the deployer before deployment changes them. The final addresses must be read
from the deployment receipts and recorded here afterwards; the prediction is
void until then and no downstream configuration may reference it.

## 5. Plan hash for approval

Stable hash over: plan version, network, deployer, classification, contract
order, constructor-arg templates, bytecode hashes and gas caps.

```text
cf458108d271c3a3f9cc9b7daa96de37bf499405cf2b8e39d5ef975bc540d691
```

This hash deliberately excludes the volatile nonce, gas price and predicted
addresses. It is the artifact to approve. If any bytecode hash, constructor
argument, contract order or gas cap changes, the hash changes and approval
must be re-requested.

## 6. Preconditions for a future execution task (not yet done)

Deployment may only be attempted after all of the following:

1. The user explicitly approves the exact plan hash above.
2. `forge build` is re-run and all four `bytecodeSha256` values match this
   plan; otherwise stop and re-plan.
3. `npm run testnet:deploy-plan` is re-run and the pending nonce, gas price
   and projected maximum cost are re-checked (gas price <= ceiling).
4. A dedicated deploy script with the same gates as the testnet adapter is
   added and reviewed: INTENT journal before every send, one send per
   contract, no retry on an ambiguous outcome, receipt verification and
   actual-address recording.
5. The deployer wallet holds enough PHRS (current: 0.5426; cap 0.05) and the
   four transactions do not interleave with any other deployer activity.

## 7. Explicitly out of scope

- Mainnet (never), any chain other than Atlantic 688689, and any real funds.
- Claiming these mocks are an official Pharos DEX, vault or token.
- Replacing or front-running the official USDC address.
- Unlimited approvals. The local saga demo uses exact, bounded allowances
  (see `docs/local-anvil.md`).

## 8. Verification of this document

`npm run verify` includes a static gate that fails if the plan script ever
gains a send/sign path or a signing-secret reference, or if any testnet file
targets mainnet. The numbers in this document come from the read-only run
recorded above and from the local Foundry measurement test.
