import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Address } from 'viem';
import {
  ONE_TUSDC_RAW,
  RECEIPT_OUT_RAW,
  SAGA_CEILING_WEI,
  SAGA_CONDITIONAL_MINT,
  SAGA_EXPECTED_POSTCONDITIONS,
  SAGA_STEPS,
  SAGA_TOTAL_GAS_CAP,
  buildSagaPlanCore,
  buildSagaStepCalldata,
  computeSagaPlanHash,
  officialAtlanticUsdcAddress,
  resolveSagaContractsFromDeployJournal,
  type SagaContracts,
  type SagaPlanCore,
} from '../src/testnet/sagaPlan.js';
import { SagaJournal, isSagaUnresolved } from '../src/testnet/saga/journal.js';

/**
 * Golden values: the reviewed Atlantic plan (candidate plan hash approved for
 * the next gated run). The runner refuses to send anything unless its freshly
 * rebuilt plan serializes to this exact hash.
 */
const REVIEWED_DEPLOYER = '0xE2B8651178ade144003537eA509E37877dba40bb' as Address;
const REVIEWED_CONTRACTS: SagaContracts = {
  tUSDC: '0x623F3575241827eb5aAb5592834632Ed67BB114C' as Address,
  tSAGA: '0xCA7c0D2474f3868bbBa0902d33918b35Dad90b19' as Address,
  swap: '0xcF74d803da1C57CeE6Bb727B9646fDb42126414D' as Address,
  vault: '0xa16085FFC63F3BaB3D2c26b22Dc44B7421cEB64b' as Address,
};
const REVIEWED_PLAN_HASH = '8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f';
const REVIEWED_CALLDATA: Record<string, string> = {
  MintTusdc:
    '0x40c10f19000000000000000000000000e2b8651178ade144003537ea509e37877dba40bb00000000000000000000000000000000000000000000000000000000000f4240',
  ApproveTusdcToSwap:
    '0x095ea7b3000000000000000000000000cf74d803da1c57cee6bb727b9646fdb42126414d00000000000000000000000000000000000000000000000000000000000f4240',
  SwapTusdcForReceipt:
    '0x02f1def000000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f1b30',
  ApproveReceiptToVault:
    '0x095ea7b3000000000000000000000000a16085ffc63f3bab3d2c26b22dc44b7421ceb64b00000000000000000000000000000000000000000000000000000000000f1b30',
  DepositReceiptToVault:
    '0xe2bbb15800000000000000000000000000000000000000000000000000000000000f1b3000000000000000000000000000000000000000000000000000000000000f1b30',
};

test('reviewed Atlantic saga plan reproduces the approved hash byte-for-byte', () => {
  const core = buildSagaPlanCore({
    deployerAddress: REVIEWED_DEPLOYER,
    contracts: REVIEWED_CONTRACTS,
  });
  assert.equal(computeSagaPlanHash(core), REVIEWED_PLAN_HASH);
  assert.equal(core.planVersion, 1);
  assert.equal(core.kind, 'test-only-saga');
  assert.equal(core.network.chainId, 688689);
  assert.equal(core.deployerAddress, REVIEWED_DEPLOYER.toLowerCase());
  assert.deepEqual(core.contracts, {
    tUSDC: REVIEWED_CONTRACTS.tUSDC.toLowerCase(),
    tSAGA: REVIEWED_CONTRACTS.tSAGA.toLowerCase(),
    swap: REVIEWED_CONTRACTS.swap.toLowerCase(),
    vault: REVIEWED_CONTRACTS.vault.toLowerCase(),
  });
  assert.equal(core.decimals.tUSDC, 6);
  assert.equal(core.decimals.tSAGA, 6);
  assert.equal(core.totalGasCap, 840_000);
  assert.equal(core.ceilingWei, '20000000000000000');
  assert.equal(core.steps.length, 5);
  assert.equal(core.steps[0]?.conditional, SAGA_CONDITIONAL_MINT);
  assert.equal('conditional' in (core.steps[1] ?? {}), false);
});

test('exact reviewed calldata for all five steps', () => {
  for (const [name, expected] of Object.entries(REVIEWED_CALLDATA)) {
    const data = buildSagaStepCalldata({
      stepName: name,
      deployerAddress: REVIEWED_DEPLOYER,
      contracts: REVIEWED_CONTRACTS,
    });
    assert.equal(data, expected, `calldata for ${name}`);
  }
});

test('saga step invariants (order, targets, amounts, gas caps, ceiling)', () => {
  assert.equal(SAGA_STEPS.length, 5);
  assert.deepEqual(
    SAGA_STEPS.map((step) => step.order),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    SAGA_STEPS.map((step) => step.name),
    [
      'MintTusdc',
      'ApproveTusdcToSwap',
      'SwapTusdcForReceipt',
      'ApproveReceiptToVault',
      'DepositReceiptToVault',
    ],
  );
  assert.deepEqual(
    SAGA_STEPS.map((step) => step.target),
    ['tUSDC', 'tUSDC', 'swap', 'tSAGA', 'vault'],
  );
  assert.deepEqual(
    SAGA_STEPS.map((step) => step.spender),
    [null, 'swap', null, 'vault', null],
  );
  assert.deepEqual(
    SAGA_STEPS.map((step) => step.gasCap),
    [150_000, 120_000, 200_000, 120_000, 250_000],
  );
  assert.equal(SAGA_TOTAL_GAS_CAP, 840_000);
  assert.equal(ONE_TUSDC_RAW, 1_000_000n);
  assert.equal(RECEIPT_OUT_RAW, 990_000n);
  assert.equal(SAGA_CEILING_WEI, 20_000_000_000_000_000n);
  // Reviewed 10 gwei run stays far under the ceiling; the ceiling holds to
  // ~23.8 gwei and must reject 24 gwei (the runner re-estimates per run).
  assert.ok(BigInt(SAGA_TOTAL_GAS_CAP) * 10_000_000_000n <= SAGA_CEILING_WEI);
  assert.ok(BigInt(SAGA_TOTAL_GAS_CAP) * 23_800_000_000n <= SAGA_CEILING_WEI);
  assert.ok(BigInt(SAGA_TOTAL_GAS_CAP) * 24_000_000_000n > SAGA_CEILING_WEI);
  assert.equal(SAGA_EXPECTED_POSTCONDITIONS.length, 10);
  assert.match(SAGA_EXPECTED_POSTCONDITIONS.at(-1) ?? '', /officialUSDC/);
  assert.match(SAGA_EXPECTED_POSTCONDITIONS[4] ?? '', /990000/);
  const mint = SAGA_STEPS[0];
  assert.ok(mint?.conditional);
  assert.match(mint.conditional, /skip if tUSDC balanceOf/);
});

test('saga plan hash binds deployer, contracts, arguments and gas caps', () => {
  const core = buildSagaPlanCore({
    deployerAddress: REVIEWED_DEPLOYER,
    contracts: REVIEWED_CONTRACTS,
  });
  const hash = computeSagaPlanHash(core);
  assert.equal(
    computeSagaPlanHash(
      buildSagaPlanCore({ deployerAddress: REVIEWED_DEPLOYER, contracts: REVIEWED_CONTRACTS }),
    ),
    hash,
  );

  const withOtherDeployer = buildSagaPlanCore({
    deployerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
    contracts: REVIEWED_CONTRACTS,
  });
  assert.notEqual(computeSagaPlanHash(withOtherDeployer), hash);

  const withOtherVault = buildSagaPlanCore({
    deployerAddress: REVIEWED_DEPLOYER,
    contracts: {
      ...REVIEWED_CONTRACTS,
      vault: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
    },
  });
  assert.notEqual(computeSagaPlanHash(withOtherVault), hash);

  const tweakedArgs = JSON.parse(JSON.stringify(core)) as {
    steps: { args: string[] }[];
  };
  (tweakedArgs.steps[2] as { args: string[] }).args[1] = '980000';
  assert.notEqual(computeSagaPlanHash(tweakedArgs as unknown as SagaPlanCore), hash);

  const tweakedCap = JSON.parse(JSON.stringify(core)) as {
    steps: { gasCap: number }[];
  };
  (tweakedCap.steps[2] as { gasCap: number }).gasCap = 199_999;
  assert.notEqual(computeSagaPlanHash(tweakedCap as unknown as SagaPlanCore), hash);

  const tweakedCeiling = JSON.parse(JSON.stringify(core)) as { ceilingWei: string };
  tweakedCeiling.ceilingWei = '19999999999999999';
  assert.notEqual(computeSagaPlanHash(tweakedCeiling as unknown as SagaPlanCore), hash);
});

test('saga plan builders reject invalid addresses and unknown steps', () => {
  assert.throws(() =>
    buildSagaPlanCore({ deployerAddress: '0x1234' as Address, contracts: REVIEWED_CONTRACTS }),
  );
  assert.throws(() =>
    buildSagaPlanCore({
      deployerAddress: REVIEWED_DEPLOYER,
      contracts: { ...REVIEWED_CONTRACTS, tUSDC: '0xzz' as Address },
    }),
  );
  assert.throws(() =>
    buildSagaStepCalldata({
      stepName: 'NotAStep',
      deployerAddress: REVIEWED_DEPLOYER,
      contracts: REVIEWED_CONTRACTS,
    }),
  );
  // Address casing is normalized: the hash never depends on input case.
  const lower = buildSagaPlanCore({
    deployerAddress: REVIEWED_DEPLOYER.toLowerCase() as Address,
    contracts: {
      tUSDC: REVIEWED_CONTRACTS.tUSDC.toLowerCase() as Address,
      tSAGA: REVIEWED_CONTRACTS.tSAGA.toLowerCase() as Address,
      swap: REVIEWED_CONTRACTS.swap.toLowerCase() as Address,
      vault: REVIEWED_CONTRACTS.vault.toLowerCase() as Address,
    },
  });
  assert.equal(computeSagaPlanHash(lower), REVIEWED_PLAN_HASH);
});

test('saga addresses resolve only from a fully CONFIRMED deployment journal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharos-saga-addresses-'));
  try {
    const journalPath = path.join(dir, 'deploy-journal.json');
    const missing = await resolveSagaContractsFromDeployJournal(journalPath);
    assert.equal(missing.ok, false);

    const confirmedEntry = (name: string, address: string) => ({
      name,
      kind: 'deploy',
      status: 'CONFIRMED',
      contractAddress: address.toLowerCase(),
      artifactSha256: 'a'.repeat(64),
    });
    const entries: Record<string, unknown> = {
      'deploy:x:1:TestOnlyUSDC': confirmedEntry('TestOnlyUSDC', REVIEWED_CONTRACTS.tUSDC),
      'deploy:x:2:TestOnlyReceiptToken': confirmedEntry(
        'TestOnlyReceiptToken',
        REVIEWED_CONTRACTS.tSAGA,
      ),
      'deploy:x:3:TestOnlySwap': confirmedEntry('TestOnlySwap', REVIEWED_CONTRACTS.swap),
      'deploy:x:4:TestOnlyVault': confirmedEntry('TestOnlyVault', REVIEWED_CONTRACTS.vault),
      'deploy:x:5:WireMinter': { name: 'WireMinter', kind: 'wire', status: 'CONFIRMED' },
    };
    await writeFile(journalPath, JSON.stringify({ version: 1, note: 'test', entries }), 'utf8');
    const resolved = await resolveSagaContractsFromDeployJournal(journalPath);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.contracts.tUSDC, REVIEWED_CONTRACTS.tUSDC);
      assert.equal(resolved.contracts.tSAGA, REVIEWED_CONTRACTS.tSAGA);
      assert.equal(resolved.contracts.swap, REVIEWED_CONTRACTS.swap);
      assert.equal(resolved.contracts.vault, REVIEWED_CONTRACTS.vault);
      assert.equal(resolved.artifactSha256.tUSDC, 'a'.repeat(64));
    }

    // A single unresolved deployment step must refuse the whole resolution.
    entries['deploy:x:3:TestOnlySwap'] = {
      ...confirmedEntry('TestOnlySwap', REVIEWED_CONTRACTS.swap),
      status: 'INTENT',
    };
    await writeFile(journalPath, JSON.stringify({ version: 1, note: 'test', entries }), 'utf8');
    const refused = await resolveSagaContractsFromDeployJournal(journalPath);
    assert.equal(refused.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saga journal round-trips entries and flags every non-resolved status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharos-saga-journal-'));
  try {
    const journal = new SagaJournal(path.join(dir, 'saga-journal.json'));
    assert.equal(await journal.get('missing'), null);
    const now = new Date().toISOString();
    const entry = {
      key: 'saga-1',
      planHash: 'c'.repeat(64),
      order: 1,
      name: 'MintTusdc',
      kind: 'call' as const,
      nonce: 18,
      gasLimit: '150000',
      gasPrice: '10000000000',
      to: REVIEWED_CONTRACTS.tUSDC.toLowerCase(),
      dataSha256: 'd'.repeat(64),
      artifactSha256: null,
      txHash: null,
      status: 'INTENT' as const,
      recordedAt: now,
      updatedAt: now,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPrice: null,
      note: 'test',
    };
    await journal.put(entry);
    assert.equal((await journal.get('saga-1'))?.status, 'INTENT');
    assert.equal((await journal.list()).length, 1);
    await journal.put({ ...entry, status: 'UNKNOWN', txHash: `0x${'ab'.repeat(32)}` });
    assert.equal((await journal.get('saga-1'))?.status, 'UNKNOWN');
    assert.equal((await journal.list())[0]?.txHash, `0x${'ab'.repeat(32)}`);

    assert.equal(isSagaUnresolved('INTENT'), true);
    assert.equal(isSagaUnresolved('BROADCAST'), true);
    assert.equal(isSagaUnresolved('REVERTED'), true);
    assert.equal(isSagaUnresolved('UNKNOWN'), true);
    assert.equal(isSagaUnresolved('CONFIRMED'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saga targets and calldata never embed the official USDC token', () => {
  const official = officialAtlanticUsdcAddress().toLowerCase();
  const mock = new Set(Object.values(REVIEWED_CONTRACTS).map((address) => address.toLowerCase()));
  assert.equal(mock.has(official), false, 'no saga mock may be the official USDC token');

  const core = buildSagaPlanCore({ deployerAddress: REVIEWED_DEPLOYER, contracts: REVIEWED_CONTRACTS });
  assert.equal(
    JSON.stringify(core).toLowerCase().includes(official),
    false,
    'the plan core must not embed the official USDC address',
  );
  for (const step of core.steps) {
    assert.ok(mock.has(step.to), `step ${step.name} must target one of the four mock contracts`);
    assert.ok(
      step.spender === null || mock.has(step.spender),
      `step ${step.name} may only approve a mock spender`,
    );
  }
  for (const name of Object.keys(REVIEWED_CALLDATA)) {
    const data = buildSagaStepCalldata({
      stepName: name,
      deployerAddress: REVIEWED_DEPLOYER,
      contracts: REVIEWED_CONTRACTS,
    }).toLowerCase();
    assert.equal(
      data.includes(official.slice(2)),
      false,
      `calldata for ${name} must not embed the official USDC address`,
    );
  }
});
