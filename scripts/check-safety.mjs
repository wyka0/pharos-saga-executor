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
  'src/testnet/config.ts',
  'src/testnet/viemTestnetClient.ts',
  'src/persistence/store.ts',
  'src/persistence/testnetJournal.ts',
  'scripts/demo-success.ts',
  'scripts/demo-failure.ts',
  'test/state-machine.test.ts',
  'test/testnet.test.ts',
];
for (const relative of required) {
  check(existsSync(path.join(ROOT, relative)), `required file exists: ${relative}`);
}

const allTs = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
].filter((file) => file.endsWith('.ts'));

const simulationFiles = allTs.filter(
  (file) =>
    !file.includes(`${path.sep}testnet${path.sep}`) &&
    !file.endsWith(`${path.sep}pharosTestnet.ts`) &&
    !file.endsWith(`${path.sep}viemTestnetClient.ts`),
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

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(
  JSON.stringify(Object.keys(manifest.dependencies ?? {})) === JSON.stringify(['viem']),
  'only viem is declared as a runtime dependency',
);
for (const banned of ['ethers', 'web3', 'wagmi', 'hardhat']) {
  check(!(manifest.dependencies && manifest.dependencies[banned]), `no chain SDK dependency: ${banned}`);
}

const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
for (const pattern of ['node_modules/', 'state/', '.demo-state/', '.env', '.local/', 'dist/']) {
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
