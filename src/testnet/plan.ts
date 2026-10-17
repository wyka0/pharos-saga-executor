import type { StepName } from '../domain/types.js';

export interface PlannedTransaction {
  kind: 'APPROVE' | 'REVOKE_APPROVAL' | 'SWAP' | 'DEPOSIT';
  from: string;
  to: string;
  data: string;
  value: string;
  gasEstimate: string;
  gasPriceWei: string;
  maxFeePerGasWei: string;
  maxCostWei: string;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  amount: string | null;
  decimals: number | null;
  spender: string | null;
  description: string;
}

export interface TransactionPlan {
  step: StepName | 'COMPENSATION_REVOKE_APPROVAL';
  network: 'atlantic-testnet';
  chainId: 688689;
  wallet: string;
  nonce: number;
  createdAt: string;
  executable: boolean;
  blockedReasons: string[];
  transactions: PlannedTransaction[];
  expectedPostconditions: string[];
  maxTestnetCostWei: string;
  planHash: string;
  approvalRequired: true;
}

export interface TokenReadiness {
  symbol: string;
  address: string;
  decimals: number;
  codePresent: boolean;
  onChainSymbol: string | null;
  onChainDecimals: number | null;
  balance: string;
  balanceRaw: string;
  totalSupply: string;
  verified: boolean;
  error: string | null;
}

export interface CapabilityReadiness {
  available: boolean;
  reasons: string[];
}

export interface TestnetReadiness {
  ok: boolean;
  checkedAt: string;
  network: {
    name: 'atlantic-testnet';
    chainId: number;
    expectedChainId: 688689;
    nativeSymbol: 'PHRS';
    explorerUrl: string;
    blockNumber: string;
  };
  wallet: string;
  nativeBalance: string;
  tokens: TokenReadiness[];
  protocols: {
    swap: { address: string; codePresent: boolean } | null;
    deposit: { address: string; codePresent: boolean } | null;
  };
  faucet: {
    documented: boolean;
    url: string | null;
    note: string;
  };
  capabilities: {
    approve: CapabilityReadiness;
    swap: CapabilityReadiness;
    deposit: CapabilityReadiness;
  };
  warnings: string[];
}
