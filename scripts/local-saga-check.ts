#!/usr/bin/env tsx
/**
 * LOCAL SAGA TOOLING CHECK - TEST-ONLY.
 *
 * Exercises the gated saga runner (src/testnet/saga/runner.ts) against
 * disposable local Anvil chains and asserts the safety behaviour:
 *
 *   A. happy path: mint -> approve -> swap -> approve -> deposit, all five
 *      transactions CONFIRMED, every journal calldata hash matches the
 *      on-chain input, and the full end-state battery holds
 *   A2. pre-funded skip: with exactly 1.000000 tUSDC already present the mint
 *      is skipped (4 transactions, no MintTusdc entry) and a re-run sends
 *      nothing and still reports COMPLETE
 *   B. wrong chain (chainId 5): refused before any send, no journal created
 *   C. forced on-chain revert (fault hook): third entry REVERTED, stops, no
 *      further sends, allowance and balance untouched
 *   D. ambiguous outcome (automine off + short timeout): exactly one
 *      broadcast, journal UNKNOWN, never resent; after mining, a re-run still
 *      refuses the unresolved entry
 *   E. altered calldata (final-byte injection on the approve): the journaled
 *      approved-calldata hash catches the mismatch on receipt, the entry is
 *      marked UNKNOWN and the run stops
 *   F. postcondition break (extra conflicting mint): the per-step
 *      postcondition check catches the drift and stops
 *   G. changed pre-state (pre-existing 123456 tUSDC): refused before any send
 *
 * Everything runs on 127.0.0.1 Anvil (chainId 31337) with the node's own
 * unlocked test accounts. No private key is read; nothing touches the upstream
 * testnet or mainnet. Run with: npm run demo:saga-tooling
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hash,
} from 'viem';
import {
  buildSagaPlanCore,
  computeSagaPlanHash,
  type SagaContracts,
} from '../src/testnet/sagaPlan.js';
import {
  runSaga,
  type SagaRunResult,
  type SagaTestInjections,
} from '../src/testnet/saga/runner.js';
import { SagaJournal } from '../src/testnet/saga/journal.js';

const ROOT = path.resolve('.');
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

const ERC20_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
const RECEIPT_ADMIN_ABI = parseAbi(['function setMinter(address minter, bool allowed)']);
const SWAP_HOOK_ABI = parseAbi(['function setFailNextSwap(bool value)']);
const VAULT_VIEW_ABI = parseAbi([
  'function sharesOf(address owner) view returns (uint256)',
  'function totalShares() view returns (uint256)',
]);

let checks = 0;
let failures = 0;
function pass(message: string): void {
  checks += 1;
  process.stdout.write(`PASS  ${message}\n`);
}
function fail(message: string): void {
  checks += 1;
  failures += 1;
  process.stderr.write(`FAIL  ${message}\n`);
}
function check(condition: boolean, message: string): void {
  if (condition) pass(message);
  else fail(message);
}

function forgeCommand() {
  return {
    repoRoot: ROOT,
    wslDistro: process.env.WSL_DISTRO ?? 'Ubuntu',
    forgeBin: process.env.FORGE_BIN ?? '/home/wyka/.foundry/bin/forge',
  };
}

/** Same force-rebuild the runner performs; needed once before the scenarios. */
function buildOnce(): void {
  const forge = forgeCommand();
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'wsl.exe',
          [
            '-d',
            forge.wslDistro,
            '--',
            '/bin/bash',
            '--noprofile',
            '--norc',
            '-c',
            `cd /mnt/c/pharos-saga-executor && ${forge.forgeBin} build --force`,
          ],
          { encoding: 'utf8', timeout: 600_000, windowsHide: true },
        )
      : spawnSync(forge.forgeBin, ['build', '--force'], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 600_000,
        });
  if (result.status !== 0) {
    throw new Error(`forge build --force failed: ${String(result.stderr ?? '').slice(-400)}`);
  }
  process.stdout.write('forge build --force: OK\n');
}

function startAnvil(port: number, chainId = 31337): ChildProcess {
  const args = ['--port', String(port), '--chain-id', String(chainId), '--silent'];
  const child =
    process.platform === 'win32'
      ? spawn(
          'wsl.exe',
          [
            '-d',
            process.env.WSL_DISTRO ?? 'Ubuntu',
            '--',
            process.env.ANVIL_BIN ?? '/home/wyka/.foundry/bin/anvil',
            ...args,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        )
      : spawn(process.env.ANVIL_BIN ?? 'anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk) => process.stderr.write(`[anvil] ${String(chunk)}`));
  child.on('error', (error) => process.stderr.write(`[anvil spawn] ${error.message}\n`));
  return child;
}

function killAnvil(port: number): void {
  try {
    if (process.platform !== 'win32') {
      spawnSync('pkill', ['-f', `anvil --port ${port}`], { stdio: 'ignore', timeout: 10_000 });
      return;
    }
    spawnSync(
      'wsl.exe',
      [
        '-d',
        process.env.WSL_DISTRO ?? 'Ubuntu',
        '--',
        '/usr/bin/pkill',
        '-f',
        `anvil --port ${port}`,
      ],
      { stdio: 'ignore', timeout: 15_000 },
    );
  } catch {
    /* best effort */
  }
}

function clientFor(port: number) {
  return createPublicClient({
    transport: http(`http://127.0.0.1:${port}`, { timeout: 10_000, retryCount: 1 }),
  });
}

async function waitForRpc(port: number, expectedChainId: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const client = clientFor(port);
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const chainId = await client.getChainId();
      if (chainId === expectedChainId) return;
      lastError = `chainId ${chainId}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`anvil on port ${port} never became ready (${lastError})`);
}

function stateDirFor(scenario: string): string {
  return path.join(ROOT, '.demo-state', 'saga-tooling', scenario);
}

interface LocalChain {
  client: ReturnType<typeof clientFor>;
  wallet: ReturnType<typeof createWalletClient>;
  contracts: SagaContracts;
}

/** Deploy + wire the four TestOnly contracts locally, mirroring the reviewed setup. */
async function deployLocalChain(port: number): Promise<LocalChain> {
  const transport = http(`http://127.0.0.1:${port}`, { timeout: 20_000, retryCount: 0 });
  const client = createPublicClient({ transport });
  const wallet = createWalletClient({ account: OWNER, chain: null, transport });

  const deploy = async (relative: string, args: readonly unknown[]): Promise<Address> => {
    const raw = await fs.readFile(path.resolve(ROOT, 'out', relative), 'utf8');
    const artifact = JSON.parse(raw) as {
      abi: readonly unknown[];
      bytecode: { object: `0x${string}` };
    };
    const hash = (await wallet.deployContract({
      account: OWNER,
      chain: null,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
    })) as Hash;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error(`local deploy failed for ${relative}`);
    }
    return receipt.contractAddress as Address;
  };

  const tUSDC = await deploy('TestOnlyTokens.sol/TestOnlyUSDC.json', [OWNER]);
  const tSAGA = await deploy('TestOnlyTokens.sol/TestOnlyReceiptToken.json', [OWNER]);
  const swap = await deploy('TestOnlySwap.sol/TestOnlySwap.json', [tUSDC, tSAGA, 100n, OWNER]);
  const vault = await deploy('TestOnlyVault.sol/TestOnlyVault.json', [tSAGA, OWNER]);

  const wireHash = (await wallet.writeContract({
    account: OWNER,
    chain: null,
    address: tSAGA,
    abi: RECEIPT_ADMIN_ABI,
    functionName: 'setMinter',
    args: [swap, true],
  })) as Hash;
  const wireReceipt = await client.waitForTransactionReceipt({ hash: wireHash });
  if (wireReceipt.status !== 'success') throw new Error('local minter wiring failed');

  return { client, wallet, contracts: { tUSDC, tSAGA, swap, vault } };
}

async function localWrite(
  chain: LocalChain,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = (await chain.wallet.writeContract({
    account: OWNER,
    chain: null,
    address,
    abi: abi as never,
    functionName,
    args: args as never,
  })) as Hash;
  const receipt = await chain.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`local write ${functionName} reverted`);
}

async function localRead(
  chain: LocalChain,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<bigint> {
  return (await chain.client.readContract({
    address,
    abi: abi as never,
    functionName,
    args: args as never,
  })) as bigint;
}

function nonceOf(chain: LocalChain, blockTag: 'latest' | 'pending' = 'pending'): Promise<number> {
  return chain.client.getTransactionCount({ address: OWNER, blockTag });
}

/** Anvil-only RPC escape hatch (runtime mining toggles for the ambiguity scenario). */
function rpc(chain: LocalChain, method: string, params: unknown[] = []): Promise<unknown> {
  return (chain.client.request as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>)({ method, params });
}

async function runLocalSaga(
  scenario: string,
  port: number,
  contracts: SagaContracts,
  options: { injections?: SagaTestInjections; timeoutMs?: number; clean?: boolean } = {},
): Promise<SagaRunResult> {
  const stateDir = stateDirFor(scenario);
  if (options.clean !== false) await fs.rm(stateDir, { recursive: true, force: true });
  const approvedPlanHash = computeSagaPlanHash(
    buildSagaPlanCore({ deployerAddress: OWNER, contracts }),
  );
  process.stdout.write(`\n--- saga runner for scenario ${scenario} (rpc 127.0.0.1:${port}) ---\n`);
  return runSaga({
    repoRoot: ROOT,
    mode: 'local-anvil',
    approvedPlanHash,
    deployerAddress: OWNER,
    rpcUrl: `http://127.0.0.1:${port}`,
    stateDir,
    receiptTimeoutMs: options.timeoutMs ?? 20_000,
    contracts,
    testInjections: options.injections,
    forgeCommand: forgeCommand(),
    log: (line) => process.stdout.write(`  [${scenario}] ${line}\n`),
  });
}

interface SagaState {
  tusdcBalance: bigint;
  tusdcAllowanceSwap: bigint;
  tsagaBalance: bigint;
  tsagaAllowanceVault: bigint;
  tsagaSupply: bigint;
  vaultShares: bigint;
  vaultTotalShares: bigint;
  vaultTsagaBalance: bigint;
  swapTusdcBalance: bigint;
}

async function sagaState(chain: LocalChain): Promise<SagaState> {
  const c = chain.contracts;
  return {
    tusdcBalance: await localRead(chain, c.tUSDC, ERC20_ABI, 'balanceOf', [OWNER]),
    tusdcAllowanceSwap: await localRead(chain, c.tUSDC, ERC20_ABI, 'allowance', [OWNER, c.swap]),
    tsagaBalance: await localRead(chain, c.tSAGA, ERC20_ABI, 'balanceOf', [OWNER]),
    tsagaAllowanceVault: await localRead(chain, c.tSAGA, ERC20_ABI, 'allowance', [OWNER, c.vault]),
    tsagaSupply: await localRead(chain, c.tSAGA, ERC20_ABI, 'totalSupply'),
    vaultShares: await localRead(chain, c.vault, VAULT_VIEW_ABI, 'sharesOf', [OWNER]),
    vaultTotalShares: await localRead(chain, c.vault, VAULT_VIEW_ABI, 'totalShares'),
    vaultTsagaBalance: await localRead(chain, c.tSAGA, ERC20_ABI, 'balanceOf', [c.vault]),
    swapTusdcBalance: await localRead(chain, c.tUSDC, ERC20_ABI, 'balanceOf', [c.swap]),
  };
}

function checkEndState(state: SagaState, label: string): void {
  check(state.tusdcBalance === 0n, `${label}: tUSDC balance is 0 (got ${state.tusdcBalance})`);
  check(state.tusdcAllowanceSwap === 0n, `${label}: tUSDC allowance to swap is 0`);
  check(state.tsagaBalance === 0n, `${label}: tSAGA balance is 0`);
  check(state.tsagaAllowanceVault === 0n, `${label}: tSAGA allowance to vault is 0`);
  check(state.vaultShares === 990_000n, `${label}: vault sharesOf(deployer) is 990000`);
  check(state.vaultTotalShares === 990_000n, `${label}: vault totalShares is 990000`);
  check(state.vaultTsagaBalance === 990_000n, `${label}: vault holds 990000 tSAGA`);
  check(state.tsagaSupply === 990_000n, `${label}: tSAGA totalSupply is 990000`);
  check(state.swapTusdcBalance === 1_000_000n, `${label}: swap holds 1000000 tUSDC`);
}

async function main(): Promise<void> {
  buildOnce();
  process.stdout.write(
    '\n======================================================================\n',
  );
  process.stdout.write('LOCAL SAGA TOOLING CHECK (test-only; 127.0.0.1 anvil, chainId 31337)\n');
  process.stdout.write('======================================================================\n');

  /* ------------------------------------------------------------- scenario A */
  process.stdout.write('\nSCENARIO A: happy path (mint required) - five confirmed transactions\n');
  const portA = 8560;
  killAnvil(portA);
  const anvilA = startAnvil(portA);
  try {
    await waitForRpc(portA, 31337);
    const chain = await deployLocalChain(portA);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('happy', portA, chain.contracts);
    check(
      result.status === 'COMPLETE',
      `A: run COMPLETE (got ${result.status}${result.reason ? ` - ${result.reason}` : ''})`,
    );
    check((await nonceOf(chain)) === before + 5, 'A: exactly five transactions were sent');
    check(
      result.steps.length === 5 && result.steps.every((step) => step.outcome === 'SENT'),
      'A: all five steps report SENT',
    );

    const journal = new SagaJournal(path.join(stateDirFor('happy'), 'saga-journal.json'));
    const entries = await journal.list();
    check(entries.length === 5, `A: journal has five entries (got ${entries.length})`);
    check(
      entries.every((entry) => entry.status === 'CONFIRMED'),
      'A: every journal entry is CONFIRMED',
    );
    check(
      entries.every((entry, index) => entry.nonce === before + index),
      'A: journaled nonces are consecutive from the pending nonce',
    );
    for (const entry of entries) {
      const tx = await chain.client.getTransaction({ hash: entry.txHash as Hash });
      const inputSha = createHash('sha256').update(tx.input).digest('hex');
      check(
        inputSha === entry.dataSha256,
        `A: on-chain input hash matches the journal for ${entry.name}`,
      );
      check(
        tx.to !== null && tx.to.toLowerCase() === entry.to.toLowerCase(),
        `A: transaction target matches the journal for ${entry.name}`,
      );
    }
    checkEndState(await sagaState(chain), 'A');
  } finally {
    killAnvil(portA);
    anvilA.kill();
  }

  /* ------------------------------------------------------------ scenario A2 */
  process.stdout.write('\nSCENARIO A2: pre-funded - mint skipped, re-run is a no-op\n');
  const portA2 = 8561;
  killAnvil(portA2);
  const anvilA2 = startAnvil(portA2);
  try {
    await waitForRpc(portA2, 31337);
    const chain = await deployLocalChain(portA2);
    await localWrite(chain, chain.contracts.tUSDC, ERC20_ABI, 'mint', [OWNER, 1_000_000n]);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('prefunded', portA2, chain.contracts);
    check(
      result.status === 'COMPLETE',
      `A2: run COMPLETE (got ${result.status}${result.reason ? ` - ${result.reason}` : ''})`,
    );
    check((await nonceOf(chain)) === before + 4, 'A2: exactly four transactions were sent');
    check(
      result.steps[0]?.outcome === 'SKIPPED_NOT_REQUIRED',
      'A2: the mint step reports SKIPPED_NOT_REQUIRED',
    );
    check(
      result.steps.slice(1).every((step) => step.outcome === 'SENT'),
      'A2: steps 2-5 report SENT',
    );

    const journal = new SagaJournal(path.join(stateDirFor('prefunded'), 'saga-journal.json'));
    const entries = await journal.list();
    check(entries.length === 4, `A2: journal has four entries (got ${entries.length})`);
    check(
      entries.every((entry) => entry.name !== 'MintTusdc'),
      'A2: no MintTusdc entry (no mint transaction, no nonce consumed)',
    );
    checkEndState(await sagaState(chain), 'A2');

    const rerun = await runLocalSaga('prefunded', portA2, chain.contracts, { clean: false });
    check(
      rerun.status === 'COMPLETE',
      `A2: re-run COMPLETE without sending (got ${rerun.status}${rerun.reason ? ` - ${rerun.reason}` : ''})`,
    );
    check((await nonceOf(chain)) === before + 4, 'A2: re-run sent nothing');
    check((await journal.list()).length === 4, 'A2: journal unchanged after the re-run');
  } finally {
    killAnvil(portA2);
    anvilA2.kill();
  }

  /* ------------------------------------------------------------- scenario B */
  process.stdout.write('\nSCENARIO B: wrong chain (chainId 5) - refusal before any send\n');
  const portB = 8562;
  killAnvil(portB);
  const anvilB = startAnvil(portB, 5);
  try {
    await waitForRpc(portB, 5);
    const client = clientFor(portB);
    const dummy: SagaContracts = {
      tUSDC: '0x0000000000000000000000000000000000000001' as Address,
      tSAGA: '0x0000000000000000000000000000000000000002' as Address,
      swap: '0x0000000000000000000000000000000000000003' as Address,
      vault: '0x0000000000000000000000000000000000000004' as Address,
    };
    const result = await runLocalSaga('wrong-chain', portB, dummy);
    check(result.status === 'STOPPED', `B: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /WRONG CHAIN/.test(result.reason)),
      `B: reason names the wrong chain (${result.reason})`,
    );
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 0,
      'B: no transaction was sent',
    );
    check(
      !existsSync(path.join(stateDirFor('wrong-chain'), 'saga-journal.json')),
      'B: no journal was created',
    );
  } finally {
    killAnvil(portB);
    anvilB.kill();
  }

  /* ------------------------------------------------------------- scenario C */
  process.stdout.write('\nSCENARIO C: forced revert - REVERTED entry, stops, no further sends\n');
  const portC = 8563;
  killAnvil(portC);
  const anvilC = startAnvil(portC);
  try {
    await waitForRpc(portC, 31337);
    const chain = await deployLocalChain(portC);
    await localWrite(chain, chain.contracts.swap, SWAP_HOOK_ABI, 'setFailNextSwap', [true]);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('revert', portC, chain.contracts);
    check(result.status === 'STOPPED', `C: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /reverted/.test(result.reason)),
      `C: reason states the revert (${result.reason})`,
    );
    check(
      (await nonceOf(chain)) === before + 3,
      'C: exactly three transactions were sent (mint, approve, failed swap)',
    );
    const journal = new SagaJournal(path.join(stateDirFor('revert'), 'saga-journal.json'));
    const entries = await journal.list();
    const statuses = entries.map((entry) => entry.status).join(',');
    check(entries.length === 3, `C: journal has three entries (got ${entries.length})`);
    check(
      statuses === 'CONFIRMED,CONFIRMED,REVERTED',
      `C: statuses are CONFIRMED,CONFIRMED,REVERTED (got ${statuses})`,
    );
    const allowance = await localRead(chain, chain.contracts.tUSDC, ERC20_ABI, 'allowance', [
      OWNER,
      chain.contracts.swap,
    ]);
    const balance = await localRead(chain, chain.contracts.tUSDC, ERC20_ABI, 'balanceOf', [OWNER]);
    check(allowance === 1_000_000n, 'C: tUSDC allowance is untouched after the reverted swap');
    check(balance === 1_000_000n, 'C: tUSDC balance is untouched after the reverted swap');
  } finally {
    killAnvil(portC);
    anvilC.kill();
  }

  /* ------------------------------------------------------------- scenario D */
  process.stdout.write('\nSCENARIO D: ambiguous outcome - one broadcast, UNKNOWN, never resent\n');
  const portD = 8564;
  killAnvil(portD);
  const anvilD = startAnvil(portD);
  try {
    await waitForRpc(portD, 31337);
    const chain = await deployLocalChain(portD);
    await rpc(chain, 'anvil_setAutomine', [false]);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('ambiguous', portD, chain.contracts, { timeoutMs: 2_500 });
    check(result.status === 'STOPPED', `D: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /not observed/.test(result.reason)),
      `D: reason reports the missing receipt (${result.reason})`,
    );
    check((await nonceOf(chain)) === before + 1, 'D: exactly one transaction was broadcast');
    check((await nonceOf(chain, 'latest')) === before, 'D: nothing mined yet (tx pending)');
    const journal = new SagaJournal(path.join(stateDirFor('ambiguous'), 'saga-journal.json'));
    const entries = await journal.list();
    check(
      entries.length === 1 && entries[0]?.status === 'UNKNOWN',
      `D: one UNKNOWN journal entry (got ${entries.map((entry) => entry.status).join(',')})`,
    );

    await rpc(chain, 'anvil_mine', []);
    check((await nonceOf(chain, 'latest')) === before + 1, 'D: the single broadcast mined');

    const rerun = await runLocalSaga('ambiguous', portD, chain.contracts, { clean: false });
    check(rerun.status === 'STOPPED', `D: re-run STOPPED (got ${rerun.status})`);
    check(
      Boolean(rerun.reason && /refusing to resend/.test(rerun.reason)),
      `D: re-run refuses the unresolved entry (${rerun.reason})`,
    );
    check((await nonceOf(chain, 'latest')) === before + 1, 'D: re-run sent nothing');
    const after = await journal.list();
    check(
      after.length === 1 && after[0]?.status === 'UNKNOWN',
      'D: journal unchanged after the re-run',
    );
  } finally {
    killAnvil(portD);
    anvilD.kill();
  }

  /* ------------------------------------------------------------- scenario E */
  process.stdout.write('\nSCENARIO E: altered calldata - input hash catches it, UNKNOWN, stops\n');
  const portE = 8565;
  killAnvil(portE);
  const anvilE = startAnvil(portE);
  try {
    await waitForRpc(portE, 31337);
    const chain = await deployLocalChain(portE);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('altered-calldata', portE, chain.contracts, {
      injections: { alterCalldataFor: 'ApproveTusdcToSwap' },
    });
    check(result.status === 'STOPPED', `E: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /calldata/.test(result.reason)),
      `E: reason names the calldata mismatch (${result.reason})`,
    );
    check(
      (await nonceOf(chain)) === before + 2,
      'E: exactly two transactions were sent (mint + altered approve)',
    );
    const journal = new SagaJournal(path.join(stateDirFor('altered-calldata'), 'saga-journal.json'));
    const entries = await journal.list();
    const statuses = entries.map((entry) => entry.status).join(',');
    check(
      entries.length === 2 && statuses === 'CONFIRMED,UNKNOWN',
      `E: statuses are CONFIRMED,UNKNOWN (got ${statuses})`,
    );
    check(
      Boolean(entries[1]?.note.includes('verification failed')),
      'E: the UNKNOWN note records the verification failure',
    );
    const allowance = await localRead(chain, chain.contracts.tUSDC, ERC20_ABI, 'allowance', [
      OWNER,
      chain.contracts.swap,
    ]);
    check(
      allowance === 1_000_001n,
      `E: the flipped-byte approve applied on-chain (allowance 1000001, got ${allowance})`,
    );
  } finally {
    killAnvil(portE);
    anvilE.kill();
  }

  /* ------------------------------------------------------------- scenario F */
  process.stdout.write('\nSCENARIO F: postcondition break - drift caught, UNKNOWN, stops\n');
  const portF = 8566;
  killAnvil(portF);
  const anvilF = startAnvil(portF);
  try {
    await waitForRpc(portF, 31337);
    const chain = await deployLocalChain(portF);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('postcondition-break', portF, chain.contracts, {
      injections: { breakPostconditionFor: 'MintTusdc' },
    });
    check(result.status === 'STOPPED', `F: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /postcondition/.test(result.reason)),
      `F: reason names the postcondition failure (${result.reason})`,
    );
    check(
      (await nonceOf(chain)) === before + 2,
      'F: two transactions were sent (mint + conflicting extra mint)',
    );
    const journal = new SagaJournal(
      path.join(stateDirFor('postcondition-break'), 'saga-journal.json'),
    );
    const entries = await journal.list();
    check(
      entries.length === 1 && entries[0]?.status === 'UNKNOWN',
      `F: one UNKNOWN journal entry (got ${entries.map((entry) => entry.status).join(',')})`,
    );
    check(
      Boolean(entries[0]?.note.includes('verification failed')),
      'F: the UNKNOWN note records the verification failure',
    );
    const balance = await localRead(chain, chain.contracts.tUSDC, ERC20_ABI, 'balanceOf', [OWNER]);
    check(balance === 1_000_001n, `F: drift is on-chain (balance 1000001, got ${balance})`);
  } finally {
    killAnvil(portF);
    anvilF.kill();
  }

  /* ------------------------------------------------------------- scenario G */
  process.stdout.write('\nSCENARIO G: changed pre-state - refusal before any send\n');
  const portG = 8567;
  killAnvil(portG);
  const anvilG = startAnvil(portG);
  try {
    await waitForRpc(portG, 31337);
    const chain = await deployLocalChain(portG);
    await localWrite(chain, chain.contracts.tUSDC, ERC20_ABI, 'mint', [OWNER, 123_456n]);
    const before = await nonceOf(chain);
    const result = await runLocalSaga('changed-prestate', portG, chain.contracts);
    check(result.status === 'STOPPED', `G: run STOPPED (got ${result.status})`);
    check(
      Boolean(result.reason && /pre-state/.test(result.reason)),
      `G: reason names the pre-state mismatch (${result.reason})`,
    );
    check((await nonceOf(chain)) === before, 'G: nothing was sent');
    check(
      !existsSync(path.join(stateDirFor('changed-prestate'), 'saga-journal.json')),
      'G: no journal was created',
    );
    const balance = await localRead(chain, chain.contracts.tUSDC, ERC20_ABI, 'balanceOf', [OWNER]);
    check(balance === 123_456n, 'G: the pre-existing balance is untouched');
  } finally {
    killAnvil(portG);
    anvilG.kill();
  }

  process.stdout.write(
    '\n======================================================================\n',
  );
  if (failures === 0) {
    process.stdout.write(`LOCAL SAGA TOOLING CHECK PASSED - ${checks} checks, 8 scenarios\n`);
  } else {
    process.stderr.write(`LOCAL SAGA TOOLING CHECK FAILED - ${failures} of ${checks} checks\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `local saga check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
