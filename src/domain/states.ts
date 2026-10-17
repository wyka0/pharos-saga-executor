import { appendAudit } from './audit.js';
import { DependencyViolationError, IllegalTransitionError } from './errors.js';
import {
  STEP_NAMES,
  isTerminalState,
  type SagaRecord,
  type SagaState,
  type StepName,
} from './types.js';

/**
 * The only legal saga transitions. Anything else is rejected, so a corrupt or
 * hand-edited state file cannot silently skip a pending step.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<SagaState, readonly SagaState[]>> = {
  CREATED: ['APPROVAL_PENDING', 'FAILED'],
  APPROVAL_PENDING: ['APPROVED', 'RETRY_WAIT', 'FAILED', 'MANUAL_RECOVERY_REQUIRED'],
  APPROVED: ['SWAP_PENDING', 'FAILED', 'MANUAL_RECOVERY_REQUIRED'],
  SWAP_PENDING: ['SWAPPED', 'RETRY_WAIT', 'COMPENSATING', 'FAILED', 'MANUAL_RECOVERY_REQUIRED'],
  SWAPPED: ['DEPOSIT_PENDING', 'COMPENSATING', 'MANUAL_RECOVERY_REQUIRED'],
  DEPOSIT_PENDING: ['COMPLETED', 'RETRY_WAIT', 'COMPENSATING', 'FAILED', 'MANUAL_RECOVERY_REQUIRED'],
  RETRY_WAIT: [
    'APPROVAL_PENDING',
    'SWAP_PENDING',
    'DEPOSIT_PENDING',
    'COMPENSATING',
    'FAILED',
    'MANUAL_RECOVERY_REQUIRED',
  ],
  COMPENSATING: ['FAILED', 'MANUAL_RECOVERY_REQUIRED'],
  COMPLETED: [],
  FAILED: [],
  MANUAL_RECOVERY_REQUIRED: [],
};

export function canTransition(from: SagaState, to: SagaState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SagaState, to: SagaState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Mutates the record to the next state and appends an audit event. It does NOT
 * persist; the executor always awaits store.save() immediately afterwards.
 */
export function applyTransition(
  record: SagaRecord,
  to: SagaState,
  at: string,
  message: string,
  data: Record<string, unknown> = {},
): SagaRecord {
  const from = record.state;
  assertTransition(from, to);
  record.state = to;
  record.updatedAt = at;
  if (to === 'COMPLETED') record.completedAt = at;
  appendAudit(record, at, {
    type: 'TRANSITION',
    message,
    from,
    to,
    data,
  });
  return record;
}

/**
 * A step cannot begin until the previous step has a verified simulated receipt.
 * This is checked before every submission attempt, not just before the saga starts.
 */
export function assertPrerequisites(record: SagaRecord, step: StepName): void {
  const index = STEP_NAMES.indexOf(step);
  if (index < 0) throw new DependencyViolationError(`Unknown step ${String(step)}`, step);

  if (index === 0) return;

  const prerequisite = STEP_NAMES[index - 1];
  if (!prerequisite) throw new DependencyViolationError(`No prerequisite for ${step}`, step);

  const prior = record.steps[prerequisite];
  if (
    prior.status !== 'SUCCEEDED' ||
    prior.submissionState !== 'VERIFIED' ||
    prior.receipt === null
  ) {
    throw new DependencyViolationError(
      `${step} cannot start: prerequisite ${prerequisite} is not verified ` +
        `(status=${prior.status}, submission=${prior.submissionState}, receipt=${prior.receipt ? 'present' : 'missing'})`,
      step,
      { prerequisite, prerequisiteStatus: prior.status },
    );
  }
}

export function assertRunnable(record: SagaRecord): void {
  if (isTerminalState(record.state)) {
    throw new IllegalTransitionError(record.state, record.state);
  }
}
