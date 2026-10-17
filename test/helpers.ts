import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { ChainAdapter, CompensationContext, ReconcileContext, SubmitContext } from '../src/adapters/types.js';
import { SimulatedAdapter } from '../src/adapters/simulated.js';
import { VirtualClock } from '../src/domain/clock.js';
import { SUCCESS_SCENARIO } from '../src/domain/scenarios.js';
import type {
  AdapterScenario,
  CompensationAction,
  CompensationPolicy,
  RetryConfig,
  SagaRecord,
  StartSagaInput,
  StepName,
} from '../src/domain/types.js';
import { DEFAULT_REQUEST } from '../src/domain/types.js';
import { SagaExecutor, type ExecutorHooks } from '../src/executor/executor.js';
import { SimulatedLedger } from '../src/persistence/ledger.js';
import { SagaStore } from '../src/persistence/store.js';

export interface AdapterCall {
  kind: 'submit' | 'reconcile' | 'compensate';
  step: StepName;
  attempt?: number;
  action?: CompensationAction;
}

export class RecordingAdapter implements ChainAdapter {
  readonly id: string;
  readonly simulated: boolean;

  constructor(
    private readonly inner: ChainAdapter,
    readonly calls: AdapterCall[],
  ) {
    this.id = inner.id;
    this.simulated = inner.simulated;
  }

  submit(step: StepName, context: SubmitContext): ReturnType<ChainAdapter['submit']> {
    this.calls.push({ kind: 'submit', step, attempt: context.attempt });
    return this.inner.submit(step, context);
  }

  reconcile(step: StepName, context: ReconcileContext): ReturnType<ChainAdapter['reconcile']> {
    this.calls.push({ kind: 'reconcile', step });
    return this.inner.reconcile(step, context);
  }

  supportsCompensation(action: CompensationAction): boolean {
    return this.inner.supportsCompensation(action);
  }

  compensate(context: CompensationContext): ReturnType<ChainAdapter['compensate']> {
    this.calls.push({ kind: 'compensate', step: context.originalStep, action: context.action });
    return this.inner.compensate(context);
  }
}

export interface HarnessOptions {
  scenario?: AdapterScenario;
  retry?: Partial<RetryConfig>;
  compensationPolicy?: Partial<CompensationPolicy>;
  hooks?: ExecutorHooks;
  clock?: VirtualClock;
  adapterFactory?: (adapter: SimulatedAdapter) => ChainAdapter;
}

export interface Harness {
  dir: string;
  clock: VirtualClock;
  store: SagaStore;
  executor: SagaExecutor;
  calls: AdapterCall[];
  start(input?: Partial<StartSagaInput>): Promise<SagaRecord>;
  startRaw(input?: Partial<StartSagaInput>): Promise<SagaRecord>;
  create(input?: Partial<StartSagaInput>): Promise<SagaRecord>;
  resume(hooks?: ExecutorHooks): Promise<SagaRecord>;
  newExecutor(hooks?: ExecutorHooks): SagaExecutor;
  reload(sagaId: string): Promise<SagaRecord>;
  cleanup(): Promise<void>;
}

let counter = 0;

export async function makeHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-saga-test-'));
  const clock = options.clock ?? new VirtualClock('2026-01-01T00:00:00.000Z');
  const store = new SagaStore(dir);
  const calls: AdapterCall[] = [];
  const sagaId = `saga_test_${++counter}`;

  const makeFactory = (custom?: (adapter: SimulatedAdapter) => ChainAdapter) => {
    return (saga: SagaRecord): ChainAdapter => {
      const simulated = new SimulatedAdapter(
        new SimulatedLedger(store.ledgerPath),
        saga.config.scenario,
      );
      return new RecordingAdapter(custom ? custom(simulated) : simulated, calls);
    };
  };

  const newExecutor = (hooks: ExecutorHooks | undefined = options.hooks): SagaExecutor =>
    new SagaExecutor({
      store,
      clock,
      jitter: () => 0.5,
      hooks,
      adapterFactory: makeFactory(options.adapterFactory),
    });

  const executor = newExecutor();

  const create = async (input: Partial<StartSagaInput> = {}): Promise<SagaRecord> => {
    const result = await executor.startSaga({
      sagaId: input.sagaId ?? sagaId,
      request: { ...DEFAULT_REQUEST, ...(input.request ?? {}) },
      scenario: input.scenario ?? options.scenario ?? SUCCESS_SCENARIO,
      retry: input.retry ?? options.retry ?? { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, backoffFactor: 2 },
      compensationPolicy: input.compensationPolicy ?? options.compensationPolicy,
      autoRun: input.autoRun ?? false,
      clientRequestId: input.clientRequestId,
    });
    return result.saga;
  };

  const startRaw = async (input: Partial<StartSagaInput> = {}): Promise<SagaRecord> => {
    const result = await executor.startSaga({
      sagaId: input.sagaId ?? `${sagaId}_run`,
      request: { ...DEFAULT_REQUEST, ...(input.request ?? {}) },
      scenario: input.scenario ?? options.scenario ?? SUCCESS_SCENARIO,
      retry: input.retry ?? options.retry ?? { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, backoffFactor: 2 },
      compensationPolicy: input.compensationPolicy ?? options.compensationPolicy,
      autoRun: true,
    });
    return result.saga;
  };

  const start = async (input: Partial<StartSagaInput> = {}): Promise<SagaRecord> => {
    const created = await create(input);
    return executor.runSaga(created.id);
  };

  const resume = async (hooks?: ExecutorHooks): Promise<SagaRecord> => {
    return newExecutor(hooks).runSaga(sagaId);
  };

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    clock,
    store,
    executor,
    calls,
    start,
    startRaw,
    create,
    resume,
    newExecutor,
    reload: (id: string) => store.load(id),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export function submittedSteps(calls: AdapterCall[]): StepName[] {
  return calls.filter((call) => call.kind === 'submit').map((call) => call.step);
}
