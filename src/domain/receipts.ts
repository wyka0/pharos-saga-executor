import type {
  CompensationAction,
  OnChainReceipt,
  ProofReceipt,
  SagaRecord,
  SimulatedReceipt,
  StepName,
} from './types.js';

export type ReceiptVerification<T extends ProofReceipt = ProofReceipt> =
  | { ok: true; receipt: T }
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

function positiveInteger(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  return BigInt(value) > 0n;
}

function address(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function txHash(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function identityReasons(
  receipt: Record<string, unknown>,
  record: SagaRecord,
  expected: {
    receiptKind: 'STEP' | 'COMPENSATION';
    operation: ProofReceipt['operation'];
    stepId: string;
    idempotencyKey: string;
  },
): string[] {
  const reasons: string[] = [];
  if (receipt.receiptVersion !== 1) reasons.push('receiptVersion must be 1');
  if (receipt.receiptKind !== expected.receiptKind) {
    reasons.push(`receiptKind must be ${expected.receiptKind}`);
  }
  if (receipt.sagaId !== record.id) reasons.push('receipt.sagaId does not match the saga');
  if (receipt.stepId !== expected.stepId) reasons.push('receipt.stepId does not match the step');
  if (receipt.idempotencyKey !== expected.idempotencyKey) {
    reasons.push('receipt.idempotencyKey does not match the persisted key');
  }
  if (receipt.operation !== expected.operation) {
    reasons.push(`receipt.operation must be ${expected.operation}`);
  }
  if (typeof receipt.disclaimer !== 'string' || receipt.disclaimer.trim().length === 0) {
    reasons.push('receipt must carry a disclaimer');
  }
  if (typeof receipt.issuedAt !== 'string' || !Number.isFinite(Date.parse(receipt.issuedAt))) {
    reasons.push('receipt.issuedAt must be a valid ISO timestamp');
  }
  if (!isRecord(receipt.result)) reasons.push('receipt.result is missing');
  return reasons;
}

function simulatedReasons(
  receipt: Record<string, unknown>,
  record: SagaRecord,
  expected: {
    receiptKind: 'STEP' | 'COMPENSATION';
    operation: ProofReceipt['operation'];
    stepId: string;
    idempotencyKey: string;
  },
): string[] {
  const reasons = identityReasons(receipt, record, expected);
  if (receipt.simulated !== true) reasons.push('simulated receipt must have simulated: true');
  if (receipt.network !== 'simulated') reasons.push('simulated receipt network must be "simulated"');
  if (receipt.simulatedStatus !== 'SIMULATED_VERIFIED') {
    reasons.push('receipt.simulatedStatus must be SIMULATED_VERIFIED');
  }
  const ref = receipt.simulatedTxRef;
  if (typeof ref !== 'string' || !/^sim_[a-f0-9]{16,64}$/i.test(ref)) {
    reasons.push('receipt.simulatedTxRef must be a sim_* reference, never a real transaction hash');
  }
  if (typeof receipt.disclaimer !== 'string' || !/SIMULATED/i.test(receipt.disclaimer)) {
    reasons.push('simulated receipt must carry a SIMULATED disclaimer');
  }
  if (!isRecord(receipt.evidence)) {
    reasons.push('receipt.evidence is missing');
  } else {
    if (receipt.evidence.adapter !== 'simulated') reasons.push('receipt.evidence.adapter must be simulated');
    if (receipt.evidence.noOnChainTransaction !== true) {
      reasons.push('receipt.evidence.noOnChainTransaction must be true');
    }
  }
  for (const forbidden of ['txHash', 'transactionHash', 'blockNumber', 'blockHash', 'explorerUrl']) {
    if (forbidden in receipt && receipt[forbidden] !== null && receipt[forbidden] !== undefined) {
      reasons.push(`simulated receipt must not contain ${forbidden}`);
    }
  }
  return reasons;
}

function onChainReasons(
  receipt: Record<string, unknown>,
  record: SagaRecord,
  expected: {
    receiptKind: 'STEP' | 'COMPENSATION';
    operation: ProofReceipt['operation'];
    stepId: string;
    idempotencyKey: string;
  },
): string[] {
  const reasons = identityReasons(receipt, record, expected);
  if (receipt.simulated !== false) reasons.push('on-chain receipt must have simulated: false');
  if (receipt.network !== 'atlantic-testnet') {
    reasons.push('on-chain receipt network must be atlantic-testnet');
  }
  if (receipt.chainId !== 688689) reasons.push('on-chain receipt chainId must be 688689');
  if (!txHash(receipt.txHash)) reasons.push('on-chain receipt txHash must be a 0x-prefixed 32-byte hash');
  if (!positiveInteger(receipt.blockNumber)) reasons.push('receipt.blockNumber must be a positive integer string');
  if (typeof receipt.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)) {
    reasons.push('receipt.blockHash must be a 0x-prefixed 32-byte hash');
  }
  if (receipt.status !== 'SUCCESS') reasons.push('on-chain receipt status must be SUCCESS');
  if (
    typeof receipt.confirmations !== 'number' ||
    !Number.isInteger(receipt.confirmations) ||
    receipt.confirmations < 1
  ) {
    reasons.push('on-chain receipt must have at least one confirmation');
  }
  if (!address(receipt.from)) reasons.push('receipt.from must be an address');
  if (!address(receipt.to)) reasons.push('receipt.to must be an address');
  if (
    typeof receipt.explorerUrl !== 'string' ||
    typeof receipt.txHash !== 'string' ||
    receipt.explorerUrl !== `https://atlantic.pharosscan.xyz/tx/${receipt.txHash}`
  ) {
    reasons.push('receipt.explorerUrl must be the Atlantic explorer URL for the txHash');
  }
  if (typeof receipt.disclaimer !== 'string' || !/ATLANTIC TESTNET|TESTNET/i.test(receipt.disclaimer)) {
    reasons.push('on-chain receipt must state that it is testnet evidence');
  }
  if (!positiveInteger(receipt.gasUsed)) reasons.push('receipt.gasUsed must be a positive integer string');
  if (typeof receipt.effectiveGasPrice !== 'string' || !/^\d+$/.test(receipt.effectiveGasPrice)) {
    reasons.push('receipt.effectiveGasPrice must be an integer string');
  }
  if (!Array.isArray(receipt.postconditions) || receipt.postconditions.length === 0) {
    reasons.push('on-chain receipt must include at least one postcondition');
  } else {
    for (const [index, condition] of receipt.postconditions.entries()) {
      if (
        !isRecord(condition) ||
        typeof condition.name !== 'string' ||
        typeof condition.expected !== 'string' ||
        typeof condition.observed !== 'string'
      ) {
        reasons.push(`postcondition ${index} is malformed`);
      }
    }
  }
  if ('simulatedTxRef' in receipt) reasons.push('on-chain receipt must not contain simulatedTxRef');
  return reasons;
}

function localReasons(
  receipt: Record<string, unknown>,
  record: SagaRecord,
  expected: {
    receiptKind: 'STEP' | 'COMPENSATION';
    operation: ProofReceipt['operation'];
    stepId: string;
    idempotencyKey: string;
  },
): string[] {
  const reasons = identityReasons(receipt, record, expected);
  if (receipt.simulated !== false) reasons.push('local receipt must have simulated: false');
  if (receipt.network !== 'local-anvil') reasons.push('local receipt network must be local-anvil');
  if (receipt.chainId !== 31337) reasons.push('local receipt chainId must be 31337');
  if (!txHash(receipt.txHash)) reasons.push('local receipt txHash must be a 32-byte hash');
  if (!positiveInteger(receipt.blockNumber)) reasons.push('receipt.blockNumber must be positive');
  if (typeof receipt.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)) {
    reasons.push('receipt.blockHash must be a 32-byte hash');
  }
  if (receipt.status !== 'SUCCESS') reasons.push('local receipt status must be SUCCESS');
  if (
    typeof receipt.confirmations !== 'number' ||
    !Number.isInteger(receipt.confirmations) ||
    receipt.confirmations < 1
  ) {
    reasons.push('local receipt must have at least one confirmation');
  }
  if (!address(receipt.from)) reasons.push('receipt.from must be an address');
  if (!address(receipt.to)) reasons.push('receipt.to must be an address');
  if (receipt.explorerUrl !== null) {
    reasons.push('local receipt must not claim an explorer link (explorerUrl must be null)');
  }
  if (typeof receipt.disclaimer !== 'string' || !/LOCAL ANVIL|TEST-ONLY/i.test(receipt.disclaimer)) {
    reasons.push('local receipt must state that it is local test-only evidence');
  }
  if (!positiveInteger(receipt.gasUsed)) reasons.push('receipt.gasUsed must be positive');
  if (typeof receipt.effectiveGasPrice !== 'string' || !/^\d+$/.test(receipt.effectiveGasPrice)) {
    reasons.push('receipt.effectiveGasPrice must be an integer string');
  }
  if (!Array.isArray(receipt.postconditions) || receipt.postconditions.length === 0) {
    reasons.push('local receipt must include at least one postcondition');
  }
  if ('simulatedTxRef' in receipt) reasons.push('local receipt must not contain simulatedTxRef');
  return reasons;
}

function stepResultReasons(
  receipt: Record<string, unknown>,
  record: SagaRecord,
  step: StepName,
): string[] {
  if (!isRecord(receipt.result)) return ['receipt.result is missing'];
  const result = receipt.result;
  const reasons: string[] = [];
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

  return reasons;
}

export function verifyStepReceipt(
  receipt: unknown,
  record: SagaRecord,
  step: StepName,
): ReceiptVerification {
  const stepRecord = record.steps[step];
  const expected = {
    receiptKind: 'STEP' as const,
    operation: step,
    stepId: stepRecord.id,
    idempotencyKey: stepRecord.idempotencyKey,
  };
  if (!isRecord(receipt)) return { ok: false, reasons: ['receipt is missing or not an object'] };

  const reasons =
    receipt.simulated === true
      ? simulatedReasons(receipt, record, expected)
      : receipt.network === 'local-anvil'
        ? localReasons(receipt, record, expected)
        : onChainReasons(receipt, record, expected);
  reasons.push(...stepResultReasons(receipt, record, step));

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, receipt: receipt as unknown as ProofReceipt };
}

export function verifyCompensationReceipt(
  receipt: unknown,
  record: SagaRecord,
  action: CompensationAction,
  compensatesStep: StepName,
): ReceiptVerification {
  const operation: ProofReceipt['operation'] =
    action === 'REVOKE_APPROVAL' ? 'COMPENSATION_REVOKE_APPROVAL' : 'COMPENSATION_UNWIND_SWAP';
  const expected = {
    receiptKind: 'COMPENSATION' as const,
    operation,
    stepId: `${record.id}:COMPENSATION:${action}`,
    idempotencyKey: `${record.id}:COMPENSATION:${action}:v1`,
  };
  if (!isRecord(receipt)) return { ok: false, reasons: ['receipt is missing or not an object'] };

  const reasons =
    receipt.simulated === true
      ? simulatedReasons(receipt, record, expected)
      : receipt.network === 'local-anvil'
        ? localReasons(receipt, record, expected)
        : onChainReasons(receipt, record, expected);

  if (receipt.compensatesStep !== compensatesStep) {
    reasons.push(`compensation must name the original failed step (${compensatesStep})`);
  }
  if (!isRecord(receipt.result)) {
    reasons.push('receipt.result is missing');
  } else if (action === 'REVOKE_APPROVAL') {
    if (receipt.result.allowance !== '0') reasons.push('revoke approval must end with allowance 0');
    if (receipt.result.spender !== record.request.spender) reasons.push('revoke approval spender mismatch');
  } else {
    if (receipt.result.tokenIn !== record.request.toToken) reasons.push('unwind swap tokenIn mismatch');
    if (receipt.result.tokenOut !== record.request.fromToken) reasons.push('unwind swap tokenOut mismatch');
    if (!positiveAmount(receipt.result.amountIn)) reasons.push('unwind swap amountIn must be positive');
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, receipt: receipt as unknown as ProofReceipt };
}

export function isSimulatedReceipt(receipt: ProofReceipt): receipt is SimulatedReceipt {
  return receipt.simulated === true;
}

export function isOnChainReceipt(receipt: ProofReceipt): receipt is OnChainReceipt {
  return receipt.simulated === false;
}
