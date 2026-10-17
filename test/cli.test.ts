import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve('src/cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], stateDir: string): CliResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PHAROS_SAGA_STATE_DIR: stateDir },
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('CLI start/inspect/list/audit commands work against persisted state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-saga-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const started = runCli(
    [
      'start',
      '--scenario',
      'success',
      '--id',
      'saga_cli_success',
      '--amount',
      '42',
      '--state-dir',
      dir,
      '--json',
    ],
    dir,
  );
  assert.equal(started.status, 0, started.stderr);
  const record = JSON.parse(started.stdout) as {
    id: string;
    state: string;
    steps: Record<string, { receipt: { simulated: boolean } | null }>;
  };
  assert.equal(record.id, 'saga_cli_success');
  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.steps.APPROVE?.receipt?.simulated, true);

  const inspected = runCli(['inspect', 'saga_cli_success', '--state-dir', dir], dir);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /SAGA saga_cli_success/);
  assert.match(inspected.stdout, /State:\s+COMPLETED/);
  assert.match(inspected.stdout, /SIMULATED ADAPTER/);
  assert.doesNotMatch(inspected.stdout, /0x[a-fA-F0-9]{64}/);

  const listed = runCli(['list', '--state-dir', dir], dir);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /saga_cli_success/);
  assert.match(listed.stdout, /COMPLETED/);

  const audit = runCli(['audit', 'saga_cli_success', '--state-dir', dir], dir);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /AUDIT LOG/);
  assert.match(audit.stdout, /SAGA_CREATED/);
});

test('CLI --no-run persists CREATED and a later run completes the same saga', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-saga-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const created = runCli(
    ['start', '--no-run', '--id', 'saga_cli_deferred', '--state-dir', dir, '--json'],
    dir,
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal((JSON.parse(created.stdout) as { state: string }).state, 'CREATED');

  const resumed = runCli(['run', 'saga_cli_deferred', '--state-dir', dir, '--json'], dir);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal((JSON.parse(resumed.stdout) as { state: string }).state, 'COMPLETED');
});

test('CLI returns a failure exit code for a FAILED saga and a not-found code for unknown ids', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharos-saga-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const failed = runCli(
    [
      'start',
      '--scenario',
      'approval-failure',
      '--id',
      'saga_cli_failure',
      '--state-dir',
      dir,
    ],
    dir,
  );
  assert.equal(failed.status, 3);
  assert.match(failed.stdout, /State:\s+FAILED/);
  assert.match(failed.stdout, /SWAP\s+PENDING/);

  const missing = runCli(['inspect', 'saga_does_not_exist', '--state-dir', dir], dir);
  assert.equal(missing.status, 6);
  assert.match(missing.stderr, /not found/i);

  const badUsage = runCli(['start', '--unknown-option', 'x', '--state-dir', dir], dir);
  assert.equal(badUsage.status, 64);
  assert.match(badUsage.stderr, /unknown option/i);
});
