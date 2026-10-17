import { createHash } from 'node:crypto';
import { PermanentStepError, TransientStepError, UnknownSubmissionOutcomeError } from '../domain/errors.js';
import {
  SIMULATED_DISCLAIMER,
  type AdapterScenario,
  type CompensationAction,
  type ReceiptResult,
  type SagaRecord,
  type SimulatedReceipt,
  type StepFaults,
  type StepName,
} from '../domain/types.js';
import { SimulatedLedger } from '../persistence/ledger.js';
import type {
  ChainAdapter,
  CompensationContext,
  CompensationResult,
  ReconcileContext,
  ReconcileResult,
  SubmitContext,
} from './types.js';

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function amount(value: number): string {
  const rounded = round6(value);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function refFor(seed: string): string {
  return `sim_${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;
}

function resultBase(record: SagaRecord): ReceiptResult {
  return {
    tokenIn: record.request.fromToken,
    tokenOut: record.request.toToken,
    amountIn: record.request.amountIn,
    amountOut: '0',
    allowance: null,
    spender: null,
    shares: null,
    protocol: null,
  };
}

function faultKey(step: StepName): 'approve' | 'swap' | 'deposit' {
  return step === 'APPROVE' ? 'approve' : step === 'SWAP' ? 'swap' : 'deposit';
}

/**
 * Deterministic simulated adapter. It never opens a socket, never reads a key,
 * and every receipt is branded SIMULATED. Its ledger is the idempotency record
 * used to reconcile a crash between "submission" and state persistence.
 */
export class SimulatedAdapter implements ChainAdapter {
  readonly id = 'simulated';
  readonly simulated = true;
  private readonly ledger: SimulatedLedger;
  private readonly scenario: AdapterScenario;

  constructor(ledger: SimulatedLedger, scenario: AdapterScenario) {
    this.ledger = ledger;
    this.scenario = scenario;
  }

  private faults(step: StepName): StepFaults {
    return this.scenario[faultKey(step)];
  }

  private buildStepReceipt(context: SubmitContext): SimulatedReceipt {
    const { saga, step, stepRecord, clock } = context;
    const request = saga.request;
    const result = resultBase(saga);

    if (step === 'APPROVE') {
      result.allowance = request.amountIn;
      result.spender = request.spender;
    } else if (step === 'SWAP') {
      result.amountOut = amount(Number(request.amountIn) * 0.995);
    } else {
      const priorSwap = saga.steps.SWAP.receipt;
      const swapped = priorSwap?.result.amountOut ?? amount(Number(request.amountIn) * 0.995);
      const shares = amount(Number(swapped) * 0.98);
      result.tokenIn = request.depositToken;
      result.tokenOut = `${request.protocol}:shares`;
      result.amountIn = swapped;
      result.amountOut = shares;
      result.shares = shares;
      result.protocol = request.protocol;
    }

    return {
      receiptVersion: 1,
      receiptKind: 'STEP',
      simulated: true,
      network: 'simulated',
      disclaimer: SIMULATED_DISCLAIMER,
      simulatedTxRef: refFor(`${stepRecord.idempotencyKey}:${step}`),
      sagaId: saga.id,
      stepId: stepRecord.id,
      idempotencyKey: stepRecord.idempotencyKey,
      operation: step,
      simulatedStatus: 'SIMULATED_VERIFIED',
      issuedAt: clock.now().toISOString(),
      result,
      evidence: {
        adapter: 'simulated',
        noOnChainTransaction: true,
        note:
          'Deterministic simulated result produced by the offline adapter. ' +
          'No wallet, RPC, signature, broadcast or confirmation was involved.',
      },
    };
  }

  private corruptReceipt(
    receipt: SimulatedReceipt,
    fault: StepFaults['verificationFault'],
  ): SimulatedReceipt {
    switch (fault) {
      case 'MISMATCHED_STEP':
        return {
          ...receipt,
          operation: receipt.operation === 'SWAP' ? 'DEPOSIT' : 'SWAP',
          stepId: `${receipt.stepId}:wrong`,
        };
      case 'SIMULATED_REVERTED':
        return { ...receipt, simulatedStatus: 'SIMULATED_REVERTED' };
      case 'MISSING_RECEIPT':
        return undefined as unknown as SimulatedReceipt;
      case 'NOT_SIMULATED':
        return { ...receipt, simulated: false as unknown as true };
      case 'REAL_LOOKING_TX_REF':
        return { ...receipt, simulatedTxRef: `0x${'ab'.repeat(32)}` };
      case 'NONE':
        return receipt;
    }
  }

  async submit(step: StepName, context: SubmitContext): Promise<SimulatedReceipt> {
    const key = context.stepRecord.idempotencyKey;
    const existing = await this.ledger.get(key);
    if (existing) {
      // Replay after a crash: exactly the same receipt, no new simulated work.
      return existing;
    }

    const faults = this.faults(step);
    if (context.attempt <= faults.transientFailures) {
      throw new TransientStepError(
        `SIMULATED_TRANSIENT_${step}`,
        `Simulated transient ${step} failure on attempt ${context.attempt} ` +
          `(injected scenario "${this.scenario.name}"). Nothing was submitted.`,
        { step, attempt: context.attempt, simulated: true },
      );
    }
    if (faults.permanentFailure) {
      throw new PermanentStepError(
        `SIMULATED_PERMANENT_${step}`,
        `Simulated permanent ${step} failure (injected scenario "${this.scenario.name}"). ` +
          'Nothing was submitted.',
        { step, attempt: context.attempt, simulated: true },
      );
    }

    const receipt = this.buildStepReceipt(context);

    if (faults.unknownOutcome === 'RESOLVABLE') {
      // Simulate the call reaching the simulated ledger, then losing the response.
      await this.ledger.put(key, receipt, context.clock.now().toISOString());
      throw new UnknownSubmissionOutcomeError(
        `SIMULATED_UNKNOWN_${step}`,
        `Simulated ${step} submission outcome is unknown. The simulated ledger may contain ` +
          'the result; the executor must reconcile by idempotency key and must not resubmit.',
        { step, attempt: context.attempt, simulated: true, idempotencyKey: key },
      );
    }
    if (faults.unknownOutcome === 'UNRESOLVABLE') {
      throw new UnknownSubmissionOutcomeError(
        `SIMULATED_UNKNOWN_${step}`,
        `Simulated ${step} submission outcome is unknown and cannot be resolved ` +
          '(injected scenario). No retry is safe.',
        { step, attempt: context.attempt, simulated: true, idempotencyKey: key },
      );
    }

    await this.ledger.put(key, receipt, context.clock.now().toISOString());

    if (faults.verificationFault !== 'NONE') {
      return this.corruptReceipt(receipt, faults.verificationFault);
    }
    return receipt;
  }

  async reconcile(step: StepName, context: ReconcileContext): Promise<ReconcileResult> {
    const receipt = await this.ledger.get(context.stepRecord.idempotencyKey);
    if (receipt) {
      return {
        receipt,
        detail: `Recovered simulated ${step} receipt from the simulated ledger by idempotency key.`,
      };
    }
    return {
      receipt: null,
      detail:
        `No simulated ${step} receipt exists for this idempotency key. ` +
        'The outcome cannot be proven; resubmission is unsafe.',
    };
  }

  supportsCompensation(action: CompensationAction): boolean {
    const outcome =
      action === 'REVOKE_APPROVAL'
        ? this.scenario.compensation.revokeApproval
        : this.scenario.compensation.unwindSwap;
    return outcome !== 'UNAVAILABLE';
  }

  private buildCompensationReceipt(context: CompensationContext): SimulatedReceipt {
    const { saga, action, originalStep, clock } = context;
    const request = saga.request;
    const idempotencyKey = `${saga.id}:COMPENSATION:${action}:v1`;
    const result = resultBase(saga);

    if (action === 'REVOKE_APPROVAL') {
      result.allowance = '0';
      result.spender = request.spender;
      result.amountIn = request.amountIn;
    } else {
      const swapReceipt = saga.steps.SWAP.receipt;
      const swapped = swapReceipt?.result.amountOut ?? amount(Number(request.amountIn) * 0.995);
      result.tokenIn = request.toToken;
      result.tokenOut = request.fromToken;
      result.amountIn = swapped;
      result.amountOut = amount(Number(swapped) * 0.99);
      result.protocol = request.protocol;
    }

    return {
      receiptVersion: 1,
      receiptKind: 'COMPENSATION',
      simulated: true,
      network: 'simulated',
      disclaimer: SIMULATED_DISCLAIMER,
      simulatedTxRef: refFor(`${idempotencyKey}:${action}`),
      sagaId: saga.id,
      stepId: `${saga.id}:COMPENSATION:${action}`,
      idempotencyKey,
      operation:
        action === 'REVOKE_APPROVAL'
          ? 'COMPENSATION_REVOKE_APPROVAL'
          : 'COMPENSATION_UNWIND_SWAP',
      simulatedStatus: 'SIMULATED_VERIFIED',
      issuedAt: clock.now().toISOString(),
      result,
      evidence: {
        adapter: 'simulated',
        noOnChainTransaction: true,
        note:
          action === 'REVOKE_APPROVAL'
            ? 'Simulated approval revocation. This is a new simulated call, not a rollback.'
            : 'Simulated unwind swap. This is a new compensating trade, not a blockchain rollback.',
      },
      compensatesStep: originalStep,
    };
  }

  async compensate(context: CompensationContext): Promise<CompensationResult> {
    const { action, saga, clock } = context;
    const outcome =
      action === 'REVOKE_APPROVAL'
        ? this.scenario.compensation.revokeApproval
        : this.scenario.compensation.unwindSwap;
    const key = `${saga.id}:COMPENSATION:${action}:v1`;

    if (outcome === 'UNAVAILABLE') {
      return {
        status: 'UNAVAILABLE',
        receipt: null,
        note: `Simulated compensation ${action} is unavailable in scenario "${this.scenario.name}".`,
      };
    }

    const existing = await this.ledger.get(key);
    if (existing) {
      return {
        status: 'SUCCEEDED',
        receipt: existing,
        note: 'Replayed the existing simulated compensation receipt (idempotent).',
      };
    }

    if (outcome === 'FAILURE') {
      return {
        status: 'FAILED',
        receipt: null,
        note: `Simulated compensation ${action} failed under scenario "${this.scenario.name}".`,
        error: new PermanentStepError(
          `SIMULATED_COMPENSATION_FAILED_${action}`,
          `Simulated compensation ${action} failed. No state was rolled back.`,
          { simulated: true, action },
        ),
      };
    }

    const receipt = this.buildCompensationReceipt(context);
    await this.ledger.put(key, receipt, clock.now().toISOString());
    return {
      status: 'SUCCEEDED',
      receipt,
      note:
        action === 'REVOKE_APPROVAL'
          ? 'Simulated approval revoked. The original failure remains on record.'
          : 'Simulated unwind swap completed. The original failure remains on record.',
    };
  }
}
