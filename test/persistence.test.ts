import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualClock } from '../src/domain/clock.js';
import { SimulatedInterruptionError } from '../src/executor/executor.js';
import { SUCCESS_SCENARIO, makeScenario } from '../src/domain/scenarios.js';
import { DEFAULT_REQUEST } from '../src/domain/types.js';
import { SagaStore } from '../src/persistence/store.js';
import { makeHarness, submittedSteps } from './helpers.js';

class InterruptingClock extends VirtualClock {
  interruptNextSleep = false;

  override async sleep(ms: number): Promise<void> {
    if (this.interruptNextSleep) {
      this.interruptNextSleep = false;
      throw new SimulatedInterruptionError('Simulated interruption during retry wait');
    }
    await super.sleep(ms);
  }
}

test('saga state, receipts and audit survive an atomic save/load round trip', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const store2 = new SagaStore(harness.dir);
  const loaded = await store2.load(record.id);

  assert.equal(loaded.state, 'COMPLETED');
  assert.equal(loaded.steps.DEPOSIT.receipt?.simulatedTxRef, record.steps.DEPOSIT.receipt?.simulatedTxRef);
  assert.equal(loaded.audit.length, record.audit.length);
  assert.deepEqual(loaded.audit.map((event) => event.seq), record.audit.map((event) => event.seq));

  const mirror = await store2.readAuditMirror(record.id);
  assert.equal(mirror.length, loaded.audit.length);
  assert.deepEqual(mirror.map((event) => event.seq), loaded.audit.map((event) => event.seq));
  assert.deepEqual(mirror.map((event) => event.type), loaded.audit.map((event) => event.type));

  const listed = await store2.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, record.id);
});

test('resume after a crash following APPROVE verification does not re-run APPROVE', async (t) => {
  const harness = await makeHarness(t, {
    hooks: {
      afterStepVerified: (_record, step) => {
        if (step === 'APPROVE') throw new SimulatedInterruptionError();
      },
    },
  });
  const created = await harness.create();
  await assert.rejects(harness.executor.runSaga(created.id), SimulatedInterruptionError);

  const interrupted = await harness.reload(created.id);
  assert.equal(interrupted.state, 'APPROVED');
  assert.equal(interrupted.steps.APPROVE.status, 'SUCCEEDED');
  assert.equal(interrupted.steps.APPROVE.attempts, 1);
  assert.equal(interrupted.steps.SWAP.attempts, 0);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE']);

  const resumed = await harness.newExecutor({}).runSaga(created.id);
  assert.equal(resumed.state, 'COMPLETED');
  assert.equal(resumed.steps.APPROVE.attempts, 1, 'APPROVE must not be re-submitted');
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'DEPOSIT']);
});

test('resume after a crash between submission and receipt persistence reconciles without resubmitting', async (t) => {
  const harness = await makeHarness(t, {
    hooks: {
      beforeReceiptPersisted: (_receipt, _record, step) => {
        if (step === 'SWAP') throw new SimulatedInterruptionError();
      },
    },
  });
  const created = await harness.create();
  await assert.rejects(harness.executor.runSaga(created.id), SimulatedInterruptionError);

  const interrupted = await harness.reload(created.id);
  assert.equal(interrupted.state, 'SWAP_PENDING');
  assert.equal(interrupted.steps.SWAP.status, 'IN_PROGRESS');
  assert.equal(interrupted.steps.SWAP.submissionState, 'IN_FLIGHT');
  assert.equal(interrupted.steps.SWAP.attempts, 1);
  assert.equal(interrupted.steps.SWAP.receipt, null);

  const resumed = await harness.newExecutor({}).runSaga(created.id);
  assert.equal(resumed.state, 'COMPLETED');
  assert.equal(resumed.steps.SWAP.attempts, 1, 'SWAP must not be re-submitted');
  assert.equal(resumed.steps.SWAP.receipt?.simulated, true);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'DEPOSIT']);
  assert.equal(harness.calls.filter((call) => call.kind === 'reconcile').length, 1);
});

test('resume after a crash before submission finds no receipt and requires manual recovery', async (t) => {
  const harness = await makeHarness(t, {
    hooks: {
      beforeSubmit: (_record, step) => {
        if (step === 'DEPOSIT') throw new SimulatedInterruptionError();
      },
    },
  });
  const created = await harness.create();
  await assert.rejects(harness.executor.runSaga(created.id), SimulatedInterruptionError);

  const interrupted = await harness.reload(created.id);
  assert.equal(interrupted.state, 'DEPOSIT_PENDING');
  assert.equal(interrupted.steps.DEPOSIT.status, 'IN_PROGRESS');
  assert.equal(interrupted.steps.DEPOSIT.submissionState, 'IN_FLIGHT');
  assert.equal(interrupted.steps.DEPOSIT.attempts, 1);

  const resumed = await harness.newExecutor({}).runSaga(created.id);
  assert.equal(resumed.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(resumed.failure?.kind, 'UNKNOWN_OUTCOME');
  assert.equal(resumed.steps.DEPOSIT.status, 'FAILED');
  assert.equal(resumed.steps.DEPOSIT.receipt, null);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP']);
  assert.equal(harness.calls.filter((call) => call.kind === 'reconcile').length, 1);
});

test('resume during RETRY_WAIT honours the persisted schedule and completes', async (t) => {
  const scenario = makeScenario('deposit-retry-interrupted', {
    deposit: { transientFailures: 1 },
  });
  const clock = new InterruptingClock('2026-01-01T00:00:00.000Z');
  const harness = await makeHarness(t, { scenario, clock });
  const created = await harness.create();

  clock.interruptNextSleep = true;
  await assert.rejects(harness.executor.runSaga(created.id), SimulatedInterruptionError);

  const interrupted = await harness.reload(created.id);
  assert.equal(interrupted.state, 'RETRY_WAIT');
  assert.equal(interrupted.steps.DEPOSIT.status, 'RETRY_WAIT');
  assert.equal(interrupted.steps.DEPOSIT.attempts, 1);
  assert.equal(interrupted.steps.DEPOSIT.retry?.delayMs, 75);
  assert.equal(interrupted.steps.SWAP.status, 'SUCCEEDED');

  const resumed = await harness.newExecutor({}).runSaga(created.id);
  assert.equal(resumed.state, 'COMPLETED');
  assert.equal(resumed.steps.DEPOSIT.attempts, 2);
  assert.equal(
    resumed.audit.filter((event) => event.type === 'TRANSITION' && event.from === 'RETRY_WAIT').length,
    1,
  );
});

test('duplicate start with the same clientRequestId returns the existing saga', async (t) => {
  const harness = await makeHarness(t);
  const first = await harness.executor.startSaga({
    sagaId: 'saga_duplicate_a',
    clientRequestId: 'client-request-1',
    request: DEFAULT_REQUEST,
    scenario: SUCCESS_SCENARIO,
    autoRun: false,
  });
  const second = await harness.executor.startSaga({
    sagaId: 'saga_duplicate_b',
    clientRequestId: 'client-request-1',
    request: DEFAULT_REQUEST,
    scenario: SUCCESS_SCENARIO,
    autoRun: false,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.saga.id, first.saga.id);
  assert.equal((await harness.store.list()).length, 1);
});

test('a completed saga is a no-op when run again', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const auditLength = record.audit.length;
  const callCount = harness.calls.length;

  const again = await harness.executor.runSaga(record.id);
  assert.equal(again.state, 'COMPLETED');
  assert.equal(again.audit.length, auditLength);
  assert.equal(harness.calls.length, callCount);

  const loaded = await new SagaStore(harness.dir).load(record.id);
  assert.equal(loaded.audit.length, auditLength);
});

test('concurrent duplicate run invocations submit each step exactly once', async (t) => {
  const harness = await makeHarness(t);
  const created = await harness.create();
  const [first, second] = await Promise.all([
    harness.executor.runSaga(created.id),
    harness.executor.runSaga(created.id),
  ]);

  assert.equal(first.state, 'COMPLETED');
  assert.equal(second.state, 'COMPLETED');
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'DEPOSIT']);
  assert.equal(first.audit.filter((event) => event.type === 'STEP_ATTEMPT').length, 3);
  assert.equal(
    first.audit.filter((event) => event.type === 'SAGA_CREATED').length,
    1,
    'only one saga record may exist',
  );
});

test('a saga can be created, inspected and resumed from a fresh executor', async (t) => {
  const harness = await makeHarness(t);
  const created = await harness.create();
  assert.equal(created.state, 'CREATED');

  const inspected = await harness.newExecutor({}).inspectSaga(created.id);
  assert.equal(inspected.state, 'CREATED');
  assert.equal(inspected.steps.APPROVE.attempts, 0);

  const resumed = await harness.newExecutor({}).runSaga(created.id);
  assert.equal(resumed.state, 'COMPLETED');
  assert.deepEqual(await harness.store.list().then((records) => records.map((record) => record.id)), [created.id]);
});
