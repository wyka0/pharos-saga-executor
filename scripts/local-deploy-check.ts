#!/usr/bin/env tsx
/**
 * LOCAL DEPLOY TOOLING CHECK - TEST-ONLY.
 *
 * Exercises the gated Atlantic deployment runner (src/testnet/deploy/runner.ts)
 * against disposable local Anvil chains and asserts the safety behaviour:
 *
 *   A. happy path: 4 deploys + minter wiring, all CONFIRMED and verified,
 *      plus independent on-chain authorization checks with a second account
 *   B. wrong chain (chainId 5): refused before any send
 *   C. forced on-chain revert (low-gas injection): stops, journal REVERTED,
 *      no further sends
 *   D. ambiguous outcome (no-mining node + short timeout): journal UNKNOWN,
 *      exactly one broadcast, still exactly one tx after mining, never resent
 *   E1. deployed runtime-bytecode mismatch (corrupt runtime byte on the vault):
 *       the masked bytecode comparison stops the run before the wiring tx
 *   E2. tampered immutable slot (corrupt immutable-template byte): masked
 *       comparison ignores slots by design, so the getter checks catch it
 *
 * Everything runs on 127.0.0.1 Anvil (chainId 31337) with the node's own
 * unlocked test accounts. No private key is read, nothing touches Atlantic or
 * mainnet. Run with: npm run demo:deploy-tooling
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  parseAbi,
  type Address,
} from 'viem';
import {
  buildPlanCore,
  computePlanHash,
  loadPlanArtifacts,
} from '../src/testnet/deployPlan.js';
import {
  runDeployment,
  type DeployRunResult,
  type DeployTestInjections,
} from '../src/testnet/deploy/runner.js';
import { DeployJournal } from '../src/testnet/deploy/journal.js';

const ROOT = path.resolve('.');
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

const RECEIPT_WIRE_ABI = parseAbi([
  'function setMinter(address minter, bool allowed)',
  'function minters(address minter) view returns (bool)',
  'function controller() view returns (address)',
]);
const USDC_ADMIN_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function burn(address from, uint256 amount)',
  'function controller() view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const SWAP_VIEW_ABI = parseAbi([
  'function controller() view returns (address)',
  'function usdc() view returns (address)',
  'function receipt() view returns (address)',
  'function feeBps() view returns (uint256)',
]);
const VAULT_VIEW_ABI = parseAbi([
  'function controller() view returns (address)',
  'function asset() view returns (address)',
]);

let failures = 0;
function pass(message: string): void {
  process.stdout.write(`PASS  ${message}\n`);
}
function fail(message: string): void {
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

/** Same force-rebuild the runner performs; needed once before hashing. */
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
    throw new Error(
      `forge build --force failed: ${String(result.stderr ?? '').slice(-400)}`,
    );
  }
  process.stdout.write('forge build --force: OK\n');
}

function startAnvil(port: number, options: { chainId?: number; extra?: string[] } = {}): ChildProcess {
  const args = [
    '--port',
    String(port),
    '--chain-id',
    String(options.chainId ?? 31337),
    '--silent',
    ...(options.extra ?? []),
  ];
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
  return path.join(ROOT, '.demo-state', 'deploy-tooling', scenario);
}

async function runOnce(
  scenario: string,
  port: number,
  approvedPlanHash: string,
  options: { injections?: DeployTestInjections; timeoutMs?: number } = {},
): Promise<DeployRunResult> {
  const stateDir = stateDirFor(scenario);
  await fs.rm(stateDir, { recursive: true, force: true });
  process.stdout.write(`\n--- runner for scenario ${scenario} (rpc 127.0.0.1:${port}) ---\n`);
  return runDeployment({
    repoRoot: ROOT,
    mode: 'local-anvil',
    approvedPlanHash,
    deployerAddress: OWNER,
    rpcUrl: `http://127.0.0.1:${port}`,
    stateDir,
    receiptTimeoutMs: options.timeoutMs ?? 20_000,
    testInjections: options.injections,
    forgeCommand: forgeCommand(),
    log: (line) => process.stdout.write(`  [${scenario}] ${line}\n`),
  });
}

async function main(): Promise<void> {
  buildOnce();
  const artifacts = await loadPlanArtifacts(ROOT);
  const approvedPlanHash = computePlanHash(buildPlanCore(OWNER, artifacts));
  process.stdout.write(`approved plan hash: ${approvedPlanHash}\n`);

  /* ---------------------------------------------------------------- scenario A */
  process.stdout.write('\nSCENARIO A: happy path deploys + on-chain authorization checks\n');
  const portA = 8546;
  killAnvil(portA);
  const anvilA = startAnvil(portA);
  const kids: ChildProcess[] = [anvilA];
  try {
    await waitForRpc(portA, 31337);
    const resultA = await runOnce('happy', portA, approvedPlanHash);
    check(resultA.status === 'COMPLETE', `A: run COMPLETE (got ${resultA.status}${resultA.reason ? ` - ${resultA.reason}` : ''})`);
    check(Object.keys(resultA.addresses).length === 4, 'A: four contracts deployed');
    check(resultA.predictedAddresses.length === 4, 'A: four deterministic predictions');

    const client = clientFor(portA);
    const wallet = createWalletClient({
      account: OWNER,
      transport: http(`http://127.0.0.1:${portA}`, { timeout: 10_000, retryCount: 1 }),
    });
    const journal = new DeployJournal(path.join(stateDirFor('happy'), 'deploy-journal.json'));
    const entries = await journal.list();
    check(entries.length === 5, `A: journal has 5 entries (got ${entries.length})`);
    check(
      entries.every((entry) => entry.status === 'CONFIRMED'),
      'A: every journal entry CONFIRMED',
    );

    const usdc = resultA.addresses['TestOnlyUSDC'] as Address;
    const receipt = resultA.addresses['TestOnlyReceiptToken'] as Address;
    const swap = resultA.addresses['TestOnlySwap'] as Address;
    const vault = resultA.addresses['TestOnlyVault'] as Address;
    for (const item of resultA.predictedAddresses) {
      const deployed = resultA.addresses[item.name];
      check(
        (deployed ?? '').toLowerCase() === item.address.toLowerCase(),
        `A: predicted address matches for ${item.name}`,
      );
    }

    const read = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      (client.readContract({ address, abi: abi as never, functionName, args: args as never })) as Promise<unknown>;
    check(
      ((await read(usdc, USDC_ADMIN_ABI, 'controller')) as string).toLowerCase() === OWNER.toLowerCase(),
      'A: usdc controller is the deployer',
    );
    check(
      ((await read(receipt, RECEIPT_WIRE_ABI, 'controller')) as string).toLowerCase() === OWNER.toLowerCase(),
      'A: receipt controller is the deployer',
    );
    check(
      ((await read(swap, SWAP_VIEW_ABI, 'controller')) as string).toLowerCase() === OWNER.toLowerCase(),
      'A: swap controller is the deployer',
    );
    check(
      ((await read(vault, VAULT_VIEW_ABI, 'controller')) as string).toLowerCase() === OWNER.toLowerCase(),
      'A: vault controller is the deployer',
    );
    check((await read(receipt, RECEIPT_WIRE_ABI, 'minters', [swap])) === true, 'A: swap wired as minter');
    check((await read(receipt, RECEIPT_WIRE_ABI, 'minters', [OWNER])) === false, 'A: controller is not a minter');
    check(((await read(swap, SWAP_VIEW_ABI, 'usdc')) as string).toLowerCase() === usdc.toLowerCase(), 'A: swap.usdc wiring');
    check(((await read(swap, SWAP_VIEW_ABI, 'receipt')) as string).toLowerCase() === receipt.toLowerCase(), 'A: swap.receipt wiring');
    check((await read(swap, SWAP_VIEW_ABI, 'feeBps')) === 100n, 'A: swap feeBps is 100');
    check(((await read(vault, VAULT_VIEW_ABI, 'asset')) as string).toLowerCase() === receipt.toLowerCase(), 'A: vault.asset wiring');
    check((await read(usdc, USDC_ADMIN_ABI, 'decimals')) === 6, 'A: usdc decimals are 6');
    check((await read(receipt, USDC_ADMIN_ABI, 'decimals')) === 6, 'A: receipt decimals are 6');

    // controller path still works
    const mintHash = await wallet.writeContract({
      account: OWNER,
      chain: null,
      address: usdc,
      abi: USDC_ADMIN_ABI,
      functionName: 'mint',
      args: [OWNER, 5n],
    });
    const mintReceipt = await client.waitForTransactionReceipt({ hash: mintHash });
    check(mintReceipt.status === 'success', 'A: controller can mint mock USDC');
    check((await read(usdc, USDC_ADMIN_ABI, 'balanceOf', [OWNER])) === 5n, 'A: controller mint credited');

    // unauthorized second account cannot change settings or mint
    const walletOther = createWalletClient({
      account: OTHER,
      transport: http(`http://127.0.0.1:${portA}`, { timeout: 10_000, retryCount: 1 }),
    });
    const expectRejected = async (label: string, send: () => Promise<`0x${string}`>): Promise<void> => {
      try {
        const hash = await send();
        const rejected = await client.waitForTransactionReceipt({ hash });
        check(rejected.status === 'reverted', `${label}: reverted on-chain`);
      } catch (error) {
        check(true, `${label}: rejected at broadcast (${(error instanceof Error ? error.message : String(error)).slice(0, 60)})`);
      }
    };
    await expectRejected('A: unauthorized setMinter', () =>
      walletOther.writeContract({
        account: OTHER,
        chain: null,
        address: receipt,
        abi: RECEIPT_WIRE_ABI,
        functionName: 'setMinter',
        args: [OTHER, true],
      }),
    );
    await expectRejected('A: unauthorized mock-USDC mint', () =>
      walletOther.writeContract({
        account: OTHER,
        chain: null,
        address: usdc,
        abi: USDC_ADMIN_ABI,
        functionName: 'mint',
        args: [OTHER, 1n],
      }),
    );
    check(
      (await read(receipt, RECEIPT_WIRE_ABI, 'minters', [OTHER])) === false,
      'A: attacker remained a non-minter',
    );
    check(
      (await read(usdc, USDC_ADMIN_ABI, 'balanceOf', [OTHER])) === 0n,
      'A: attacker holds no mock USDC',
    );
  } finally {
    killAnvil(portA);
    for (const child of kids) child.kill();
  }

  /* ---------------------------------------------------------------- scenario B */
  process.stdout.write('\nSCENARIO B: wrong-chain refusal (chainId 5, no sends)\n');
  const portB = 8547;
  killAnvil(portB);
  const anvilB = startAnvil(portB, { chainId: 5 });
  try {
    await waitForRpc(portB, 5);
    const resultB = await runOnce('wrong-chain', portB, approvedPlanHash);
    check(resultB.status === 'STOPPED', 'B: run stopped');
    check(/WRONG CHAIN/.test(resultB.reason ?? ''), `B: refusal names the wrong chain (${resultB.reason})`);
    const client = clientFor(portB);
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 0,
      'B: no transaction was sent',
    );
    let journalExists = true;
    try {
      await fs.access(path.join(stateDirFor('wrong-chain'), 'deploy-journal.json'));
    } catch {
      journalExists = false;
    }
    check(!journalExists, 'B: no journal was even created');
  } finally {
    killAnvil(portB);
    anvilB.kill();
  }

  /* ---------------------------------------------------------------- scenario C */
  process.stdout.write('\nSCENARIO C: forced on-chain revert (low-gas injection)\n');
  const portC = 8548;
  killAnvil(portC);
  const anvilC = startAnvil(portC);
  try {
    await waitForRpc(portC, 31337);
    const resultC = await runOnce('forced-revert', portC, approvedPlanHash, {
      injections: { lowGasFor: 'TestOnlyReceiptToken' },
    });
    check(resultC.status === 'STOPPED', 'C: run stopped');
    check(/reverted/.test(resultC.reason ?? ''), `C: stop reason is a revert (${resultC.reason})`);
    const client = clientFor(portC);
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 2,
      'C: exactly two transactions were sent (USDC + failed receipt deploy)',
    );
    const swapPredicted = getContractAddress({ from: OWNER, nonce: 2n });
    const swapCode = await client.getCode({ address: swapPredicted });
    check(!swapCode || swapCode === '0x', 'C: swap was never deployed');
    const journal = new DeployJournal(path.join(stateDirFor('forced-revert'), 'deploy-journal.json'));
    const entries = await journal.list();
    check(entries.length === 2, `C: journal stopped at 2 entries (got ${entries.length})`);
    check(entries[0]?.status === 'CONFIRMED', 'C: USDC entry CONFIRMED');
    check(entries[1]?.status === 'REVERTED', 'C: receipt-token entry REVERTED');
  } finally {
    killAnvil(portC);
    anvilC.kill();
  }

  /* ---------------------------------------------------------------- scenario D */
  process.stdout.write('\nSCENARIO D: ambiguous outcome (no-mining node, short timeout)\n');
  const portD = 8549;
  killAnvil(portD);
  const anvilD = startAnvil(portD, { extra: ['--no-mining'] });
  try {
    await waitForRpc(portD, 31337);
    const resultD = await runOnce('ambiguous', portD, approvedPlanHash, { timeoutMs: 2_500 });
    check(resultD.status === 'STOPPED', 'D: run stopped');
    check(/not observed/.test(resultD.reason ?? ''), `D: stop reason is an unobserved receipt (${resultD.reason})`);
    const client = clientFor(portD);
    const journal = new DeployJournal(path.join(stateDirFor('ambiguous'), 'deploy-journal.json'));
    const entriesAfterStop = await journal.list();
    check(entriesAfterStop.length === 1, `D: exactly one journal entry (got ${entriesAfterStop.length})`);
    check(entriesAfterStop[0]?.status === 'UNKNOWN', 'D: entry marked UNKNOWN');
    check(entriesAfterStop[0]?.txHash !== null, 'D: the broadcast hash was journaled');

    // Mine the pending transaction afterwards (the operator would reconcile).
    const request = client.request as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    await request({ method: 'anvil_mine', params: [] });
    await delay(500);
    const block = await client.getBlock({ blockNumber: 1n, includeTransactions: true });
    check(block.transactions.length === 1, `D: the mined block contains exactly one tx (got ${block.transactions.length})`);
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 1,
      'D: exactly one transaction ever existed for the account',
    );
    const usdcPredicted = getContractAddress({ from: OWNER, nonce: 0n });
    const usdcCode = await client.getCode({ address: usdcPredicted });
    check(Boolean(usdcCode) && usdcCode !== '0x', 'D: the single broadcast became the USDC deploy');
    const entriesAfterMine = await journal.list();
    check(entriesAfterMine.length === 1, 'D: no resend happened after mining');
    check(entriesAfterMine[0]?.status === 'UNKNOWN', 'D: journal still UNKNOWN (no automatic resend)');
  } finally {
    killAnvil(portD);
    anvilD.kill();
  }

  /* --------------------------------------------------------------- scenario E1 */
  process.stdout.write('\nSCENARIO E1: deployed runtime-bytecode mismatch (corrupt runtime byte)\n');
  const portE1 = 8550;
  killAnvil(portE1);
  const anvilE1 = startAnvil(portE1);
  try {
    await waitForRpc(portE1, 31337);
    const resultE1 = await runOnce('bytecode-mismatch', portE1, approvedPlanHash, {
      injections: { corruptByteFor: 'TestOnlyVault' },
    });
    check(resultE1.status === 'STOPPED', 'E1: run stopped');
    check(
      /deployed bytecode differs/.test(resultE1.reason ?? ''),
      `E1: stop reason is a bytecode mismatch (${resultE1.reason})`,
    );
    const client = clientFor(portE1);
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 4,
      'E1: exactly four transactions were sent (wiring never executed)',
    );
    const journal = new DeployJournal(path.join(stateDirFor('bytecode-mismatch'), 'deploy-journal.json'));
    const entries = await journal.list();
    check(entries.length === 4, `E1: journal has 4 entries (got ${entries.length})`);
    const vaultEntry = entries.find((entry) => entry.name === 'TestOnlyVault');
    check(vaultEntry?.status === 'UNKNOWN', 'E1: vault entry marked UNKNOWN');
    check(
      (vaultEntry?.note ?? '').includes('deployed bytecode differs'),
      'E1: note records the bytecode mismatch',
    );
    check(!entries.some((entry) => entry.name === 'WireMinter'), 'E1: wiring step never ran');
    const receiptAddr = resultE1.addresses['TestOnlyReceiptToken'] as Address;
    const swapAddr = resultE1.addresses['TestOnlySwap'] as Address;
    const read = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      (client.readContract({ address, abi: abi as never, functionName, args: args as never })) as Promise<unknown>;
    check((await read(receiptAddr, RECEIPT_WIRE_ABI, 'minters', [swapAddr])) === false, 'E1: swap minter was not wired');
    const vaultAddr = vaultEntry?.contractAddress as Address | null;
    check(Boolean(vaultAddr), 'E1: journal recorded the vault address for reconciliation');
    if (vaultAddr) {
      const vaultCode = await client.getCode({ address: vaultAddr });
      check(Boolean(vaultCode) && vaultCode !== '0x', 'E1: the corrupt vault code exists on-chain (and was detected)');
    }
  } finally {
    killAnvil(portE1);
    anvilE1.kill();
  }

  /* --------------------------------------------------------------- scenario E2 */
  process.stdout.write('\nSCENARIO E2: tampered immutable slot (corrupt immutable-template byte)\n');
  const portE2 = 8551;
  killAnvil(portE2);
  const anvilE2 = startAnvil(portE2);
  try {
    await waitForRpc(portE2, 31337);
    const resultE2 = await runOnce('immutable-tamper', portE2, approvedPlanHash, {
      injections: { corruptImmutableFor: 'TestOnlyVault' },
    });
    check(resultE2.status === 'STOPPED', 'E2: run stopped');
    check(
      /controller mismatch|asset mismatch/.test(resultE2.reason ?? ''),
      `E2: getter checks caught the tampered immutable (${resultE2.reason})`,
    );
    const client = clientFor(portE2);
    check(
      (await client.getTransactionCount({ address: OWNER, blockTag: 'pending' })) === 4,
      'E2: exactly four transactions were sent (wiring never executed)',
    );
    const journal = new DeployJournal(path.join(stateDirFor('immutable-tamper'), 'deploy-journal.json'));
    const entries = await journal.list();
    check(entries.length === 4, `E2: journal has 4 entries (got ${entries.length})`);
    const vaultEntry = entries.find((entry) => entry.name === 'TestOnlyVault');
    check(vaultEntry?.status === 'UNKNOWN', 'E2: vault entry marked UNKNOWN');
    check(
      (vaultEntry?.note ?? '').includes('verification failed'),
      'E2: note records the verification failure',
    );
    check(!entries.some((entry) => entry.name === 'WireMinter'), 'E2: wiring step never ran');
  } finally {
    killAnvil(portE2);
    anvilE2.kill();
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write('LOCAL DEPLOY TOOLING CHECK: 6/6 scenarios PASS\n');
  } else {
    process.stderr.write(`LOCAL DEPLOY TOOLING CHECK: ${failures} check(s) FAILED\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\nlocal deploy tooling check aborted: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
