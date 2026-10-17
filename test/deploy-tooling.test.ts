import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Address } from 'viem';
import {
  DEPLOY_STEPS,
  HARD_CEILING_WEI,
  buildPlanCore,
  computePlanHash,
  resolveConstructorArgs,
  type AddressBook,
  type ArtifactInfo,
} from '../src/testnet/deployPlan.js';
import {
  DeployVerificationError,
  assertLocalRpcUrl,
  intrinsicGasForCreation,
  maskImmutableRanges,
  scrubSensitive,
  verifyRuntimeCode,
} from '../src/testnet/deploy/verify.js';
import { DeployJournal, isUnresolved } from '../src/testnet/deploy/journal.js';

const DEPLOYER = '0x1111111111111111111111111111111111111111' as Address;

function fixtureArtifacts(): Map<string, ArtifactInfo> {
  const map = new Map<string, ArtifactInfo>();
  for (const step of DEPLOY_STEPS) {
    if (step.artifact) map.set(step.name, { sha256: 'a'.repeat(64), initCodeBytes: 1234 });
  }
  return map;
}

test('deployment step plan invariants (order, kinds, gas caps, ceiling)', () => {
  assert.equal(DEPLOY_STEPS.length, 5);
  assert.deepEqual(
    DEPLOY_STEPS.map((step) => step.order),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    DEPLOY_STEPS.map((step) => step.kind),
    ['deploy', 'deploy', 'deploy', 'deploy', 'wire'],
  );
  assert.equal(DEPLOY_STEPS.at(-1)?.name, 'WireMinter');
  const total = DEPLOY_STEPS.reduce((sum, step) => sum + step.gasCap, 0);
  assert.equal(total, 3_400_000);
  for (const step of DEPLOY_STEPS) {
    assert.ok(step.gasCap > step.measuredGas, `${step.name}: cap must exceed measured gas`);
  }
  assert.equal(HARD_CEILING_WEI, 50_000_000_000_000_000n);
  // worst case at the observed 10 gwei stays under the hard ceiling
  assert.ok(BigInt(total) * 10n ** 10n <= HARD_CEILING_WEI);
});

test('plan hash is stable and binds bytecode, args and gas caps', () => {
  const artifacts = fixtureArtifacts();
  const core = buildPlanCore(DEPLOYER, artifacts);
  assert.equal(core.planVersion, 2);
  assert.equal(core.network.chainId, 688689);
  assert.equal(core.deployerAddress, DEPLOYER.toLowerCase());
  assert.equal(core.totalGasCap, 3_400_000);
  const hash = computePlanHash(core);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computePlanHash(buildPlanCore(DEPLOYER, artifacts)), hash, 'hash must be stable');

  const tweakedCap = JSON.parse(JSON.stringify(core)) as typeof core;
  const firstStep = tweakedCap.steps[0];
  assert.ok(firstStep);
  firstStep.gasCap -= 1;
  assert.notEqual(computePlanHash(tweakedCap), hash, 'gas caps are bound');

  const tweakedArgs = JSON.parse(JSON.stringify(core)) as typeof core;
  const swapStep = tweakedArgs.steps.find((step) => step.name === 'TestOnlySwap');
  assert.ok(swapStep);
  swapStep.constructorArgs = 'usdc,receiptToken,101,controller';
  assert.notEqual(computePlanHash(tweakedArgs), hash, 'constructor args are bound');

  const otherArtifacts = new Map(artifacts);
  otherArtifacts.set('TestOnlyUSDC', { sha256: 'b'.repeat(64), initCodeBytes: 1234 });
  assert.notEqual(computePlanHash(buildPlanCore(DEPLOYER, otherArtifacts)), hash, 'bytecode hashes are bound');

  assert.throws(() => buildPlanCore(DEPLOYER, new Map()), /Missing artifact hash/);
});

test('constructor arguments resolve only from verified addresses', () => {
  const book: AddressBook = {
    controller: DEPLOYER,
    usdc: '0x2222222222222222222222222222222222222222' as Address,
    receipt: '0x3333333333333333333333333333333333333333' as Address,
    swap: '0x4444444444444444444444444444444444444444' as Address,
  };
  assert.deepEqual(resolveConstructorArgs('TestOnlyUSDC', book), [DEPLOYER]);
  assert.deepEqual(resolveConstructorArgs('TestOnlyReceiptToken', book), [DEPLOYER]);
  assert.deepEqual(resolveConstructorArgs('TestOnlySwap', book), [
    book.usdc,
    book.receipt,
    100n,
    DEPLOYER,
  ]);
  assert.deepEqual(resolveConstructorArgs('TestOnlyVault', book), [book.receipt, DEPLOYER]);
  assert.deepEqual(resolveConstructorArgs('WireMinter', book), [book.swap, true]);
  assert.throws(() => resolveConstructorArgs('TestOnlySwap', { controller: DEPLOYER }), /usdc/);
  assert.throws(() => resolveConstructorArgs('TestOnlyVault', { controller: DEPLOYER }), /receipt/);
  assert.throws(() => resolveConstructorArgs('WireMinter', { controller: DEPLOYER }), /swap/);
  assert.throws(() => resolveConstructorArgs('Unknown', book), /Unknown deployment step/);
});

test('runtime-code verification ignores immutable slots but detects any other change', () => {
  const artifactDeployed = `0xaabb${'00'.repeat(2)}cc${'00'.repeat(2)}`;
  const references = { '1': [{ start: 2, length: 2 }], '2': [{ start: 5, length: 2 }] };
  const actual = `0xaabb${'1122'}cc${'3344'}`;
  const result = verifyRuntimeCode(actual, {
    deployedBytecode: artifactDeployed,
    immutableReferences: references,
  });
  assert.equal(result.immutableSlotCount, 4);
  assert.match(result.maskedSha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      verifyRuntimeCode(`0xaabc${'1122'}cc${'3344'}`, {
        deployedBytecode: artifactDeployed,
        immutableReferences: references,
      }),
    DeployVerificationError,
  );
  assert.throws(
    () =>
      verifyRuntimeCode(`0xaabb1122cc33`, {
        deployedBytecode: artifactDeployed,
        immutableReferences: references,
      }),
    /length mismatch/,
  );
  assert.throws(
    () =>
      verifyRuntimeCode('0x', {
        deployedBytecode: artifactDeployed,
        immutableReferences: references,
      }),
    /no deployed runtime code/,
  );
  assert.throws(
    () =>
      verifyRuntimeCode(actual, {
        deployedBytecode: artifactDeployed,
        immutableReferences: { '1': [{ start: 6, length: 2 }] },
      }),
    /out of code bounds/,
  );
  assert.throws(
    () =>
      verifyRuntimeCode(actual, {
        deployedBytecode: artifactDeployed,
        immutableReferences: { '1': [{ start: 2, length: 2 }], '2': [{ start: 3, length: 1 }] },
      }),
    /overlapping/,
  );
  assert.equal(maskImmutableRanges('0xaabb1122', [{ start: 1, length: 1 }]), '0xaa001122');
});

test('intrinsic gas for creation includes EIP-2 and EIP-3860 costs', () => {
  assert.equal(intrinsicGasForCreation('0x'), 53_000n);
  assert.equal(intrinsicGasForCreation('0x00'), 53_006n); // 4 calldata + 2 per word
  assert.equal(intrinsicGasForCreation('0xff'), 53_018n);
  assert.equal(intrinsicGasForCreation(`0x${'ff'.repeat(32)}`), 53_000n + 512n + 2n);
  assert.throws(() => intrinsicGasForCreation('0x1'), DeployVerificationError);
  assert.throws(() => intrinsicGasForCreation('0xzz'), DeployVerificationError);
});

test('sensitive text is scrubbed before logging or journaling', () => {
  const rpc = 'https://rpc.example.invalid/secret-key';
  const key = `0x${'ab'.repeat(32)}`;
  assert.equal(scrubSensitive(`boom ${rpc} key ${key}`, rpc), 'boom <rpc-url> key <redacted-64-hex>');
  assert.equal(scrubSensitive('plain message', rpc), 'plain message');
});

test('local-anvil mode refuses non-loopback or non-http RPC URLs', () => {
  assertLocalRpcUrl('http://127.0.0.1:8546');
  assertLocalRpcUrl('http://localhost:8546');
  assert.throws(() => assertLocalRpcUrl('https://rpc.example.invalid'), DeployVerificationError);
  assert.throws(() => assertLocalRpcUrl('http://10.0.0.5:8545'), DeployVerificationError);
  assert.throws(() => assertLocalRpcUrl('ftp://127.0.0.1'), DeployVerificationError);
  assert.throws(() => assertLocalRpcUrl('not a url'), DeployVerificationError);
});

test('journal round-trips entries and flags every non-CONFIRMED status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharos-deploy-journal-'));
  try {
    const journal = new DeployJournal(path.join(dir, 'deploy-journal.json'));
    assert.equal(await journal.get('missing'), null);
    const now = new Date().toISOString();
    const entry = {
      key: 'deploy-1',
      planHash: 'c'.repeat(64),
      order: 1,
      name: 'TestOnlyUSDC',
      kind: 'deploy' as const,
      nonce: 0,
      gasLimit: '850000',
      gasPrice: '10000000000',
      to: null,
      dataSha256: 'd'.repeat(64),
      artifactSha256: null,
      txHash: null,
      status: 'INTENT' as const,
      recordedAt: now,
      updatedAt: now,
      contractAddress: null,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPrice: null,
      note: 'test',
    };
    await journal.put(entry);
    assert.equal((await journal.get('deploy-1'))?.status, 'INTENT');
    assert.equal((await journal.list()).length, 1);
    await journal.put({
      ...entry,
      status: 'CONFIRMED',
      contractAddress: '0x5555555555555555555555555555555555555555',
    });
    assert.equal((await journal.get('deploy-1'))?.status, 'CONFIRMED');
    assert.equal((await journal.list())[0]?.contractAddress, '0x5555555555555555555555555555555555555555');

    assert.equal(isUnresolved('INTENT'), true);
    assert.equal(isUnresolved('BROADCAST'), true);
    assert.equal(isUnresolved('REVERTED'), true);
    assert.equal(isUnresolved('UNKNOWN'), true);
    assert.equal(isUnresolved('CONFIRMED'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
