import type {
  CompensationAction,
  SagaRecord,
  SimulatedReceipt,
  StepName,
} from './types.js';

export type ReceiptVerification =
  | { ok: true; receipt: SimulatedReceipt }
  | { ok: false; reasons: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveAmount(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function amountAtLeast(value: unknown, minimum: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Number(value);
  const min = Number(minimum);
  return Number.isFinite(parsed) && Number.isFinite(min) && parsed + 1e-9 >= min;
}

function commonReasons(
  receipt: unknown,
  record: SagaRecord,
  expected: {
    receiptKind: 'STEP' | 'COMPENSATION';
    operation: SimulatedReceipt['operation'];
    stepId: string;
    idempotencyKey: string;
  },
): { reasons: string[]; value: Record<string, unknown> | null } {
  const reasons: string[] = [];
  if (!isRecord(receipt)) {
    return { reasons: ['receipt is missing or not an object'], value: null };
  }

  if (receipt.receiptVersion !== 1) reasons.push('receiptVersion must be 1');
  if (receipt.receiptKind !== expected.receiptKind) {
    reasons.push(`receiptKind must be ${expected.receiptKind}`);
  }
  if (receipt.simulated !== true) reasons.push('receipt.simulated must be true');
  if (receipt.network !== 'simulated') reasons.push('receipt.network must be "simulated"');
  if (receipt.simulatedStatus !== 'SIMULATED_VERIFIED') {
    reasons.push('receipt.simulatedStatus must be SIMULATED_VERIFIED');
  }
  if (receipt.sagaId !== record.id) reasons.push('receipt.sagaId does not match the saga');
  if (receipt.stepId !== expected.stepId) reasons.push('receipt.stepId does not match the step');
  if (receipt.idempotencyKey !== expected.idempotencyKey) {
    reasons.push('receipt.idempotencyKey does not match the persisted key');
  }
  if (receipt.operation !== expected.operation) {
    reasons.push(`receipt.operation must be ${expected.operation}`);
  }

  const ref = receipt.simulatedTxRef;
  if (typeof ref !== 'string' || !/^sim_[a-f0-9]{16,64}$/i.test(ref)) {
    reasons.push('receipt.simulatedTxRef must be a sim_* reference, never a real transaction hash');
  }

  if (typeof receipt.disclaimer !== 'string' || !/SIMULATED/i.test(receipt.disclaimer)) {
    reasons.push('receipt must carry a SIMULATED disclaimer');
  }
  if (!isRecord(receipt.evidence)) {
    reasons.push('receipt.evidence is missing');
  } else {
    if (receipt.evidence.adapter !== 'simulated') reasons.push('receipt.evidence.adapter must be simulated');
    if (receipt.evidence.noOnChainTransaction !== true) {
      reasons.push('receipt.evidence.noOnChainTransaction must be true');
    }
  }

  // A simulated receipt must not masquerade as live blockchain evidence.
  for (const forbidden of ['txHash', 'transactionHash', 'blockNumber', 'blockHash', 'explorerUrl']) {
    if (forbidden in receipt && receipt[forbidden] !== null && receipt[forbidden] !== undefined) {
      reasons.push(`receipt must not contain ${forbidden} for the simulated adapter`);
    }
  }

  if (typeof receipt.issuedAt !== 'string' || !Number.isFinite(Date.parse(receipt.issuedAt))) {
    reasons.push('receipt.issuedAt must be a valid ISO timestamp');
  }
  if (!isRecord(receipt.result)) reasons.push('receipt.result is missing');

  return { reasons, value: receipt };
}

export function verifyStepReceipt(
  receipt: unknown,
  record: SagaRecord,
  step: StepName,
): ReceiptVerification {
  const stepRecord = record.steps[step];
  const { reasons, value } = commonReasons(receipt, record, {
    receiptKind: 'STEP',
    operation: step,
    stepId: stepRecord.id,
    idempotencyKey: stepRecord.idempotencyKey,
  });
  if (!value || !isRecord(value.result)) return { ok: false, reasons };

  const result = value.result;
  if (typeof result.tokenIn !== 'string' || result.tokenIn.length === 0) {
    reasons.push('result.tokenIn is missing');
  }
  if (!positiveAmount(result.amountIn)) reasons.push('result.amountIn must be a positive decimal string');

  if (step === 'APPROVE') {
    if (result.tokenIn !== record.request.fromToken) reasons.push('approval tokenIn mismatch');
    if (!amountAtLeast(result.allowance, record.request.amountIn)) {
      reasons.push('approval allowance must cover request.amountIn');
    }
    if (result.spender !== record.request.spender) reasons.push('approval spender mismatch');
  }

  if (step === 'SWAP') {
    if (result.tokenIn !== record.request.fromToken) reasons.push('swap tokenIn mismatch');
    if (result.tokenOut !== record.request.toToken) reasons.push('swap tokenOut mismatch');
    if (!positiveAmount(result.amountOut)) reasons.push('swap amountOut must be positive');
    if (Math.abs(Number(result.amountIn) - Number(record.request.amountIn)) > 1e-9) {
      reasons.push('swap amountIn does not match the request');
    }
  }

  if (step === 'DEPOSIT') {
    if (result.tokenIn !== record.request.depositToken) reasons.push('deposit tokenIn mismatch');
    if (!positiveAmount(result.shares)) reasons.push('deposit shares must be positive');
    if (result.protocol !== record.request.protocol) reasons.push('deposit protocol mismatch');
  }

  return reasons.length === 0
    ? { ok: true, receipt: value as unknown as SimulatedReceipt }
    : { ok: false, reasons };
}

export function verifyCompensationReceipt(
  receipt: unknown,
  record: SagaRecord,
  action: CompensationAction,
  compensatesStep: StepName,
): ReceiptVerification {
  const operation =
    action === 'REVOKE_APPROVAL' ? 'COMPENSATION_REVOKE_APPROVAL' : 'COMPENSATION_UNWIND_SWAP';
  const expectedId = `${record.id}:COMPENSATION:${action}:v1`;
  const { reasons, value } = commonReasons(receipt, record, {
    receiptKind: 'COMPENSATION',
    operation,
    stepId: `${record.id}:COMPENSATION:${action}`,
    idempotencyKey: expectedId,
  });
  if (!value || !isRecord(value.result)) return { ok: false, reasons };

  if (value.compensatesStep !== compensatesStep) {
    reasons.push(`compensation must name the original failed step (${compensatesStep})`);
  }
  const result = value.result;
  if (action === 'REVOKE_APPROVAL') {
    if (result.allowance !== '0') reasons.push('revoke approval must end with allowance 0');
    if (result.spender !== record.request.spender) reasons.push('revoke approval spender mismatch');
  } else {
    if (result.tokenIn !== record.request.toToken) reasons.push('unwind swap tokenIn mismatch');
    if (result.tokenOut !== record.request.fromToken) reasons.push('unwind swap tokenOut mismatch');
    if (!positiveAmount(result.amountIn)) reasons.push('unwind swap amountIn must be positive');
  }

  return reasons.length === 0
    ? { ok: true, receipt: value as unknown as SimulatedReceipt }
    : { ok: false, reasons };
}
