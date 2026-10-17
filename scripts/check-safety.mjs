#!/usr/bin/env node
/**
 * Static safety gate for the simulated Saga Executor.
 * It does not execute the saga and never makes a network call.
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
    const stat = statSync(full);
    if (stat.isDirectory()) result.push(...walk(full));
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
  'package.json',
  'package-lock.json',
  '.gitignore',
  'LICENSE',
  'src/domain/states.ts',
  'src/domain/receipts.ts',
  'src/executor/executor.ts',
  'src/adapters/types.ts',
  'src/adapters/simulated.ts',
  'src/persistence/store.ts',
  'scripts/demo-success.ts',
  'scripts/demo-failure.ts',
  'test/state-machine.test.ts',
];
for (const relative of required) {
  check(existsSync(path.join(ROOT, relative)), `required file exists: ${relative}`);
}

const sourceFiles = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
].filter((file) => file.endsWith('.ts'));

const forbidden = [
  'PRIVATE_KEY',
  'privateKey',
  'mnemonic',
  'eth_sendRawTransaction',
  'sendRawTransaction',
  'eth_sendTransaction',
  'JsonRpcProvider',
  'new Wallet',
  'wallet.json',
  'https://',
  'http://',
  'fetch(',
];
let forbiddenHits = 0;
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8');
  for (const needle of forbidden) {
    if (text.includes(needle)) {
      forbiddenHits += 1;
      fail(`${path.relative(ROOT, file)} contains forbidden token ${needle}`);
    }
  }
}
if (forbiddenHits === 0) {
  pass(`no wallet/RPC/network/key patterns in ${sourceFiles.length} executable TypeScript files`);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(manifest.dependencies === undefined, 'no runtime dependencies are declared');
for (const banned of ['ethers', 'viem', 'web3', 'wagmi', 'hardhat']) {
  check(
    !(manifest.devDependencies && manifest.devDependencies[banned]),
    `no chain SDK dependency: ${banned}`,
  );
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
      file.endsWith('.env') && !file.endsWith('.env.example') ||
      file.endsWith('.log') ||
      file.endsWith('.tmp'),
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
console.log('\nSAFETY GATE PASSED - simulation-only project, no wallet/RPC/secrets, required files present.');
