import { SUCCESS_SCENARIO } from '../src/domain/scenarios.js';
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
    'PHAROS SAGA EXECUTOR - SUCCESS DEMONSTRATION',
    'DEMONSTRATION / SIMULATED - not live blockchain evidence',
  );
  const options = {
    name: 'success',
    scenario: SUCCESS_SCENARIO,
  };
  const harness = await createDemoHarness(options);
  const record = await runDemoSaga(harness, options);

  process.stdout.write(formatSaga(record));

  assertDemo(record.state === 'COMPLETED', 'success demo must finish COMPLETED');
  assertDemo(record.steps.APPROVE.status === 'SUCCEEDED', 'APPROVE must succeed');
  assertDemo(record.steps.SWAP.status === 'SUCCEEDED', 'SWAP must succeed');
  assertDemo(record.steps.DEPOSIT.status === 'SUCCEEDED', 'DEPOSIT must succeed');
  assertDemo(record.steps.APPROVE.attempts === 1, 'APPROVE must need one attempt');
  assertDemo(record.steps.SWAP.attempts === 1, 'SWAP must need one attempt');
  assertDemo(record.steps.DEPOSIT.attempts === 1, 'DEPOSIT must need one attempt');
  assertDemo(record.steps.APPROVE.receipt?.simulated === true, 'APPROVE receipt must be simulated');
  assertDemo(record.steps.SWAP.receipt?.simulated === true, 'SWAP receipt must be simulated');
  assertDemo(record.steps.DEPOSIT.receipt?.simulated === true, 'DEPOSIT receipt must be simulated');
  assertDemo(
    record.steps.DEPOSIT.receipt?.result.amountIn === record.steps.SWAP.receipt?.result.amountOut,
    'DEPOSIT must consume the exact SWAP output',
  );
  assertDemo(countEvent(record, 'RECEIPT_VERIFIED') === 3, 'three receipts must be verified');
  assertDemo(countEvent(record, 'STEP_SUCCEEDED') === 3, 'three steps must be recorded succeeded');

  const order = record.audit
    .filter((event) => event.type === 'STEP_ATTEMPT')
    .map((event) => event.data.step);
  assertDemo(
    order.join(',') === 'APPROVE,SWAP,DEPOSIT',
    `steps must execute in dependency order, got ${order.join(',')}`,
  );

  printResult(record);
  process.stdout.write(
    '\nDEMO RESULT: PASS - APPROVE -> SWAP -> DEPOSIT completed in order with verified simulated receipts.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
