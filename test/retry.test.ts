import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError } from '../src/domain/errors.js';
import { RetryPolicy, createSeededJitter } from '../src/domain/retry.js';
import { makeScenario } from '../src/domain/scenarios.js';
import { makeHarness, submittedSteps } from './helpers.js';

const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, backoffFactor: 2 };

test('exponential backoff is bounded and uses deterministic equal jitter', () => {
  const policy = new RetryPolicy({ maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 1_000, backoffFactor: 2 });
  const jitter = () => 0.5;
  const input = { sagaId: 'saga_x', step: 'DEPOSIT' as const };

  assert.equal(policy.schedule(1, jitter, input).delayMs, 75);
  assert.equal(policy.schedule(2, jitter, input).delayMs, 150);
  assert.equal(policy.schedule(3, jitter, input).delayMs, 300);
  assert.equal(policy.schedule(4, jitter, input).delayMs, 600);
  assert.equal(policy.schedule(5, jitter, input).delayMs, 750, 'raw 1600 is capped at 1000');
  assert.equal(policy.schedule(6, jitter, input).delayMs, 750);

  assert.equal(policy.schedule(1, () => 0, input).delayMs, 50);
  assert.equal(policy.schedule(1, () => 0.999, input).delayMs, 100);
  assert.equal(policy.schedule(1, () => 42, input).delayMs, 100, 'jitter is clamped');
});

test('seeded jitter is reproducible and stays in [0, 1)', () => {
  const source = createSeededJitter('test-seed');
  const input = { sagaId: 'saga_1', step: 'SWAP' as const, attempt: 2 };
  const first = source(input);
  const second = source({ ...input });
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 1);
  const other = source({ ...input, attempt: 3 });
  assert.notEqual(first, other);
});

test('invalid retry policy values are rejected', () => {
  assert.throws(() => new RetryPolicy({ maxAttempts: 0 }), ConfigurationError);
  assert.throws(() => new RetryPolicy({ maxAttempts: 1.5 }), ConfigurationError);
  assert.throws(() => new RetryPolicy({ baseDelayMs: 100, maxDelayMs: 50 }), ConfigurationError);
  assert.throws(() => new RetryPolicy({ backoffFactor: 0 }), ConfigurationError);
});

test('a transient SWAP failure is retried and then succeeds', async (t) => {
  const scenario = makeScenario('retry-swap-once', { swap: { transientFailures: 1 } });
  const harness = await makeHarness(t, { scenario, retry });
  const record = await harness.start();

  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.steps.SWAP.attempts, 2);
  assert.equal(record.steps.SWAP.status, 'SUCCEEDED');
  assert.equal(record.steps.SWAP.errors.length, 1);
  assert.equal(record.steps.SWAP.errors[0]?.kind, 'TRANSIENT');
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_SCHEDULED').length, 1);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_EXHAUSTED').length, 0);
  assert.equal(harness.clock.now().toISOString(), '2026-01-01T00:00:00.075Z');
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'SWAP', 'DEPOSIT']);

  const retryEvent = record.audit.find((event) => event.type === 'RETRY_SCHEDULED');
  assert.equal(retryEvent?.data.delayMs, 75);
  assert.equal(retryEvent?.data.jitter, 0.5);
  assert.ok(
    record.audit.some(
      (event) => event.type === 'TRANSITION' && event.from === 'SWAP_PENDING' && event.to === 'RETRY_WAIT',
    ),
  );
  assert.ok(
    record.audit.some(
      (event) => event.type === 'TRANSITION' && event.from === 'RETRY_WAIT' && event.to === 'SWAP_PENDING',
    ),
  );
});

test('retry exhaustion stops APPROVE and never starts SWAP', async (t) => {
  const scenario = makeScenario('approve-transient-exhaustion', {
    approve: { transientFailures: 3 },
  });
  const harness = await makeHarness(t, { scenario, retry });
  const record = await harness.start();

  assert.equal(record.state, 'FAILED');
  assert.equal(record.steps.APPROVE.status, 'FAILED');
  assert.equal(record.steps.APPROVE.attempts, 3);
  assert.equal(record.steps.SWAP.attempts, 0);
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'APPROVE', 'APPROVE']);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_SCHEDULED').length, 2);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_EXHAUSTED').length, 1);
  assert.equal(record.failure?.step, 'APPROVE');
  assert.equal(record.failure?.kind, 'TRANSIENT');
  assert.equal(record.failure?.retryExhausted, true);
  assert.equal(record.compensation?.status, 'NOT_REQUIRED');
  assert.equal(harness.clock.now().toISOString(), '2026-01-01T00:00:00.225Z');
});

test('maximum retry count is configurable and honored exactly', async (t) => {
  const scenario = makeScenario('deposit-retry-four', {
    deposit: { transientFailures: 4 },
  });
  const harness = await makeHarness(t, {
    scenario,
    retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 1_000, backoffFactor: 2 },
  });
  const record = await harness.start();

  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.steps.DEPOSIT.attempts, 5);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_SCHEDULED').length, 4);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_EXHAUSTED').length, 0);
  assert.equal(record.steps.DEPOSIT.receipt?.simulated, true);
});

test('retry delays never exceed maxDelayMs', async (t) => {
  const scenario = makeScenario('deposit-capped-retry', {
    deposit: { transientFailures: 3 },
  });
  const harness = await makeHarness(t, {
    scenario,
    retry: { maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 80, backoffFactor: 4 },
  });
  const record = await harness.start();
  assert.equal(record.state, 'COMPLETED');
  const delays = record.audit
    .filter((event) => event.type === 'RETRY_SCHEDULED')
    .map((event) => Number(event.data.delayMs));
  assert.deepEqual(delays, [38, 60, 60]);
  assert.ok(delays.every((delay) => delay <= 80));
});
