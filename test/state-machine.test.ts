import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualClock } from '../src/domain/clock.js';
import { ConfigurationError, DependencyViolationError, IllegalTransitionError } from '../src/domain/errors.js';
import { createSagaRecord } from '../src/domain/saga.js';
import { ALLOWED_TRANSITIONS, applyTransition, assertPrerequisites, canTransition } from '../src/domain/states.js';
import {
  DEFAULT_REQUEST,
  SAGA_STATES,
  STEP_NAMES,
  type SagaRecord,
} from '../src/domain/types.js';
import { makeHarness } from './helpers.js';

function newRecord(): SagaRecord {
  return createSagaRecord({ request: DEFAULT_REQUEST }, new VirtualClock('2026-01-01T00:00:00.000Z'));
}

function advanceTo(record: SagaRecord, state: SagaRecord['state']): void {
  const order = [
    'CREATED',
    'APPROVAL_PENDING',
    'APPROVED',
    'SWAP_PENDING',
    'SWAPPED',
    'DEPOSIT_PENDING',
    'COMPLETED',
  ];
  const fromIndex = order.indexOf(record.state);
  const toIndex = order.indexOf(state);
  if (fromIndex < 0 || toIndex < 0) return;
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    applyTransition(record, order[index] as SagaRecord['state'], '2026-01-01T00:00:00.000Z', 'advance');
  }
}

test('all required saga states are defined', () => {
  const required = [
    'CREATED',
    'APPROVAL_PENDING',
    'APPROVED',
    'SWAP_PENDING',
    'SWAPPED',
    'DEPOSIT_PENDING',
    'COMPLETED',
    'RETRY_WAIT',
    'COMPENSATING',
    'FAILED',
    'MANUAL_RECOVERY_REQUIRED',
  ];
  assert.deepEqual([...SAGA_STATES].sort(), [...required].sort());
  for (const state of required) {
    assert.ok(state in ALLOWED_TRANSITIONS, `${state} must have a transition entry`);
  }
});

test('legal happy-path transitions are accepted and audit events record from/to', () => {
  const record = newRecord();
  applyTransition(record, 'APPROVAL_PENDING', '2026-01-01T00:00:00.000Z', 'accepted');
  applyTransition(record, 'APPROVED', '2026-01-01T00:00:00.000Z', 'approved');
  applyTransition(record, 'SWAP_PENDING', '2026-01-01T00:00:00.000Z', 'swap');
  applyTransition(record, 'SWAPPED', '2026-01-01T00:00:00.000Z', 'swapped');
  applyTransition(record, 'DEPOSIT_PENDING', '2026-01-01T00:00:00.000Z', 'deposit');
  applyTransition(record, 'COMPLETED', '2026-01-01T00:00:00.000Z', 'done');

  assert.equal(record.state, 'COMPLETED');
  const transitions = record.audit.filter((event) => event.type === 'TRANSITION');
  assert.deepEqual(
    transitions.map((event) => `${event.from}->${event.to}`),
    [
      'CREATED->APPROVAL_PENDING',
      'APPROVAL_PENDING->APPROVED',
      'APPROVED->SWAP_PENDING',
      'SWAP_PENDING->SWAPPED',
      'SWAPPED->DEPOSIT_PENDING',
      'DEPOSIT_PENDING->COMPLETED',
    ],
  );
  assert.equal(record.completedAt, '2026-01-01T00:00:00.000Z');
});

test('illegal transitions are rejected instead of skipping dependency states', () => {
  const record = newRecord();
  assert.throws(
    () => applyTransition(record, 'SWAPPED', '2026-01-01T00:00:00.000Z', 'skip'),
    IllegalTransitionError,
  );
  assert.equal(record.state, 'CREATED');
  assert.equal(record.audit.length, 1);

  advanceTo(record, 'APPROVED');
  assert.throws(
    () => applyTransition(record, 'COMPLETED', '2026-01-01T00:00:00.000Z', 'skip'),
    IllegalTransitionError,
  );
  assert.equal(record.state, 'APPROVED');

  advanceTo(record, 'SWAPPED');
  assert.throws(
    () => applyTransition(record, 'SWAP_PENDING', '2026-01-01T00:00:00.000Z', 'backwards'),
    IllegalTransitionError,
  );
});

test('terminal states have no outgoing transitions', () => {
  for (const terminal of ['COMPLETED', 'FAILED', 'MANUAL_RECOVERY_REQUIRED'] as const) {
    assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
    for (const target of SAGA_STATES) {
      assert.equal(canTransition(terminal, target), false, `${terminal} -> ${target}`);
    }
  }
});

test('RETRY_WAIT can only return to a step pending state, failure, compensation or manual recovery', () => {
  const allowed = ALLOWED_TRANSITIONS.RETRY_WAIT;
  assert.ok(allowed.includes('APPROVAL_PENDING'));
  assert.ok(allowed.includes('SWAP_PENDING'));
  assert.ok(allowed.includes('DEPOSIT_PENDING'));
  assert.ok(!allowed.includes('COMPLETED'));
  assert.ok(!allowed.includes('SWAPPED'));
});

test('a step cannot start before its prerequisite has a verified receipt', () => {
  const record = newRecord();
  advanceTo(record, 'SWAP_PENDING');
  assert.throws(() => assertPrerequisites(record, 'SWAP'), DependencyViolationError);

  // A step marked succeeded without a receipt is still not sufficient.
  record.steps.APPROVE.status = 'SUCCEEDED';
  record.steps.APPROVE.submissionState = 'VERIFIED';
  assert.throws(() => assertPrerequisites(record, 'SWAP'), DependencyViolationError);

  advanceTo(record, 'SWAPPED');
  assert.throws(() => assertPrerequisites(record, 'DEPOSIT'), DependencyViolationError);
});

test('verified receipts satisfy prerequisites for later steps', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  assert.equal(record.state, 'COMPLETED');
  assert.doesNotThrow(() => assertPrerequisites(record, 'SWAP'));
  assert.doesNotThrow(() => assertPrerequisites(record, 'DEPOSIT'));
});

test('saga and step identifiers are stable, unique and idempotency keys are step-scoped', () => {
  const record = newRecord();
  const ids = STEP_NAMES.map((step) => record.steps[step].id);
  const keys = STEP_NAMES.map((step) => record.steps[step].idempotencyKey);
  assert.equal(new Set(ids).size, 3);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(ids, STEP_NAMES.map((step) => `${record.id}:${step}`));
  assert.deepEqual(keys, STEP_NAMES.map((step) => `${record.id}:${step}:v1`));
  assert.equal(newRecord().id === record.id, false);
});

test('invalid retry configuration is rejected (bounded, no infinite loops)', () => {
  const clock = new VirtualClock();
  assert.throws(
    () => createSagaRecord({ request: DEFAULT_REQUEST, retry: { maxAttempts: 0 } }, clock),
    ConfigurationError,
  );
  assert.throws(
    () => createSagaRecord({ request: DEFAULT_REQUEST, retry: { maxAttempts: 21 } }, clock),
    ConfigurationError,
  );
  assert.throws(
    () => createSagaRecord({ request: DEFAULT_REQUEST, retry: { baseDelayMs: 500, maxDelayMs: 100 } }, clock),
    ConfigurationError,
  );
  assert.throws(
    () => createSagaRecord({ request: DEFAULT_REQUEST, sagaId: '../escape' }, clock),
    ConfigurationError,
  );
});

test('invalid request amounts are rejected', () => {
  const clock = new VirtualClock();
  for (const amount of ['0', '-1', 'abc', '1e6', '1.2.3']) {
    assert.throws(
      () => createSagaRecord({ request: { ...DEFAULT_REQUEST, amountIn: amount } }, clock),
      ConfigurationError,
      `amount ${amount} must be rejected`,
    );
  }
  assert.throws(
    () =>
      createSagaRecord(
        { request: { ...DEFAULT_REQUEST, depositToken: 'NOT-THE-SWAP-OUTPUT' } },
        clock,
      ),
    ConfigurationError,
    'DEPOSIT must consume the SWAP output token',
  );
});
