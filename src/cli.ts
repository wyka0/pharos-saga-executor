#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ConfigurationError, SagaBusyError, SagaNotFoundError } from './domain/errors.js';
import { scenarioByName, SCENARIO_NAMES } from './domain/scenarios.js';
import type {
  CompensationPolicy,
  SagaRecord,
  StartSagaInput,
} from './domain/types.js';
import { DEFAULT_REQUEST } from './domain/types.js';
import { SagaExecutor } from './executor/executor.js';
import { SagaStore } from './persistence/store.js';
import { formatAuditLog, formatSaga, formatSagaList } from './render.js';

class UsageError extends Error {
  readonly code = 'USAGE';
}

interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

const VALUE_OPTIONS = new Set([
  'state-dir',
  'id',
  'client-request-id',
  'scenario',
  'from',
  'to',
  'deposit-token',
  'amount',
  'owner',
  'spender',
  'protocol',
  'deposit-target',
  'max-attempts',
  'base-delay-ms',
  'max-delay-ms',
  'backoff-factor',
  'compensation-swap',
  'compensation-deposit',
]);

const BOOLEAN_FLAGS = new Set(['json', 'no-run', 'help']);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} does not take a value`);
      flags.add(key);
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new UsageError(`Unknown option --${key}`);
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = args[i + 1];
      i += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`Option --${key} requires a value`);
    }
    options.set(key, value);
  }
  return { positional, flags, options };
}

function stateDir(parsed: ParsedArgs): string {
  return parsed.options.get('state-dir') ?? process.env.PHAROS_SAGA_STATE_DIR?.trim() ?? 'state';
}

function makeExecutor(parsed: ParsedArgs): SagaExecutor {
  return new SagaExecutor({ store: new SagaStore(stateDir(parsed)) });
}

function optionalInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new UsageError(`${label} must be an integer`);
  return parsed;
}

function optionalNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${label} must be a number`);
  return parsed;
}

function parseCompensation(parsed: ParsedArgs): Partial<CompensationPolicy> {
  const policy: Partial<CompensationPolicy> = {};
  const swap = parsed.options.get('compensation-swap');
  if (swap !== undefined) {
    if (swap === 'revoke') policy.onSwapFailure = 'REVOKE_APPROVAL';
    else if (swap === 'none') policy.onSwapFailure = 'NONE';
    else throw new UsageError('--compensation-swap must be revoke or none');
  }
  const deposit = parsed.options.get('compensation-deposit');
  if (deposit !== undefined) {
    if (deposit === 'unwind') policy.onDepositFailure = 'SIMULATED_UNWIND_SWAP';
    else if (deposit === 'none') policy.onDepositFailure = 'NONE';
    else throw new UsageError('--compensation-deposit must be unwind or none');
  }
  return policy;
}

function statusExitCode(record: SagaRecord): number {
  if (record.state === 'COMPLETED') return 0;
  if (record.state === 'FAILED') return 3;
  if (record.state === 'MANUAL_RECOVERY_REQUIRED') return 4;
  return 0;
}

function output(parsed: ParsedArgs, record: SagaRecord): void {
  if (parsed.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    process.stdout.write(formatSaga(record));
  }
}

function requirePositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positional[index];
  if (!value) throw new UsageError(`Missing ${label}`);
  return value;
}

function printHelp(): void {
  process.stdout.write(
    [
      'pharos-saga - deterministic, resumable APPROVE -> SWAP -> DEPOSIT saga executor',
      'SIMULATED ADAPTER ONLY: no wallet, RPC, signature or real transaction is used.',
      '',
      'Usage:',
      '  pharos-saga start [options]',
      '  pharos-saga run <sagaId> [options]',
      '  pharos-saga inspect <sagaId> [options]',
      '  pharos-saga list [options]',
      '  pharos-saga audit <sagaId> [options]',
      '',
      'Start options:',
      '  --scenario <name>            success | failure | approval-failure | manual-recovery |',
      '                               compensation-unavailable | unknown-outcome |',
      '                               resolvable-unknown | verification-failure',
      '  --id <sagaId>                stable saga id (optional)',
      '  --client-request-id <id>     idempotency key for saga creation',
      '  --from <token>               default PROS',
      '  --to <token>                 default USDC',
      '  --deposit-token <token>      default USDC',
      '  --amount <decimal>           default 100 (simulated units)',
      '  --owner <label>              simulated account label',
      '  --spender <label>            simulated spender label',
      '  --protocol <label>           simulated deposit protocol label',
      '  --deposit-target <label>     simulated vault label',
      '  --max-attempts <n>           bounded retries per step (1-20, default 3)',
      '  --base-delay-ms <n>          exponential backoff base (default 100)',
      '  --max-delay-ms <n>           backoff ceiling (default 1000)',
      '  --backoff-factor <n>         exponential factor (default 2)',
      '  --compensation-swap <mode>   revoke | none',
      '  --compensation-deposit <m>   unwind | none',
      '  --no-run                     create and persist CREATED without executing',
      '',
      'Common options:',
      '  --state-dir <path>           default ./state or PHAROS_SAGA_STATE_DIR',
      '  --json                       print one JSON record instead of text',
      '  --help                       show this help',
      '',
      'Exit codes: 0 completed, 3 failed, 4 manual recovery required,',
      '            5 busy, 6 not found, 64 usage/configuration, 70 internal error.',
      '',
      `Available scenarios: ${SCENARIO_NAMES.join(', ')}`,
    ].join('\n') + '\n',
  );
}

async function commandStart(parsed: ParsedArgs): Promise<number> {
  const scenarioName = parsed.options.get('scenario') ?? 'success';
  const scenario = scenarioByName(scenarioName);
  const request = {
    ...DEFAULT_REQUEST,
    amountIn: parsed.options.get('amount') ?? DEFAULT_REQUEST.amountIn,
    fromToken: parsed.options.get('from') ?? DEFAULT_REQUEST.fromToken,
    toToken: parsed.options.get('to') ?? DEFAULT_REQUEST.toToken,
    depositToken: parsed.options.get('deposit-token') ?? parsed.options.get('to') ?? DEFAULT_REQUEST.depositToken,
    owner: parsed.options.get('owner') ?? DEFAULT_REQUEST.owner,
    spender: parsed.options.get('spender') ?? DEFAULT_REQUEST.spender,
    protocol: parsed.options.get('protocol') ?? DEFAULT_REQUEST.protocol,
    depositTarget: parsed.options.get('deposit-target') ?? DEFAULT_REQUEST.depositTarget,
  };
  const input: StartSagaInput = {
    request,
    scenario,
    sagaId: parsed.options.get('id'),
    clientRequestId: parsed.options.get('client-request-id'),
    autoRun: !parsed.flags.has('no-run'),
    retry: {
      maxAttempts: optionalInt(parsed.options.get('max-attempts'), '--max-attempts'),
      baseDelayMs: optionalNumber(parsed.options.get('base-delay-ms'), '--base-delay-ms'),
      maxDelayMs: optionalNumber(parsed.options.get('max-delay-ms'), '--max-delay-ms'),
      backoffFactor: optionalNumber(parsed.options.get('backoff-factor'), '--backoff-factor'),
    },
    compensationPolicy: parseCompensation(parsed),
  };
  // Remove undefined retry keys so defaults apply cleanly.
  for (const key of Object.keys(input.retry ?? {})) {
    if ((input.retry as Record<string, unknown>)[key] === undefined) {
      delete (input.retry as Record<string, unknown>)[key];
    }
  }
  const executor = makeExecutor(parsed);
  const result = await executor.startSaga(input);
  output(parsed, result.saga);
  if (!parsed.flags.has('json')) {
    process.stdout.write(`created=${result.created}\n`);
  }
  return statusExitCode(result.saga);
}

async function commandRun(parsed: ParsedArgs): Promise<number> {
  const sagaId = requirePositional(parsed, 1, 'saga id');
  const record = await makeExecutor(parsed).runSaga(sagaId);
  output(parsed, record);
  return statusExitCode(record);
}

async function commandInspect(parsed: ParsedArgs): Promise<number> {
  const sagaId = requirePositional(parsed, 1, 'saga id');
  const record = await makeExecutor(parsed).inspectSaga(sagaId);
  output(parsed, record);
  return 0;
}

async function commandList(parsed: ParsedArgs): Promise<number> {
  const records = await makeExecutor(parsed).listSagas();
  if (parsed.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
  } else {
    process.stdout.write(formatSagaList(records));
  }
  return 0;
}

async function commandAudit(parsed: ParsedArgs): Promise<number> {
  const sagaId = requirePositional(parsed, 1, 'saga id');
  const record = await makeExecutor(parsed).inspectSaga(sagaId);
  if (parsed.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(record.audit, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAuditLog(record)}\n`);
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(argv);
  const command = parsed.positional[0] ?? '';
  switch (command) {
    case 'start':
      return commandStart(parsed);
    case 'run':
      return commandRun(parsed);
    case 'inspect':
      return commandInspect(parsed);
    case 'list':
      return commandList(parsed);
    case 'audit':
      return commandAudit(parsed);
    default:
      throw new UsageError(`Unknown command "${command}". Use --help for usage.`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof SagaBusyError) {
        process.stderr.write(`busy: ${error.message}\n`);
        process.exitCode = 5;
        return;
      }
      if (error instanceof SagaNotFoundError) {
        process.stderr.write(`not found: ${error.message}\n`);
        process.exitCode = 6;
        return;
      }
      if (error instanceof UsageError || error instanceof ConfigurationError) {
        process.stderr.write(`usage/configuration error: ${error.message}\n`);
        process.exitCode = 64;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`internal error: ${message}\n`);
      process.exitCode = 70;
    });
}
