/**
 * Shared domain types for the Pharos Saga Executor.
 *
 * IMPORTANT: this first iteration has a simulated adapter only. Nothing in
 * these types represents a live chain transaction. Receipts carry an explicit
 * `simulated: true` brand and a `disclaimer`; the verifier rejects anything
 * that looks like a real transaction reference.
 */

export const SAGA_SCHEMA_VERSION = 1 as const;

export const SAGA_STATES = [
  'CREATED',
  'APPROVAL_PENDING',
  'APPROVED',
  'SWAP_PENDING',
  'SWAPPED',
  'DEPOSIT_PENDING',
  'COMPLETED',
  'RETRY_WAIT',
  'COMPENSATING',
  'FAILED',
  'MANUAL_RECOVERY_REQUIRED',
] as const;

export type SagaState = (typeof SAGA_STATES)[number];

export const STEP_NAMES = ['APPROVE', 'SWAP', 'DEPOSIT'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type StepStatus = 'PENDING' | 'IN_PROGRESS' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED';
export type SubmissionState =
  | 'NOT_SUBMITTED'
  | 'IN_FLIGHT'
  | 'UNKNOWN_OUTCOME'
  | 'VERIFIED';

export type FailureKind =
  | 'TRANSIENT'
  | 'PERMANENT'
  | 'UNKNOWN_OUTCOME'
  | 'VERIFICATION'
  | 'INTERNAL';

export type SettlementState = 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE';

export type CompensationAction = 'REVOKE_APPROVAL' | 'SIMULATED_UNWIND_SWAP';
export type CompensationPolicyAction = CompensationAction | 'NONE';
export type CompensationStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'SKIPPED';

export interface SagaRequest {
  /** A label for a simulated account. Never a private key or real address. */
  owner: string;
  fromToken: string;
  toToken: string;
  depositToken: string;
  /** Decimal amount in simulated units, e.g. "100". */
  amountIn: string;
  spender: string;
  protocol: string;
  depositTarget: string;
}

export interface RetryConfig {
  /** Total submission attempts allowed per step. 1 means no retry. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface CompensationPolicy {
  onSwapFailure: 'REVOKE_APPROVAL' | 'NONE';
  onDepositFailure: 'SIMULATED_UNWIND_SWAP' | 'NONE';
}

export type CompensationOutcome = 'SUCCESS' | 'FAILURE' | 'UNAVAILABLE';
export type UnknownOutcomeMode = 'RESOLVABLE' | 'UNRESOLVABLE';
export type VerificationFault =
  | 'NONE'
  | 'MISMATCHED_STEP'
  | 'SIMULATED_REVERTED'
  | 'MISSING_RECEIPT'
  | 'NOT_SIMULATED'
  | 'REAL_LOOKING_TX_REF';

export interface StepFaults {
  /** Throw this many transient errors before any success is possible. */
  transientFailures: number;
  /** After transient failures are exhausted, throw a permanent error. */
  permanentFailure: boolean;
  /** Simulate a submission with an unknown outcome. */
  unknownOutcome: UnknownOutcomeMode | null;
  /** Corrupt the receipt returned to the executor (adapter-side demo only). */
  verificationFault: VerificationFault;
}

export interface AdapterScenario {
  name: string;
  approve: StepFaults;
  swap: StepFaults;
  deposit: StepFaults;
  compensation: {
    revokeApproval: CompensationOutcome;
    unwindSwap: CompensationOutcome;
  };
}

export interface TestnetToken {
  symbol: string;
  address: string;
  decimals: number;
  /** Human-readable provenance, e.g. docs.pharos.xyz/getting-started/token-registry. */
  verifiedSource: string;
}

export interface TestnetProtocol {
  name: string;
  address: string;
  kind: 'swap' | 'deposit';
  verifiedSource: string;
}

export interface TestnetNetworkConfig {
  name: 'atlantic-testnet';
  chainId: 688689;
  nativeSymbol: 'PHRS';
  explorerUrl: string;
  /** Name of the env var holding the RPC URL. Never the URL itself (it may contain a key). */
  rpcUrlEnv: string;
}

export interface PlanApproval {
  planHash: string;
  approvedAt: string;
  approvedBy: string;
}

/**
 * Testnet configuration. It contains no secret material: only public addresses,
 * a documentation provenance string, the NAME of an RPC env var, and an
 * optional approval record for a specific plan hash.
 */
export interface TestnetConfig {
  network: TestnetNetworkConfig;
  tokens: TestnetToken[];
  swap: TestnetProtocol | null;
  deposit: TestnetProtocol | null;
  approvedPlan: PlanApproval | null;
}

export interface SagaConfig {
  adapterId: 'simulated' | 'pharos-testnet';
  retry: RetryConfig;
  compensationPolicy: CompensationPolicy;
  scenario: AdapterScenario | null;
  testnet: TestnetConfig | null;
}

export interface ErrorRecord {
  kind: FailureKind;
  code: string;
  message: string;
  at: string;
  attempt: number | null;
}

export interface RetrySchedule {
  attempt: number;
  scheduledAt: string;
  delayMs: number;
  jitter: number;
  reason: string;
}

export interface ReceiptResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  allowance: string | null;
  spender: string | null;
  shares: string | null;
  protocol: string | null;
}

export type ReceiptOperation =
  | 'APPROVE'
  | 'SWAP'
  | 'DEPOSIT'
  | 'COMPENSATION_REVOKE_APPROVAL'
  | 'COMPENSATION_UNWIND_SWAP';

export interface SimulatedReceipt {
  receiptVersion: 1;
  receiptKind: 'STEP' | 'COMPENSATION';
  simulated: true;
  network: 'simulated';
  disclaimer: string;
  simulatedTxRef: string;
  sagaId: string;
  stepId: string;
  idempotencyKey: string;
  operation: ReceiptOperation;
  simulatedStatus: 'SIMULATED_VERIFIED' | 'SIMULATED_REVERTED';
  issuedAt: string;
  result: ReceiptResult;
  evidence: {
    adapter: 'simulated';
    noOnChainTransaction: true;
    note: string;
  };
  compensatesStep?: StepName;
}

export interface OnChainPostcondition {
  name: string;
  expected: string;
  observed: string;
}

/** A real testnet receipt. Distinct type from SimulatedReceipt by construction. */
export interface OnChainReceipt {
  receiptVersion: 1;
  receiptKind: 'STEP' | 'COMPENSATION';
  simulated: false;
  network: 'atlantic-testnet';
  chainId: 688689;
  disclaimer: string;
  txHash: string;
  blockNumber: string;
  blockHash: string;
  status: 'SUCCESS';
  confirmations: number;
  from: string;
  to: string;
  explorerUrl: string;
  sagaId: string;
  stepId: string;
  idempotencyKey: string;
  operation: ReceiptOperation;
  issuedAt: string;
  result: ReceiptResult;
  gasUsed: string;
  effectiveGasPrice: string;
  postconditions: OnChainPostcondition[];
  compensatesStep?: StepName;
}

export type ProofReceipt = SimulatedReceipt | OnChainReceipt;

export interface StepRecord {
  /** Stable identifier: `<sagaId>:<STEP>`. */
  id: string;
  name: StepName;
  status: StepStatus;
  attempts: number;
  idempotencyKey: string;
  prerequisiteStep: StepName | null;
  prerequisiteState: SagaState;
  submissionState: SubmissionState;
  startedAt: string | null;
  finishedAt: string | null;
  verifiedAt: string | null;
  receipt: ProofReceipt | null;
  /** Evidence of a receipt that failed verification. Treated as untrusted. */
  invalidReceiptEvidence: unknown | null;
  errors: ErrorRecord[];
  retry: RetrySchedule | null;
}

export interface FailureRecord {
  step: StepName;
  kind: FailureKind;
  code: string;
  message: string;
  at: string;
  attempts: number;
  retryExhausted: boolean;
}

export interface CompensationRecord {
  required: boolean;
  action: CompensationPolicyAction;
  status: CompensationStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  receipt: ProofReceipt | null;
  error: ErrorRecord | null;
  note: string;
}

export type AuditEventType =
  | 'SAGA_CREATED'
  | 'SAGA_RUN_STARTED'
  | 'TRANSITION'
  | 'STEP_ATTEMPT'
  | 'STEP_SUCCEEDED'
  | 'STEP_FAILED'
  | 'RETRY_SCHEDULED'
  | 'RETRY_EXHAUSTED'
  | 'RECEIPT_VERIFIED'
  | 'RECEIPT_VERIFICATION_FAILED'
  | 'RECONCILIATION_ATTEMPTED'
  | 'RECONCILIATION_RESULT'
  | 'COMPENSATION_STARTED'
  | 'COMPENSATION_SUCCEEDED'
  | 'COMPENSATION_FAILED'
  | 'COMPENSATION_UNAVAILABLE'
  | 'MANUAL_RECOVERY_REQUIRED'
  | 'SAGA_COMPLETED'
  | 'SAGA_FAILED'
  | 'INTERNAL_ERROR';

export interface AuditEvent {
  /** Monotonic within one saga, starting at 1. */
  seq: number;
  at: string;
  type: AuditEventType;
  level: 'INFO' | 'WARN' | 'ERROR';
  sagaId: string;
  stepId: string | null;
  message: string;
  from: SagaState | null;
  to: SagaState | null;
  data: Record<string, unknown>;
}

export interface SagaRecord {
  schemaVersion: typeof SAGA_SCHEMA_VERSION;
  id: string;
  /** Optional caller-supplied idempotency key for saga creation. */
  clientRequestId: string | null;
  state: SagaState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  request: SagaRequest;
  config: SagaConfig;
  steps: Record<StepName, StepRecord>;
  failure: FailureRecord | null;
  compensation: CompensationRecord | null;
  audit: AuditEvent[];
  nextAuditSeq: number;
  revision: number;
}

export interface StartSagaInput {
  sagaId?: string;
  clientRequestId?: string;
  request: SagaRequest;
  adapterId?: 'simulated' | 'pharos-testnet';
  retry?: Partial<RetryConfig>;
  compensationPolicy?: Partial<CompensationPolicy>;
  scenario?: AdapterScenario;
  testnet?: TestnetConfig;
  /** Defaults to true. Set false to persist CREATED and inspect before running. */
  autoRun?: boolean;
}

export interface StartSagaResult {
  saga: SagaRecord;
  created: boolean;
}

export const DEFAULT_REQUEST: SagaRequest = {
  owner: 'sim:demo-account',
  fromToken: 'PROS',
  toToken: 'USDC',
  depositToken: 'USDC',
  amountIn: '100',
  spender: 'sim:pharos-router',
  protocol: 'sim:pharos-vault',
  depositTarget: 'sim:pharos-vault',
};

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  backoffFactor: 2,
};

export const DEFAULT_COMPENSATION_POLICY: CompensationPolicy = {
  onSwapFailure: 'REVOKE_APPROVAL',
  onDepositFailure: 'SIMULATED_UNWIND_SWAP',
};

export const SIMULATED_DISCLAIMER =
  'SIMULATED ONLY - no wallet was used and no on-chain transaction was sent or confirmed.';

export function pendingStateFor(step: StepName): SagaState {
  switch (step) {
    case 'APPROVE':
      return 'APPROVAL_PENDING';
    case 'SWAP':
      return 'SWAP_PENDING';
    case 'DEPOSIT':
      return 'DEPOSIT_PENDING';
  }
}

export function verifiedStateFor(step: StepName): SagaState {
  switch (step) {
    case 'APPROVE':
      return 'APPROVED';
    case 'SWAP':
      return 'SWAPPED';
    case 'DEPOSIT':
      return 'COMPLETED';
  }
}

export function stepForPendingState(state: SagaState): StepName | null {
  switch (state) {
    case 'APPROVAL_PENDING':
      return 'APPROVE';
    case 'SWAP_PENDING':
      return 'SWAP';
    case 'DEPOSIT_PENDING':
      return 'DEPOSIT';
    default:
      return null;
  }
}

export function isTerminalState(state: SagaState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'MANUAL_RECOVERY_REQUIRED';
}
