import { MANUAL_RECOVERY_SCENARIO } from '../src/domain/scenarios.js';
import { formatSaga } from '../src/render.js';
import {
  assertDemo,
  banner,
  countEvent,
  createDemoHarness,
  printResult,
  runDemoSaga,
} from './lib.js';

async function main(): Promise<void> {
  banner(
    'PHAROS SAGA EXECUTOR - MANUAL RECOVERY DEMONSTRATION',
    'DEMONSTRATION / SIMULATED - injected compensation failure, not live blockchain evidence',
  );
  const options = {
    name: 'manual',
    scenario: MANUAL_RECOVERY_SCENARIO,
    compensationPolicy: {
      onSwapFailure: 'REVOKE_APPROVAL' as const,
      onDepositFailure: 'SIMULATED_UNWIND_SWAP' as const,
    },
  };
  const harness = await createDemoHarness(options);
  const record = await runDemoSaga(harness, options);

  process.stdout.write(formatSaga(record));

  assertDemo(record.state === 'MANUAL_RECOVERY_REQUIRED', 'saga must stop for manual recovery');
  assertDemo(record.steps.APPROVE.status === 'SUCCEEDED', 'APPROVE must remain succeeded');
  assertDemo(record.steps.SWAP.status === 'FAILED', 'SWAP must be recorded failed');
  assertDemo(record.steps.DEPOSIT.status === 'PENDING', 'DEPOSIT must never start');
  assertDemo(record.steps.DEPOSIT.attempts === 0, 'DEPOSIT must have zero attempts');
  assertDemo(record.failure?.step === 'SWAP', 'original failure must remain on SWAP');
  assertDemo(record.compensation?.status === 'FAILED', 'compensation must be recorded failed');
  assertDemo(
    record.compensation?.error?.code === 'SIMULATED_COMPENSATION_FAILED_REVOKE_APPROVAL',
    'compensation failure must carry its own error code',
  );
  assertDemo(countEvent(record, 'STEP_FAILED') === 1, 'the original step failure must be recorded once');
  assertDemo(
    countEvent(record, 'COMPENSATION_FAILED') === 1,
    'compensation failure must be recorded separately',
  );
  assertDemo(
    record.audit.some((event) => event.type === 'MANUAL_RECOVERY_REQUIRED'),
    'manual recovery transition must be audited',
  );

  printResult(record);
  process.stdout.write(
    '\nDEMO RESULT: PASS - SWAP failed permanently, the configured simulated approval revocation ' +
      'also failed, and the saga stopped in MANUAL_RECOVERY_REQUIRED with both failures and all ' +
      'receipts preserved. Nothing was rolled back and DEPOSIT was never attempted.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
