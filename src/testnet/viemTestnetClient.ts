import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ATLANTIC_TESTNET } from './config.js';
import type {
  ReadContractArgs,
  RpcReceipt,
  RpcTransactionRequest,
  TestnetClient,
  TestnetClientOptions,
} from './client.js';

const ATLANTIC_CHAIN = {
  id: 688689,
  name: 'Pharos Atlantic Testnet',
  nativeCurrency: { name: 'PHRS', symbol: 'PHRS', decimals: 18 },
  rpcUrls: { default: { http: ['https://atlantic.dplabs-internal.com'] } },
} as const;

function mapReceipt(receipt: {
  transactionHash: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  from: Address;
  to: Address | null;
}): RpcReceipt {
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: (receipt.blockNumber ?? 0n).toString(),
    blockHash: receipt.blockHash ?? '',
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: (receipt.effectiveGasPrice ?? 0n).toString(),
    from: receipt.from,
    to: receipt.to,
    confirmations: 1,
  };
}

/**
 * Real Atlantic-testnet client. Constructed only by the gated testnet CLI;
 * the private key is held inside the viem account and never logged.
 */
export class ViemTestnetClient implements TestnetClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly address: string;
  private readonly timeoutMs: number;

  constructor(options: TestnetClientOptions) {
    this.address =
      options.address ??
      (options.privateKey ? privateKeyToAccount(options.privateKey as Hex).address : '');
    if (!isAddress(this.address)) {
      throw new Error('ViemTestnetClient requires a valid address or a private key to derive one');
    }
    this.account = options.privateKey ? privateKeyToAccount(options.privateKey as Hex) : null;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    const transport = http(options.rpcUrl, { timeout: 20_000, retryCount: 0 });
    this.publicClient = createPublicClient({ chain: ATLANTIC_CHAIN, transport });
    this.walletClient = this.account
      ? createWalletClient({ account: this.account, chain: ATLANTIC_CHAIN, transport })
      : null;
  }

  getAddress(): string {
    return this.address;
  }

  async getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async getBalance(address: string): Promise<bigint> {
    if (!isAddress(address)) throw new Error('Invalid address');
    return this.publicClient.getBalance({ address });
  }

  async getCode(address: string): Promise<string> {
    if (!isAddress(address)) throw new Error('Invalid address');
    return (await this.publicClient.getCode({ address })) ?? '0x';
  }

  async readContract<T>(args: ReadContractArgs): Promise<T> {
    return (await this.publicClient.readContract({
      address: args.address as Address,
      abi: args.abi as never,
      functionName: args.functionName,
      args: args.args as never,
    })) as T;
  }

  async estimateGas(tx: RpcTransactionRequest): Promise<bigint> {
    return this.publicClient.estimateGas({
      account: this.address as Address,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: BigInt(tx.value),
    });
  }

  async getGasPrice(): Promise<bigint> {
    return this.publicClient.getGasPrice();
  }

  async getTransactionCount(address: string, blockTag: 'latest' | 'pending' = 'pending'): Promise<number> {
    if (!isAddress(address)) throw new Error('Invalid address');
    return this.publicClient.getTransactionCount({ address, blockTag });
  }

  async getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: hash as Hex });
      return mapReceipt(receipt);
    } catch (error) {
      if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    }
  }

  async waitForTransactionReceipt(hash: string, timeoutMs: number): Promise<RpcReceipt | null> {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: hash as Hex,
        confirmations: 1,
        timeout: timeoutMs || this.timeoutMs,
      });
      return mapReceipt(receipt);
    } catch (error) {
      if ((error as { name?: string }).name === 'WaitForTransactionReceiptTimeoutError') return null;
      throw error;
    }
  }

  async sendTransaction(tx: RpcTransactionRequest): Promise<string> {
    if (!this.walletClient || !this.account) {
      throw new Error('Refusing to send: no signing key was provided (read-only client)');
    }
    if (tx.chainId !== ATLANTIC_TESTNET.chainId) {
      throw new Error('Refusing to send: chainId is not Atlantic testnet 688689');
    }
    if (tx.from.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error('Refusing to send: from does not match the configured wallet');
    }
    return this.walletClient.sendTransaction({
      account: this.account,
      chain: ATLANTIC_CHAIN,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: BigInt(tx.value),
      gas: BigInt(tx.gas),
      nonce: tx.nonce,
    });
  }
}
