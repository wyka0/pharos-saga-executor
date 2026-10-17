import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyStepReceipt } from '../src/domain/receipts.js';
import { formatSaga } from '../src/render.js';
import { SimulatedLedger } from '../src/persistence/ledger.js';
import { makeHarness } from './helpers.js';

const ROOT = process.cwd();

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

test('executable simulation source contains no wallet, signing, RPC or network sending code', async () => {
  const allFiles = [
    ...(await listFiles(path.join(ROOT, 'src'))),
    ...(await listFiles(path.join(ROOT, 'scripts'))),
  ].filter((file) => file.endsWith('.ts'));
  const localOnlyFiles = new Set([
    path.join(ROOT, 'src', 'adapters', 'localAnvil.ts'),
    path.join(ROOT, 'src', 'persistence', 'localJournal.ts'),
    path.join(ROOT, 'scripts', 'local-anvil.ts'),
  ]);
  const testnetReadOnlyFiles = new Set([path.join(ROOT, 'scripts', 'testnet-deploy-plan.ts')]);
  const simulationFiles = allFiles.filter(
    (file) =>
      !file.includes(`${path.sep}testnet${path.sep}`) &&
      !file.endsWith(`${path.sep}pharosTestnet.ts`) &&
      !file.endsWith(`${path.sep}viemTestnetClient.ts`) &&
      !localOnlyFiles.has(file) &&
      !testnetReadOnlyFiles.has(file),
  );
  assert.ok(simulationFiles.length >= 20);

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
    'fetch(',
    'viem',
  ];
  for (const file of simulationFiles) {
    const source = await fs.readFile(file, 'utf8');
    const isSimulationCli = file.endsWith(`${path.sep}src${path.sep}cli.ts`);
    for (const needle of forbidden) {
      // The CLI only passes the env VARIABLE NAME "PRIVATE_KEY"; it never reads a value.
      if (needle === 'PRIVATE_KEY' && isSimulationCli) continue;
      assert.equal(
        source.includes(needle),
        false,
        `${path.relative(ROOT, file)} must not contain ${needle}`,
      );
    }
    // The shared receipt verifier compares an explorer URL string; it performs no I/O.
    if (!file.endsWith(`${path.sep}domain${path.sep}receipts.ts`)) {
      assert.equal(source.includes('http://'), false, `${path.relative(ROOT, file)} must be offline`);
      assert.equal(source.includes('https://'), false, `${path.relative(ROOT, file)} must be offline`);
    }
  }
});

test('testnet adapter is isolated from mainnet and never targets rpc.pharos.xyz', async () => {
  const testnetFiles = [
    ...(await listFiles(path.join(ROOT, 'src', 'testnet'))),
    path.join(ROOT, 'src', 'adapters', 'pharosTestnet.ts'),
    path.join(ROOT, 'scripts', 'testnet-deploy-plan.ts'),
  ].filter((file) => file.endsWith('.ts'));
  assert.ok(testnetFiles.length >= 5);
  for (const file of testnetFiles) {
    const source = await fs.readFile(file, 'utf8');
    assert.equal(source.includes('rpc.pharos.xyz'), false, `${path.relative(ROOT, file)} must not target mainnet RPC`);
    assert.equal(source.includes('1672'), false, `${path.relative(ROOT, file)} must not reference mainnet chain id`);
  }
  const config = await fs.readFile(path.join(ROOT, 'src', 'testnet', 'config.ts'), 'utf8');
  assert.match(config, /688689/);
  assert.match(config, /atlantic-testnet/);

  const deployPlan = await fs.readFile(path.join(ROOT, 'scripts', 'testnet-deploy-plan.ts'), 'utf8');
  assert.doesNotMatch(deployPlan, /sendTransaction|writeContract|deployContract|sendRawTransaction/);
  assert.doesNotMatch(deployPlan, /PRIVATE_KEY|privateKey|mnemonic/);
});

test('local anvil adapter is isolated to a disposable chain and never targets Atlantic or mainnet', async () => {
  const localFiles = [
    path.join(ROOT, 'src', 'adapters', 'localAnvil.ts'),
    path.join(ROOT, 'src', 'persistence', 'localJournal.ts'),
    path.join(ROOT, 'scripts', 'local-anvil.ts'),
  ];
  for (const file of localFiles) {
    assert.equal(existsSync(file), true, `missing local-only file ${path.relative(ROOT, file)}`);
    const source = await fs.readFile(file, 'utf8');
    for (const forbidden of ['rpc.pharos.xyz', 'atlantic.pharosscan', '688689', 'mainnet.pharos']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${path.relative(ROOT, file)} must never target Atlantic or mainnet (${forbidden})`,
      );
    }
  }
  const saga = await fs.readFile(path.join(ROOT, 'src', 'domain', 'saga.ts'), 'utf8');
  assert.match(saga, /'127\.0\.0\.1', 'localhost'/);
  assert.match(saga, /31337/);
  const foundry = await fs.readFile(path.join(ROOT, 'foundry.toml'), 'utf8');
  assert.match(foundry, /http:\/\/127\.0\.0\.1:8545/);
  assert.equal(foundry.includes('688689'), false, 'foundry.toml must not reference Atlantic chain id');
  const demo = await fs.readFile(path.join(ROOT, 'scripts', 'local-anvil.ts'), 'utf8');
  assert.match(demo, /NOT ATLANTIC TESTNET, NOT MAINNET/);
});

test('package manifest permits only viem for testnet and no other chain SDK', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['viem']);
  const all = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  for (const banned of ['ethers', 'web3', 'wagmi', '@solana/web3.js', 'hardhat']) {
    assert.equal(all.includes(banned), false, `${banned} must not be installed`);
  }
  for (const script of ['test', 'demo:success', 'demo:failure', 'demo:local', 'verify']) {
    assert.ok(manifest.scripts[script], `missing npm script ${script}`);
  }
});

test('repository ignore rules cover generated state, secrets and dependencies', async () => {
  const ignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  for (const pattern of ['node_modules/', 'state/', '.demo-state/', '.env', '.local/', 'dist/', 'out/', 'cache/']) {
    assert.ok(ignore.includes(pattern), `.gitignore must cover ${pattern}`);
  }
  assert.equal(existsSync(path.join(ROOT, '.env')), false, 'no .env file may exist');
  assert.equal(
    existsSync(path.join(ROOT, '.env.example')),
    false,
    '.env.example is intentionally absent because no secret configuration is needed',
  );
});

test('MIT license carries the required copyright line', async () => {
  const license = await fs.readFile(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 wyka0/);
});

test('all rubric-required project files exist', () => {
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
    'src/cli.ts',
    'src/executor/executor.ts',
    'src/adapters/simulated.ts',
    'src/persistence/store.ts',
    'scripts/demo-success.ts',
    'scripts/demo-failure.ts',
    'test/state-machine.test.ts',
  ];
  for (const file of required) {
    assert.equal(existsSync(path.join(ROOT, file)), true, `missing required file ${file}`);
  }
});

test('simulated receipts are branded and cannot masquerade as live evidence', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const receipt = record.steps.SWAP.receipt;
  assert.ok(receipt);
  assert.equal(receipt.simulated, true);
  assert.equal(receipt.network, 'simulated');
  assert.match(receipt.simulatedTxRef, /^sim_/);
  assert.match(receipt.disclaimer, /SIMULATED/);
  assert.equal(receipt.evidence.noOnChainTransaction, true);
  assert.equal('txHash' in receipt, false);
  assert.equal('transactionHash' in receipt, false);
  assert.equal('blockNumber' in receipt, false);

  const notSimulated = { ...receipt, simulated: false };
  const falseRef = { ...receipt, simulatedTxRef: `0x${'ab'.repeat(32)}` };
  const fakeHash = { ...receipt, transactionHash: `0x${'cd'.repeat(32)}` };
  for (const candidate of [notSimulated, falseRef, fakeHash]) {
    const verification = verifyStepReceipt(candidate, record, 'SWAP');
    assert.equal(verification.ok, false);
  }
});

test('human-readable output never claims a live transaction', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const output = formatSaga(record);
  assert.match(output, /SIMULATED ADAPTER/);
  assert.match(output, /NOT live blockchain evidence/i);
  assert.doesNotMatch(output, /0x[a-fA-F0-9]{64}/);
  assert.doesNotMatch(output, /confirmed on-chain/i);
  assert.match(output, /no transaction hash/i);
  assert.match(output, /no explorer link/i);
});

test('simulated ledger is explicitly labelled and stores only sim_ receipts', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const ledger = new SimulatedLedger(harness.store.ledgerPath);
  const keys = await ledger.keys();
  assert.equal(keys.length, 3);
  for (const key of keys) {
    const receipt = await ledger.get(key);
    assert.ok(receipt);
    assert.match(receipt.simulatedTxRef, /^sim_/);
    assert.equal(receipt.simulated, true);
  }
  const raw = await fs.readFile(harness.store.ledgerPath, 'utf8');
  assert.match(raw, /SIMULATED ONLY/);
  assert.doesNotMatch(raw, /0x[a-fA-F0-9]{64}/);
  assert.ok(record.steps.DEPOSIT.receipt);
});
