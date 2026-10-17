import { randomBytes } from 'node:crypto';
import { appendAudit } from './audit.js';
import type { Clock } from './clock.js';
import { ConfigurationError } from './errors.js';
import { assertRetryConfig } from './retry.js';
import { normalizeScenario } from './scenarios.js';
import {
  DEFAULT_COMPENSATION_POLICY,
  DEFAULT_REQUEST,
  DEFAULT_RETRY,
  SAGA_SCHEMA_VERSION,
  SIMULATED_DISCLAIMER,
  STEP_NAMES,
  type CompensationPolicy,
  type SagaConfig,
  type SagaRecord,
  type SagaRequest,
  type StartSagaInput,
  type StepName,
  type StepRecord,
  type TestnetConfig,
  type TestnetToken,
  type LocalAnvilConfig,
} from './types.js';

const SAGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const AMOUNT_PATTERN = /^\d+(\.\d{1,18})?$/;

export function assertSagaId(sagaId: string): void {
  if (!SAGA_ID_PATTERN.test(sagaId) || sagaId.includes('..')) {
    throw new ConfigurationError(
      'saga id must be 3-80 characters of letters, digits, dot, underscore or dash, starting alphanumeric',
    );
  }
}

export function generateSagaId(clock: Clock): string {
  const stamp = clock.now().getTime().toString(36);
  return `saga_${stamp}_${randomBytes(4).toString('hex')}`;
}

function requiredString(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string') throw new ConfigurationError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ConfigurationError(`${label} must not be empty`);
  if (trimmed.length > max) throw new ConfigurationError(`${label} must be at most ${max} characters`);
  return trimmed;
}

export function normalizeRequest(input: SagaRequest): SagaRequest {
  const amountIn = requiredString(input.amountIn, 'request.amountIn', 40);
  if (!AMOUNT_PATTERN.test(amountIn) || Number(amountIn) <= 0) {
    throw new ConfigurationError('request.amountIn must be a positive decimal string (no sign/exponent)');
  }
  const fromToken = requiredString(input.fromToken, 'request.fromToken', 40);
  const toToken = requiredString(input.toToken, 'request.toToken', 40);
  const depositToken = requiredString(input.depositToken, 'request.depositToken', 40);
  if (depositToken !== toToken) {
    throw new ConfigurationError(
      'request.depositToken must equal request.toToken: DEPOSIT consumes the verified SWAP output',
    );
  }
  return {
    owner: requiredString(input.owner, 'request.owner'),
    fromToken,
    toToken,
    depositToken,
    amountIn,
    spender: requiredString(input.spender, 'request.spender'),
    protocol: requiredString(input.protocol, 'request.protocol'),
    depositTarget: requiredString(input.depositTarget, 'request.depositTarget'),
  };
}

export function normalizeCompensationPolicy(
  input: Partial<CompensationPolicy> | undefined,
): CompensationPolicy {
  const policy: CompensationPolicy = {
    onSwapFailure: input?.onSwapFailure ?? DEFAULT_COMPENSATION_POLICY.onSwapFailure,
    onDepositFailure: input?.onDepositFailure ?? DEFAULT_COMPENSATION_POLICY.onDepositFailure,
  };
  if (policy.onSwapFailure !== 'REVOKE_APPROVAL' && policy.onSwapFailure !== 'NONE') {
    throw new ConfigurationError('compensationPolicy.onSwapFailure must be REVOKE_APPROVAL or NONE');
  }
  if (
    policy.onDepositFailure !== 'SIMULATED_UNWIND_SWAP' &&
    policy.onDepositFailure !== 'NONE'
  ) {
    throw new ConfigurationError(
      'compensationPolicy.onDepositFailure must be SIMULATED_UNWIND_SWAP or NONE',
    );
  }
  return policy;
}

function prerequisiteFor(step: StepName): { step: StepName | null; state: SagaRecord['state'] } {
  const index = STEP_NAMES.indexOf(step);
  if (index <= 0) return { step: null, state: 'CREATED' };
  const stepName = STEP_NAMES[index - 1] as StepName;
  return {
    step: stepName,
    state: stepName === 'APPROVE' ? 'APPROVED' : 'SWAPPED',
  };
}

function makeStep(sagaId: string, step: StepName): StepRecord {
  const prerequisite = prerequisiteFor(step);
  return {
    id: `${sagaId}:${step}`,
    name: step,
    status: 'PENDING',
    attempts: 0,
    idempotencyKey: `${sagaId}:${step}:v1`,
    prerequisiteStep: prerequisite.step,
    prerequisiteState: prerequisite.state,
    submissionState: 'NOT_SUBMITTED',
    startedAt: null,
    finishedAt: null,
    verifiedAt: null,
    receipt: null,
    invalidReceiptEvidence: null,
    errors: [],
    retry: null,
  };
}

export function validateTestnetConfig(input: TestnetConfig): TestnetConfig {
  if (input.network.chainId !== 688689 || input.network.name !== 'atlantic-testnet') {
    throw new ConfigurationError('Only Pharos Atlantic testnet (chainId 688689) is allowed');
  }
  let explorerHost = '';
  try {
    explorerHost = new URL(input.network.explorerUrl).hostname;
  } catch {
    throw new ConfigurationError('Testnet explorer URL is invalid');
  }
  if (explorerHost !== 'atlantic.pharosscan.xyz') {
    throw new ConfigurationError('Testnet explorer must be atlantic.pharosscan.xyz');
  }
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(input.network.rpcUrlEnv)) {
    throw new ConfigurationError('network.rpcUrlEnv must be an environment variable NAME');
  }
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const seen = new Set<string>();
  for (const token of input.tokens as TestnetToken[]) {
    if (!addressPattern.test(token.address)) {
      throw new ConfigurationError(`Invalid testnet token address for ${token.symbol}`);
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      throw new ConfigurationError(`Invalid decimals for ${token.symbol}`);
    }
    if (seen.has(token.address.toLowerCase())) {
      throw new ConfigurationError(`Duplicate testnet token address for ${token.symbol}`);
    }
    seen.add(token.address.toLowerCase());
  }
  for (const protocol of [input.swap, input.deposit]) {
    if (protocol && !addressPattern.test(protocol.address)) {
      throw new ConfigurationError(`Invalid testnet ${protocol.kind} protocol address`);
    }
  }
  if (input.approvedPlan && !/^[a-f0-9]{64}$/.test(input.approvedPlan.planHash)) {
    throw new ConfigurationError('approvedPlan.planHash must be a 32-byte lowercase hex digest');
  }
  return structuredClone(input);
}

export function buildConfig(input: StartSagaInput): SagaConfig {
  const adapterId = input.adapterId ?? 'simulated';
  if (adapterId === 'pharos-testnet') {
    if (!input.testnet) {
      throw new ConfigurationError('adapterId pharos-testnet requires a testnet configuration');
    }
    if (input.localAnvil) {
      throw new ConfigurationError('localAnvil configuration requires adapterId local-anvil');
    }
    return {
      adapterId,
      retry: assertRetryConfig(input.retry ?? DEFAULT_RETRY),
      compensationPolicy: normalizeCompensationPolicy(input.compensationPolicy),
      scenario: null,
      testnet: validateTestnetConfig(input.testnet),
      localAnvil: null,
    };
  }
  if (adapterId === 'local-anvil') {
    if (!input.localAnvil) {
      throw new ConfigurationError('adapterId local-anvil requires a localAnvil configuration');
    }
    if (input.testnet) {
      throw new ConfigurationError('testnet configuration cannot be used with adapterId local-anvil');
    }
    return {
      adapterId,
      retry: assertRetryConfig(input.retry ?? DEFAULT_RETRY),
      compensationPolicy: normalizeCompensationPolicy(input.compensationPolicy),
      scenario: null,
      testnet: null,
      localAnvil: validateLocalAnvilConfig(input.localAnvil),
    };
  }
  if (input.testnet || input.localAnvil) {
    throw new ConfigurationError('testnet/localAnvil configuration requires the matching adapterId');
  }
  return {
    adapterId: 'simulated',
    retry: assertRetryConfig(input.retry ?? DEFAULT_RETRY),
    compensationPolicy: normalizeCompensationPolicy(input.compensationPolicy),
    scenario: normalizeScenario(input.scenario),
    testnet: null,
    localAnvil: null,
  };
}

export function validateLocalAnvilConfig(input: LocalAnvilConfig): LocalAnvilConfig {
  if (input.chainId !== 31337) {
    throw new ConfigurationError('Local Anvil adapter requires chainId 31337');
  }
  let url: URL;
  try {
    url = new URL(input.rpcUrl);
  } catch {
    throw new ConfigurationError('localAnvil.rpcUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new ConfigurationError(
      'localAnvil.rpcUrl must be a localhost HTTP endpoint (127.0.0.1 or localhost)',
    );
  }
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  for (const [label, value] of Object.entries({
    owner: input.owner,
    usdc: input.usdc,
    receiptToken: input.receiptToken,
    swap: input.swap,
    vault: input.vault,
  })) {
    if (!addressPattern.test(value)) {
      throw new ConfigurationError(`localAnvil.${label} must be a valid address`);
    }
  }
  return structuredClone(input);
}

export function createSagaRecord(input: StartSagaInput, clock: Clock): SagaRecord {
  const id = input.sagaId ?? generateSagaId(clock);
  assertSagaId(id);

  const now = clock.now().toISOString();
  const request = normalizeRequest(input.request ?? DEFAULT_REQUEST);
  const config = buildConfig(input);
  const clientRequestId =
    input.clientRequestId === undefined ? null : requiredString(input.clientRequestId, 'clientRequestId');

  const steps = Object.fromEntries(
    STEP_NAMES.map((step) => [step, makeStep(id, step)]),
  ) as Record<StepName, StepRecord>;

  const record: SagaRecord = {
    schemaVersion: SAGA_SCHEMA_VERSION,
    id,
    clientRequestId,
    state: 'CREATED',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    request,
    config,
    steps,
    failure: null,
    compensation: null,
    audit: [],
    nextAuditSeq: 1,
    revision: 0,
  };

  appendAudit(record, now, {
    type: 'SAGA_CREATED',
    message: 'Saga created in CREATED state. Simulated adapter selected; no transaction path is enabled.',
    data: {
      adapterId: config.adapterId,
      simulated: config.adapterId === 'simulated',
      disclaimer:
        config.adapterId === 'simulated'
          ? SIMULATED_DISCLAIMER
          : config.adapterId === 'local-anvil'
            ? 'LOCAL ANVIL TEST-ONLY CHAIN (chainId 31337). No Atlantic or mainnet transaction.'
            : 'ON-CHAIN TESTNET - Pharos Atlantic testnet (chainId 688689). Testnet funds only.',
      scenario: config.scenario?.name ?? null,
      testnet: config.testnet
        ? {
            network: config.testnet.network.name,
            chainId: config.testnet.network.chainId,
            swapConfigured: config.testnet.swap !== null,
            depositConfigured: config.testnet.deposit !== null,
            approvedPlan: config.testnet.approvedPlan?.planHash ?? null,
          }
        : null,
      localAnvil: config.localAnvil
        ? {
            chainId: config.localAnvil.chainId,
            rpcUrl: config.localAnvil.rpcUrl,
            usdc: config.localAnvil.usdc,
            swap: config.localAnvil.swap,
            vault: config.localAnvil.vault,
          }
        : null,
      retry: config.retry,
      compensationPolicy: config.compensationPolicy,
      clientRequestId,
    },
  });

  return record;
}
