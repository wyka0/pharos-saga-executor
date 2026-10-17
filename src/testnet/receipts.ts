import type {
  OnChainPostcondition,
  OnChainReceipt,
  ProofReceipt,
  SagaRecord,
  StepName,
} from '../domain/types.js';
import type { RpcReceipt } from './client.js';
import { explorerTxUrl } from './config.js';
import type { PlannedTransaction, TransactionPlan } from './plan.js';
import { formatUnits, parseUnits } from './units.js';

export const ONCHAIN_DISCLAIMER =
  'REAL PHAROS ATLANTIC TESTNET TRANSACTION (chainId 688689) - testnet funds only. ' +
  'This is on-chain testnet evidence, not a mainnet transaction and not a simulation.';

export function buildStepReceipt(input: {
  record: SagaRecord;
  step: StepName;
  plan: TransactionPlan;
  transaction: PlannedTransaction;
  rpc: RpcReceipt;
  postconditions: OnChainPostcondition[];
  allowance: bigint | null;
  observedAt: string;
}): OnChainReceipt {
  const { record, step, transaction, rpc, postconditions, allowance, observedAt } = input;
  const token = transaction.tokenSymbol ?? record.request.fromToken;
  return {
    receiptVersion: 1,
    receiptKind: 'STEP',
    simulated: false,
    network: 'atlantic-testnet',
    chainId: 688689,
    disclaimer: ONCHAIN_DISCLAIMER,
    txHash: rpc.transactionHash,
    blockNumber: rpc.blockNumber,
    blockHash: rpc.blockHash,
    status: 'SUCCESS',
    confirmations: Math.max(1, rpc.confirmations),
    from: rpc.from,
    to: rpc.to ?? transaction.to,
    explorerUrl: explorerTxUrl(rpc.transactionHash),
    sagaId: record.id,
    stepId: record.steps[step].id,
    idempotencyKey: record.steps[step].idempotencyKey,
    operation: step,
    issuedAt: observedAt,
    result: {
      tokenIn: token,
      tokenOut: '',
      amountIn: record.request.amountIn,
      amountOut: '0',
      allowance: allowance === null ? null : formatUnits(allowance, transaction.decimals ?? 18),
      spender: transaction.spender,
      shares: null,
      protocol: null,
    },
    gasUsed: rpc.gasUsed,
    effectiveGasPrice: rpc.effectiveGasPrice,
    postconditions,
  };
}

export function buildRevokeReceipt(input: {
  record: SagaRecord;
  originalStep: StepName;
  plan: TransactionPlan;
  transaction: PlannedTransaction;
  rpc: RpcReceipt;
  postconditions: OnChainPostcondition[];
  allowance: bigint;
  observedAt: string;
}): OnChainReceipt {
  const { record, originalStep, transaction, rpc, postconditions, allowance, observedAt } = input;
  return {
    receiptVersion: 1,
    receiptKind: 'COMPENSATION',
    simulated: false,
    network: 'atlantic-testnet',
    chainId: 688689,
    disclaimer: ONCHAIN_DISCLAIMER,
    txHash: rpc.transactionHash,
    blockNumber: rpc.blockNumber,
    blockHash: rpc.blockHash,
    status: 'SUCCESS',
    confirmations: Math.max(1, rpc.confirmations),
    from: rpc.from,
    to: rpc.to ?? transaction.to,
    explorerUrl: explorerTxUrl(rpc.transactionHash),
    sagaId: record.id,
    stepId: `${record.id}:COMPENSATION:REVOKE_APPROVAL`,
    idempotencyKey: `${record.id}:COMPENSATION:REVOKE_APPROVAL:v1`,
    operation: 'COMPENSATION_REVOKE_APPROVAL',
    issuedAt: observedAt,
    result: {
      tokenIn: transaction.tokenSymbol ?? record.request.fromToken,
      tokenOut: '',
      amountIn: record.request.amountIn,
      amountOut: '0',
      allowance: formatUnits(allowance, transaction.decimals ?? 18),
      spender: transaction.spender,
      shares: null,
      protocol: null,
    },
    gasUsed: rpc.gasUsed,
    effectiveGasPrice: rpc.effectiveGasPrice,
    postconditions,
    compensatesStep: originalStep,
  };
}

export interface AllowancePostconditionResult {
  ok: boolean;
  conditions: OnChainPostcondition[];
  allowance: bigint | null;
  error: string | null;
}

/**
 * Data-only check. It verifies the receipt fields plus the allowance
 * postcondition. Any read error is reported as a failure, never retried here,
 * because this runs after a broadcast.
 */
export async function checkAllowancePostconditions(input: {
  rpc: RpcReceipt;
  planTransaction: PlannedTransaction;
  wallet: string;
  expectedMinimum: bigint | null;
  expectedExactZero: boolean;
  readAllowance: () => Promise<bigint>;
}): Promise<AllowancePostconditionResult> {
  const conditions: OnChainPostcondition[] = [];
  let allowance: bigint | null = null;
  let error: string | null = null;

  conditions.push({
    name: 'receipt.status',
    expected: 'success',
    observed: input.rpc.status,
  });
  conditions.push({
    name: 'transaction.to',
    expected: input.planTransaction.to.toLowerCase(),
    observed: (input.rpc.to ?? '').toLowerCase(),
  });
  conditions.push({
    name: 'transaction.from',
    expected: input.wallet.toLowerCase(),
    observed: input.rpc.from.toLowerCase(),
  });

  try {
    allowance = await input.readAllowance();
    conditions.push({
      name: 'allowance',
      expected: input.expectedExactZero
        ? '0'
        : `>= ${input.expectedMinimum?.toString() ?? '0'}`,
      observed: allowance.toString(),
    });
  } catch (readError) {
    error = readError instanceof Error ? readError.message : String(readError);
    conditions.push({ name: 'allowance', expected: 'readable', observed: `error: ${error}` });
  }

  const receiptOk =
    input.rpc.status === 'success' &&
    (input.rpc.to ?? '').toLowerCase() === input.planTransaction.to.toLowerCase() &&
    input.rpc.from.toLowerCase() === input.wallet.toLowerCase();
  const allowanceOk =
    allowance !== null &&
    (input.expectedExactZero
      ? allowance === 0n
      : input.expectedMinimum !== null && allowance >= input.expectedMinimum);

  return { ok: receiptOk && allowanceOk, conditions, allowance, error };
}

export function amountFromRecord(record: SagaRecord, decimals: number): bigint {
  return parseUnits(record.request.amountIn, decimals);
}

export function isConfirmedReceipt(receipt: ProofReceipt | null): receipt is OnChainReceipt {
  return receipt !== null && receipt.simulated === false && receipt.status === 'SUCCESS';
}
