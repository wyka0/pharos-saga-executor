#!/usr/bin/env node
/**
 * Static safety gate for the Pharos Saga Executor.
 * Simulation must stay offline; the testnet adapter must never target mainnet.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}
function fail(message) {
  failures += 1;
  console.error(`FAIL  ${message}`);
}
function check(condition, message) {
  if (condition) pass(message);
  else fail(message);
}
function walk(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

const required = [
  'README.md',
  'SKILL.md',
  'docs/environment.md',
  'docs/architecture.md',
  'docs/verified-output.md',
  'docs/testnet-readiness.md',
  'docs/testnet-results.md',
  'docs/reviewer-guide.md',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'LICENSE',
  'src/domain/states.ts',
  'src/domain/receipts.ts',
  'src/executor/executor.ts',
  'src/adapters/types.ts',
  'src/adapters/simulated.ts',
  'src/adapters/pharosTestnet.ts',
  'src/adapters/localAnvil.ts',
  'src/testnet/config.ts',
  'src/testnet/viemTestnetClient.ts',
  'src/persistence/store.ts',
  'src/persistence/testnetJournal.ts',
  'src/persistence/localJournal.ts',
  'scripts/demo-success.ts',
  'scripts/demo-failure.ts',
  'scripts/local-anvil.ts',
  'scripts/testnet-deploy-plan.ts',
  'test/state-machine.test.ts',
  'test/testnet.test.ts',
  'test/local-anvil.test.ts',
  'foundry.toml',
  'contracts/test-only/TestOnlyERC20.sol',
  'contracts/test-only/TestOnlyTokens.sol',
  'contracts/test-only/TestOnlySwap.sol',
  'contracts/test-only/TestOnlyVault.sol',
  'contracts/test/TestOnlySaga.t.sol',
  'contracts/test/DeploymentGas.t.sol',
  'contracts/test/TestOnlyAuth.t.sol',
  'docs/local-anvil.md',
  'docs/testnet-deployment-plan.md',
  'docs/testnet-deployment-tooling.md',
  'src/testnet/deployPlan.ts',
  'src/testnet/deploy/runner.ts',
  'src/testnet/deploy/verify.ts',
  'src/testnet/deploy/journal.ts',
  'scripts/testnet-deploy.ts',
  'scripts/local-deploy-check.ts',
  'test/deploy-tooling.test.ts',
];
for (const relative of required) {
  check(existsSync(path.join(ROOT, relative)), `required file exists: ${relative}`);
}

const allTs = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
].filter((file) => file.endsWith('.ts'));

const localOnlyFiles = new Set([
  path.join(ROOT, 'src', 'adapters', 'localAnvil.ts'),
  path.join(ROOT, 'src', 'persistence', 'localJournal.ts'),
  path.join(ROOT, 'scripts', 'local-anvil.ts'),
  path.join(ROOT, 'scripts', 'local-deploy-check.ts'),
]);

const testnetReadOnlyFiles = new Set([path.join(ROOT, 'scripts', 'testnet-deploy-plan.ts')]);

/** The gated deployment CLI is the only script allowed to send (atlantic mode). */
const testnetSendFiles = new Set([path.join(ROOT, 'scripts', 'testnet-deploy.ts')]);

const simulationFiles = allTs.filter(
  (file) =>
    !file.includes(`${path.sep}testnet${path.sep}`) &&
    !file.endsWith(`${path.sep}pharosTestnet.ts`) &&
    !file.endsWith(`${path.sep}viemTestnetClient.ts`) &&
    !localOnlyFiles.has(file) &&
    !testnetReadOnlyFiles.has(file) &&
    !testnetSendFiles.has(file),
);
const simulationForbidden = [
  'PRIVATE_KEY',
  'privateKey',
  'mnemonic',
  'eth_sendRawTransaction',
  'sendRawTransaction',
  'eth_sendTransaction',
  'JsonRpcProvider',
  'new Wallet',
  'wallet.json',
  'fetch(',
  'viem',
];
let simulationHits = 0;
for (const file of simulationFiles) {
  const text = readFileSync(file, 'utf8');
  const isSimulationCli = file.endsWith(`${path.sep}src${path.sep}cli.ts`);
  for (const needle of simulationForbidden) {
    // The CLI only passes the env VARIABLE NAME "PRIVATE_KEY"; it never reads a value.
    if (needle === 'PRIVATE_KEY' && isSimulationCli) continue;
    if (text.includes(needle)) {
      simulationHits += 1;
      fail(`${path.relative(ROOT, file)} contains forbidden simulation token ${needle}`);
    }
  }
  if (!file.endsWith(`${path.sep}domain${path.sep}receipts.ts`)) {
    for (const url of ['http://', 'https://']) {
      if (text.includes(url)) {
        simulationHits += 1;
        fail(`${path.relative(ROOT, file)} must remain offline (found ${url})`);
      }
    }
  }
}
if (simulationHits === 0) {
  pass(`${simulationFiles.length} simulation files are free of wallet/RPC/network code`);
}

const testnetFiles = [
  ...walk(path.join(ROOT, 'src', 'testnet')),
  path.join(ROOT, 'src', 'adapters', 'pharosTestnet.ts'),
  ...testnetReadOnlyFiles,
  ...testnetSendFiles,
].filter((file) => file.endsWith('.ts'));
let testnetHits = 0;
for (const file of testnetFiles) {
  const text = readFileSync(file, 'utf8');
  for (const forbidden of ['rpc.pharos.xyz', '1672', 'mainnet.pharos']) {
    if (text.includes(forbidden)) {
      testnetHits += 1;
      fail(`${path.relative(ROOT, file)} must not contain mainnet target ${forbidden}`);
    }
  }
  if (/0x[0-9a-fA-F]{64}/.test(text)) {
    testnetHits += 1;
    fail(`${path.relative(ROOT, file)} contains a 32-byte hex literal (possible key/tx secret)`);
  }
}
if (testnetHits === 0) {
  pass(`${testnetFiles.length} testnet files are isolated from mainnet and contain no key literals`);
}
const deployPlanPath = path.join(ROOT, 'scripts', 'testnet-deploy-plan.ts');
const deployPlan = readFileSync(deployPlanPath, 'utf8');
check(
  !/sendTransaction|writeContract|deployContract|sendRawTransaction/.test(deployPlan),
  'deployment plan script has no send/sign/broadcast path',
);
check(
  !/PRIVATE_KEY|privateKey|mnemonic/.test(deployPlan),
  'deployment plan script never references signing secrets',
);

const deployCorePath = path.join(ROOT, 'src', 'testnet', 'deployPlan.ts');
const deployCore = readFileSync(deployCorePath, 'utf8');
check(
  deployCore.includes('688689'),
  'shared plan module is pinned to the Atlantic chainId 688689',
);
check(
  !/sendTransaction|writeContract|deployContract|sendRawTransaction|eth_sendTransaction|privateKey|PRIVATE_KEY|mnemonic/.test(
    deployCore,
  ),
  'shared plan module has no send/sign/secret path',
);
const deployRunnerPath = path.join(ROOT, 'src', 'testnet', 'deploy', 'runner.ts');
const deployRunner = readFileSync(deployRunnerPath, 'utf8');
check(deployRunner.includes('INTENT'), 'deploy runner journals INTENT before sending');
check(deployRunner.includes('HARD_CEILING_WEI'), 'deploy runner enforces the PHRS hard ceiling');
check(
  /confirmAtlanticTestnet/.test(deployRunner),
  'deploy runner requires the explicit Atlantic confirmation flag',
);
check(/verifyRuntimeCode/.test(deployRunner), 'deploy runner verifies deployed runtime code');
check(
  /resent/.test(deployRunner) && deployRunner.includes('UNKNOWN') && deployRunner.includes('REVERTED'),
  'deploy runner marks ambiguous/reverted outcomes and never resends',
);
const deployJournalPath = path.join(ROOT, 'src', 'testnet', 'deploy', 'journal.ts');
const deployJournalText = readFileSync(deployJournalPath, 'utf8');
check(deployJournalText.includes("'INTENT'"), 'deploy journal defines the INTENT status');
const deployCliPath = path.join(ROOT, 'scripts', 'testnet-deploy.ts');
const deployCli = readFileSync(deployCliPath, 'utf8');
check(
  deployCli.includes('--confirm-atlantic-testnet'),
  'deploy CLI requires --confirm-atlantic-testnet for atlantic mode',
);
check(deployCli.includes('--approve-plan'), 'deploy CLI requires an approved plan hash');
check(/keyProvider/.test(deployCli), 'deploy CLI reads the signing key lazily at first send');

const localFiles = [...localOnlyFiles].filter((file) => existsSync(file));
let localHits = 0;
for (const file of localFiles) {
  const text = readFileSync(file, 'utf8');
  for (const forbidden of ['rpc.pharos.xyz', 'atlantic.pharosscan', '688689', 'mainnet.pharos', '1672']) {
    if (text.includes(forbidden)) {
      localHits += 1;
      fail(`${path.relative(ROOT, file)} must never target Atlantic or mainnet (${forbidden})`);
    }
  }
}
if (localHits === 0) {
  pass(`${localFiles.length} local-anvil files contain no Atlantic/mainnet target`);
}
const sagaText = readFileSync(path.join(ROOT, 'src', 'domain', 'saga.ts'), 'utf8');
check(
  sagaText.includes("'127.0.0.1'") && sagaText.includes('31337'),
  'local config validation only allows localhost endpoints on chainId 31337',
);
const foundryToml = readFileSync(path.join(ROOT, 'foundry.toml'), 'utf8');
check(
  foundryToml.includes('http://127.0.0.1:8545') && !foundryToml.includes('688689'),
  'foundry.toml declares only a local RPC endpoint',
);

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(
  JSON.stringify(Object.keys(manifest.dependencies ?? {})) === JSON.stringify(['viem']),
  'only viem is declared as a runtime dependency',
);
for (const banned of ['ethers', 'web3', 'wagmi', 'hardhat']) {
  check(!(manifest.dependencies && manifest.dependencies[banned]), `no chain SDK dependency: ${banned}`);
}

const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
for (const pattern of ['node_modules/', 'state/', '.demo-state/', '.env', '.local/', 'dist/', 'out/', 'cache/']) {
  check(ignore.includes(pattern), `.gitignore covers ${pattern}`);
}
check(!existsSync(path.join(ROOT, '.env')), 'no .env file exists');
check(!existsSync(path.join(ROOT, '.env.example')), '.env.example is not needed or present');

const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
check(license.includes('Copyright (c) 2026 wyka0'), 'LICENSE carries copyright 2026 wyka0');

const skill = readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
check(skill.startsWith('---'), 'SKILL.md starts with YAML front matter');
check(/^name:\s*pharos-saga-executor$/m.test(skill), 'SKILL.md declares the skill name');
check(/^description:/m.test(skill), 'SKILL.md declares a description');
check(/SIMULATION ONLY/i.test(skill), 'SKILL.md states the simulation-only boundary');
check(/ATLANTIC TESTNET/i.test(skill), 'SKILL.md documents the gated testnet adapter');

if (existsSync(path.join(ROOT, '.git'))) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const bad = tracked.filter(
    (file) =>
      file.startsWith('node_modules/') ||
      file.startsWith('dist/') ||
      file.startsWith('state/') ||
      file.startsWith('.demo-state/') ||
      file.startsWith('.local/') ||
      file === '.env' ||
      (file.endsWith('.env') && !file.endsWith('.env.example')) ||
      file.endsWith('.log') ||
      file.endsWith('.tmp') ||
      file.endsWith('testnet-journal.json'),
  );
  check(bad.length === 0, `no generated state, secrets or dependencies are tracked (${tracked.length} tracked files)`);
  if (bad.length > 0) console.error(`      tracked offenders: ${bad.join(', ')}`);
} else {
  pass('git repository not initialised yet; tracked-file check deferred');
}

if (failures > 0) {
  console.error(`\nSAFETY GATE FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log('\nSAFETY GATE PASSED - simulation stays offline; testnet path is gated and mainnet-free.');
