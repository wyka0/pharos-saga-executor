import { ConfigurationError } from './errors.js';
import type {
  AdapterScenario,
  CompensationOutcome,
  StepFaults,
  UnknownOutcomeMode,
  VerificationFault,
} from './types.js';

export function makeFaults(overrides: Partial<StepFaults> = {}): StepFaults {
  return {
    transientFailures: overrides.transientFailures ?? 0,
    permanentFailure: overrides.permanentFailure ?? false,
    unknownOutcome: overrides.unknownOutcome ?? null,
    verificationFault: overrides.verificationFault ?? 'NONE',
  };
}

export function makeScenario(
  name: string,
  overrides: {
    approve?: Partial<StepFaults>;
    swap?: Partial<StepFaults>;
    deposit?: Partial<StepFaults>;
    compensation?: {
      revokeApproval?: CompensationOutcome;
      unwindSwap?: CompensationOutcome;
    };
  } = {},
): AdapterScenario {
  return {
    name,
    approve: makeFaults(overrides.approve),
    swap: makeFaults(overrides.swap),
    deposit: makeFaults(overrides.deposit),
    compensation: {
      revokeApproval: overrides.compensation?.revokeApproval ?? 'SUCCESS',
      unwindSwap: overrides.compensation?.unwindSwap ?? 'SUCCESS',
    },
  };
}

export const SUCCESS_SCENARIO = makeScenario('success');
export const FAILURE_SCENARIO = makeScenario('failure', {
  deposit: { transientFailures: 2, permanentFailure: true },
});
export const APPROVAL_FAILURE_SCENARIO = makeScenario('approval-failure', {
  approve: { permanentFailure: true },
});
export const MANUAL_RECOVERY_SCENARIO = makeScenario('manual-recovery', {
  swap: { permanentFailure: true },
  compensation: { revokeApproval: 'FAILURE' },
});
export const COMPENSATION_UNAVAILABLE_SCENARIO = makeScenario('compensation-unavailable', {
  deposit: { permanentFailure: true },
  compensation: { unwindSwap: 'UNAVAILABLE' },
});
export const UNKNOWN_OUTCOME_SCENARIO = makeScenario('unknown-outcome', {
  swap: { unknownOutcome: 'UNRESOLVABLE' },
});
export const RESOLVABLE_UNKNOWN_SCENARIO = makeScenario('resolvable-unknown', {
  swap: { unknownOutcome: 'RESOLVABLE' },
});
export const VERIFICATION_FAILURE_SCENARIO = makeScenario('verification-failure', {
  swap: { verificationFault: 'MISMATCHED_STEP' },
});

const PRESETS: Record<string, AdapterScenario> = {
  success: SUCCESS_SCENARIO,
  failure: FAILURE_SCENARIO,
  'approval-failure': APPROVAL_FAILURE_SCENARIO,
  'manual-recovery': MANUAL_RECOVERY_SCENARIO,
  'compensation-unavailable': COMPENSATION_UNAVAILABLE_SCENARIO,
  'unknown-outcome': UNKNOWN_OUTCOME_SCENARIO,
  'resolvable-unknown': RESOLVABLE_UNKNOWN_SCENARIO,
  'verification-failure': VERIFICATION_FAILURE_SCENARIO,
};

export const SCENARIO_NAMES = Object.keys(PRESETS);

export function scenarioByName(name: string): AdapterScenario {
  const scenario = PRESETS[name];
  if (!scenario) {
    throw new ConfigurationError(
      `Unknown scenario "${name}". Available scenarios: ${SCENARIO_NAMES.join(', ')}`,
    );
  }
  return structuredClone(scenario);
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new ConfigurationError(`${label} must be an integer between 0 and 20`);
  }
}

function assertFaults(input: StepFaults, label: string): void {
  assertCount(input.transientFailures, `${label}.transientFailures`);
  if (typeof input.permanentFailure !== 'boolean') {
    throw new ConfigurationError(`${label}.permanentFailure must be boolean`);
  }
  const unknownModes: Array<UnknownOutcomeMode | null> = ['RESOLVABLE', 'UNRESOLVABLE', null];
  if (!unknownModes.includes(input.unknownOutcome)) {
    throw new ConfigurationError(`${label}.unknownOutcome must be RESOLVABLE, UNRESOLVABLE or null`);
  }
  const faults: VerificationFault[] = [
    'NONE',
    'MISMATCHED_STEP',
    'SIMULATED_REVERTED',
    'MISSING_RECEIPT',
    'NOT_SIMULATED',
    'REAL_LOOKING_TX_REF',
  ];
  if (!faults.includes(input.verificationFault)) {
    throw new ConfigurationError(`${label}.verificationFault is not supported`);
  }
}

export function normalizeScenario(input: AdapterScenario | undefined): AdapterScenario {
  if (!input) return structuredClone(SUCCESS_SCENARIO);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new ConfigurationError('scenario.name must be a non-empty string');
  }
  assertFaults(input.approve, 'scenario.approve');
  assertFaults(input.swap, 'scenario.swap');
  assertFaults(input.deposit, 'scenario.deposit');
  const outcomes: CompensationOutcome[] = ['SUCCESS', 'FAILURE', 'UNAVAILABLE'];
  if (!outcomes.includes(input.compensation.revokeApproval)) {
    throw new ConfigurationError('scenario.compensation.revokeApproval is invalid');
  }
  if (!outcomes.includes(input.compensation.unwindSwap)) {
    throw new ConfigurationError('scenario.compensation.unwindSwap is invalid');
  }
  return structuredClone(input);
}
