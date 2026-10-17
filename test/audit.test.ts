import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuditOrdering } from '../src/domain/audit.js';
import { FAILURE_SCENARIO, MANUAL_RECOVERY_SCENARIO } from '../src/domain/scenarios.js';
import type { SagaRecord } from '../src/domain/types.js';
import { makeHarness } from './helpers.js';

function eventIndex(record: SagaRecord, predicate: (event: SagaRecord['audit'][number]) => boolean): number {
  const index = record.audit.findIndex(predicate);
  assert.notEqual(index, -1, 'expected audit event was not found');
  return index;
}

function transitionIndex(record: SagaRecord, to: string): number {
  return eventIndex(record, (event) => event.type === 'TRANSITION' && event.to === to);
}

test('success audit log is strictly ordered, complete and describes every state', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();

  const ordering = assertAuditOrdering(record.audit);
  assert.deepEqual(ordering, { ok: true });
  assert.deepEqual(
    record.audit.map((event) => event.seq),
    record.audit.map((_event, index) => index + 1),
  );
  assert.equal(record.nextAuditSeq, record.audit.length + 1);

  const types = record.audit.map((event) => event.type);
  for (const required of [
    'SAGA_CREATED',
    'SAGA_RUN_STARTED',
    'STEP_ATTEMPT',
    'RECEIPT_VERIFIED',
    'STEP_SUCCEEDED',
    'TRANSITION',
  ]) {
    assert.ok(types.includes(required as never), `missing audit event ${required}`);
  }
  assert.equal(types.filter((type) => type === 'STEP_ATTEMPT').length, 3);
  assert.equal(types.filter((type) => type === 'RECEIPT_VERIFIED').length, 3);
  assert.equal(types.filter((type) => type === 'STEP_SUCCEEDED').length, 3);

  const states = record.audit
    .filter((event) => event.type === 'TRANSITION')
    .map((event) => event.to);
  assert.deepEqual(states, [
    'APPROVAL_PENDING',
    'APPROVED',
    'SWAP_PENDING',
    'SWAPPED',
    'DEPOSIT_PENDING',
    'COMPLETED',
  ]);

  for (const event of record.audit) {
    assert.equal(event.sagaId, record.id);
    assert.ok(event.at);
  }
  for (const event of record.audit.filter((candidate) =>
    ['STEP_ATTEMPT', 'RECEIPT_VERIFIED', 'STEP_SUCCEEDED'].includes(candidate.type),
  )) {
    assert.ok(event.stepId, `${event.type} must name its step`);
  }
});

test('retry and compensation events are ordered around the original failure', async (t) => {
  const harness = await makeHarness(t, { scenario: FAILURE_SCENARIO });
  const record = await harness.start();

  assert.deepEqual(assertAuditOrdering(record.audit), { ok: true });
  const retries = record.audit.filter((event) => event.type === 'RETRY_SCHEDULED');
  assert.equal(retries.length, 2);
  assert.deepEqual(
    retries.map((event) => event.data.delayMs),
    [75, 150],
  );

  const permanentFailure = eventIndex(
    record,
    (event) =>
      event.type === 'STEP_FAILED' &&
      event.level === 'ERROR' &&
      event.data.code === 'SIMULATED_PERMANENT_DEPOSIT',
  );
  const compensationStarted = eventIndex(record, (event) => event.type === 'COMPENSATION_STARTED');
  const compensationSucceeded = eventIndex(record, (event) => event.type === 'COMPENSATION_SUCCEEDED');
  const sagaFailed = eventIndex(record, (event) => event.type === 'SAGA_FAILED');
  const finalFailed = transitionIndex(record, 'FAILED');

  assert.ok(retries[1] && record.audit.indexOf(retries[1]) < permanentFailure);
  assert.ok(permanentFailure < compensationStarted);
  assert.ok(compensationStarted < compensationSucceeded);
  assert.ok(compensationSucceeded < sagaFailed);
  assert.ok(sagaFailed < finalFailed);
  assert.equal(record.failure?.step, 'DEPOSIT');
  assert.equal(record.compensation?.status, 'SUCCEEDED');
});

test('compensation failure is audited separately from the original step failure', async (t) => {
  const harness = await makeHarness(t, { scenario: MANUAL_RECOVERY_SCENARIO });
  const record = await harness.start();

  const stepFailure = eventIndex(
    record,
    (event) => event.type === 'STEP_FAILED' && event.data.step === 'SWAP',
  );
  const compensationStarted = eventIndex(record, (event) => event.type === 'COMPENSATION_STARTED');
  const compensationFailed = eventIndex(record, (event) => event.type === 'COMPENSATION_FAILED');
  const manual = eventIndex(record, (event) => event.type === 'MANUAL_RECOVERY_REQUIRED');

  assert.ok(stepFailure < compensationStarted);
  assert.ok(compensationStarted < compensationFailed);
  assert.ok(compensationFailed < manual);
  assert.equal(record.audit[compensationFailed]?.data.action, 'REVOKE_APPROVAL');
  assert.equal(record.failure?.step, 'SWAP');
  assert.equal(record.compensation?.status, 'FAILED');
  assert.equal(record.compensation?.error?.code, 'SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL');
  assert.ok(
    record.audit.some(
      (event) => event.type === 'TRANSITION' && event.from === 'COMPENSATING' && event.to === 'MANUAL_RECOVERY_REQUIRED',
    ),
  );
});

test('audit errors include kind, code, message, timestamp and attempt', async (t) => {
  const harness = await makeHarness(t, { scenario: FAILURE_SCENARIO });
  const record = await harness.start();
  const transient = record.steps.DEPOSIT.errors.filter((error) => error.kind === 'TRANSIENT');
  assert.equal(transient.length, 2);
  for (const error of transient) {
    assert.equal(error.code, 'SIMULATED_TRANSIENT_DEPOSIT');
    assert.ok(error.message.length > 0);
    assert.ok(Number.isFinite(Date.parse(error.at)));
    assert.ok(error.attempt !== null);
  }
  const failedEvents = record.audit.filter(
    (event) => event.type === 'STEP_FAILED' && event.data.step === 'DEPOSIT',
  );
  assert.equal(failedEvents.length, 3);
  assert.deepEqual(
    failedEvents.map((event) => event.data.kind),
    ['TRANSIENT', 'TRANSIENT', 'PERMANENT'],
  );
});

test('the NDJSON audit mirror matches the authoritative snapshot for a failed saga', async (t) => {
  const harness = await makeHarness(t, { scenario: FAILURE_SCENARIO });
  const record = await harness.start();
  const mirror = await harness.store.readAuditMirror(record.id);
  assert.deepEqual(mirror, record.audit);
  assert.equal(mirror.length, record.audit.length);
  assert.deepEqual(assertAuditOrdering(mirror), { ok: true });
});

test('a duplicate run of a completed saga adds no audit events', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const before = record.audit.length;
  await harness.executor.runSaga(record.id);
  const after = await harness.reload(record.id);
  assert.equal(after.audit.length, before);
  assert.equal(after.state, 'COMPLETED');
});

test('timestamps are non-decreasing and retry waits advance virtual time', async (t) => {
  const harness = await makeHarness(t, { scenario: FAILURE_SCENARIO });
  const record = await harness.start();
  const times = record.audit.map((event) => Date.parse(event.at));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok((times[index] ?? 0) >= (times[index - 1] ?? 0));
  }
  assert.equal(record.audit.at(-1)?.at, '2026-01-01T00:00:00.225Z');
});
