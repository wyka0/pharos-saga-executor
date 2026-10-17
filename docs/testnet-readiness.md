# Testnet readiness — Pharos Atlantic

Inspection date: **2026-10-17**
Target: **Pharos Atlantic Testnet only** (chainId **688689**). Mainnet is never used.
Wallet: **`0xE2B8651178ade144003537eA509E37877dba40bb`** (public address only)
Project: `C:\pharos-saga-executor`

> No transaction was signed or broadcast during the readiness work.
> No private key, seed phrase, keystore password or session token is printed,
> logged or stored in this repository.

## 1. Baseline before the extension

The pre-existing project was verified first:

```text
npm run verify -> build + 61/61 tests + safety gate, exit 0
git status     -> clean
HEAD           -> 15d867925dd192f7802c5fd730f6deb239b46bf8 (main)
```

The simulated adapter, state machine, persistence, CLI and all 61 original
tests were preserved.

## 2. Official network facts (verified)

Sources:

- <https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md>
- <https://docs.pharos.xyz/getting-started/token-registry.md>
- <https://docs.pharos.xyz/getting-started/canonical-contracts.md>
- <https://github.com/PharosNetwork/pharos-skill-engine/blob/main/assets/networks.json>
- Live JSON-RPC read against the official public endpoint

| Fact | Verified value |
| --- | --- |
| Network | Pharos Atlantic Testnet |
| Chain ID | **688689** (`0xa8231` observed live) |
| Public RPC | `https://atlantic.dplabs-internal.com` |
| Explorer | `https://atlantic.pharosscan.xyz/` |
| Native token | **PHRS**, 18 decimals |
| Rate limit | 500 requests / 5 minutes |
| Live block observed | 31,540,254 (readiness run) |
| Gas price observed | 10 gwei |
| Latest base fee observed | 1 gwei |
| Latest block gas limit observed | 1,000,000,000 |

The configured local RPC points at the same official Atlantic host (path
redacted). `eth_chainId` from that configuration returned **688689**, matching
the official network. No network switch was performed.

## 3. Local configuration (names only)

A local env file outside this repository was used read-only. Only variable
**names** were inspected; values were never printed:

```text
RPC_URL
PRIVATE_KEY
GOVERNOR_ADDRESS
PHAROS_API_KEY
```

The home-directory `.env` is empty. The project itself contains **no** `.env`;
`.gitignore` excludes `.env`, `.local/`, `state/`, `.demo-state/` and `dist/`.

The wallet address was derived locally from the configured key and printed as a
public address only:

```text
0xE2B8651178ade144003537eA509E37877dba40bb
```

The key itself was never displayed, logged or written to disk by this project.

## 4. Wallet readiness

Read-only checks (no signing key read by the readiness command; `--address` was
used):

| Check | Result |
| --- | --- |
| Address | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| Chain ID | **688689** — correct Atlantic testnet |
| Native balance | **0.542613955838483504 PHRS** (exact wei: `542613955838483504`) |
| Nonce | **13** |
| USDC balance | **20 USDC** (`20000000` base units, 6 decimals) |
| Other test ERC-20 balances | **0** USDT / WBTC / WETH / WPHRS |

The wallet is on the correct network and has both gas and test USDC. It still has
**no verified protocol** to use as a swap or deposit target.

### 4.1 Funding verification (2026-10-17)

The wallet was funded externally with 20 USDC. The transaction was verified
read-only via JSON-RPC and the explorer:

| Field | Verified value |
| --- | --- |
| Transaction | `0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b` |
| Explorer | <https://atlantic.pharosscan.xyz/tx/0x9e4834a1cf39b353c134ba4cc002c46357b54acd0e6d7d0c12bab759cc76370b> |
| Block | `31543356` |
| Block timestamp | `2026-10-17T17:01:25Z` |
| From | `0x4cf51364a6d88ba64bcdb93f444b05d1cf4f00e3` |
| To | USDC contract `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` |
| Method | `transfer(address,uint256)` (`0xa9059cbb`) |
| Receipt status | **success** |
| USDC `Transfer` log | from funder to `0xE2B8651178ade144003537eA509E37877dba40bb`, `20000000` raw = **20 USDC** |
| Gas used / price | 57,347 / 3.25 gwei |
| Fee | `0.00018637775 PHRS` |

A fresh `balanceOf(wallet)` call after the receipt returned exactly
`20000000` base units. The funding transaction was sent externally; this project
did not sign or broadcast it.

## 5. Verified token contracts

All addresses and decimals below come from the official Atlantic token registry.
Each address was checked live: contract code exists, `symbol()` and `decimals()`
match the registry, and `totalSupply()` is non-zero.

| Symbol | Address | Decimals | Code | On-chain metadata | Wallet balance |
| --- | --- | ---: | --- | --- | ---: |
| USDC | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` | 6 | present | verified | **20** |
| USDT | `0xE7E84B8B4f39C507499c40B4ac199B050e2882d5` | 6 | present | verified | **0** |
| WBTC | `0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4` | 18 | present | verified | **0** |
| WETH | `0x7d211F77525ea39A0592794f793cC1036eEaccD5` | 18 | present | verified | **0** |
| WPHRS | `0x838800b758277CC111B2d48Ab01e5E164f8E9471` | 18 | present | verified | **0** |

The official registry lists `initsupply = 0` for these entries even though the
deployed contracts currently report a non-zero total supply. That is a registry
presentation detail; on-chain metadata was used for the readiness decision.

USDC on-chain state at the post-funding check: **1,798 bytes of code**, symbol
`USDC`, decimals `6`, total supply `100108237887829` raw
(100,108,237.887829 USDC), wallet balance `20000000` raw (20 USDC).

## 6. Faucet availability

- **Native PHRS:** the docs mention a Pharos faucet/team but publish **no public
  faucet URL**. The wallet already holds 0.5426 PHRS, so no funding request is
  needed for gas.
- **Test ERC-20s (USDC/USDT/WBTC/WETH/WPHRS):** no public faucet or distribution
  URL is documented. The wallet was separately funded with **20 USDC**; the
  other tokens remain zero.

No funds were requested by this project, and no automatic network switch or
transfer was made. The funding transaction came from an external address.

## 7. Deployed swap/deposit protocols

Official docs were queried directly (GitBook `ask` endpoint) and the canonical
contracts page was read:

> “No officially documented Atlantic DEX/router, swap, or lending/vault
> contracts are listed.”

The Atlantic canonical contracts are infrastructure only:

- Create2Deployer
- DeterministicDeploymentProxy
- MultiCall3
- GnosisSafe / GnosisSafeL2 / MultiSend
- Permit2
- ERC-4337 EntryPoint / SenderCreator

The local `GOVERNOR_ADDRESS` has contract code, but it is not documented as a
swap, router, vault or lending protocol. It is therefore **not** used as a
protocol target.

The only documented way to obtain a DEX/vault is to deploy your own example
contracts (Foundry/Hardhat tutorials). That is a new deployment and was not
authorized, so it was not done.

## 8. Capability matrix

| Step | Capability | Reason |
| --- | --- | --- |
| `APPROVE` | **UNAVAILABLE** | No verified protocol spender exists. The wallet now holds 20 USDC, so balance is no longer the blocker. |
| `SWAP` | **UNAVAILABLE** | No verified swap/router or calldata/ABI exists on Atlantic. |
| `DEPOSIT` | **UNAVAILABLE** | No verified vault/lending/deposit protocol exists on Atlantic. |
| Full APPROVE→SWAP→DEPOSIT | **BLOCKED** | The protocol prerequisites remain missing. |

The adapter refuses to approve an arbitrary address, to target a random contract,
or to invent calldata. Those refusals are tested offline.

## 9. Initial readiness output (pre-funding)

The capture below is retained as the original readiness snapshot. It shows a
zero USDC balance because it was taken before the externally funded transfer.
The current balance and funding transaction are in section 4.1.

Command (read-only; `--address` means no signing key was read):

```powershell
npm run testnet:readiness -- `
  --env-file <local-env-file> `
  --address 0xE2B8651178ade144003537eA509E37877dba40bb `
  --state-dir .demo-state/readiness `
  --token USDC --amount 0.01
```

Observed output (values are public; the RPC path is redacted):

```text
PHAROS ATLANTIC TESTNET READINESS (READ-ONLY)
Network:     atlantic-testnet (chainId 688689, expected 688689)
RPC host:    https://atlantic.dplabs-internal.com/<redacted-path>
Block:       31540254
Wallet:      0xE2B8651178ade144003537eA509E37877dba40bb
Native:      0.542613955838483504 PHRS
Explorer:    https://atlantic.pharosscan.xyz/
Faucet:      documented=false url=none
             Official docs mention a Pharos faucet for native PHRS but publish no URL.
             No documented faucet exists for testnet USDC/USDT/WETH/WPHRS.

Tokens:
  USDC 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B code=true verified=true decimals=6 balance=0
  USDT 0xE7E84B8B4f39C507499c40B4ac199B050e2882d5 code=true verified=true decimals=6 balance=0
  WBTC 0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4 code=true verified=true decimals=18 balance=0
  WETH 0x7d211F77525ea39A0592794f793cC1036eEaccD5 code=true verified=true decimals=18 balance=0
  WPHRS 0x838800b758277CC111B2d48Ab01e5E164f8E9471 code=true verified=true decimals=18 balance=0

Capabilities:
  APPROVE available=false
    - No verified swap or deposit contract is configured, so there is no justified approval spender
    - Wallet holds 0 USDC, less than the requested 0.01
  SWAP    available=false
    - No verified swap/router contract is configured. Official Pharos docs list only token,
      deployment and Permit2 canonical contracts on Atlantic testnet.
  DEPOSIT available=false
    - No verified deposit/vault contract is configured. Official Pharos docs list no deployed
      lending or vault protocol on Atlantic testnet.

No transaction was signed or broadcast.
```

### 9.1 Post-funding verification (read-only)

A second read-only pass after the funding transfer confirmed:

| Check | Result |
| --- | --- |
| `eth_chainId` | **688689** |
| Latest block observed | `31543563` |
| Wallet | `0xE2B8651178ade144003537eA509E37877dba40bb` |
| Native balance | `542613955838483504` wei = **0.542613955838483504 PHRS** |
| USDC code | present, 1,798 bytes |
| USDC `symbol()` / `decimals()` | `USDC` / `6` |
| USDC total supply | `100108237887829` raw |
| USDC wallet balance | `20000000` raw = **20 USDC** |
| Funding receipt | **success**, block `31543356` |
| Transactions signed/broadcast by this project | **0** |

## 10. What must be true before a live test

1. **Fund the wallet with the input token — DONE.** The wallet holds 20 USDC
   from the verified funding transaction in section 4.1.
2. **Provide a verified spender/protocol.** A contract address alone is not
   enough: it must be documented as a swap/router or deposit/vault for Atlantic,
   with a published ABI/calldata contract and a known postcondition. None exists
   in the official docs today.
3. Alternatively, **explicitly authorize deploying test-only contracts** (a
   mock swap and mock vault, or a token + DEX + vault set) in a separate,
   separately approved task. No deployment was done.
4. Re-run `testnet:plan`, review the exact calldata, gas and maximum cost, and
   approve the resulting plan hash explicitly.

Until 1–3 are resolved, no live APPROVE/SWAP/DEPOSIT is proposed. The adapter
reports the missing prerequisite instead of faking a transaction.

## 11. Update (Task 5 continuation): Foundry found, local validation and plan prepared

The earlier "tooling blocker" is resolved and item 3 above is partially
progressed, still **without any Atlantic transaction**:

- **Foundry was found in WSL Ubuntu** (`/home/wyka/.foundry/bin`, version
  1.2.3-stable: `forge`, `anvil`, `cast`). It was never on the Windows side.
  No PATH or shell profile was changed.
- **Test-only contracts exist and compile**: `contracts/test-only/`
  (`TestOnlyUSDC`, `TestOnlyReceiptToken`, `TestOnlySwap`, `TestOnlyVault`),
  plus 16 passing Foundry tests (7 saga + 8 authorization/sabotage + 1
  deployment-gas measurement).
- **Local end-to-end validation passed** on a disposable Anvil chain
  (chainId 31337): success, forced SWAP revert with `REVOKE_APPROVAL`, forced
  DEPOSIT revert with `SIMULATED_UNWIND_SWAP`, and unknown-outcome
  reconciliation with no resubmission (`npm run demo:local`), plus a
  six-scenario gated-deployment safety check (`npm run demo:deploy-tooling`).
- **Atlantic deployment plan regenerated (read-only, NOT executed)**:
  [`testnet-deployment-plan.md`](testnet-deployment-plan.md), plan hash (v2)
  `7e1050c9717789fce229945649acbc21baaed46f67346967a8d74362edd4d806`,
  3,400,000 total gas cap across 5 transactions, 0.034 PHRS planned spend at
  10 gwei. The gated runner described in
  [testnet-deployment-tooling.md](testnet-deployment-tooling.md) has never run
  against Atlantic.

No `TestOnly*` contract has been deployed to Atlantic. Deployment remains a
separate, explicitly approved task; see the plan document for preconditions.
