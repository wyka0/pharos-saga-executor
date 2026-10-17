import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PharosTestnetAdapter } from '../src/adapters/pharosTestnet.js';
import { VirtualClock } from '../src/domain/clock.js';
import {
  ConfigurationError,
  PermanentStepError,
  UnknownSubmissionOutcomeError,
} from '../src/domain/errors.js';
import { verifyStepReceipt } from '../src/domain/receipts.js';
import { createSagaRecord } from '../src/domain/saga.js';
import {
  DEFAULT_REQUEST,
  type PlanApproval,
  type SagaRecord,
  type TestnetConfig,
} from '../src/domain/types.js';
import { SagaExecutor } from '../src/executor/executor.js';
import { TestnetJournal } from '../src/persistence/testnetJournal.js';
import { SagaStore } from '../src/persistence/store.js';
import {
  FakeTestnetClient,
  TEST_PROTOCOL,
  TEST_TOKEN,
  testConfig,
} from './testnet-fakes.js';

const CLOCK = new VirtualClock('2026-10-17T00:00:00.000Z');

function request() {
  return {
    ...DEFAULT_REQUEST,
    fromToken: 'USDC',
    toToken: 'USDC',
    depositToken: 'USDC',
    amountIn: '0.01',
    spender: TEST_PROTOCOL,
    protocol: 'test-fixture-vault',
    owner: 'testnet-wallet',
  };
}

function sagaFor(config: TestnetConfig, overrides: Partial<ReturnType<typeof request>> = {}): SagaRecord {
  return createSagaRecord(
    {
      sagaId: 'saga_testnet_test',
      request: { ...request(), ...overrides },
      adapterId: 'pharos-testnet',
      testnet: config,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 1 },
    },
    CLOCK,
  );
}

function approvalFor(hash: string): PlanApproval {
  return { planHash: hash, approvedAt: '2026-10-17T00:00:00.000Z', approvedBy: 'test-user' };
}

async function makeAdapter(t: TestContext, config = testConfig()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-testnet-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const client = new FakeTestnetClient();
  const journal = new TestnetJournal(path.join(dir, 'journal.json'));
  const adapter = new PharosTestnetAdapter({
    client,
    config,
    journal,
    clock: CLOCK,
    sleep: async () => undefined,
    receiptTimeoutMs: 1,
  });
  return { dir, client, journal, adapter };
}

async function executableApprovePlan(client: FakeTestnetClient, adapter: PharosTestnetAdapter, config = testConfig()) {
  client.setBalance(1_000_000n);
  const saga = sagaFor(config);
  const plan = await adapter.plan(saga, 'APPROVE');
  assert.equal(plan.executable, true, plan.blockedReasons.join('; '));
  return { saga, plan };
}

test('readiness refuses a non-Atlantic chain before planning', async (t) => {
  const { client, adapter } = await makeAdapter(t);
  client.chainId = 1672;
  const report = await adapter.readiness({
    fromToken: 'USDC',
    amountIn: '0.01',
    spender: TEST_PROTOCOL,
  });
  assert.equal(report.ok, false);
  assert.equal(report.network.chainId, 1672);
  assert.ok(report.warnings.some((warning) => warning.includes('expected 688689')));
  assert.equal(report.capabilities.approve.available, false);
  assert.equal(report.capabilities.swap.available, false);
  assert.equal(report.capabilities.deposit.available, false);
});

test('readiness reports the verified token, balance, and missing protocols', async (t) => {
  const { client, adapter } = await makeAdapter(t, testConfig({ swap: null, deposit: null }));
  const report = await adapter.readiness({
    fromToken: 'USDC',
    amountIn: '0.01',
    spender: TEST_PROTOCOL,
  });
  assert.equal(report.ok, true);
  assert.equal(report.network.chainId, 688689);
  assert.equal(report.wallet, client.getAddress());
  assert.ok(report.nativeBalance.startsWith('0.54'));
  assert.equal(report.tokens[0]?.verified, true);
  assert.equal(report.tokens[0]?.balance, '0');
  assert.equal(report.capabilities.approve.available, false);
  assert.ok(report.capabilities.approve.reasons.some((reason) => /no verified swap or deposit/i.test(reason)));
  assert.equal(report.capabilities.swap.available, false);
  assert.equal(report.capabilities.deposit.available, false);
  assert.equal(report.faucet.documented, false);
});

test('approve planning is blocked when no verified spender protocol exists', async (t) => {
  const { client, adapter } = await makeAdapter(t, testConfig({ swap: null, deposit: null }));
  client.setBalance(1_000_000n);
  const plan = await adapter.plan(sagaFor(testConfig({ swap: null, deposit: null })), 'APPROVE');
  assert.equal(plan.executable, false);
  assert.equal(plan.transactions.length, 0);
  assert.equal(plan.maxTestnetCostWei, '0');
  assert.ok(plan.blockedReasons.some((reason) => /no verified swap or deposit/i.test(reason)));
});

test('approve plan uses the exact amount and no unlimited allowance', async (t) => {
  const { client, adapter } = await makeAdapter(t);
  client.setBalance(1_000_000n);
  const config = testConfig();
  const saga = sagaFor(config);
  const plan = await adapter.plan(saga, 'APPROVE');
  assert.equal(plan.executable, true);
  assert.equal(plan.chainId, 688689);
  assert.equal(plan.transactions.length, 1);
  const tx = plan.transactions[0]!;
  assert.equal(tx.kind, 'APPROVE');
  assert.equal(tx.to, TEST_TOKEN.address);
  assert.equal(tx.spender, TEST_PROTOCOL);
  assert.equal(tx.tokenSymbol, 'USDC');
  assert.equal(tx.amount, '0.01');
  assert.equal(tx.decimals, 6);
  assert.match(tx.data, /^0x095ea7b3/);
  const amountWord = BigInt(`0x${tx.data.slice(74, 138)}`);
  assert.equal(amountWord, 10_000n, 'allowance must be exactly 0.01 USDC, never uint256 max');
  assert.equal(tx.gasEstimate, '71377');
  assert.equal(tx.maxFeePerGasWei, '20000000000');
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  CLOCK.advance(5_000);
  const planAgain = await adapter.plan(sagaFor(config), 'APPROVE');
  assert.equal(planAgain.planHash, plan.planHash, 'plan hash must not depend on wall-clock createdAt');
});

test('read-only checks retry transient RPC failures and never send', async (t) => {
  const { client, adapter } = await makeAdapter(t);
  client.setBalance(1_000_000n);
  client.chainIdFailures = 3;
  const plan = await adapter.plan(sagaFor(testConfig()), 'APPROVE');
  assert.equal(plan.executable, true);
  assert.equal(client.sendCalls.length, 0);
  assert.equal(client.chainIdFailures, 0);
});

test('submit refuses without explicit approval and sends nothing', async (t) => {
  const { client, adapter } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
    }),
    (error: unknown) => error instanceof PermanentStepError && error.code === 'PLAN_APPROVAL_REQUIRED',
  );
  assert.equal(client.sendCalls.length, 0);
});

test('submit refuses a plan hash that was not approved', async (t) => {
  const { client, adapter } = await makeAdapter(t);
  const { saga } = await executableApprovePlan(client, adapter);
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor('0'.repeat(64)),
    }),
    (error: unknown) => error instanceof PermanentStepError && error.code === 'PLAN_HASH_MISMATCH',
  );
  assert.equal(client.sendCalls.length, 0);
});

test('submit broadcasts once, verifies the on-chain postcondition, and returns a real receipt', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  const receipt = await adapter.submit('APPROVE', {
    saga,
    step: 'APPROVE',
    stepRecord: saga.steps.APPROVE,
    attempt: 1,
    clock: CLOCK,
    approval: approvalFor(plan.planHash),
  });
  assert.equal(receipt.simulated, false);
  if (receipt.simulated) throw new Error('expected on-chain receipt');
  assert.equal(receipt.network, 'atlantic-testnet');
  assert.equal(receipt.chainId, 688689);
  assert.match(receipt.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.status, 'SUCCESS');
  assert.equal(receipt.explorerUrl, `https://atlantic.pharosscan.xyz/tx/${receipt.txHash}`);
  assert.equal(receipt.result.allowance, '0.01');
  assert.equal(client.getAllowance(), 10_000n);
  assert.equal(client.sendCalls.length, 1);
  assert.equal(client.sendCalls[0]?.to, TEST_TOKEN.address);
  const verification = verifyStepReceipt(receipt, saga, 'APPROVE');
  assert.equal(verification.ok, true);
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'CONFIRMED');
  assert.equal(entry?.txHash, receipt.txHash);
});

test('a reverted transaction is recorded as REVERTED and never retried', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  client.sendMode = 'revert';
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) => error instanceof PermanentStepError && error.code === 'TESTNET_TX_REVERTED',
  );
  assert.equal(client.sendCalls.length, 1);
  assert.equal(client.getAllowance(), 0n);
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'REVERTED');
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) => error instanceof PermanentStepError && error.code === 'TESTNET_TX_REVERTED',
  );
  assert.equal(client.sendCalls.length, 1, 'must not resend a reverted transaction');
});

test('a receipt timeout is an unknown outcome and is never resubmitted', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  client.sendMode = 'timeout';
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) =>
      error instanceof UnknownSubmissionOutcomeError && error.code === 'TESTNET_RECEIPT_TIMEOUT',
  );
  assert.equal(client.sendCalls.length, 1);
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'UNKNOWN');
  assert.ok(entry?.txHash);

  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 2,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) => error instanceof UnknownSubmissionOutcomeError,
  );
  assert.equal(client.sendCalls.length, 1, 'unknown outcomes must not be resubmitted');
});

test('an ambiguous send error is unknown and never resubmitted', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  client.sendMode = 'throw';
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) => error instanceof UnknownSubmissionOutcomeError && error.code === 'TESTNET_SEND_UNKNOWN',
  );
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'UNKNOWN');
  assert.equal(entry?.txHash, null);
  assert.equal(client.sendCalls.length, 1);
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 2,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) => error instanceof UnknownSubmissionOutcomeError,
  );
  assert.equal(client.sendCalls.length, 1);
});

test('a confirmed transaction with a failed postcondition is unknown, not success', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  client.sendMode = 'no-postcondition';
  await assert.rejects(
    adapter.submit('APPROVE', {
      saga,
      step: 'APPROVE',
      stepRecord: saga.steps.APPROVE,
      attempt: 1,
      clock: CLOCK,
      approval: approvalFor(plan.planHash),
    }),
    (error: unknown) =>
      error instanceof UnknownSubmissionOutcomeError &&
      error.code === 'TESTNET_POSTCONDITION_UNCONFIRMED',
  );
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'UNKNOWN');
  assert.equal(client.sendCalls.length, 1);
});

test('reconcile recovers a broadcast transaction without resubmitting', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const { saga, plan } = await executableApprovePlan(client, adapter);
  client.sendMode = 'success';
  const receipt = await adapter.submit('APPROVE', {
    saga,
    step: 'APPROVE',
    stepRecord: saga.steps.APPROVE,
    attempt: 1,
    clock: CLOCK,
    approval: approvalFor(plan.planHash),
  });
  if (receipt.simulated) throw new Error('expected on-chain');
  // Simulate the saga snapshot having missed the receipt: journal remains authoritative.
  const entry = await journal.get(saga.steps.APPROVE.idempotencyKey);
  assert.equal(entry?.status, 'CONFIRMED');
  const reconciled = await adapter.reconcile('APPROVE', {
    saga,
    step: 'APPROVE',
    stepRecord: saga.steps.APPROVE,
    clock: CLOCK,
  });
  assert.equal(reconciled.receipt?.simulated, false);
  assert.equal(client.sendCalls.length, 1);
});

test('compensation is unavailable when no verified protocol exists', async (t) => {
  const { adapter } = await makeAdapter(t, testConfig({ swap: null, deposit: null }));
  assert.equal(adapter.supportsCompensation('REVOKE_APPROVAL'), false);
  assert.equal(adapter.supportsCompensation('SIMULATED_UNWIND_SWAP'), false);
});

test('testnet config rejects mainnet chain id and non-Atlantic explorer', () => {
  assert.throws(
    () =>
      createSagaRecord(
        {
          request: request(),
          adapterId: 'pharos-testnet',
          testnet: { ...testConfig(), network: { ...testConfig().network, chainId: 1672 as never } },
        },
        CLOCK,
      ),
    ConfigurationError,
  );
  assert.throws(
    () =>
      createSagaRecord(
        {
          request: request(),
          adapterId: 'pharos-testnet',
          testnet: {
            ...testConfig(),
            network: { ...testConfig().network, explorerUrl: 'https://example.com/' },
          },
        },
        CLOCK,
      ),
    ConfigurationError,
  );
});

test('an existing unknown revoke outcome is never resubmitted', async (t) => {
  const { client, adapter, journal } = await makeAdapter(t);
  const saga = sagaFor(testConfig());
  const key = `${saga.id}:COMPENSATION:REVOKE_APPROVAL:v1`;
  await journal.put({
    key,
    sagaId: saga.id,
    step: 'SWAP',
    planHash: 'a'.repeat(64),
    nonce: 13,
    txHash: `0x${'ab'.repeat(32)}`,
    status: 'UNKNOWN',
    recordedAt: CLOCK.now().toISOString(),
    updatedAt: CLOCK.now().toISOString(),
    receipt: null,
    plan: null,
    note: 'existing unknown revoke',
  });
  const revokePlan = await adapter.planRevoke(saga);
  const result = await adapter.compensate({
    saga,
    action: 'REVOKE_APPROVAL',
    originalStep: 'SWAP',
    clock: CLOCK,
    approval: approvalFor(revokePlan.planHash),
  });
  assert.equal(result.status, 'FAILED');
  assert.match(result.note, /not resubmit|manual/i);
  assert.equal(client.sendCalls.length, 0);
});

test('executor stops after APPROVE when SWAP is unavailable and never claims three steps', async (t) => {
  const { dir, client, journal, adapter } = await makeAdapter(t);
  const config = testConfig();
  const { plan } = await executableApprovePlan(client, adapter);
  const store = new SagaStore(path.join(dir, 'state'));
  const executor = new SagaExecutor({
    store,
    clock: CLOCK,
    jitter: () => 0.5,
    approval: approvalFor(plan.planHash),
    adapterFactory: () => adapter,
  });
  const created = await executor.startSaga({
    sagaId: 'saga_testnet_partial',
    request: request(),
    adapterId: 'pharos-testnet',
    testnet: config,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 1 },
    autoRun: false,
  });
  const record = await executor.runSaga(created.saga.id);

  assert.equal(record.steps.APPROVE.status, 'SUCCEEDED');
  assert.equal(record.steps.APPROVE.receipt?.simulated, false);
  assert.equal(record.steps.SWAP.status, 'FAILED');
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.notEqual(record.state, 'COMPLETED');
  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.compensation?.status, 'FAILED');
  assert.equal(client.sendCalls.length, 1, 'only the approved APPROVE transaction was sent');
  assert.ok(
    record.audit.some(
      (event) =>
        event.type === 'STEP_FAILED' &&
        event.data.step === 'SWAP' &&
        event.data.code === 'CAPABILITY_UNAVAILABLE',
    ),
  );
  assert.equal(journal.get(record.steps.APPROVE.idempotencyKey) !== null, true);
});
