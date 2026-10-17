import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../domain/clock.js';
import { SagaBusyError, SagaNotFoundError } from '../domain/errors.js';
import { assertSagaId } from '../domain/saga.js';
import type { AuditEvent, SagaRecord } from '../domain/types.js';
import { atomicWriteJson, ensureDir, readJsonIfExists } from './atomic.js';

const LOCK_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{2,80}$/;

interface LockFile {
  sagaId: string;
  token: string;
  pid: number;
  acquiredAt: string;
}

export interface SagaStoreOptions {
  lockStaleMs?: number;
}

/**
 * File-backed saga persistence.
 *
 * Layout (all generated, all git-ignored):
 *   <stateDir>/sagas/<sagaId>.json          authoritative snapshot, atomic write
 *   <stateDir>/sagas/<sagaId>.audit.ndjson  append-oriented audit mirror
 *   <stateDir>/locks/<sagaId>.lock          per-saga execution lock
 *   <stateDir>/simulated-ledger.json        idempotency ledger for simulated calls
 *
 * The JSON snapshot is the source of truth. The NDJSON mirror is rewritten from
 * the snapshot on every save so an inspector can tail it without parsing JSON.
 */
export class SagaStore {
  readonly stateDir: string;
  readonly sagasDir: string;
  readonly locksDir: string;
  readonly ledgerPath: string;
  readonly lockStaleMs: number;
  private initPromise: Promise<void> | null = null;

  constructor(stateDir: string, options: SagaStoreOptions = {}) {
    if (!stateDir || stateDir.trim() === '') throw new Error('stateDir must not be empty');
    this.stateDir = path.resolve(stateDir);
    this.sagasDir = path.join(this.stateDir, 'sagas');
    this.locksDir = path.join(this.stateDir, 'locks');
    this.ledgerPath = path.join(this.stateDir, 'simulated-ledger.json');
    this.lockStaleMs = options.lockStaleMs ?? 5 * 60_000;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.sagasDir);
        await ensureDir(this.locksDir);
      })();
    }
    await this.initPromise;
  }

  private sagaPath(sagaId: string): string {
    assertSagaId(sagaId);
    return path.join(this.sagasDir, `${sagaId}.json`);
  }

  auditMirrorPath(sagaId: string): string {
    assertSagaId(sagaId);
    return path.join(this.sagasDir, `${sagaId}.audit.ndjson`);
  }

  private lockPath(name: string): string {
    if (!LOCK_NAME_PATTERN.test(name) || name.includes('..')) {
      throw new Error(`Invalid lock name: ${name}`);
    }
    return path.join(this.locksDir, `${name}.lock`);
  }

  async save(record: SagaRecord): Promise<void> {
    await this.init();
    assertSagaId(record.id);
    record.revision += 1;
    await atomicWriteJson(this.sagaPath(record.id), record);
    const auditText = record.audit.map((event) => JSON.stringify(event)).join('\n');
    await fs.writeFile(this.auditMirrorPath(record.id), `${auditText}\n`, 'utf8');
  }

  async load(sagaId: string): Promise<SagaRecord> {
    await this.init();
    const record = await readJsonIfExists<SagaRecord>(this.sagaPath(sagaId));
    if (!record) throw new SagaNotFoundError(sagaId);
    if (record.id !== sagaId) throw new Error(`Saga snapshot id mismatch for ${sagaId}`);
    if (record.schemaVersion !== 1) throw new Error(`Unsupported saga schema: ${record.schemaVersion}`);
    return record;
  }

  async loadMaybe(sagaId: string): Promise<SagaRecord | null> {
    await this.init();
    return readJsonIfExists<SagaRecord>(this.sagaPath(sagaId));
  }

  async list(): Promise<SagaRecord[]> {
    await this.init();
    const entries = await fs.readdir(this.sagasDir, { withFileTypes: true });
    const records: SagaRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(this.sagasDir, entry.name);
      const record = await readJsonIfExists<SagaRecord>(fullPath);
      if (record) records.push(record);
    }
    records.sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt);
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
    return records;
  }

  async findByClientRequestId(clientRequestId: string): Promise<SagaRecord | null> {
    const records = await this.list();
    return records.find((record) => record.clientRequestId === clientRequestId) ?? null;
  }

  async acquireLock(name: string, clock?: Clock): Promise<() => Promise<void>> {
    await this.init();
    const lockPath = this.lockPath(name);
    const token = randomBytes(12).toString('hex');
    const body: LockFile = {
      sagaId: name,
      token,
      pid: process.pid,
      acquiredAt: (clock?.now() ?? new Date()).toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            const current = await readJsonIfExists<LockFile>(lockPath);
            if (current?.token === token) await fs.rm(lockPath, { force: true });
          } catch {
            // A lock we cannot read is still not ours; leave it for inspection.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const stat = await fs.stat(lockPath);
          stale = Date.now() - stat.mtimeMs > this.lockStaleMs;
        } catch {
          stale = true;
        }
        if (!stale) throw new SagaBusyError(name);
        await fs.rm(lockPath, { force: true });
      }
    }
    throw new SagaBusyError(name);
  }

  async readAuditMirror(sagaId: string): Promise<AuditEvent[]> {
    const text = await fs.readFile(this.auditMirrorPath(sagaId), 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEvent);
  }
}
