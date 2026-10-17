# Atlantic Testnet Deployment Plan (Prepared, NOT Executed)

**Status: PREPARED FOR REVIEW. NOTHING WAS SIGNED OR BROADCAST.**
**Classification: TEST-ONLY MOCK CONTRACTS on Pharos Atlantic testnet (chainId 688689).
Not a Pharos protocol, not mainnet, no real funds.**

This page is a concrete deployment plan for the four clearly-labelled
`TestOnly*` contracts plus the minter-wiring call, produced by a read-only
script (`scripts/testnet-deploy-plan.ts`). It is **not** an execution
authorization. The plan core (order, caps, artifact hashes) is shared with the
gated runner via `src/testnet/deployPlan.ts`.

Since the first version of this page the contracts were hardened (F-1: mock
token and mock vault settings are restricted to an immutable test
controller), the swap constructor no longer wires the minter, and a fifth
transaction now performs the wiring explicitly. **Every earlier plan hash is
superseded.**

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
| Block | 31546237 |
| RPC host | `atlantic.dplabs-internal.com` (path redacted) |
| Deployer (public) | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| PHRS balance | 0.542613955838483504 |
| USDC balance | 20.000000 (20000000 raw, 6 decimals) |
| Pending nonce | 13 |
| Gas price | 10 gwei (10000000000 wei) |
| Maximum PHRS expenditure | 0.034 PHRS at the current gas price (3,400,000 gas cap) |
| Absolute operator ceiling | 0.05 PHRS (implies max 14.7 gwei for the full run) |

The values above are a snapshot. A future execution run must re-read them and
abort if the nonce moved, the gas price exceeds the ceiling, or an artifact
hash differs. The plan hash in section 5 deliberately excludes these volatile
values.

## 3. Transactions (in this exact order)

All sources live under `contracts/test-only/`. `bytecodeSha256` is the SHA-256
of the compiled init bytecode (`bytecode.object` in the Foundry artifact).
Every mock takes the deployer as the immutable `controller`, which is the only
account allowed to mint, burn, change minters or toggle fault hooks.

| # | Kind | Contract / call | Source | Constructor args | Init code | Measured gas | Gas cap | bytecodeSha256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | deploy | `TestOnlyUSDC` | `TestOnlyTokens.sol` | `(controller)` | 3125 B | 557,441 | 850,000 | `5548138e17bd36fb0234255823741f69b3b694dafa93af0db28ea86d8f78dcb6` |
| 2 | deploy | `TestOnlyReceiptToken` | `TestOnlyTokens.sol` | `(controller)` | 3399 B | 611,864 | 900,000 | `6e4a97c8b9e846e71fdf7aea2cbf40a789d10abd24056b636e914e026529388a` |
| 3 | deploy | `TestOnlySwap` | `TestOnlySwap.sol` | `(usdc, receiptToken, 100, controller)` | 2858 B | 518,281 | 800,000 | `682c314c4c35c0c9ba802e8c4c86cfa6694f06494a33b3cfa3e238ad785528d3` |
| 4 | deploy | `TestOnlyVault` | `TestOnlyVault.sol` | `(receiptToken, controller)` | 2521 B | 478,683 | 750,000 | `67f7cc0a0e8b5d5897f3963ec8e57bfc478bb88e57a69b2e406a8deea9b1859c` |
| 5 | call | `TestOnlyReceiptToken.setMinter(swap, true)` | `TestOnlyTokens.sol` | - | - | 23,592 | 100,000 | - |

`measured gas` was measured locally with
`contracts/test/DeploymentGas.t.sol` (`forge test --match-test testDeploymentGas -vv`).
The wiring call (step 5) is sent by the deployer because the deployer is the
immutable controller; the swap itself can never wire its own minter.

**Gas totals**

- Measured execution gas (4 deploys + wiring): **2,189,861**
- Total gas cap with per-tx safety margins (5 transactions): **3,400,000**
- At 10 gwei this caps the spend at **0.034 PHRS**; the operator ceiling is
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

Step 5 is a call to the receipt token, not a creation. These are
**predictions, not deployment evidence**. Any transaction sent from the
deployer before deployment changes them. The final addresses must be read
from the deployment receipts and recorded here afterwards; the prediction is
void until then and no downstream configuration may reference it.

## 5. Plan hash for approval

Stable hash over: plan version, network, deployer, classification, contract
order, constructor-arg templates, bytecode hashes and gas caps.

```text
7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806
```

This hash deliberately excludes the volatile nonce, gas price and predicted
addresses. It is the artifact to approve. If any bytecode hash, constructor
argument, contract order or gas cap changes, the hash changes and approval
must be re-requested. The gated runner re-derives this hash from freshly
rebuilt artifacts and refuses to send anything unless it matches the approved
value exactly.

## 6. Preconditions for a future execution task (not yet done)

Deployment may only be attempted after all of the following:

1. The user explicitly approves the exact plan hash above.
2. The gated runner (`scripts/testnet-deploy.ts --mode atlantic`, documented in
   `docs/testnet-deployment-tooling.md`) is used. It force-rebuilds the
   contracts, re-verifies every artifact hash, re-reads chainId / nonce / gas
   price / balance, enforces the 0.05 PHRS ceiling, writes a durable `INTENT`
   journal entry before every send, sends each transaction exactly once and
   verifies each receipt, deployed bytecode and actual address. It never
   resends an ambiguous outcome and stops on any mismatch.
3. `npm run testnet:deploy-plan` is re-run and the pending nonce, gas price and
   projected maximum cost are re-checked (gas price <= ceiling).
4. The deployer wallet holds enough PHRS (current: 0.5426; cap 0.05) and the
   five transactions do not interleave with any other deployer activity.
5. The signing key stays solely in `C:\temp-secrets\.env` (`PRIVATE_KEY`); the
   runner reads it lazily only after all gates pass, immediately before the
   first send, and never prints or journals it.

## 7. Explicitly out of scope

- Mainnet (never), any chain other than Atlantic 688689, and any real funds.
- Claiming these mocks are an official Pharos DEX, vault or token.
- Replacing or front-running the official USDC address.
- Unlimited approvals. The local saga demo uses exact, bounded allowances
  (see `docs/local-anvil.md`).

## 8. Verification of this document

`npm run verify` includes a static gate that fails if the plan script or the
shared plan module ever gains a send/sign path or a signing-secret reference,
or if any testnet file targets mainnet. The numbers in this document come from
the read-only run recorded above, the local Foundry measurement test, and the
six-scenario local safety check in `docs/testnet-deployment-tooling.md`.
