import { ConfigurationError } from '../domain/errors.js';
import type { SagaRecord } from '../domain/types.js';
import { SimulatedLedger } from '../persistence/ledger.js';
import { SimulatedAdapter } from './simulated.js';
import type { ChainAdapter } from './types.js';

/**
 * Adapter selection is deliberately narrow in this iteration. A future
 * verified testnet adapter would be constructed here for
 * `adapterId === 'verified-testnet'`; the executor and state machine remain
 * unchanged because they depend only on ChainAdapter.
 */
export function createAdapter(saga: SagaRecord, ledger: SimulatedLedger): ChainAdapter {
  if (saga.config.adapterId === 'simulated') {
    return new SimulatedAdapter(ledger, saga.config.scenario);
  }
  throw new ConfigurationError(
    `Adapter "${String(saga.config.adapterId)}" is not implemented. ` +
      'This build only ships the offline simulated adapter.',
  );
}
