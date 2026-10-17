import { UNKNOWN_OUTCOME_SCENARIO } from '../src/domain/scenarios.js';
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
    'PHAROS SAGA EXECUTOR - UNKNOWN SUBMISSION OUTCOME DEMONSTRATION',
    'DEMONSTRATION / SIMULATED - injected unknown outcome, not live blockchain evidence',
  );
  const options = {
    name: 'unknown-outcome',
    scenario: UNKNOWN_OUTCOME_SCENARIO,
  };
  const harness = await createDemoHarness(options);
  const record = await runDemoSaga(harness, options);

  process.stdout.write(formatSaga(record));

  assertDemo(
    record.state === 'MANUAL_RECOVERY_REQUIRED',
    'unknown outcome must stop for manual recovery',
  );
  assertDemo(record.steps.SWAP.status === 'FAILED', 'SWAP must be marked failed/unknown');
  assertDemo(record.steps.SWAP.attempts === 1, 'unknown outcome must not be retried');
  assertDemo(record.steps.DEPOSIT.attempts === 0, 'DEPOSIT must never start');
  assertDemo(record.failure?.kind === 'UNKNOWN_OUTCOME', 'failure kind must be UNKNOWN_OUTCOME');
  assertDemo(
    countEvent(record, 'RECONCILIATION_ATTEMPTED') === 1,
    'reconciliation must be attempted exactly once',
  );
  assertDemo(
    countEvent(record, 'RECONCILIATION_RESULT') === 1,
    'reconciliation result must be recorded',
  );
  assertDemo(countEvent(record, 'RETRY_SCHEDULED') === 0, 'no retry may be scheduled');
  assertDemo(record.compensation === null, 'no compensation may run for an unknown outcome');

  printResult(record);
  process.stdout.write(
    '\nDEMO RESULT: PASS - SWAP outcome was unknown, reconciliation found no receipt, and the ' +
      'executor stopped in MANUAL_RECOVERY_REQUIRED without resubmitting or compensating.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
