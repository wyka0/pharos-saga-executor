import { createAdapter } from '../adapters/factory.js';
import type { ChainAdapter, SubmitContext } from '../adapters/types.js';
import { appendAudit } from '../domain/audit.js';
import { SystemClock, type Clock } from '../domain/clock.js';
import {
  ReceiptVerificationError,
  classifyError,
  errorMessage,
  toErrorRecord,
} from '../domain/errors.js';
import { verifyCompensationReceipt, verifyStepReceipt } from '../domain/receipts.js';
import { RetryPolicy, createSeededJitter, type JitterSource } from '../domain/retry.js';
import { createSagaRecord } from '../domain/saga.js';
import {
  applyTransition,
  assertPrerequisites,
  canTransition,
} from '../domain/states.js';
import {
  STEP_NAMES,
  isTerminalState,
  pendingStateFor,
  stepForPendingState,
  verifiedStateFor,
  type AuditEvent,
  type CompensationAction,
  type ErrorRecord,
  type FailureKind,
  type SagaRecord,
  type SimulatedReceipt,
  type StartSagaInput,
  type StartSagaResult,
  type StepName,
} from '../domain/types.js';
import { SimulatedLedger } from '../persistence/ledger.js';
import { SagaStore } from '../persistence/store.js';

/**
 * Fault-injection-only error used by tests to stop the process at a precise
 * crash window. It is never thrown by the executor or the adapter.
 */
export class SimulatedInterruptionError extends Error {
  readonly code = 'SIMULATED_PROCESS_INTERRUPTION';

  constructor(message = 'Simulated process interruption for crash-window testing') {
    super(message);
    this.name = 'SimulatedInterruptionError';
  }
}

export interface ExecutorHooks {
  /** Called after IN_FLIGHT is persisted, immediately before adapter.submit(). */
  beforeSubmit?: (record: SagaRecord, step: StepName) => Promise<void> | void;
  /** Called after adapter.submit() returns, before receipt verification/persistence. */
  beforeReceiptPersisted?: (
    receipt: unknown,
    record: SagaRecord,
    step: StepName,
  ) => Promise<void> | void;
  /** Called after the verified state has been persisted. Exceptions propagate. */
  afterStepVerified?: (record: SagaRecord, step: StepName) => Promise<void> | void;
}

export interface SagaExecutorOptions {
  store: SagaStore;
  clock?: Clock;
  jitter?: JitterSource;
  adapterFactory?: (saga: SagaRecord) => ChainAdapter;
  hooks?: ExecutorHooks;
  /** Safety guard against a bug causing an unbounded drive loop. */
  maxLoopIterations?: number;
}

interface FailureInput {
  kind: FailureKind;
  code: string;
  message: string;
  retryExhausted: boolean;
}

/**
 * Drives the APPROVE -> SWAP -> DEPOSIT state machine.
 *
 * Every mutation that matters is persisted before the next action, every step
 * transition is guarded, and no unknown submission is ever blindly retried.
 */
export class SagaExecutor {
  private readonly store: SagaStore;
  private readonly clock: Clock;
  private readonly jitter: JitterSource;
  private readonly adapterFactory: (saga: SagaRecord) => ChainAdapter;
  private readonly hooks: ExecutorHooks;
  private readonly maxLoopIterations: number;
  private readonly keyedQueues = new Map<string, Promise<void>>();

  constructor(options: SagaExecutorOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    // Deterministic by default so a resumed run computes the same retry delay.
    this.jitter = options.jitter ?? createSeededJitter('pharos-saga-executor');
    const ledger = new SimulatedLedger(this.store.ledgerPath);
    this.adapterFactory = options.adapterFactory ?? ((saga) => createAdapter(saga, ledger));
    this.hooks = options.hooks ?? {};
    this.maxLoopIterations = options.maxLoopIterations ?? 200;
  }

  async startSaga(input: StartSagaInput): Promise<StartSagaResult> {
    await this.store.init();
    const release = await this.store.acquireLock('__start__', this.clock);
    let created = false;
    let sagaId = '';
    try {
      if (input.clientRequestId) {
        const existing = await this.store.findByClientRequestId(input.clientRequestId);
        if (existing) return { saga: existing, created: false };
      }
      if (input.sagaId) {
        const existing = await this.store.loadMaybe(input.sagaId);
        if (existing) return { saga: existing, created: false };
      }

      const record = createSagaRecord(input, this.clock);
      await this.store.save(record);
      sagaId = record.id;
      created = true;
    } finally {
      await release();
    }

    if (input.autoRun !== false) {
      await this.runSaga(sagaId);
    }
    return { saga: await this.store.load(sagaId), created };
  }

  async runSaga(sagaId: string): Promise<SagaRecord> {
    const releaseQueue = await this.acquireKey(sagaId);
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      releaseLock = await this.store.acquireLock(sagaId, this.clock);
      const record = await this.store.load(sagaId);
      if (isTerminalState(record.state)) return record;

      const at = this.nowIso();
      appendAudit(record, at, {
        type: 'SAGA_RUN_STARTED',
        message: `Executor attached in state ${record.state}. Persisting before any step.`,
        data: { state: record.state, simulated: true },
      });
      await this.persist(record, at);

      const adapter = this.adapterFactory(record);
      await this.drive(record, adapter);
      return record;
    } finally {
      if (releaseLock) await releaseLock();
      releaseQueue();
    }
  }

  async inspectSaga(sagaId: string): Promise<SagaRecord> {
    return this.store.load(sagaId);
  }

  async listSagas(): Promise<SagaRecord[]> {
    return this.store.list();
  }

  async audit(sagaId: string): Promise<AuditEvent[]> {
    return (await this.store.load(sagaId)).audit;
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private async persist(record: SagaRecord, at?: string): Promise<void> {
    if (at) record.updatedAt = at;
    await this.store.save(record);
  }

  private async transition(
    record: SagaRecord,
    to: SagaRecord['state'],
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    applyTransition(record, to, this.nowIso(), message, data);
    await this.store.save(record);
  }

  private async drive(record: SagaRecord, adapter: ChainAdapter): Promise<void> {
    let iterations = 0;
    while (!isTerminalState(record.state)) {
      iterations += 1;
      if (iterations > this.maxLoopIterations) {
        await this.manualRecovery(
          record,
          `Loop guard tripped after ${this.maxLoopIterations} iterations; state=${record.state}.`,
          { guard: true },
        );
        return;
      }

      switch (record.state) {
        case 'CREATED':
          await this.transition(
            record,
            'APPROVAL_PENDING',
            'Saga accepted. APPROVE is the only step that may start.',
            { simulated: true },
          );
          break;
        case 'APPROVED':
          await this.transition(
            record,
            'SWAP_PENDING',
            'APPROVE receipt verified. SWAP may now start.',
            { prerequisite: 'APPROVE' },
          );
          break;
        case 'SWAPPED':
          await this.transition(
            record,
            'DEPOSIT_PENDING',
            'SWAP receipt verified. DEPOSIT may now start.',
            { prerequisite: 'SWAP' },
          );
          break;
        case 'APPROVAL_PENDING':
          await this.executeStep(record, adapter, 'APPROVE');
          break;
        case 'SWAP_PENDING':
          await this.executeStep(record, adapter, 'SWAP');
          break;
        case 'DEPOSIT_PENDING':
          await this.executeStep(record, adapter, 'DEPOSIT');
          break;
        case 'RETRY_WAIT':
          await this.handleRetryWait(record);
          break;
        case 'COMPENSATING':
          await this.runCompensation(record, adapter);
          break;
        case 'COMPLETED':
        case 'FAILED':
        case 'MANUAL_RECOVERY_REQUIRED':
          return;
      }
    }
  }

  private async executeStep(
    record: SagaRecord,
    adapter: ChainAdapter,
    step: StepName,
  ): Promise<void> {
    const stepRecord = record.steps[step];
    const pendingState = pendingStateFor(step);

    try {
      assertPrerequisites(record, step);
    } catch (error) {
      await this.manualRecovery(record, `Dependency check failed before ${step}.`, {
        error: errorMessage(error),
      });
      return;
    }

    if (record.state !== pendingState) {
      await this.manualRecovery(
        record,
        `State ${record.state} does not permit ${step}; expected ${pendingState}.`,
        { expectedState: pendingState },
      );
      return;
    }

    if (stepRecord.status === 'SUCCEEDED' || stepRecord.submissionState === 'VERIFIED') {
      await this.manualRecovery(
        record,
        `${step} is already verified but the saga is still in ${record.state}. Evidence preserved.`,
        { stepStatus: stepRecord.status, submissionState: stepRecord.submissionState },
      );
      return;
    }

    if (
      stepRecord.status === 'IN_PROGRESS' ||
      stepRecord.submissionState === 'IN_FLIGHT' ||
      stepRecord.submissionState === 'UNKNOWN_OUTCOME'
    ) {
      await this.reconcileStep(
        record,
        adapter,
        step,
        'Found a persisted in-flight/unknown submission on resume; reconciling by idempotency key.',
      );
      return;
    }

    stepRecord.attempts += 1;
    const attempt = stepRecord.attempts;
    stepRecord.status = 'IN_PROGRESS';
    stepRecord.submissionState = 'IN_FLIGHT';
    stepRecord.startedAt ??= this.nowIso();
    const attemptAt = this.nowIso();
    appendAudit(record, attemptAt, {
      type: 'STEP_ATTEMPT',
      message:
        `Starting simulated ${step} attempt ${attempt}/${record.config.retry.maxAttempts}. ` +
        'No on-chain transaction is possible with this adapter.',
      stepId: stepRecord.id,
      data: {
        step,
        attempt,
        idempotencyKey: stepRecord.idempotencyKey,
        maxAttempts: record.config.retry.maxAttempts,
        simulated: true,
      },
    });
    await this.persist(record, attemptAt);

    const context: SubmitContext = {
      saga: record,
      step,
      stepRecord,
      attempt,
      clock: this.clock,
    };

    let phase: 'BEFORE_SUBMIT' | 'SUBMITTED' = 'BEFORE_SUBMIT';
    try {
      await this.hooks.beforeSubmit?.(record, step);
      const receipt = await adapter.submit(step, context);
      phase = 'SUBMITTED';
      await this.hooks.beforeReceiptPersisted?.(receipt, record, step);

      const verification = verifyStepReceipt(receipt, record, step);
      if (!verification.ok) {
        await this.failVerification(record, step, receipt, verification.reasons);
        return;
      }

      const verifiedAt = this.nowIso();
      stepRecord.receipt = verification.receipt;
      stepRecord.submissionState = 'VERIFIED';
      stepRecord.status = 'SUCCEEDED';
      stepRecord.verifiedAt = verifiedAt;
      stepRecord.finishedAt = verifiedAt;
      appendAudit(record, verifiedAt, {
        type: 'RECEIPT_VERIFIED',
        message: `${step} simulated receipt verified; dependency requirement satisfied.`,
        stepId: stepRecord.id,
        data: {
          simulatedTxRef: verification.receipt.simulatedTxRef,
          result: verification.receipt.result,
          simulated: true,
        },
      });
      appendAudit(record, verifiedAt, {
        type: 'STEP_SUCCEEDED',
        message: `${step} succeeded in the simulated adapter.`,
        stepId: stepRecord.id,
        data: { attempt, simulated: true },
      });

      await this.transition(
        record,
        verifiedStateFor(step),
        `${step} verified.`,
        { step, receiptKind: verification.receipt.receiptKind, simulated: true },
      );
    } catch (error) {
      if (error instanceof SimulatedInterruptionError) throw error;
      if (phase === 'SUBMITTED') {
        // A receipt already exists for this attempt. Persistence/verification
        // failures must not be misrepresented as an adapter submission error.
        throw error;
      }
      await this.handleStepError(record, adapter, step, error);
      return;
    }

    await this.hooks.afterStepVerified?.(record, step);
  }

  private async handleStepError(
    record: SagaRecord,
    adapter: ChainAdapter,
    step: StepName,
    error: unknown,
  ): Promise<void> {
    const stepRecord = record.steps[step];
    const kind = classifyError(error);
    const at = this.nowIso();
    const errorRecord = toErrorRecord(error, at, stepRecord.attempts, kind);
    stepRecord.errors.push(errorRecord);

    if (kind === 'TRANSIENT') {
      appendAudit(record, at, {
        type: 'STEP_FAILED',
        level: 'WARN',
        message: `${step} attempt ${stepRecord.attempts} failed transiently: ${errorRecord.message}`,
        stepId: stepRecord.id,
        data: { step, attempt: stepRecord.attempts, kind, code: errorRecord.code, simulated: true },
      });

      const retryPolicy = new RetryPolicy(record.config.retry);
      if (retryPolicy.attemptsRemain(stepRecord.attempts)) {
        const schedule = retryPolicy.schedule(stepRecord.attempts, this.jitter, {
          sagaId: record.id,
          step,
        });
        const scheduledAt = new Date(this.clock.now().getTime() + schedule.delayMs).toISOString();
        stepRecord.status = 'RETRY_WAIT';
        stepRecord.submissionState = 'NOT_SUBMITTED';
        stepRecord.retry = {
          attempt: stepRecord.attempts,
          scheduledAt,
          delayMs: schedule.delayMs,
          jitter: schedule.jitter,
          reason: errorRecord.code,
        };
        appendAudit(record, at, {
          type: 'RETRY_SCHEDULED',
          level: 'WARN',
          message:
            `Bounded retry scheduled for ${step} attempt ${stepRecord.attempts + 1}/` +
            `${record.config.retry.maxAttempts} after ${schedule.delayMs}ms ` +
            `(exponential base ${schedule.rawDelayMs}ms, jitter ${schedule.jitter.toFixed(3)}).`,
          stepId: stepRecord.id,
          data: {
            step,
            failedAttempt: stepRecord.attempts,
            nextAttempt: stepRecord.attempts + 1,
            delayMs: schedule.delayMs,
            rawDelayMs: schedule.rawDelayMs,
            jitter: schedule.jitter,
            scheduledAt,
            simulated: true,
          },
        });
        await this.transition(record, 'RETRY_WAIT', `${step} waiting for a bounded retry.`, {
          step,
          attempt: stepRecord.attempts,
          scheduledAt,
        });
        return;
      }

      appendAudit(record, at, {
        type: 'RETRY_EXHAUSTED',
        level: 'ERROR',
        message:
          `${step} retry budget exhausted after ${stepRecord.attempts} attempt(s) ` +
          `(maxAttempts=${record.config.retry.maxAttempts}). Applying permanent-failure policy.`,
        stepId: stepRecord.id,
        data: { step, attempts: stepRecord.attempts, maxAttempts: record.config.retry.maxAttempts },
      });
      stepRecord.status = 'FAILED';
      stepRecord.finishedAt = at;
      await this.failStep(record, adapter, step, {
        kind: 'TRANSIENT',
        code: errorRecord.code,
        message: errorRecord.message,
        retryExhausted: true,
      });
      return;
    }

    if (kind === 'UNKNOWN_OUTCOME') {
      stepRecord.submissionState = 'UNKNOWN_OUTCOME';
      appendAudit(record, at, {
        type: 'STEP_FAILED',
        level: 'ERROR',
        message: `${step} submission outcome is UNKNOWN: ${errorRecord.message}`,
        stepId: stepRecord.id,
        data: { step, attempt: stepRecord.attempts, kind, code: errorRecord.code, simulated: true },
      });
      await this.persist(record, at);
      await this.reconcileStep(record, adapter, step, 'Submission outcome unknown after adapter error.');
      return;
    }

    if (kind === 'INTERNAL') {
      await this.manualRecovery(record, `${step} hit an internal error: ${errorRecord.message}`, {
        step,
        error: errorRecord,
      });
      return;
    }

    if (kind === 'VERIFICATION') {
      appendAudit(record, at, {
        type: 'RECEIPT_VERIFICATION_FAILED',
        level: 'ERROR',
        message: `${step} receipt could not be verified: ${errorRecord.message}`,
        stepId: stepRecord.id,
        data: { step, kind, code: errorRecord.code },
      });
      stepRecord.status = 'FAILED';
      stepRecord.submissionState = 'UNKNOWN_OUTCOME';
      stepRecord.finishedAt = at;
      record.failure = {
        step,
        kind: 'VERIFICATION',
        code: errorRecord.code,
        message: errorRecord.message,
        at,
        attempts: stepRecord.attempts,
        retryExhausted: false,
      };
      await this.manualRecovery(record, `${step} verification failure requires manual recovery.`, {
        step,
        reasons: (error as ReceiptVerificationError).reasons ?? [],
      });
      return;
    }

    appendAudit(record, at, {
      type: 'STEP_FAILED',
      level: 'ERROR',
      message: `${step} failed permanently: ${errorRecord.message}`,
      stepId: stepRecord.id,
      data: { step, attempt: stepRecord.attempts, kind, code: errorRecord.code, simulated: true },
    });
    stepRecord.status = 'FAILED';
    stepRecord.submissionState = 'NOT_SUBMITTED';
    stepRecord.finishedAt = at;
    await this.failStep(record, adapter, step, {
      kind,
      code: errorRecord.code,
      message: errorRecord.message,
      retryExhausted: false,
    });
  }

  private async failVerification(
    record: SagaRecord,
    step: StepName,
    receipt: unknown,
    reasons: string[],
  ): Promise<void> {
    const stepRecord = record.steps[step];
    const at = this.nowIso();
    const error = new ReceiptVerificationError(
      `${step} simulated receipt failed verification: ${reasons.join('; ')}`,
      reasons,
    );
    const errorRecord = toErrorRecord(error, at, stepRecord.attempts, 'VERIFICATION');
    stepRecord.errors.push(errorRecord);
    stepRecord.invalidReceiptEvidence = receipt ?? null;
    stepRecord.status = 'FAILED';
    stepRecord.submissionState = 'UNKNOWN_OUTCOME';
    stepRecord.finishedAt = at;
    record.failure = {
      step,
      kind: 'VERIFICATION',
      code: errorRecord.code,
      message: errorRecord.message,
      at,
      attempts: stepRecord.attempts,
      retryExhausted: false,
    };
    appendAudit(record, at, {
      type: 'RECEIPT_VERIFICATION_FAILED',
      level: 'ERROR',
      message: `${step} receipt failed verification; refusing to advance or retry.`,
      stepId: stepRecord.id,
      data: { step, reasons, simulated: true },
    });
    await this.manualRecovery(record, `${step} verification failure requires manual recovery.`, {
      step,
      reasons,
      note: 'No compensation was attempted because the outcome cannot be proven.',
    });
  }

  private async reconcileStep(
    record: SagaRecord,
    adapter: ChainAdapter,
    step: StepName,
    reason: string,
  ): Promise<void> {
    const stepRecord = record.steps[step];
    stepRecord.submissionState = 'UNKNOWN_OUTCOME';
    const at = this.nowIso();
    appendAudit(record, at, {
      type: 'RECONCILIATION_ATTEMPTED',
      message: `${step} outcome unknown; querying the adapter by idempotency key. No resubmission.`,
      stepId: stepRecord.id,
      data: { step, idempotencyKey: stepRecord.idempotencyKey, reason, simulated: true },
    });
    await this.persist(record, at);

    let resolved: SimulatedReceipt | null = null;
    let detail = '';
    try {
      const result = await adapter.reconcile(step, {
        saga: record,
        step,
        stepRecord,
        clock: this.clock,
      });
      resolved = result.receipt;
      detail = result.detail;
    } catch (error) {
      const errorRecord = toErrorRecord(error, this.nowIso(), stepRecord.attempts, 'UNKNOWN_OUTCOME');
      stepRecord.errors.push(errorRecord);
      appendAudit(record, this.nowIso(), {
        type: 'RECONCILIATION_RESULT',
        level: 'ERROR',
        message: `${step} reconciliation failed: ${errorRecord.message}`,
        stepId: stepRecord.id,
        data: { step, found: false, error: errorRecord, simulated: true },
      });
      await this.manualForUnknown(record, step, `${step} reconciliation failed.`);
      return;
    }

    if (resolved) {
      const verification = verifyStepReceipt(resolved, record, step);
      if (verification.ok) {
        const verifiedAt = this.nowIso();
        stepRecord.receipt = verification.receipt;
        stepRecord.submissionState = 'VERIFIED';
        stepRecord.status = 'SUCCEEDED';
        stepRecord.verifiedAt = verifiedAt;
        stepRecord.finishedAt = verifiedAt;
        appendAudit(record, verifiedAt, {
          type: 'RECONCILIATION_RESULT',
          message: `${step} reconciled successfully by idempotency key. ${detail}`,
          stepId: stepRecord.id,
          data: { step, found: true, detail, simulatedTxRef: verification.receipt.simulatedTxRef },
        });
        appendAudit(record, verifiedAt, {
          type: 'RECEIPT_VERIFIED',
          message: `${step} reconciled simulated receipt verified.`,
          stepId: stepRecord.id,
          data: { simulatedTxRef: verification.receipt.simulatedTxRef, reconciled: true },
        });
        appendAudit(record, verifiedAt, {
          type: 'STEP_SUCCEEDED',
          message: `${step} succeeded after reconciliation (no resubmission).`,
          stepId: stepRecord.id,
          data: { attempt: stepRecord.attempts, reconciled: true },
        });
        await this.transition(record, verifiedStateFor(step), `${step} verified via reconciliation.`, {
          step,
          reconciled: true,
        });
        return;
      }

      stepRecord.invalidReceiptEvidence = resolved;
      appendAudit(record, this.nowIso(), {
        type: 'RECONCILIATION_RESULT',
        level: 'ERROR',
        message: `${step} reconciliation returned a receipt that failed verification.`,
        stepId: stepRecord.id,
        data: { step, found: true, reasons: verification.reasons, simulated: true },
      });
      await this.manualForUnknown(record, step, `${step} reconciled receipt failed verification.`);
      return;
    }

    appendAudit(record, this.nowIso(), {
      type: 'RECONCILIATION_RESULT',
      level: 'WARN',
      message: `${step} could not be reconciled. ${detail}`,
      stepId: stepRecord.id,
      data: { step, found: false, detail, simulated: true },
    });
    await this.manualForUnknown(record, step, `${step} outcome is unknown and unreconciled.`);
  }

  private async manualForUnknown(record: SagaRecord, step: StepName, message: string): Promise<void> {
    const stepRecord = record.steps[step];
    const at = this.nowIso();
    stepRecord.status = 'FAILED';
    stepRecord.finishedAt = at;
    record.failure = {
      step,
      kind: 'UNKNOWN_OUTCOME',
      code: 'UNKNOWN_SUBMISSION_OUTCOME',
      message,
      at,
      attempts: stepRecord.attempts,
      retryExhausted: false,
    };
    await this.manualRecovery(record, message, {
      step,
      idempotencyKey: stepRecord.idempotencyKey,
      note:
        'No automatic retry and no compensation were attempted because the submission outcome is unknown.',
    });
  }

  private async failStep(
    record: SagaRecord,
    adapter: ChainAdapter,
    step: StepName,
    failure: FailureInput,
  ): Promise<void> {
    const at = this.nowIso();
    record.failure = {
      step,
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
      at,
      attempts: record.steps[step].attempts,
      retryExhausted: failure.retryExhausted,
    };

    if (step === 'APPROVE') {
      record.compensation = {
        required: false,
        action: 'NONE',
        status: 'NOT_REQUIRED',
        attempts: 0,
        startedAt: null,
        finishedAt: at,
        receipt: null,
        error: null,
        note: 'APPROVE failed before approval; SWAP and DEPOSIT never started. No compensation is needed.',
      };
      appendAudit(record, at, {
        type: 'SAGA_FAILED',
        level: 'ERROR',
        message: 'Saga failed at APPROVE. SWAP was never attempted; no compensation required.',
        stepId: record.steps[step].id,
        data: { step, failure, simulated: true, swapAttempted: false },
      });
      await this.transition(record, 'FAILED', 'APPROVE failed permanently before SWAP could start.', {
        step,
        retryExhausted: failure.retryExhausted,
      });
      return;
    }

    const action: CompensationAction | 'NONE' =
      step === 'SWAP'
        ? record.config.compensationPolicy.onSwapFailure
        : record.config.compensationPolicy.onDepositFailure;

    if (action === 'NONE') {
      record.compensation = {
        required: false,
        action: 'NONE',
        status: 'SKIPPED',
        attempts: 0,
        startedAt: null,
        finishedAt: at,
        receipt: null,
        error: null,
        note:
          'No safe compensation is configured for this failure. ' +
          'Evidence is preserved for manual recovery; no rollback was attempted.',
      };
      appendAudit(record, at, {
        type: 'COMPENSATION_UNAVAILABLE',
        level: 'ERROR',
        message: `${step} failed and policy disables compensation. Manual recovery required.`,
        stepId: record.steps[step].id,
        data: { step, action, simulated: true },
      });
      await this.manualRecovery(record, `${step} failed with no compensation configured.`, {
        step,
        failure,
      });
      return;
    }

    if (!adapter.supportsCompensation(action)) {
      record.compensation = {
        required: true,
        action,
        status: 'UNAVAILABLE',
        attempts: 0,
        startedAt: null,
        finishedAt: at,
        receipt: null,
        error: null,
        note: `Adapter reports compensation ${action} is unavailable. No rollback was attempted.`,
      };
      appendAudit(record, at, {
        type: 'COMPENSATION_UNAVAILABLE',
        level: 'ERROR',
        message: `Adapter does not support ${action}; manual recovery required.`,
        stepId: record.steps[step].id,
        data: { step, action, simulated: true },
      });
      await this.manualRecovery(record, `${step} failed and ${action} is unavailable.`, {
        step,
        action,
        failure,
      });
      return;
    }

    record.compensation = {
      required: true,
      action,
      status: 'PENDING',
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      receipt: null,
      error: null,
      note: `Configured compensation ${action} will be attempted as a separate simulated call.`,
    };
    await this.transition(
      record,
      'COMPENSATING',
      `${step} failed permanently. Starting configured compensation ${action}.`,
      { step, action, originalFailure: failure.code, simulated: true },
    );
  }

  private async runCompensation(record: SagaRecord, adapter: ChainAdapter): Promise<void> {
    const compensation = record.compensation;
    if (
      !compensation ||
      compensation.status !== 'PENDING' ||
      compensation.action === 'NONE' ||
      !record.failure
    ) {
      await this.manualRecovery(record, 'COMPENSATING state has no valid pending compensation policy.', {
        compensation,
      });
      return;
    }

    const action = compensation.action;
    const originalStep = record.failure.step;
    compensation.attempts += 1;
    compensation.startedAt ??= this.nowIso();
    const startedAt = this.nowIso();
    appendAudit(record, startedAt, {
      type: 'COMPENSATION_STARTED',
      message:
        `Starting simulated compensation ${action} for the original ${originalStep} failure. ` +
        'This is a new simulated call, not a blockchain rollback.',
      stepId: `${record.id}:COMPENSATION:${action}`,
      data: { action, originalStep, simulated: true },
    });
    await this.persist(record, startedAt);

    let result;
    try {
      result = await adapter.compensate({
        saga: record,
        action,
        originalStep,
        clock: this.clock,
      });
    } catch (error) {
      const at = this.nowIso();
      const errorRecord = toErrorRecord(error, at, compensation.attempts, 'PERMANENT');
      compensation.status = 'FAILED';
      compensation.finishedAt = at;
      compensation.error = errorRecord;
      compensation.note = 'Compensation threw an error; no rollback occurred.';
      appendAudit(record, at, {
        type: 'COMPENSATION_FAILED',
        level: 'ERROR',
        message: `Compensation ${action} threw: ${errorRecord.message}`,
        stepId: `${record.id}:COMPENSATION:${action}`,
        data: { action, originalStep, error: errorRecord, simulated: true },
      });
      await this.manualRecovery(record, `Compensation ${action} failed; manual recovery required.`, {
        action,
        originalStep,
        error: errorRecord,
      });
      return;
    }

    const at = this.nowIso();
    compensation.finishedAt = at;
    compensation.note = result.note;

    if (result.status === 'SUCCEEDED' && result.receipt) {
      const verification = verifyCompensationReceipt(result.receipt, record, action, originalStep);
      if (!verification.ok) {
        const errorRecord = toErrorRecord(
          new ReceiptVerificationError(
            `Compensation receipt failed verification: ${verification.reasons.join('; ')}`,
            verification.reasons,
          ),
          at,
          compensation.attempts,
          'VERIFICATION',
        );
        compensation.status = 'FAILED';
        compensation.error = errorRecord;
        appendAudit(record, at, {
          type: 'COMPENSATION_FAILED',
          level: 'ERROR',
          message: 'Compensation simulated receipt failed verification.',
          stepId: `${record.id}:COMPENSATION:${action}`,
          data: { action, originalStep, reasons: verification.reasons, simulated: true },
        });
        await this.manualRecovery(record, `Compensation ${action} receipt failed verification.`, {
          action,
          originalStep,
          reasons: verification.reasons,
        });
        return;
      }

      compensation.status = 'SUCCEEDED';
      compensation.receipt = verification.receipt;
      compensation.error = null;
      appendAudit(record, at, {
        type: 'COMPENSATION_SUCCEEDED',
        message:
          `Simulated compensation ${action} succeeded. The original ${originalStep} failure is ` +
          'still recorded; nothing was rolled back.',
        stepId: `${record.id}:COMPENSATION:${action}`,
        data: {
          action,
          originalStep,
          simulatedTxRef: verification.receipt.simulatedTxRef,
          simulated: true,
        },
      });
      appendAudit(record, at, {
        type: 'SAGA_FAILED',
        level: 'ERROR',
        message:
          `Saga failed at ${originalStep}; compensation ${action} succeeded. ` +
          'Outcome is FAILED, not COMPLETED.',
        stepId: record.steps[originalStep].id,
        data: { originalFailure: record.failure.code, compensationStatus: 'SUCCEEDED', simulated: true },
      });
      await this.transition(record, 'FAILED', `Compensation ${action} succeeded; saga remains failed.`, {
        action,
        originalStep,
      });
      return;
    }

    if (result.status === 'UNAVAILABLE') {
      compensation.status = 'UNAVAILABLE';
      compensation.receipt = null;
      compensation.error = null;
      appendAudit(record, at, {
        type: 'COMPENSATION_UNAVAILABLE',
        level: 'ERROR',
        message: `Compensation ${action} is unavailable: ${result.note}`,
        stepId: `${record.id}:COMPENSATION:${action}`,
        data: { action, originalStep, simulated: true },
      });
      await this.manualRecovery(record, `Compensation ${action} unavailable; manual recovery required.`, {
        action,
        originalStep,
      });
      return;
    }

    const errorRecord: ErrorRecord = result.error
      ? toErrorRecord(result.error, at, compensation.attempts, 'PERMANENT')
      : {
          kind: 'PERMANENT',
          code: 'COMPENSATION_FAILED',
          message: result.note,
          at,
          attempt: compensation.attempts,
        };
    compensation.status = 'FAILED';
    compensation.receipt = result.receipt;
    compensation.error = errorRecord;
    appendAudit(record, at, {
      type: 'COMPENSATION_FAILED',
      level: 'ERROR',
      message: `Compensation ${action} failed: ${result.note}`,
      stepId: `${record.id}:COMPENSATION:${action}`,
      data: { action, originalStep, error: errorRecord, simulated: true },
    });
    await this.manualRecovery(record, `Compensation ${action} failed; manual recovery required.`, {
      action,
      originalStep,
      error: errorRecord,
    });
  }

  private async handleRetryWait(record: SagaRecord): Promise<void> {
    const step = STEP_NAMES.find((candidate) => record.steps[candidate].status === 'RETRY_WAIT');
    if (!step) {
      await this.manualRecovery(record, 'RETRY_WAIT state has no step marked RETRY_WAIT.');
      return;
    }
    const stepRecord = record.steps[step];
    const retry = stepRecord.retry;
    if (!retry) {
      await this.manualRecovery(record, `${step} is RETRY_WAIT without a retry schedule.`);
      return;
    }

    const waitMs = Math.max(0, Date.parse(retry.scheduledAt) - this.clock.now().getTime());
    if (waitMs > 0) await this.clock.sleep(waitMs);

    stepRecord.status = 'PENDING';
    const at = this.nowIso();
    await this.transition(record, pendingStateFor(step), `${step} retry window elapsed.`, {
      step,
      nextAttempt: stepRecord.attempts + 1,
      waitedMs: waitMs,
    });
  }

  private async manualRecovery(
    record: SagaRecord,
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    const at = this.nowIso();
    const step = record.failure?.step ?? stepForPendingState(record.state) ?? 'APPROVE';
    appendAudit(record, at, {
      type: 'MANUAL_RECOVERY_REQUIRED',
      level: 'ERROR',
      message,
      stepId: record.steps[step].id,
      data: { ...data, simulated: true },
    });
    if (canTransition(record.state, 'MANUAL_RECOVERY_REQUIRED')) {
      await this.transition(record, 'MANUAL_RECOVERY_REQUIRED', message, data);
      return;
    }
    appendAudit(record, at, {
      type: 'INTERNAL_ERROR',
      level: 'ERROR',
      message: `Cannot transition ${record.state} to MANUAL_RECOVERY_REQUIRED; preserving state for inspection.`,
      stepId: record.steps[step].id,
      data,
    });
    await this.persist(record, at);
  }

  private async acquireKey(key: string): Promise<() => void> {
    const previous = this.keyedQueues.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.keyedQueues.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  }
}
