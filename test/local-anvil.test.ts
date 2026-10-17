/**
 * Offline tests for the local-anvil surface: configuration gating, local
 * receipt verification, and the durable local journal.
 *
 * These tests never touch Anvil, WSL, RPC, wallets or Atlantic. The real
 * local end-to-end run lives in scripts/local-anvil.ts (npm run demo:local).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemClock } from '../src/domain/clock.js';
import { buildConfig, createSagaRecord, validateLocalAnvilConfig } from '../src/domain/saga.js';
import { verifyCompensationReceipt, verifyStepReceipt } from '../src/domain/receipts.js';
import { LocalJournal } from '../src/persistence/localJournal.js';
import type { LocalAnvilConfig, LocalReceipt, SagaRecord, StepName } from '../src/domain/types.js';

const CONFIG: LocalAnvilConfig = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  usdc: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  receiptToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  swap: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  vault: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
};

function makeRecord(): SagaRecord {
  return createSagaRecord(
    {
      sagaId: 'saga_local_unit',
      adapterId: 'local-anvil',
      localAnvil: CONFIG,
      request: {
        owner: CONFIG.owner,
        fromToken: 'tUSDC',
        toToken: 'tSAGA',
        depositToken: 'tSAGA',
        amountIn: '1',
        spender: CONFIG.swap,
        protocol: 'TestOnlyVault',
        depositTarget: CONFIG.vault,
      },
    },
    new SystemClock(),
  );
}

function makeReceipt(record: SagaRecord, step: StepName): LocalReceipt {
  const base = {
    receiptVersion: 1 as const,
    receiptKind: 'STEP' as const,
    simulated: false as const,
    network: 'local-anvil' as const,
    chainId: 31337 as const,
    disclaimer: 'LOCAL ANVIL TEST-ONLY CHAIN (chainId 31337) - no Atlantic or mainnet transaction.',
    txHash: `0x${'11'.repeat(32)}`,
    blockNumber: '5',
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'SUCCESS' as const,
    confirmations: 1,
    from: CONFIG.owner,
    to: step === 'APPROVE' ? CONFIG.usdc : step === 'SWAP' ? CONFIG.swap : CONFIG.vault,
    explorerUrl: null,
    sagaId: record.id,
    stepId: record.steps[step].id,
    idempotencyKey: record.steps[step].idempotencyKey,
    operation: step,
    issuedAt: '2026-10-17T00:00:00.000Z',
    gasUsed: '21000',
    effectiveGasPrice: '1000000000',
    postconditions: [{ name: 'balance', expected: '1', observed: '1' }],
  };
  if (step === 'APPROVE') {
    return {
      ...base,
      result: {
        tokenIn: 'tUSDC',
        tokenOut: '',
        amountIn: '1',
        amountOut: '0',
        allowance: '1',
        spender: CONFIG.swap,
        shares: null,
        protocol: null,
      },
    };
  }
  if (step === 'SWAP') {
    return {
      ...base,
      result: {
        tokenIn: 'tUSDC',
        tokenOut: 'tSAGA',
        amountIn: '1',
        amountOut: '0.99',
        allowance: null,
        spender: null,
        shares: null,
        protocol: null,
      },
    };
  }
  return {
    ...base,
    result: {
      tokenIn: 'tSAGA',
      tokenOut: 'TestOnlyVault:shares',
      amountIn: '0.99',
      amountOut: '0.99',
      allowance: null,
      spender: null,
      shares: '0.99',
      protocol: 'TestOnlyVault',
    },
  };
}

test('local config accepts only localhost http and chainId 31337', () => {
  const accepted = validateLocalAnvilConfig(CONFIG);
  assert.equal(accepted.chainId, 31337);

  assert.throws(() => validateLocalAnvilConfig({ ...CONFIG, chainId: 1 as never }), /31337/);
  assert.throws(() => validateLocalAnvilConfig({ ...CONFIG, chainId: 688689 as never }), /31337/);
  assert.throws(
    () => validateLocalAnvilConfig({ ...CONFIG, rpcUrl: 'https://127.0.0.1:8545' }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => validateLocalAnvilConfig({ ...CONFIG, rpcUrl: 'http://example.com:8545' }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => validateLocalAnvilConfig({ ...CONFIG, owner: 'not-an-address' }),
    /owner/,
  );
});

test('buildConfig keeps local-anvil and testnet configurations exclusive', () => {
  const config = buildConfig({
    sagaId: 'saga_local_unit',
    adapterId: 'local-anvil',
    localAnvil: CONFIG,
  });
  assert.equal(config.adapterId, 'local-anvil');
  assert.equal(config.localAnvil?.chainId, 31337);
  assert.equal(config.testnet, null);

  assert.throws(
    () => buildConfig({ adapterId: 'local-anvil' } as never),
    /localAnvil configuration/,
  );
  assert.throws(
    () =>
      buildConfig({
        adapterId: 'local-anvil',
        localAnvil: CONFIG,
        testnet: {
          network: {
            name: 'Pharos Atlantic Testnet',
            chainId: 688689,
            rpcUrl: 'https://rpc.pharos.xyz',
            explorerUrl: 'https://atlantic.pharosscan.xyz',
          },
          tokens: [],
          swap: null,
          deposit: null,
          approvedPlan: null,
        },
      }),
    /cannot be used with adapterId local-anvil/,
  );
});

test('verifyStepReceipt accepts well-formed local receipts for every step', () => {
  const record = makeRecord();
  for (const step of ['APPROVE', 'SWAP', 'DEPOSIT'] as StepName[]) {
    const verification = verifyStepReceipt(makeReceipt(record, step), record, step);
    assert.equal(verification.ok, true, `step ${step} should verify`);
  }
});

test('verifyStepReceipt rejects explorer links, wrong chains and missing warning text', () => {
  const record = makeRecord();
  const withExplorer = { ...makeReceipt(record, 'SWAP'), explorerUrl: 'https://example.com/tx/1' };
  assert.equal(verifyStepReceipt(withExplorer, record, 'SWAP').ok, false);

  const wrongChain = { ...makeReceipt(record, 'SWAP'), chainId: 688689 };
  assert.equal(verifyStepReceipt(wrongChain, record, 'SWAP').ok, false);

  const wrongNetwork = { ...makeReceipt(record, 'SWAP'), network: 'atlantic-testnet' };
  assert.equal(verifyStepReceipt(wrongNetwork, record, 'SWAP').ok, false);

  const noWarning = { ...makeReceipt(record, 'SWAP'), disclaimer: 'all good' };
  assert.equal(verifyStepReceipt(noWarning, record, 'SWAP').ok, false);

  const noPostconditions = { ...makeReceipt(record, 'SWAP'), postconditions: [] };
  assert.equal(verifyStepReceipt(noPostconditions, record, 'SWAP').ok, false);
});

test('verifyCompensationReceipt accepts a local revoke receipt and rejects a non-zero allowance', () => {
  const record = makeRecord();
  const original = makeReceipt(record, 'SWAP');
  const receipt: LocalReceipt = {
    ...original,
    receiptKind: 'COMPENSATION',
    stepId: `${record.id}:COMPENSATION:REVOKE_APPROVAL`,
    idempotencyKey: `${record.id}:COMPENSATION:REVOKE_APPROVAL:v1`,
    operation: 'COMPENSATION_REVOKE_APPROVAL',
    result: {
      tokenIn: 'tUSDC',
      tokenOut: '',
      amountIn: '1',
      amountOut: '0',
      allowance: '0',
      spender: CONFIG.swap,
      shares: null,
      protocol: null,
    },
    compensatesStep: 'SWAP',
  };
  assert.equal(verifyCompensationReceipt(receipt, record, 'REVOKE_APPROVAL', 'SWAP').ok, true);

  const bad = { ...receipt, result: { ...receipt.result, allowance: '1' } };
  assert.equal(verifyCompensationReceipt(bad, record, 'REVOKE_APPROVAL', 'SWAP').ok, false);

  const wrongStep = { ...receipt, compensatesStep: 'DEPOSIT' };
  assert.equal(verifyCompensationReceipt(wrongStep, record, 'REVOKE_APPROVAL', 'SWAP').ok, false);
});

test('LocalJournal persists an INTENT before any send and updates it atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-local-journal-'));
  try {
    const journal = new LocalJournal(path.join(dir, 'journal.json'));
    const at = '2026-10-17T00:00:00.000Z';
    await journal.put({
      key: 'saga_local_unit:SWAP',
      sagaId: 'saga_local_unit',
      step: 'SWAP',
      nonce: 0,
      txHash: null,
      status: 'INTENT',
      recordedAt: at,
      updatedAt: at,
      receipt: null,
      note: 'intent before send',
    });
    const intent = await journal.get('saga_local_unit:SWAP');
    assert.equal(intent?.status, 'INTENT');
    assert.equal(intent?.txHash, null);

    assert.equal(await journal.get('missing'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
