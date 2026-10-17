/**
 * LOCAL ANVIL END-TO-END DEMO - TEST-ONLY.
 *
 * Drives the real SagaExecutor through the local-anvil adapter against a
 * disposable Anvil chain (chainId 31337) with TestOnly* contracts:
 *
 *   1. APPROVE -> SWAP -> DEPOSIT success with balance/receipt postconditions
 *   2. forced SWAP revert            -> REVOKE_APPROVAL compensation
 *   3. forced DEPOSIT revert         -> SIMULATED_UNWIND_SWAP compensation
 *   4. unknown SWAP outcome injected -> reconcile by idempotency key, no resubmission
 *
 * No Atlantic, no mainnet, no private keys (Anvil signs for its own unlocked
 * account), no real funds. Foundry/anvil is required and is discovered via
 * ANVIL_BIN (default: /home/wyka/.foundry/bin/anvil through WSL Ubuntu).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
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
import { LocalAnvilAdapter } from '../src/adapters/localAnvil.js';
import type { LocalAnvilConfig, ProofReceipt, SagaRecord, StartSagaInput } from '../src/domain/types.js';
import { SagaExecutor } from '../src/executor/executor.js';
import { LocalJournal } from '../src/persistence/localJournal.js';
import { SagaStore } from '../src/persistence/store.js';
import { assertDemo } from './lib.js';

// Well-known public Anvil test address (account 0). NOT a private key.
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const ONE_TUSDC = 1_000_000n; // 6 decimals
const SWAP_FEE_BPS = 100n; // 1% test fee

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const USDC_ADMIN_ABI = parseAbi(['function mint(address to, uint256 amount)']);
const RECEIPT_MINTER_ABI = parseAbi(['function setMinter(address minter, bool allowed)']);
const SWAP_FAULT_ABI = parseAbi(['function setFailNextSwap(bool value)']);
const VAULT_FAULT_ABI = parseAbi(['function setFailNextDeposit(bool value)']);
const VAULT_SHARES_ABI = parseAbi(['function sharesOf(address owner) view returns (uint256)']);

interface ForgeArtifact {
  abi: readonly unknown[];
  bytecode: { object: string };
}

function banner(): void {
  process.stdout.write(
    [
      '='.repeat(78),
      'PHAROS SAGA EXECUTOR - LOCAL ANVIL END-TO-END DEMONSTRATION',
      'CLASSIFICATION: TEST-ONLY - real transactions on a disposable chain (chainId 31337)',
      'NOT ATLANTIC TESTNET, NOT MAINNET, NO REAL FUNDS, NO PRIVATE KEYS.',
      '='.repeat(78),
      '',
    ].join('\n'),
  );
}

async function loadArtifact(relative: string): Promise<ForgeArtifact> {
  const file = path.resolve('out', relative);
  const raw = await fs.readFile(file, 'utf8').catch(() => {
    throw new Error(
      `Missing Foundry artifact ${file}. Build first with:\n` +
        "  wsl.exe -d Ubuntu -- /home/wyka/.foundry/bin/forge build",
    );
  });
  const parsed = JSON.parse(raw) as ForgeArtifact;
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode?.object !== 'string') {
    throw new Error(`Malformed Foundry artifact ${file}`);
  }
  return parsed;
}

/* JSON ABI artifacts are intentionally treated loosely at this test-only boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */

async function deploy(
  wallet: any,
  publicClient: any,
  artifact: ForgeArtifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash: Hash = await wallet.deployContract({
    account: OWNER,
    chain: null,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Local deploy failed: ${hash}`);
  }
  return receipt.contractAddress as Address;
}

async function write(
  wallet: any,
  publicClient: any,
  params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  },
): Promise<Hash> {
  const hash: Hash = await wallet.writeContract({
    account: OWNER,
    chain: null,
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args ?? [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Local write reverted: ${hash}`);
  return hash;
}

async function read(
  client: any,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<bigint> {
  return client.readContract({ address, abi, functionName, args });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function startAnvil(port: number): ChildProcess {
  const args = ['--port', String(port), '--chain-id', '31337', '--silent'];
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
  if (process.platform !== 'win32') {
    try {
      spawnSync('pkill', ['-f', `anvil --port ${port}`], { stdio: 'ignore', timeout: 10_000 });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
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

async function waitForRpc(client: any, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const chainId = await client.getChainId();
      if (chainId === 31337) return;
      lastError = `unexpected chainId ${chainId}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Anvil was not reachable with chainId 31337 within ${timeoutMs}ms: ${lastError}`);
}

/**
 * The three-step saga only defines one APPROVE (for the swap spender). The
 * test-only vault additionally pulls tSAGA with transferFrom, so the harness
 * grants a bounded, exact test allowance before each saga that will deposit.
 * This is a documented local-test precondition, never an unlimited approval.
 */
async function grantVaultAllowance(
  wallet: any,
  publicClient: any,
  receiptToken: Address,
  vault: Address,
  amount: bigint,
): Promise<void> {
  await write(wallet, publicClient, {
    address: receiptToken,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [vault, amount],
  });
}

function assertLocalReceipt(receipt: ProofReceipt | null | undefined, label: string): void {
  assertDemo(receipt !== null && receipt !== undefined, `${label} must have a receipt`);
  assertDemo(receipt.simulated === false, `${label} receipt must not be simulated`);
  assertDemo(receipt.network === 'local-anvil', `${label} receipt must be on local-anvil`);
  assertDemo(receipt.explorerUrl === null, `${label} receipt must not claim an explorer link`);
  assertDemo(
    typeof receipt.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(receipt.txHash),
    `${label} receipt must carry a real transaction hash`,
  );
}

interface ScenarioDeps {
  config: LocalAnvilConfig;
  swap: Address;
  vault: Address;
}

interface ScenarioResult {
  saga: SagaRecord;
  adapter: LocalAnvilAdapter;
  journal: LocalJournal;
  stateDir: string;
}

async function runScenario(
  name: string,
  sagaId: string,
  deps: ScenarioDeps,
  options: { unknownOn?: 'SWAP' } = {},
): Promise<ScenarioResult> {
  const stateDir = path.resolve('.demo-state', 'local-anvil', name);
  await fs.rm(stateDir, { recursive: true, force: true });
  const store = new SagaStore(stateDir);
  const journal = new LocalJournal(path.join(stateDir, 'local-anvil-journal.json'));
  const adapter = new LocalAnvilAdapter({
    config: deps.config,
    journal,
    ...(options.unknownOn ? { unknownOn: options.unknownOn } : {}),
  });
  const executor = new SagaExecutor({ store, adapterFactory: () => adapter });
  const input: StartSagaInput = {
    sagaId,
    clientRequestId: `client_local_${name}`,
    adapterId: 'local-anvil',
    localAnvil: deps.config,
    request: {
      owner: OWNER,
      fromToken: 'tUSDC',
      toToken: 'tSAGA',
      depositToken: 'tSAGA',
      amountIn: '1',
      spender: deps.swap,
      protocol: 'TestOnlyVault',
      depositTarget: deps.vault,
    },
  };
  const { saga } = await executor.startSaga(input);
  return { saga, adapter, journal, stateDir };
}

async function main(): Promise<void> {
  banner();

  const port = Number(process.env.LOCAL_ANVIL_PORT ?? '8546');
  const externalRpc = process.env.LOCAL_ANVIL_RPC;
  const rpcUrl = externalRpc ?? `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  if (!externalRpc) {
    killAnvil(port); // clear a stale listener from a previous run
    child = startAnvil(port);
  }

  try {
    const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const publicClient: any = createPublicClient({ transport });
    const wallet: any = createWalletClient({ account: OWNER, transport });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    await waitForRpc(publicClient);
    assertDemo((await publicClient.getChainId()) === 31337, 'demo only runs on chainId 31337');
    process.stdout.write(`Anvil ready at ${rpcUrl} (chainId 31337).\n`);

    const usdcArt = await loadArtifact('TestOnlyTokens.sol/TestOnlyUSDC.json');
    const receiptArt = await loadArtifact('TestOnlyTokens.sol/TestOnlyReceiptToken.json');
    const swapArt = await loadArtifact('TestOnlySwap.sol/TestOnlySwap.json');
    const vaultArt = await loadArtifact('TestOnlyVault.sol/TestOnlyVault.json');

    const usdc = await deploy(wallet, publicClient, usdcArt, [OWNER]);
    const receiptToken = await deploy(wallet, publicClient, receiptArt, [OWNER]);
    const swap = await deploy(wallet, publicClient, swapArt, [usdc, receiptToken, SWAP_FEE_BPS, OWNER]);
    const vault = await deploy(wallet, publicClient, vaultArt, [receiptToken, OWNER]);
    // The receipt token only accepts a minter set by its immutable test controller
    // (OWNER). This mirrors the wiring transaction of the gated deployment script.
    await write(wallet, publicClient, {
      address: receiptToken,
      abi: RECEIPT_MINTER_ABI,
      functionName: 'setMinter',
      args: [swap, true],
    });
    await write(wallet, publicClient, {
      address: usdc,
      abi: USDC_ADMIN_ABI,
      functionName: 'mint',
      args: [OWNER, 1_000n * ONE_TUSDC],
    });
    process.stdout.write(
      `Deployed TEST-ONLY contracts: usdc=${usdc} receipt=${receiptToken} swap=${swap} vault=${vault}\n\n`,
    );

    const config: LocalAnvilConfig = {
      chainId: 31337,
      rpcUrl,
      owner: OWNER,
      usdc,
      receiptToken,
      swap,
      vault,
    };
    const deps: ScenarioDeps = { config, swap, vault };

    // ---------------------------------------------------------------- scenario 1
    process.stdout.write('SCENARIO 1: APPROVE -> SWAP -> DEPOSIT success\n');
    // Test-only precondition: exact 0.99 tSAGA allowance for the mock vault's transferFrom.
    await grantVaultAllowance(wallet, publicClient, receiptToken, vault, 990_000n);
    const before1 = await read(publicClient, usdc, ERC20_ABI, 'balanceOf', [OWNER]);
    const one = await runScenario('success', 'saga_local_success', deps);
    assertDemo(one.saga.state === 'COMPLETED', `scenario 1 must COMPLETE; got ${one.saga.state}`);
    assertDemo(one.saga.steps.APPROVE.status === 'SUCCEEDED', 'scenario 1 APPROVE must succeed');
    assertDemo(one.saga.steps.SWAP.status === 'SUCCEEDED', 'scenario 1 SWAP must succeed');
    assertDemo(one.saga.steps.DEPOSIT.status === 'SUCCEEDED', 'scenario 1 DEPOSIT must succeed');
    assertLocalReceipt(one.saga.steps.APPROVE.receipt, 'scenario 1 APPROVE');
    assertLocalReceipt(one.saga.steps.SWAP.receipt, 'scenario 1 SWAP');
    assertLocalReceipt(one.saga.steps.DEPOSIT.receipt, 'scenario 1 DEPOSIT');
    const after1 = await read(publicClient, usdc, ERC20_ABI, 'balanceOf', [OWNER]);
    assertDemo(before1 - after1 === ONE_TUSDC, `scenario 1 must spend exactly 1 tUSDC; spent ${before1 - after1}`);
    assertDemo(
      (await read(publicClient, receiptToken, ERC20_ABI, 'balanceOf', [OWNER])) === 0n,
      'scenario 1 receipt tokens must be deposited',
    );
    assertDemo(
      (await read(publicClient, vault, VAULT_SHARES_ABI, 'sharesOf', [OWNER])) === 990_000n,
      'scenario 1 vault shares must be 0.99',
    );
    assertDemo(
      (await read(publicClient, usdc, ERC20_ABI, 'allowance', [OWNER, swap])) === 0n,
      'scenario 1 exact approval must be fully consumed',
    );
    assertDemo(one.adapter.sendCount === 3, `scenario 1 must send exactly 3 txs; got ${one.adapter.sendCount}`);
    process.stdout.write('SCENARIO 1 PASS - real local txs, balances and receipts verified.\n\n');

    // ---------------------------------------------------------------- scenario 2
    process.stdout.write('SCENARIO 2: forced SWAP revert -> REVOKE_APPROVAL compensation\n');
    await write(wallet, publicClient, {
      address: swap,
      abi: SWAP_FAULT_ABI,
      functionName: 'setFailNextSwap',
      args: [true],
    });
    const two = await runScenario('swap-failure', 'saga_local_swap_failure', deps);
    assertDemo(two.saga.state === 'FAILED', `scenario 2 must FAIL; got ${two.saga.state}`);
    assertDemo(two.saga.failure?.step === 'SWAP', `scenario 2 must fail on SWAP; got ${two.saga.failure?.step}`);
    assertDemo(two.saga.steps.SWAP.attempts === 1, 'scenario 2 must not blind-retry a deterministic revert');
    assertDemo(
      two.saga.compensation?.action === 'REVOKE_APPROVAL' &&
        two.saga.compensation.status === 'SUCCEEDED',
      `scenario 2 compensation must revoke the approval; got ${two.saga.compensation?.action}/${two.saga.compensation?.status}`,
    );
    assertLocalReceipt(two.saga.compensation?.receipt, 'scenario 2 compensation');
    assertDemo(
      (await read(publicClient, usdc, ERC20_ABI, 'allowance', [OWNER, swap])) === 0n,
      'scenario 2 compensation must end with allowance 0',
    );
    assertDemo(two.adapter.sendCount === 2, `scenario 2 must only attempt approve+swap; got ${two.adapter.sendCount}`);
    await write(wallet, publicClient, {
      address: swap,
      abi: SWAP_FAULT_ABI,
      functionName: 'setFailNextSwap',
      args: [false],
    });
    process.stdout.write('SCENARIO 2 PASS - revert diagnosed as permanent, allowance revoked, no resend.\n\n');

    // ---------------------------------------------------------------- scenario 3
    process.stdout.write('SCENARIO 3: forced DEPOSIT revert -> SIMULATED_UNWIND_SWAP compensation\n');
    await write(wallet, publicClient, {
      address: vault,
      abi: VAULT_FAULT_ABI,
      functionName: 'setFailNextDeposit',
      args: [true],
    });
    // Test-only precondition: re-grant the exact 0.99 tSAGA vault allowance.
    await grantVaultAllowance(wallet, publicClient, receiptToken, vault, 990_000n);
    const before3 = await read(publicClient, usdc, ERC20_ABI, 'balanceOf', [OWNER]);
    const three = await runScenario('deposit-failure', 'saga_local_deposit_failure', deps);
    assertDemo(three.saga.state === 'FAILED', `scenario 3 must FAIL; got ${three.saga.state}`);
    assertDemo(three.saga.failure?.step === 'DEPOSIT', `scenario 3 must fail on DEPOSIT; got ${three.saga.failure?.step}`);
    assertDemo(
      three.saga.compensation?.action === 'SIMULATED_UNWIND_SWAP' &&
        three.saga.compensation.status === 'SUCCEEDED',
      `scenario 3 compensation must unwind the swap; got ${three.saga.compensation?.action}/${three.saga.compensation?.status}`,
    );
    assertLocalReceipt(three.saga.compensation?.receipt, 'scenario 3 compensation');
    const after3 = await read(publicClient, usdc, ERC20_ABI, 'balanceOf', [OWNER]);
    assertDemo(
      before3 - after3 === 19_900n,
      `scenario 3 net cost after unwind must be 1% twice (19900 raw); got ${before3 - after3}`,
    );
    assertDemo(
      (await read(publicClient, receiptToken, ERC20_ABI, 'balanceOf', [OWNER])) === 0n,
      'scenario 3 unwind must burn the receipt tokens',
    );
    assertDemo(three.adapter.sendCount === 3, `scenario 3 must attempt approve+swap+deposit; got ${three.adapter.sendCount}`);
    await write(wallet, publicClient, {
      address: vault,
      abi: VAULT_FAULT_ABI,
      functionName: 'setFailNextDeposit',
      args: [false],
    });
    process.stdout.write('SCENARIO 3 PASS - failure compensated by a new on-chain unwind tx.\n\n');

    // ---------------------------------------------------------------- scenario 4
    process.stdout.write('SCENARIO 4: unknown SWAP outcome -> reconcile by idempotency key\n');
    // Test-only precondition: exact 0.99 tSAGA allowance for the mock vault.
    await grantVaultAllowance(wallet, publicClient, receiptToken, vault, 990_000n);
    const four = await runScenario('unknown-reconcile', 'saga_local_unknown', deps, {
      unknownOn: 'SWAP',
    });
    assertDemo(four.saga.state === 'COMPLETED', `scenario 4 must COMPLETE; got ${four.saga.state}`);
    assertDemo(
      four.adapter.sendCount === 3,
      `scenario 4 must not resubmit SWAP after the unknown outcome; sends=${four.adapter.sendCount}`,
    );
    const swapEntry = await four.journal.get(four.saga.steps.SWAP.idempotencyKey);
    assertDemo(swapEntry?.status === 'CONFIRMED', `scenario 4 SWAP journal must reconcile; got ${swapEntry?.status}`);
    assertDemo(swapEntry?.txHash !== null, 'scenario 4 reconciled SWAP must keep its real hash');
    assertDemo(
      four.saga.audit.some((event) => event.type === 'RECONCILIATION_RESULT' && event.data.found === true),
      'scenario 4 must audit a successful reconciliation',
    );
    assertDemo(
      four.saga.audit.some((event) => event.type === 'STEP_SUCCEEDED' && event.data.reconciled === true),
      'scenario 4 must mark SWAP succeeded via reconciliation',
    );
    assertLocalReceipt(four.saga.steps.SWAP.receipt, 'scenario 4 reconciled SWAP');
    assertDemo(
      (await read(publicClient, receiptToken, ERC20_ABI, 'allowance', [OWNER, vault])) === 0n,
      'scenario 4 bounded vault allowance must be fully consumed',
    );
    process.stdout.write('SCENARIO 4 PASS - unknown outcome reconciled without a second send.\n\n');

    process.stdout.write(
      [
        '='.repeat(78),
        'LOCAL ANVIL DEMO RESULT: PASS',
        `Scenarios: 4/4 passed (state under .demo-state/local-anvil/<scenario>).`,
        'All transactions were local Anvil test transactions (chainId 31337).',
        'No Atlantic testnet or mainnet transaction was sent.',
        '='.repeat(78),
        '',
      ].join('\n'),
    );
  } finally {
    if (child) {
      child.kill();
      await delay(500);
      killAnvil(port);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
