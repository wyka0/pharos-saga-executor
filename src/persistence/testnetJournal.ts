import { atomicWriteJson, readJsonIfExists } from './atomic.js';
import type { OnChainReceipt, StepName } from '../domain/types.js';
import type { TransactionPlan } from '../testnet/plan.js';

export type JournalStatus = 'INTENT' | 'BROADCAST' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN';

export interface TestnetJournalEntry {
  key: string;
  sagaId: string;
  step: StepName;
  planHash: string;
  nonce: number;
  txHash: string | null;
  status: JournalStatus;
  recordedAt: string;
  updatedAt: string;
  receipt: OnChainReceipt | null;
  plan: TransactionPlan | null;
  note: string;
}

interface JournalFile {
  version: 1;
  note: string;
  entries: Record<string, TestnetJournalEntry>;
}

const EMPTY: JournalFile = {
  version: 1,
  note: 'ATLANTIC TESTNET JOURNAL - public transaction metadata only. No keys or secrets.',
  entries: {},
};

/**
 * Durable intent/broadcast journal. An INTENT is written BEFORE a transaction is
 * sent. If the process dies between send and journal update, the key remains
 * INTENT and is treated as an unknown outcome, never as safe to resubmit.
 */
export class TestnetJournal {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<JournalFile> {
    const parsed = await readJsonIfExists<JournalFile>(this.filePath);
    if (!parsed) return structuredClone(EMPTY);
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new Error(`Invalid testnet journal at ${this.filePath}`);
    }
    return parsed;
  }

  async get(key: string): Promise<TestnetJournalEntry | null> {
    return (await this.read()).entries[key] ?? null;
  }

  async put(entry: TestnetJournalEntry): Promise<void> {
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
