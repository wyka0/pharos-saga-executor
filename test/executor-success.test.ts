import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStepReceipt } from '../src/domain/receipts.js';
import { makeHarness, submittedSteps } from './helpers.js';

test('successful three-step execution completes with verified simulated receipts', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();

  assert.equal(record.state, 'COMPLETED');
  assert.ok(record.completedAt);
  assert.equal(record.failure, null);
  assert.equal(record.compensation, null);
  assert.deepEqual(submittedSteps(harness.calls), ['APPROVE', 'SWAP', 'DEPOSIT']);

  for (const step of ['APPROVE', 'SWAP', 'DEPOSIT'] as const) {
    const stepRecord = record.steps[step];
    assert.equal(stepRecord.status, 'SUCCEEDED', `${step} status`);
    assert.equal(stepRecord.submissionState, 'VERIFIED', `${step} submission`);
    assert.equal(stepRecord.attempts, 1, `${step} attempts`);
    assert.ok(stepRecord.receipt, `${step} receipt must be persisted`);
    assert.equal(stepRecord.receipt?.simulated, true);
    assert.equal(stepRecord.receipt?.network, 'simulated');
    assert.match(stepRecord.receipt?.simulatedTxRef ?? '', /^sim_[a-f0-9]{16,64}$/);
    assert.match(stepRecord.receipt?.disclaimer ?? '', /SIMULATED/i);
    assert.equal(stepRecord.receipt?.evidence.noOnChainTransaction, true);
    assert.equal('txHash' in (stepRecord.receipt ?? {}), false);
    assert.equal('transactionHash' in (stepRecord.receipt ?? {}), false);
    assert.equal(stepRecord.errors.length, 0);
  }

  assert.equal(
    record.steps.DEPOSIT.receipt?.result.amountIn,
    record.steps.SWAP.receipt?.result.amountOut,
    'DEPOSIT must consume the exact verified SWAP output',
  );
  assert.equal(record.steps.APPROVE.receipt?.result.allowance, record.request.amountIn);
  assert.equal(record.steps.APPROVE.receipt?.result.spender, record.request.spender);
});

test('each receipt passes the independent verifier before the state machine advances', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  for (const step of ['APPROVE', 'SWAP', 'DEPOSIT'] as const) {
    const verification = verifyStepReceipt(record.steps[step].receipt, record, step);
    assert.equal(verification.ok, true, `${step} verification must pass`);
  }
  assert.equal(record.audit.filter((event) => event.type === 'RECEIPT_VERIFIED').length, 3);
  assert.equal(record.audit.filter((event) => event.type === 'STEP_SUCCEEDED').length, 3);
  assert.equal(record.audit.filter((event) => event.type === 'STEP_ATTEMPT').length, 3);
});

test('successful run records the exact legal state sequence', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start();
  const transitions = record.audit
    .filter((event) => event.type === 'TRANSITION')
    .map((event) => `${event.from}->${event.to}`);
  assert.deepEqual(transitions, [
    'CREATED->APPROVAL_PENDING',
    'APPROVAL_PENDING->APPROVED',
    'APPROVED->SWAP_PENDING',
    'SWAP_PENDING->SWAPPED',
    'SWAPPED->DEPOSIT_PENDING',
    'DEPOSIT_PENDING->COMPLETED',
  ]);
});

test('decimal amounts propagate through SWAP and DEPOSIT deterministically', async (t) => {
  const harness = await makeHarness(t);
  const record = await harness.start({ request: { ...{ ...recordRequest() }, amountIn: '12.5' } });
  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.steps.APPROVE.receipt?.result.allowance, '12.5');
  assert.equal(record.steps.SWAP.receipt?.result.amountIn, '12.5');
  assert.equal(record.steps.SWAP.receipt?.result.amountOut, '12.4375');
  assert.equal(record.steps.DEPOSIT.receipt?.result.amountIn, '12.4375');
  assert.ok(Number(record.steps.DEPOSIT.receipt?.result.shares) > 0);
});

function recordRequest() {
  return {
    owner: 'sim:test-account',
    fromToken: 'PROS',
    toToken: 'USDC',
    depositToken: 'USDC',
    amountIn: '100',
    spender: 'sim:router',
    protocol: 'sim:vault',
    depositTarget: 'sim:vault',
  };
}
