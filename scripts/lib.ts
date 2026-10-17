import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VirtualClock } from '../src/domain/clock.js';
import type { AdapterScenario, CompensationPolicy, RetryConfig, SagaRecord } from '../src/domain/types.js';
import { DEFAULT_REQUEST } from '../src/domain/types.js';
import { SagaExecutor } from '../src/executor/executor.js';
import { SagaStore } from '../src/persistence/store.js';

export const DEMO_START = '2026-01-01T00:00:00.000Z';

export interface DemoOptions {
  name: string;
  scenario: AdapterScenario;
  compensationPolicy?: Partial<CompensationPolicy>;
  retry?: Partial<RetryConfig>;
  amount?: string;
}

export interface DemoHarness {
  stateDir: string;
  sagaId: string;
  clock: VirtualClock;
  executor: SagaExecutor;
  store: SagaStore;
}

export async function createDemoHarness(options: DemoOptions): Promise<DemoHarness> {
  const stateDir = path.resolve('.demo-state', options.name);
  await fs.rm(stateDir, { recursive: true, force: true });
  const clock = new VirtualClock(DEMO_START);
  const store = new SagaStore(stateDir);
  const executor = new SagaExecutor({
    store,
    clock,
    jitter: () => 0.5,
  });
  return {
    stateDir,
    sagaId: `saga_demo_${options.name}`,
    clock,
    executor,
    store,
  };
}

export async function runDemoSaga(
  harness: DemoHarness,
  options: DemoOptions,
): Promise<SagaRecord> {
  const created = await harness.executor.startSaga({
    sagaId: harness.sagaId,
    clientRequestId: `client_demo_${options.name}`,
    request: {
      ...DEFAULT_REQUEST,
      amountIn: options.amount ?? '100',
    },
    scenario: options.scenario,
    retry: options.retry ?? {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      backoffFactor: 2,
    },
    compensationPolicy: options.compensationPolicy,
    autoRun: false,
  });
  if (!created.created) throw new Error('Demo saga id unexpectedly already existed');
  process.stdout.write(
    `[PERSISTED] ${created.saga.id} state=${created.saga.state} ` +
      `stateDir=${harness.stateDir}\n`,
  );
  return harness.executor.runSaga(harness.sagaId);
}

export function banner(title: string, classification: string): void {
  process.stdout.write(
    [
      '='.repeat(78),
      title,
      `CLASSIFICATION: ${classification}`,
      'SIMULATED ADAPTER ONLY - no wallet, no RPC, no signature, no real transaction.',
      '='.repeat(78),
      '',
    ].join('\n'),
  );
}

export function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DEMO ASSERTION FAILED: ${message}`);
}

export function eventTypes(record: SagaRecord): string[] {
  return record.audit.map((event) => event.type);
}

export function countEvent(record: SagaRecord, type: string): number {
  return record.audit.filter((event) => event.type === type).length;
}

export function printResult(record: SagaRecord): void {
  process.stdout.write(`\nFINAL STATE: ${record.state}\n`);
  process.stdout.write(
    `STEPS: approve=${record.steps.APPROVE.status}/${record.steps.APPROVE.attempts} ` +
      `swap=${record.steps.SWAP.status}/${record.steps.SWAP.attempts} ` +
      `deposit=${record.steps.DEPOSIT.status}/${record.steps.DEPOSIT.attempts}\n`,
  );
  process.stdout.write(
    `COMPENSATION: ${record.compensation?.action ?? 'none'} -> ` +
      `${record.compensation?.status ?? 'not reached'}\n`,
  );
  process.stdout.write(
    `FINAL EVIDENCE: all receipts are simulated; no transaction hash or explorer link exists.\n`,
  );
}
