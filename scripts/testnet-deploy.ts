#!/usr/bin/env tsx
/**
 * GATED DEPLOYMENT CLI - TEST-ONLY MOCK CONTRACTS.
 *
 * Two modes:
 *   --mode atlantic     SIGNS AND BROADCASTS to Pharos Atlantic testnet
 *                       (chainId 688689) - only after every gate passes.
 *                       Requires: --env-file <path> --address <0x...>
 *                                 --approve-plan <64-hex>
 *                                 --confirm-atlantic-testnet
 *   --mode local-anvil  Exercises the exact same runner against a disposable
 *                       local Anvil node (chainId 31337 only, loopback RPC,
 *                       node-signed unlocked account, never reads a key).
 *
 * The runner (src/testnet/deploy/runner.ts) is the only send path and enforces:
 *   force-rebuild -> approved plan-hash gate -> chain guard -> nonce / gas price
 *   / balance re-read -> 0.05 PHRS hard ceiling -> INTENT journal before every
 *   send -> exactly one send per step -> receipt + deployed bytecode +
 *   immutable-reference + actual-address verification. Ambiguous outcomes are
 *   never resent; any mismatch stops the run.
 *
 * Test-only fault injections (--test-inject-*) are refused in atlantic mode.
 */
import path from 'node:path';
import { isAddress, type Address } from 'viem';
import { loadEnvFile } from '../src/testnet/env.js';
import { runDeployment, type DeployRunResult } from '../src/testnet/deploy/runner.js';

const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const USAGE = [
  'GATED DEPLOYMENT CLI (TEST-ONLY MOCK CONTRACTS)',
  '',
  'Atlantic (SIGNS AND BROADCASTS after all gates pass):',
  '  npx tsx scripts/testnet-deploy.ts --mode atlantic --env-file <path> \\',
  '      --address <0x...> --approve-plan <64-hex> --confirm-atlantic-testnet',
  '',
  'Local Anvil tooling check (never reads a key; unlocked node account signs):',
  '  npx tsx scripts/testnet-deploy.ts --mode local-anvil --approve-plan <64-hex> \\',
  '      [--rpc http://127.0.0.1:8546] [--address 0x...] [--receipt-timeout-ms 20000] \\',
  '      [--state-dir .demo-state/...] [--test-inject-corrupt-byte <name>] \\',
  '      [--test-inject-corrupt-immutable <name>] \\',
  '      [--test-inject-low-gas <name>] [--test-inject-ambiguous <name>]',
  '',
  'Every run force-rebuilds the contracts, compares fresh artifact hashes with',
  'the approved plan hash, verifies chainId/nonce/gas price/balance and the',
  '0.05 PHRS ceiling, journals INTENT before each send, and never resends an',
  'ambiguous transaction. Test injections are refused in atlantic mode.',
  '',
].join('\n');

function printResult(result: DeployRunResult): void {
  process.stdout.write(`\nrun status: ${result.status}${result.reason ? ` - ${result.reason}` : ''}\n`);
  for (const [name, address] of Object.entries(result.addresses)) {
    process.stdout.write(`  ${name}: ${address}\n`);
  }
  process.stdout.write(`  total gas used: ${result.totalGasUsed}\n`);
  process.stdout.write(`  total spent: ${result.totalWeiSpent} wei\n`);
  process.stdout.write(`  journal: ${result.journalPath}\n`);
}

async function main(): Promise<number> {
  const mode = argValue('--mode');
  if (mode !== 'atlantic' && mode !== 'local-anvil') {
    process.stderr.write(USAGE);
    return 1;
  }
  const approvedPlanHash = argValue('--approve-plan');
  if (!approvedPlanHash || !/^[0-9a-fA-F]{64}$/.test(approvedPlanHash)) {
    process.stderr.write('refusing: --approve-plan <64-hex hash from the plan script> is required\n');
    return 1;
  }
  const injections = {
    corruptByteFor: argValue('--test-inject-corrupt-byte'),
    corruptImmutableFor: argValue('--test-inject-corrupt-immutable'),
    lowGasFor: argValue('--test-inject-low-gas'),
    ambiguousFor: argValue('--test-inject-ambiguous'),
  };
  const anyInjection = Boolean(
    injections.corruptByteFor ||
      injections.corruptImmutableFor ||
      injections.lowGasFor ||
      injections.ambiguousFor,
  );
  const repoRoot = process.cwd();
  const log = (line: string) => {
    process.stdout.write(`${line}\n`);
  };
  const forgeCommand = {
    repoRoot,
    wslDistro: process.env.WSL_DISTRO ?? 'Ubuntu',
    forgeBin: process.env.FORGE_BIN ?? '/home/wyka/.foundry/bin/forge',
  };

  if (mode === 'atlantic') {
    if (!hasFlag('--confirm-atlantic-testnet')) {
      process.stderr.write('refusing: atlantic mode additionally requires --confirm-atlantic-testnet\n');
      return 1;
    }
    if (anyInjection) {
      process.stderr.write('refusing: test injections are only available in local-anvil mode\n');
      return 1;
    }
    const envFile = argValue('--env-file');
    if (!envFile) {
      process.stderr.write('refusing: atlantic mode requires --env-file <path>\n');
      return 1;
    }
    const address = argValue('--address');
    if (!address || !isAddress(address)) {
      process.stderr.write('refusing: atlantic mode requires --address <approved deployer>\n');
      return 1;
    }
    const env = loadEnvFile(envFile);
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) {
      process.stderr.write('refusing: RPC_URL is missing from the env file\n');
      return 1;
    }
    const keyVar = argValue('--key-var') ?? 'PRIVATE_KEY';
    log('ATLANTIC MODE: this run will SIGN AND BROADCAST after all gates pass.');
    log(`approved plan hash: ${approvedPlanHash.toLowerCase()}`);
    log(`deployer (from --address): ${address}`);
    log('the signing key is read from the env file only after all gates pass,');
    log('immediately before the first send, and is never printed or journaled.');
    const result = await runDeployment({
      repoRoot,
      mode: 'atlantic',
      approvedPlanHash,
      deployerAddress: address as Address,
      rpcUrl,
      stateDir: path.resolve(argValue('--state-dir') ?? path.join('.local', 'atlantic-deploy')),
      receiptTimeoutMs: Number(argValue('--receipt-timeout-ms') ?? 180_000),
      confirmAtlanticTestnet: true,
      keyProvider: () => {
        const fresh = loadEnvFile(envFile);
        const key = fresh[keyVar];
        if (!key) throw new Error('the signing key is missing from the env file');
        return key.startsWith('0x') ? key : `0x${key}`;
      },
      forgeCommand,
      log,
    });
    printResult(result);
    return result.status === 'COMPLETE' ? 0 : 2;
  }

  const rpcUrl = argValue('--rpc') ?? 'http://127.0.0.1:8546';
  const addressArg = argValue('--address') ?? ANVIL_ACCOUNT_0;
  if (!isAddress(addressArg)) {
    process.stderr.write('refusing: --address is not a valid address\n');
    return 1;
  }
  log('LOCAL ANVIL MODE: disposable chain only; no key is read, nothing is signed.');
  log(`approved plan hash: ${approvedPlanHash.toLowerCase()}`);
  const result = await runDeployment({
    repoRoot,
    mode: 'local-anvil',
    approvedPlanHash,
    deployerAddress: addressArg as Address,
    rpcUrl,
    stateDir: path.resolve(
      argValue('--state-dir') ?? path.join('.demo-state', 'deploy-tooling', 'manual'),
    ),
    receiptTimeoutMs: Number(argValue('--receipt-timeout-ms') ?? 20_000),
    testInjections: anyInjection ? injections : undefined,
    forgeCommand,
    log,
  });
  printResult(result);
  return result.status === 'COMPLETE' ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `deploy CLI failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
