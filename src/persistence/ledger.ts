import type { SimulatedReceipt } from '../domain/types.js';
import { atomicWriteJson, readJsonIfExists } from './atomic.js';

interface LedgerEntry {
  key: string;
  receipt: SimulatedReceipt;
  recordedAt: string;
}

interface LedgerFile {
  version: 1;
  note: string;
  entries: Record<string, LedgerEntry>;
}

const EMPTY_LEDGER: LedgerFile = {
  version: 1,
  note: 'SIMULATED ONLY - this ledger records deterministic simulated calls, not blockchain transactions.',
  entries: {},
};

/**
 * Idempotency ledger for the simulated adapter. The receipt is written before
 * the adapter returns, so a crash between "submission" and persistence can be
 * reconciled by idempotency key on the next run.
 *
 * In-process reads/writes are serialized. Cross-process concurrent writers are
 * not supported; the executor's per-saga file lock covers one saga at a time.
 */
export class SimulatedLedger {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<LedgerFile> {
    const parsed = await readJsonIfExists<LedgerFile>(this.filePath);
    if (!parsed) return structuredClone(EMPTY_LEDGER);
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new Error(`Invalid simulated ledger at ${this.filePath}`);
    }
    return parsed;
  }

  async get(key: string): Promise<SimulatedReceipt | null> {
    const ledger = await this.read();
    return ledger.entries[key]?.receipt ?? null;
  }

  async put(key: string, receipt: SimulatedReceipt, recordedAt: string): Promise<void> {
    const operation = async (): Promise<void> => {
      const ledger = await this.read();
      ledger.entries[key] = { key, receipt, recordedAt };
      await atomicWriteJson(this.filePath, ledger);
    };
    const queued = this.queue.then(operation, operation);
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  async keys(): Promise<string[]> {
    return Object.keys((await this.read()).entries).sort();
  }
}
