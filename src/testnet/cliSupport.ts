import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateTestnetConfig } from '../domain/saga.js';
import type { TestnetConfig } from '../domain/types.js';
import { SagaStore } from '../persistence/store.js';
import { TestnetJournal } from '../persistence/testnetJournal.js';
import type { TestnetClient } from './client.js';
import { defaultAtlanticTestnetConfig } from './config.js';
import { loadEnvFile, redactRpcUrl } from './env.js';
import { ViemTestnetClient } from './viemTestnetClient.js';

export interface TestnetCliOptions {
  envFile: string;
  rpcVar: string;
  keyVar: string;
  address?: string;
  configFile?: string;
  stateDir: string;
  /** Only the execute path may read the signing key. Readiness/planning must not. */
  requireSigning?: boolean;
}

export interface TestnetRuntime {
  client: TestnetClient;
  config: TestnetConfig;
  journal: TestnetJournal;
  store: SagaStore;
  rpcHost: string;
}

function mergeConfig(configFile: string | undefined): TestnetConfig {
  const config = defaultAtlanticTestnetConfig();
  if (!configFile) return config;
  const raw = JSON.parse(readFileSync(configFile, 'utf8')) as {
    tokens?: TestnetConfig['tokens'];
    swap?: TestnetConfig['swap'];
    deposit?: TestnetConfig['deposit'];
  };
  if (raw.tokens) config.tokens = raw.tokens;
  if ('swap' in raw) config.swap = raw.swap ?? null;
  if ('deposit' in raw) config.deposit = raw.deposit ?? null;
  // Approval is never loaded from a config file; it must be supplied per run.
  config.approvedPlan = null;
  return validateTestnetConfig(config);
}

export async function createTestnetRuntime(options: TestnetCliOptions): Promise<TestnetRuntime> {
  const env = loadEnvFile(options.envFile);
  const rpcUrl = env[options.rpcVar];
  if (!rpcUrl) throw new Error(`Missing ${options.rpcVar} in the configured env file`);
  if (!/^https:\/\//.test(rpcUrl)) throw new Error(`${options.rpcVar} must be an https URL`);
  let privateKey: string | undefined;
  if (options.requireSigning) {
    const rawKey = env[options.keyVar];
    if (rawKey) {
      const clean = rawKey.startsWith('0x') ? rawKey.slice(2) : rawKey;
      if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error(`${options.keyVar} is not a valid 32-byte hex private key`);
      }
      privateKey = `0x${clean}`;
    }
    if (!privateKey) throw new Error(`Missing ${options.keyVar}; execution requires a signer`);
  }
  if (!privateKey && !options.address) {
    throw new Error('Provide --address for read-only mode, or a key variable for signing');
  }

  const client = new ViemTestnetClient({
    rpcUrl,
    privateKey,
    address: options.address,
  });
  const config = mergeConfig(options.configFile);
  return {
    client,
    config,
    journal: new TestnetJournal(path.join(options.stateDir, 'testnet-journal.json')),
    store: new SagaStore(options.stateDir),
    rpcHost: redactRpcUrl(rpcUrl),
  };
}
