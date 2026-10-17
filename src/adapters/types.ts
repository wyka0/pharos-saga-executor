import type { Clock } from '../domain/clock.js';
import type {
  CompensationAction,
  PlanApproval,
  ProofReceipt,
  SagaRecord,
  SettlementState,
  StepName,
  StepRecord,
} from '../domain/types.js';

export interface SubmitContext {
  saga: SagaRecord;
  step: StepName;
  stepRecord: StepRecord;
  /** 1-based submission attempt for this step (bounded by retry.maxAttempts). */
  attempt: number;
  clock: Clock;
  /**
   * Explicit approval for the exact plan hash. Required by the testnet adapter;
   * ignored by the simulated adapter. Never inferred automatically.
   */
  approval?: PlanApproval;
}

export interface ReconcileContext {
  saga: SagaRecord;
  step: StepName;
  stepRecord: StepRecord;
  clock: Clock;
}

export interface ReconcileResult {
  receipt: ProofReceipt | null;
  detail: string;
}

export interface CompensationContext {
  saga: SagaRecord;
  action: CompensationAction;
  originalStep: StepName;
  clock: Clock;
  approval?: PlanApproval;
}

export interface CompensationResult {
  status: SettlementState;
  receipt: ProofReceipt | null;
  note: string;
  error?: unknown;
}

/**
 * The adapter seam. The saga state machine only sees this interface, so the
 * simulated and testnet adapters share the same executor and state machine.
 *
 * Requirements for any adapter:
 *  - submit() must be idempotent by `stepRecord.idempotencyKey`.
 *  - a submission with an uncertain outcome must throw
 *    UnknownSubmissionOutcomeError, never a transient error.
 *  - reconcile() must look up the key before any resubmission.
 *  - receipts must pass the adapter's own verification before being returned.
 */
export interface ChainAdapter {
  readonly id: string;
  readonly simulated: boolean;
  submit(step: StepName, context: SubmitContext): Promise<ProofReceipt>;
  reconcile(step: StepName, context: ReconcileContext): Promise<ReconcileResult>;
  supportsCompensation(action: CompensationAction): boolean;
  compensate(context: CompensationContext): Promise<CompensationResult>;
}
