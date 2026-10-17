import { atomicWriteJson, readJsonIfExists } from './atomic.js';
import type { LocalReceipt, StepName } from '../domain/types.js';

export type LocalJournalStatus = 'INTENT' | 'BROADCAST' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN';

export interface LocalJournalEntry {
  key: string;
  sagaId: string;
  step: StepName;
  nonce: number;
  txHash: string | null;
  status: LocalJournalStatus;
  recordedAt: string;
  updatedAt: string;
  receipt: LocalReceipt | null;
  note: string;
}

interface LocalJournalFile {
  version: 1;
  note: string;
  entries: Record<string, LocalJournalEntry>;
}

const EMPTY: LocalJournalFile = {
  version: 1,
  note: 'LOCAL ANVIL TEST-ONLY JOURNAL - no keys, no Atlantic, no mainnet.',
  entries: {},
};

/** Durable local-only journal. An INTENT is written before any send. */
export class LocalJournal {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<LocalJournalFile> {
    const parsed = await readJsonIfExists<LocalJournalFile>(this.filePath);
    if (!parsed) return structuredClone(EMPTY);
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new Error(`Invalid local journal at ${this.filePath}`);
    }
    return parsed;
  }

  async get(key: string): Promise<LocalJournalEntry | null> {
    return (await this.read()).entries[key] ?? null;
  }

  async put(entry: LocalJournalEntry): Promise<void> {
    const operation = async (): Promise<void> => {
      const journal = await this.read();
      journal.entries[entry.key] = entry;
      await atomicWriteJson(this.filePath, journal);
    };
    const queued = this.queue.then(operation, operation);
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }
}
