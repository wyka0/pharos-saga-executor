import type { AuditEvent, AuditEventType, SagaRecord, SagaState } from './types.js';

export interface AuditInput {
  type: AuditEventType;
  message: string;
  level?: AuditEvent['level'];
  stepId?: string | null;
  from?: SagaState | null;
  to?: SagaState | null;
  data?: Record<string, unknown>;
}

/**
 * Appends one audit event to the saga's in-memory log and returns it.
 * The caller persists the record before doing anything else that matters.
 */
export function appendAudit(record: SagaRecord, at: string, input: AuditInput): AuditEvent {
  const event: AuditEvent = {
    seq: record.nextAuditSeq,
    at,
    type: input.type,
    level: input.level ?? 'INFO',
    sagaId: record.id,
    stepId: input.stepId ?? null,
    message: input.message,
    from: input.from ?? null,
    to: input.to ?? null,
    data: input.data ?? {},
  };
  record.nextAuditSeq += 1;
  record.audit.push(event);
  return event;
}

/** Events must be strictly ordered and complete. Used by tests and verify. */
export function assertAuditOrdering(events: AuditEvent[]): { ok: true } | { ok: false; reason: string } {
  let previous = 0;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.seq !== previous + 1) {
      return { ok: false, reason: `expected seq ${previous + 1}, got ${event.seq}` };
    }
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) return { ok: false, reason: `invalid timestamp at seq ${event.seq}` };
    if (time < previousTime) {
      return { ok: false, reason: `timestamp moved backwards at seq ${event.seq}` };
    }
    previous = event.seq;
    previousTime = time;
  }
  return { ok: true };
}
