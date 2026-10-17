import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChainAdapter,
  CompensationContext,
  ReconcileContext,
  SubmitContext,
} from '../src/adapters/types.js';
import { makeScenario } from '../src/domain/scenarios.js';
import type { SimulatedReceipt, StepName } from '../src/domain/types.js';
import { makeHarness, submittedSteps } from './helpers.js';

class CorruptCompensationAdapter implements ChainAdapter {
  readonly id: string;
  readonly simulated: boolean;

  constructor(private readonly inner: ChainAdapter) {
    this.id = inner.id;
    this.simulated = inner.simulated;
  }

  submit(step: StepName, context: SubmitContext): Promise<SimulatedReceipt> {
    return this.inner.submit(step, context);
  }

  reconcile(step: StepName, context: ReconcileContext): ReturnType<ChainAdapter['reconcile']> {
    return this.inner.reconcile(step, context);
  }

  supportsCompensation(action: Parameters<ChainAdapter['supportsCompensation']>[0]): boolean {
    return this.inner.supportsCompensation(action);
  }

  async compensate(context: CompensationContext): ReturnType<ChainAdapter['compensate']> {
    const result = await this.inner.compensate(context);
    if (!result.receipt) return result;
    return {
      ...result,
      receipt: { ...result.receipt, simulated: false as unknown as true },
    };
  }
}

test('APPROVE permanent failure halts before SWAP and needs no compensation', async (t) => {
  const scenario = makeScenario('approve-permanent', { approve: { permanentFailure: true } });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'FAILED');
  assert.equal(record.failure?.step, 'APPROVE');
  assert.equal(record.failure?.kind, 'PERMANENT');
  assert.equal(record.steps.APPROVE.status, 'FAILED');
  assert.equal(record.steps.SWAP.attempts, 0);
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE']);
  assert.equal(record.compensation?.status, 'NOT_REQUIRED');
  assert.equal(record.compensation?.action, 'NONE');
  assert.ok(record.audit.some((event) => event.type === 'SAGA_FAILED'));
  assert.equal(harness.calls.some((call) => call.kind === 'compensate'), false);
});

test('SWAP permanent failure executes configured simulated approval revocation', async (t) => {
  const scenario = makeScenario('swap-permanent', { swap: { permanentFailure: true } });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'FAILED');
  assert.equal(record.steps.APPROVE.status, 'SUCCEEDED');
  assert.equal(record.steps.SWAP.status, 'FAILED');
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.equal(record.failure?.step, 'SWAP');
  assert.equal(record.compensation?.action, 'REVOKE_APPROVAL');
  assert.equal(record.compensation?.status, 'SUCCEEDED');
  assert.equal(record.compensation?.receipt?.simulated, true);
  assert.match(record.compensation?.receipt?.simulatedTxRef ?? '', /^sim_/);
  assert.deepEqual(
    harness.calls.filter((call) => call.kind === 'compensate').map((call) => call.action),
    ['REVOKE_APPROVAL'],
  );
  assert.ok(record.audit.some((event) => event.type === 'COMPENSATION_SUCCEEDED'));
  assert.ok(record.audit.some((event) => event.type === 'SAGA_FAILED'));
  assert.equal(record.completedAt, null);
});

test('compensation failure is recorded separately and leads to manual recovery', async (t) => {
  const scenario = makeScenario('swap-compensation-failure', {
    swap: { permanentFailure: true },
    compensation: { revokeApproval: 'FAILURE' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.failure?.step, 'SWAP');
  assert.equal(record.compensation?.status, 'FAILED');
  assert.equal(record.compensation?.error?.kind, 'PERMANENT');
  assert.equal(record.compensation?.error?.code, 'SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL');
  assert.ok(record.audit.some((event) => event.type === 'STEP_FAILED'));
  assert.ok(record.audit.some((event) => event.type === 'COMPENSATION_FAILED'));
  assert.ok(record.audit.some((event) => event.type === 'MANUAL_RECOVERY_REQUIRED'));
  assert.equal(record.steps.DEPOSIT.attempts, 0);
});

test('SWAP failure with compensation disabled goes straight to manual recovery', async (t) => {
  const scenario = makeScenario('swap-no-compensation', { swap: { permanentFailure: true } });
  const harness = await makeHarness(t, {
    scenario,
    compensationPolicy: { onSwapFailure: 'NONE' },
  });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.compensation?.action, 'NONE');
  assert.equal(record.compensation?.status, 'SKIPPED');
  assert.equal(harness.calls.some((call) => call.kind === 'compensate'), false);
  assert.ok(record.audit.some((event) => event.type === 'COMPENSATION_UNAVAILABLE'));
});

test('DEPOSIT permanent failure after SWAP executes configured simulated unwind', async (t) => {
  const scenario = makeScenario('deposit-permanent', { deposit: { permanentFailure: true } });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'FAILED');
  assert.equal(record.steps.APPROVE.status, 'SUCCEEDED');
  assert.equal(record.steps.SWAP.status, 'SUCCEEDED');
  assert.equal(record.steps.DEPOSIT.status, 'FAILED');
  assert.equal(record.failure?.step, 'DEPOSIT');
  assert.equal(record.compensation?.action, 'SIMULATED_UNWIND_SWAP');
  assert.equal(record.compensation?.status, 'SUCCEEDED');
  assert.equal(record.compensation?.receipt?.simulated, true);
  assert.deepEqual(
    harness.calls.filter((call) => call.kind === 'compensate').map((call) => call.action),
    ['SIMULATED_UNWIND_SWAP'],
  );
  assert.equal(record.completedAt, null);
});

test('DEPOSIT compensation failure preserves both failures and stops for manual recovery', async (t) => {
  const scenario = makeScenario('deposit-compensation-failure', {
    deposit: { permanentFailure: true },
    compensation: { unwindSwap: 'FAILURE' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.failure?.step, 'DEPOSIT');
  assert.equal(record.compensation?.status, 'FAILED');
  assert.equal(record.compensation?.error?.code, 'SIMULATED_COMPENSATION_FAILED_SIMULATED_UNWIND_SWAP');
  assert.equal(record.steps.SWAP.status, 'SUCCEEDED');
});

test('DEPOSIT failure with no safe compensation stops for manual recovery', async (t) => {
  const scenario = makeScenario('deposit-no-compensation', { deposit: { permanentFailure: true } });
  const harness = await makeHarness(t, {
    scenario,
    compensationPolicy: { onDepositFailure: 'NONE' },
  });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.compensation?.status, 'SKIPPED');
  assert.equal(harness.calls.some((call) => call.kind === 'compensate'), false);
});

test('adapter-reported unavailable compensation stops for manual recovery without a rollback claim', async (t) => {
  const scenario = makeScenario('deposit-compensation-unavailable', {
    deposit: { permanentFailure: true },
    compensation: { unwindSwap: 'UNAVAILABLE' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.compensation?.status, 'UNAVAILABLE');
  assert.equal(record.compensation?.receipt, null);
  assert.equal(harness.calls.some((call) => call.kind === 'compensate'), false);
  assert.ok(record.audit.some((event) => event.type === 'COMPENSATION_UNAVAILABLE'));
});

test('compensation receipt verification failure is a separate failure and needs manual recovery', async (t) => {
  const scenario = makeScenario('deposit-corrupt-compensation', {
    deposit: { permanentFailure: true },
  });
  const harness = await makeHarness(t, {
    scenario,
    adapterFactory: (inner) => new CorruptCompensationAdapter(inner),
  });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.failure?.step, 'DEPOSIT');
  assert.equal(record.compensation?.status, 'FAILED');
  assert.equal(record.compensation?.error?.kind, 'VERIFICATION');
  assert.ok(record.audit.some((event) => event.type === 'COMPENSATION_FAILED'));
});

test('transient retry exhaustion on DEPOSIT also applies the compensation policy', async (t) => {
  const scenario = makeScenario('deposit-transient-exhaustion', {
    deposit: { transientFailures: 3 },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'FAILED');
  assert.equal(record.failure?.step, 'DEPOSIT');
  assert.equal(record.failure?.kind, 'TRANSIENT');
  assert.equal(record.failure?.retryExhausted, true);
  assert.equal(record.steps.DEPOSIT.attempts, 3);
  assert.equal(record.compensation?.status, 'SUCCEEDED');
});

test('an unknown submission outcome is never retried and ends in manual recovery', async (t) => {
  const scenario = makeScenario('swap-unknown', {
    swap: { unknownOutcome: 'UNRESOLVABLE' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.failure?.kind, 'UNKNOWN_OUTCOME');
  assert.equal(record.steps.SWAP.attempts, 1);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_SCHEDULED').length, 0);
  assert.equal(record.compensation, null);
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP']);
  assert.equal(harness.calls.filter((call) => call.kind === 'reconcile').length, 1);
});

test('a resolvable unknown submission is reconciled without resubmitting and the saga completes', async (t) => {
  const scenario = makeScenario('swap-unknown-resolvable', {
    swap: { unknownOutcome: 'RESOLVABLE' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.steps.SWAP.attempts, 1);
  assert.equal(record.steps.SWAP.receipt?.simulated, true);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'DEPOSIT']);
  assert.equal(harness.calls.filter((call) => call.kind === 'reconcile').length, 1);
  assert.ok(
    record.audit.some(
      (event) => event.type === 'RECONCILIATION_RESULT' && event.data.found === true,
    ),
  );
  assert.ok(
    record.audit.some(
      (event) => event.type === 'RECEIPT_VERIFIED' && event.data.reconciled === true,
    ),
  );
});

test('a receipt that fails verification halts without advancing or retrying', async (t) => {
  const scenario = makeScenario('swap-verification-fault', {
    swap: { verificationFault: 'MISMATCHED_STEP' },
  });
  const harness = await makeHarness(t, { scenario });
  const record = await harness.start();

  assert.equal(record.state, 'MANUAL_RECOVERY_REQUIRED');
  assert.equal(record.failure?.kind, 'VERIFICATION');
  assert.equal(record.steps.SWAP.status, 'FAILED');
  assert.equal(record.steps.SWAP.submissionState, 'UNKNOWN_OUTCOME');
  assert.notEqual(record.steps.SWAP.invalidReceiptEvidence, null);
  assert.equal(record.steps.DEPOSIT.attempts, 0);
  assert.equal(record.audit.filter((event) => event.type === 'RETRY_SCHEDULED').length, 0);
  assert.ok(record.audit.some((event) => event.type === 'RECEIPT_VERIFICATION_FAILED'));
});
