import type { PlanApproval, TestnetNetworkConfig } from '../domain/types.js';

export interface RpcTransactionRequest {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  nonce: number;
  chainId: 688689;
}

export interface RpcReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status: 'success' | 'reverted';
  gasUsed: string;
  effectiveGasPrice: string;
  from: string;
  to: string | null;
  confirmations: number;
}

export interface ReadContractArgs {
  address: string;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Narrow chain client used by PharosTestnetAdapter. The real implementation is
 * in viemTestnetClient.ts; tests inject a fake so the suite stays offline.
 */
export interface TestnetClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getCode(address: string): Promise<string>;
  readContract<T>(args: ReadContractArgs): Promise<T>;
  estimateGas(tx: RpcTransactionRequest): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  getTransactionCount(address: string, blockTag?: 'latest' | 'pending'): Promise<number>;
  getTransactionReceipt(hash: string): Promise<RpcReceipt | null>;
  waitForTransactionReceipt(hash: string, timeoutMs: number): Promise<RpcReceipt | null>;
  getAddress(): string;
  sendTransaction(tx: RpcTransactionRequest): Promise<string>;
}

export interface TestnetClientOptions {
  rpcUrl: string;
  /** Required for signing/broadcast. Omitted for read-only readiness/planning. */
  privateKey?: string;
  /** Required when no privateKey is supplied. */
  address?: string;
  timeoutMs?: number;
}

export interface TestnetNetworkGuard {
  network: TestnetNetworkConfig;
  expectedChainId: 688689;
}

export interface ApprovalGate {
  /** The exact plan hash the user approved. */
  approval: PlanApproval | null;
}
