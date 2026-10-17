import type { AuditEvent, ProofReceipt, SagaRecord } from './domain/types.js';

const SIMULATED_DISCLAIMER =
  'SIMULATED ADAPTER - NO WALLET, RPC, SIGNATURE, BROADCAST OR ON-CHAIN TRANSACTION WAS USED.';
const TESTNET_DISCLAIMER =
  'REAL PHAROS ATLANTIC TESTNET (chainId 688689) - TESTNET FUNDS ONLY. NOT MAINNET.';

function receiptLabel(receipt: ProofReceipt): string {
  return receipt.simulated
    ? `receipt=${receipt.simulatedTxRef} (SIMULATED)`
    : `tx=${receipt.txHash} block=${receipt.blockNumber} (ATLANTIC TESTNET)`;
}

function line(char = '='): string {
  return char.repeat(78);
}

function compact(value: unknown): string {
  return JSON.stringify(value);
}

export function formatAuditEvent(event: AuditEvent): string {
  const transition =
    event.from || event.to ? ` ${event.from ?? '-'} -> ${event.to ?? '-'}` : '';
  const step = event.stepId ? ` [${event.stepId}]` : '';
  return (
    `#${String(event.seq).padStart(4, '0')} ${event.at} ${event.level.padEnd(5)} ` +
    `${event.type}${transition}${step} | ${event.message} | ${compact(event.data)}`
  );
}

export function formatAuditLog(record: SagaRecord): string {
  const header = `AUDIT LOG (${record.audit.length} events, ordered by seq)`;
  return [header, ...record.audit.map((event) => formatAuditEvent(event))].join('\n');
}

function stepLine(record: SagaRecord, step: keyof SagaRecord['steps']): string {
  const value = record.steps[step];
  const receipt = value.receipt ? receiptLabel(value.receipt) : 'receipt=none';
  const retry = value.retry
    ? ` last-retry=${value.retry.delayMs}ms@${value.retry.scheduledAt}`
    : '';
  const errors = value.errors.length > 0 ? ` errors=${value.errors.length}` : '';
  return (
    `  ${step.padEnd(8)} ${value.status.padEnd(12)} attempts=${value.attempts} ` +
    `submission=${value.submissionState} ${receipt}${retry}${errors}`
  );
}

export function formatSaga(record: SagaRecord): string {
  const lines: string[] = [];
  lines.push(line());
  lines.push(`SAGA ${record.id}`);
  lines.push(
    record.config.adapterId === 'simulated' ? SIMULATED_DISCLAIMER : TESTNET_DISCLAIMER,
  );
  lines.push(line());
  lines.push(`State:       ${record.state}`);
  lines.push(`Created:     ${record.createdAt}`);
  lines.push(`Updated:     ${record.updatedAt}`);
  lines.push(`Completed:   ${record.completedAt ?? '-'}`);
  lines.push(`Revision:    ${record.revision}`);
  lines.push(`Adapter:     ${record.config.adapterId} (simulated=${record.config.adapterId === 'simulated'})`);
  lines.push(`Scenario:    ${record.config.scenario?.name ?? 'n/a (testnet, no fault injection)'}`);
  lines.push(
    `Request:     ${record.request.amountIn} ${record.request.fromToken} -> ` +
      `${record.request.toToken} -> deposit ${record.request.depositToken}`,
  );
  lines.push(
    `Actors:      owner=${record.request.owner} spender=${record.request.spender} ` +
      `protocol=${record.request.protocol}`,
  );
  lines.push(
    `Retry:       maxAttempts=${record.config.retry.maxAttempts} ` +
      `base=${record.config.retry.baseDelayMs}ms max=${record.config.retry.maxDelayMs}ms ` +
      `factor=${record.config.retry.backoffFactor}`,
  );
  lines.push(
    `Comp policy: swap=${record.config.compensationPolicy.onSwapFailure} ` +
      `deposit=${record.config.compensationPolicy.onDepositFailure}`,
  );
  lines.push(
    record.config.adapterId === 'simulated'
      ? 'Evidence:    SIMULATED receipts only; no transaction hash, no explorer link, no on-chain confirmation.'
      : 'Evidence:    real Atlantic testnet receipts with transaction hashes and explorer links.',
  );
  lines.push('');
  lines.push('STEPS (stable IDs and idempotency keys)');
  for (const step of ['APPROVE', 'SWAP', 'DEPOSIT'] as const) {
    lines.push(`${stepLine(record, step)}`);
    lines.push(`           id=${record.steps[step].id} idem=${record.steps[step].idempotencyKey}`);
  }

  lines.push('');
  lines.push('FAILURE');
  if (!record.failure) {
    lines.push('  none');
  } else {
    lines.push(
      `  step=${record.failure.step} kind=${record.failure.kind} code=${record.failure.code} ` +
        `attempts=${record.failure.attempts} retryExhausted=${record.failure.retryExhausted}`,
    );
    lines.push(`  message=${record.failure.message}`);
    lines.push(`  at=${record.failure.at}`);
  }

  lines.push('');
  lines.push('COMPENSATION / RECOVERY');
  if (!record.compensation) {
    lines.push('  not reached');
  } else {
    lines.push(
      `  required=${record.compensation.required} action=${record.compensation.action} ` +
        `status=${record.compensation.status} attempts=${record.compensation.attempts}`,
    );
    lines.push(`  note=${record.compensation.note}`);
    if (record.compensation.receipt) {
      lines.push(
        `  compensationReceipt=${receiptLabel(record.compensation.receipt)} (NOT a rollback)`,
      );
    }
    if (record.compensation.error) {
      lines.push(`  compensationError=${record.compensation.error.code}: ${record.compensation.error.message}`);
    }
  }

  lines.push('');
  lines.push(formatAuditLog(record));
  lines.push(line());
  lines.push(
    record.config.adapterId === 'simulated'
      ? 'Reminder: simulated receipts are NOT live blockchain evidence.'
      : 'Reminder: TESTNET ONLY. Never treat this as mainnet evidence or real-fund activity.',
  );
  lines.push(line());
  return `${lines.join('\n')}\n`;
}

export function formatSagaSummary(record: SagaRecord): string {
  return (
    `${record.id.padEnd(46)} ${record.state.padEnd(25)} ` +
    `${record.request.amountIn} ${record.request.fromToken}->${record.request.toToken} ` +
    `updated=${record.updatedAt}`
  );
}

export function formatSagaList(records: SagaRecord[]): string {
  if (records.length === 0) return 'No sagas found.\n';
  const lines = [
    `${'SAGA ID'.padEnd(46)} ${'STATE'.padEnd(25)} REQUEST`,
    '-'.repeat(110),
    ...records.map(formatSagaSummary),
    '',
    `${records.length} saga(s).`,
  ];
  return `${lines.join('\n')}\n`;
}
