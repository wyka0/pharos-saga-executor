import { atomicWriteJson, readJsonIfExists } from '../../persistence/atomic.js';

/**
 * Durable deployment journal.
 *
 * An INTENT entry is written (fsync + atomic replace) BEFORE any signing or
 * broadcast. A key with status INTENT/BROADCAST/REVERTED/UNKNOWN means an
 * unresolved outcome: the runner refuses to touch that key again, so a
 * transaction is never automatically resent.
 */
export type DeployJournalStatus = 'INTENT' | 'BROADCAST' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN';

export interface DeployJournalEntry {
  key: string;
  planHash: string;
  order: number;
  name: string;
  kind: 'deploy' | 'wire';
  nonce: number;
  gasLimit: string;
  gasPrice: string;
  to: string | null;
  dataSha256: string;
  artifactSha256: string | null;
  txHash: string | null;
  status: DeployJournalStatus;
  recordedAt: string;
  updatedAt: string;
  contractAddress: string | null;
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  note: string;
}

interface JournalFile {
  version: 1;
  note: string;
  entries: Record<string, DeployJournalEntry>;
}

const FILE_NOTE =
  'GATED DEPLOYMENT JOURNAL - public transaction metadata only. No keys or secrets.';

export class DeployJournal {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(key: string): Promise<DeployJournalEntry | null> {
    const file = await this.load();
    return file.entries[key] ?? null;
  }

  async list(): Promise<DeployJournalEntry[]> {
    const file = await this.load();
    return Object.values(file.entries).sort((a, b) => a.order - b.order);
  }

  async put(entry: DeployJournalEntry): Promise<void> {
    const file = await this.load();
    file.entries[entry.key] = entry;
    await atomicWriteJson(this.filePath, file);
  }

  private async load(): Promise<JournalFile> {
    const file = await readJsonIfExists<JournalFile>(this.filePath);
    return file ?? { version: 1, note: FILE_NOTE, entries: {} };
  }
}

/** Statuses that block a re-run of the same key until a human reconciles. */
export function isUnresolved(status: DeployJournalStatus): boolean {
  return status !== 'CONFIRMED';
}
