import type {
  ErrorRecord,
  FailureKind,
  StepName,
} from './types.js';

export class SagaError extends Error {
  readonly kind: FailureKind;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    kind: FailureKind,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export class TransientStepError extends SagaError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super('TRANSIENT', code, message, details);
  }
}

export class PermanentStepError extends SagaError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super('PERMANENT', code, message, details);
  }
}

/**
 * The submission may or may not have happened. Never retry this blindly.
 * The executor must reconcile by idempotency key or stop for manual recovery.
 */
export class UnknownSubmissionOutcomeError extends SagaError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super('UNKNOWN_OUTCOME', code, message, details);
  }
}

export class ReceiptVerificationError extends SagaError {
  readonly reasons: string[];

  constructor(message: string, reasons: string[], details: Record<string, unknown> = {}) {
    super('VERIFICATION', 'RECEIPT_VERIFICATION_FAILED', message, details);
    this.reasons = reasons;
  }
}

export class DependencyViolationError extends SagaError {
  constructor(message: string, step: StepName, details: Record<string, unknown> = {}) {
    super('PERMANENT', 'DEPENDENCY_NOT_VERIFIED', message, { step, ...details });
  }
}

export class IllegalTransitionError extends SagaError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('INTERNAL', 'ILLEGAL_STATE_TRANSITION', `Illegal saga transition: ${from} -> ${to}`, {
      from,
      to,
    });
    this.from = from;
    this.to = to;
  }
}

export class SagaNotFoundError extends Error {
  readonly code = 'SAGA_NOT_FOUND';
  readonly sagaId: string;

  constructor(sagaId: string) {
    super(`Saga not found: ${sagaId}`);
    this.name = 'SagaNotFoundError';
    this.sagaId = sagaId;
  }
}

export class SagaBusyError extends Error {
  readonly code = 'SAGA_BUSY';
  readonly sagaId: string;

  constructor(sagaId: string) {
    super(
      `Saga ${sagaId} is already being executed (lock is held). ` +
        'Wait for the other process to finish, or inspect the lock file before removing it.',
    );
    this.name = 'SagaBusyError';
    this.sagaId = sagaId;
  }
}

export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Unknown errors are deliberately not retried. Only explicitly classified
 * transient failures (or errors marked `retryable: true`) get a retry.
 */
export function classifyError(error: unknown): FailureKind {
  if (error instanceof SagaError) return error.kind;

  if (error && typeof error === 'object') {
    const candidate = error as { retryable?: unknown; status?: unknown; code?: unknown };
    if (candidate.retryable === true) return 'TRANSIENT';
    if (typeof candidate.status === 'number' && (candidate.status === 429 || candidate.status >= 500)) {
      return 'TRANSIENT';
    }
    const transientCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'RATE_LIMITED',
    ]);
    if (typeof candidate.code === 'string' && transientCodes.has(candidate.code)) {
      return 'TRANSIENT';
    }
  }

  return 'PERMANENT';
}

export function errorCode(error: unknown): string {
  if (error instanceof SagaError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNCLASSIFIED_ERROR';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toErrorRecord(
  error: unknown,
  at: string,
  attempt: number | null,
  forcedKind?: FailureKind,
): ErrorRecord {
  return {
    kind: forcedKind ?? classifyError(error),
    code: errorCode(error),
    message: errorMessage(error),
    at,
    attempt,
  };
}
