import { FAILURE_SCENARIO } from '../src/domain/scenarios.js';
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
    'PHAROS SAGA EXECUTOR - FORCED-FAILURE + COMPENSATION DEMONSTRATION',
    'DEMONSTRATION / SIMULATED - deterministic injected failure, not live blockchain evidence',
  );
  const options = {
    name: 'failure',
    scenario: FAILURE_SCENARIO,
    compensationPolicy: {
      onSwapFailure: 'REVOKE_APPROVAL' as const,
      onDepositFailure: 'SIMULATED_UNWIND_SWAP' as const,
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      backoffFactor: 2,
    },
  };
  const harness = await createDemoHarness(options);
  const record = await runDemoSaga(harness, options);

  process.stdout.write(formatSaga(record));

  assertDemo(record.state === 'FAILED', 'failure demo must end FAILED (compensation is not success)');
  assertDemo(record.steps.APPROVE.status === 'SUCCEEDED', 'APPROVE must succeed');
  assertDemo(record.steps.SWAP.status === 'SUCCEEDED', 'SWAP must succeed');
  assertDemo(record.steps.DEPOSIT.status === 'FAILED', 'DEPOSIT must fail permanently');
  assertDemo(record.steps.DEPOSIT.attempts === 3, 'DEPOSIT must use all three attempts');
  assertDemo(record.failure?.step === 'DEPOSIT', 'failure must be recorded on DEPOSIT');
  assertDemo(record.failure?.attempts === 3, 'failure must occur on the third and final attempt');
  assertDemo(
    record.failure?.code === 'SIMULATED_PERMANENT_DEPOSIT',
    'the final failure must be the injected permanent error',
  );
  assertDemo(countEvent(record, 'RETRY_SCHEDULED') === 2, 'two retries must be scheduled');
  assertDemo(
    countEvent(record, 'RETRY_EXHAUSTED') === 0,
    'the final failure is the injected permanent error, not transient exhaustion',
  );
  assertDemo(
    record.compensation?.status === 'SUCCEEDED',
    'configured simulated compensation must succeed',
  );
  assertDemo(
    record.compensation?.action === 'SIMULATED_UNWIND_SWAP',
    'deposit failure must use the configured unwind swap',
  );
  assertDemo(record.compensation?.receipt?.simulated === true, 'compensation receipt must be simulated');
  assertDemo(
    record.compensation?.receipt?.simulatedTxRef.startsWith('sim_') === true,
    'compensation must use a simulated reference',
  );

  const retryDelays = record.audit
    .filter((event) => event.type === 'RETRY_SCHEDULED')
    .map((event) => event.data.delayMs);
  assertDemo(
    retryDelays.join(',') === '75,150',
    `deterministic jittered delays must be 75,150; got ${retryDelays.join(',')}`,
  );
  assertDemo(
    record.audit.some((event) => event.type === 'COMPENSATION_STARTED'),
    'compensation start must be audited',
  );
  assertDemo(
    record.audit.some((event) => event.type === 'COMPENSATION_SUCCEEDED'),
    'compensation success must be audited separately',
  );

  printResult(record);
  process.stdout.write(
    '\nDEMO RESULT: PASS - DEPOSIT failed transiently twice, retried with bounded jittered backoff, ' +
      'failed permanently on attempt 3, then executed the configured SIMULATED_UNWIND_SWAP. ' +
      'The saga is FAILED, not COMPLETED, and the original failure is preserved.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
