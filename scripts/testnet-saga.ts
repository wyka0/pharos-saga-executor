#!/usr/bin/env tsx
/**
 * GATED SAGA CLI - TEST-ONLY MOCK ECOSYSTEM.
 *
 * Two modes:
 *   --mode atlantic     SIGNS AND BROADCASTS the reviewed five-step saga
 *                       (mint 1 tUSDC -> approve -> swap -> approve -> deposit)
 *                       to Pharos Atlantic testnet (chainId 688689) - only
 *                       after every gate passes. Requires:
 *                         --env-file <path> --address <0x...>
 *                         --approve-plan <64-hex from scripts/testnet-saga-plan.ts>
 *                         --confirm-atlantic-testnet
 *                       Contract addresses are always derived from the durable,
 *                       verified deployment journal (--deploy-journal), never
 *                       from flags, so the approved plan hash binds them.
 *   --mode local-anvil  Exercises the exact same runner against a disposable
 *                       local Anvil node (chainId 31337 only, loopback RPC,
 *                       node-signed unlocked account, never reads a key). The
 *                       four already-deployed addresses come from
 *                       --tusdc/--tsaga/--swap/--vault.
 *
 * The runner (src/testnet/saga/runner.ts) is the only send path and enforces:
 *   force-rebuild -> approved plan-hash gate -> chain guard -> nonce / gas
 *   price / balance re-read -> 0.02 PHRS ceiling -> deployed-contract + wiring
 *   verification -> per-step preconditions -> INTENT journal before every send
 *   -> exactly one send per step -> receipt + transaction-input hash +
 *   postconditions + end-of-saga battery (official USDC untouched). Ambiguous
 *   outcomes are never resent; any mismatch stops the run.
 *
 * Test-only fault injections (--test-inject-*) are refused in atlantic mode.
 */
import path from 'node:path';
import { isAddress, type Address } from 'viem';
import { loadEnvFile } from '../src/testnet/env.js';
import { runSaga, type SagaRunResult } from '../src/testnet/saga/runner.js';

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
  'GATED SAGA CLI (TEST-ONLY MOCK ECOSYSTEM)',
  '',
  'Atlantic (SIGNS AND BROADCASTS after all gates pass; addresses come from the',
  'deployment journal, never from flags):',
  '  npx tsx scripts/testnet-saga.ts --mode atlantic --env-file <path> \\',
  '      --address <0x...> --approve-plan <64-hex> --confirm-atlantic-testnet \\',
  '      [--deploy-journal .local/atlantic-deploy/deploy-journal.json] \\',
  '      [--state-dir .local/atlantic-saga] [--receipt-timeout-ms 180000]',
  '',
  'Local Anvil tooling check (never reads a key; unlocked node account signs):',
  '  npx tsx scripts/testnet-saga.ts --mode local-anvil --approve-plan <64-hex> \\',
  '      --tusdc 0x... --tsaga 0x... --swap 0x... --vault 0x... \\',
  '      [--rpc http://127.0.0.1:8566] [--address 0x...] \\',
  '      [--test-inject-alter-calldata <name>] \\',
  '      [--test-inject-break-postcondition <name>] [--test-inject-ambiguous <name>]',
  '',
  'Every run force-rebuilds the contracts, re-derives the plan hash for the',
  'resolved addresses and refuses to send unless it matches --approve-plan,',
  'verifies chainId/nonce/gas price/balance and the 0.02 PHRS ceiling, verifies',
  'the deployed contracts and their wiring, journals INTENT before each send,',
  'and never resends an ambiguous transaction. Test injections are refused in',
  'atlantic mode.',
  '',
].join('\n');

function printResult(result: SagaRunResult): void {
  process.stdout.write(
    `\nrun status: ${result.status}${result.reason ? ` - ${result.reason}` : ''}\n`,
  );
  for (const step of result.steps) {
    process.stdout.write(`  ${step.order}. ${step.name}: ${step.outcome}\n`);
  }
  if (result.contracts) {
    process.stdout.write(`  tUSDC: ${result.contracts.tUSDC}\n`);
    process.stdout.write(`  tSAGA: ${result.contracts.tSAGA}\n`);
    process.stdout.write(`  swap:  ${result.contracts.swap}\n`);
    process.stdout.write(`  vault: ${result.contracts.vault}\n`);
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
    alterCalldataFor: argValue('--test-inject-alter-calldata'),
    breakPostconditionFor: argValue('--test-inject-break-postcondition'),
    ambiguousFor: argValue('--test-inject-ambiguous'),
  };
  const anyInjection = Boolean(
    injections.alterCalldataFor || injections.breakPostconditionFor || injections.ambiguousFor,
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
    const deployJournalPath = path.resolve(
      argValue('--deploy-journal') ?? path.join('.local', 'atlantic-deploy', 'deploy-journal.json'),
    );
    log('ATLANTIC MODE: this run will SIGN AND BROADCAST after all gates pass.');
    log(`approved plan hash: ${approvedPlanHash.toLowerCase()}`);
    log(`deployer (from --address): ${address}`);
    log(`deployment journal: ${deployJournalPath}`);
    log('contract addresses are always derived from that journal, never from flags.');
    log('the signing key is read from the env file only after all gates pass,');
    log('immediately before the first send, and is never printed or journaled.');
    const result = await runSaga({
      repoRoot,
      mode: 'atlantic',
      approvedPlanHash,
      deployerAddress: address as Address,
      rpcUrl,
      stateDir: path.resolve(argValue('--state-dir') ?? path.join('.local', 'atlantic-saga')),
      receiptTimeoutMs: Number(argValue('--receipt-timeout-ms') ?? 180_000),
      deployJournalPath,
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

  const rpcUrl = argValue('--rpc') ?? 'http://127.0.0.1:8566';
  const addressArg = argValue('--address') ?? ANVIL_ACCOUNT_0;
  if (!isAddress(addressArg)) {
    process.stderr.write('refusing: --address is not a valid address\n');
    return 1;
  }
  const tusdc = argValue('--tusdc');
  const tsaga = argValue('--tsaga');
  const swap = argValue('--swap');
  const vault = argValue('--vault');
  if (
    !tusdc ||
    !tsaga ||
    !swap ||
    !vault ||
    ![tusdc, tsaga, swap, vault].every((value) => isAddress(value))
  ) {
    process.stderr.write(
      'refusing: local-anvil mode requires the four already-deployed addresses --tusdc --tsaga --swap --vault\n',
    );
    return 1;
  }
  log('LOCAL ANVIL MODE: disposable chain only; no key is read, the node account signs.');
  log(`approved plan hash: ${approvedPlanHash.toLowerCase()}`);
  const result = await runSaga({
    repoRoot,
    mode: 'local-anvil',
    approvedPlanHash,
    deployerAddress: addressArg as Address,
    rpcUrl,
    stateDir: path.resolve(
      argValue('--state-dir') ?? path.join('.demo-state', 'saga-tooling', 'manual'),
    ),
    receiptTimeoutMs: Number(argValue('--receipt-timeout-ms') ?? 20_000),
    contracts: {
      tUSDC: tusdc as Address,
      tSAGA: tsaga as Address,
      swap: swap as Address,
      vault: vault as Address,
    },
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
      `saga CLI failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
