import type { Clock } from '../domain/clock.js';
import { ConfigurationError } from '../domain/errors.js';
import { normalizeScenario } from '../domain/scenarios.js';
import type { SagaRecord } from '../domain/types.js';
import { SimulatedLedger } from '../persistence/ledger.js';
import type { TestnetJournal } from '../persistence/testnetJournal.js';
import { PharosTestnetAdapter } from './pharosTestnet.js';
import { SimulatedAdapter } from './simulated.js';
import type { ChainAdapter } from './types.js';
import type { TestnetClient } from '../testnet/client.js';

export interface TestnetAdapterDeps {
  client: TestnetClient;
  journal: TestnetJournal;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  receiptTimeoutMs?: number;
}

export function createAdapter(
  saga: SagaRecord,
  ledger: SimulatedLedger,
  testnet?: TestnetAdapterDeps,
): ChainAdapter {
  if (saga.config.adapterId === 'simulated') {
    return new SimulatedAdapter(ledger, normalizeScenario(saga.config.scenario ?? undefined));
  }
  if (saga.config.adapterId === 'pharos-testnet') {
    if (!testnet) {
      throw new ConfigurationError(
        'pharos-testnet adapter requires a verified RPC client, journal and testnet config',
      );
    }
    if (!saga.config.testnet) throw new ConfigurationError('Missing testnet configuration on saga');
    return new PharosTestnetAdapter({
      client: testnet.client,
      config: saga.config.testnet,
      journal: testnet.journal,
      clock: testnet.clock,
      sleep: testnet.sleep,
      receiptTimeoutMs: testnet.receiptTimeoutMs,
    });
  }
  throw new ConfigurationError(`Adapter "${String(saga.config.adapterId)}" is not implemented.`);
}
