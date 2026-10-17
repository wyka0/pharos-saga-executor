import type { Clock } from '../domain/clock.js';
import type {
  CompensationAction,
  SagaRecord,
  SettlementState,
  SimulatedReceipt,
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
}

export interface ReconcileContext {
  saga: SagaRecord;
  step: StepName;
  stepRecord: StepRecord;
  clock: Clock;
}

export interface ReconcileResult {
  receipt: SimulatedReceipt | null;
  detail: string;
}

export interface CompensationContext {
  saga: SagaRecord;
  action: CompensationAction;
  originalStep: StepName;
  clock: Clock;
}

export interface CompensationResult {
  status: SettlementState;
  receipt: SimulatedReceipt | null;
  note: string;
  error?: unknown;
}

/**
 * The adapter seam. The saga state machine only sees this interface, so a
 * verified Pharos testnet adapter can be added later without changing the
 * executor or the persisted state format.
 *
 * Requirements for a future adapter:
 *  - submit() must be idempotent by `stepRecord.idempotencyKey`.
 *  - a submission with an uncertain outcome must throw
 *    UnknownSubmissionOutcomeError, never a transient error.
 *  - reconcile() must look up the key before any resubmission.
 *  - receipts must pass the adapter's own verification before being returned.
 */
export interface ChainAdapter {
  readonly id: string;
  readonly simulated: boolean;
  submit(step: StepName, context: SubmitContext): Promise<SimulatedReceipt>;
  reconcile(step: StepName, context: ReconcileContext): Promise<ReconcileResult>;
  supportsCompensation(action: CompensationAction): boolean;
  compensate(context: CompensationContext): Promise<CompensationResult>;
}
