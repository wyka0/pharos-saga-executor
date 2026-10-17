import type {
  ReadContractArgs,
  RpcReceipt,
  RpcTransactionRequest,
  TestnetClient,
} from '../src/testnet/client.js';
import type { TestnetConfig } from '../src/domain/types.js';
import { ATLANTIC_TOKENS } from '../src/testnet/config.js';

export const TEST_WALLET = '0xE2B8651178ade144003537eA509E37877dba40bb';
export const TEST_TOKEN = ATLANTIC_TOKENS[0]!;
export const TEST_PROTOCOL = '0x1111111111111111111111111111111111111111';

export type SendMode = 'success' | 'revert' | 'throw' | 'timeout' | 'no-postcondition';

export class FakeTestnetClient implements TestnetClient {
  chainId = 688689;
  address = TEST_WALLET;
  nativeBalance = 542_613_955_838_483_504n;
  balances = new Map<string, bigint>([
    [`${TEST_TOKEN.address.toLowerCase()}:${TEST_WALLET.toLowerCase()}`, 0n],
  ]);
  allowances = new Map<string, bigint>();
  codes = new Map<string, string>();
  gasEstimate = 71_377n;
  gasPrice = 10_000_000_000n;
  sendMode: SendMode = 'success';
  chainIdFailures = 0;
  sendCalls: RpcTransactionRequest[] = [];
  receipts = new Map<string, RpcReceipt>();
  private nonce = 13;
  private hashCounter = 0;

  constructor() {
    this.codes.set(TEST_TOKEN.address.toLowerCase(), '0x60006000');
    this.codes.set(TEST_PROTOCOL.toLowerCase(), '0x60006000');
  }

  getAddress(): string {
    return this.address;
  }

  async getChainId(): Promise<number> {
    if (this.chainIdFailures > 0) {
      this.chainIdFailures -= 1;
      throw new Error('transient read failure');
    }
    return this.chainId;
  }

  async getBlockNumber(): Promise<bigint> {
    return 31_539_564n;
  }

  async getBalance(): Promise<bigint> {
    return this.nativeBalance;
  }

  async getCode(address: string): Promise<string> {
    return this.codes.get(address.toLowerCase()) ?? '0x';
  }

  async readContract<T>(args: ReadContractArgs): Promise<T> {
    const token = args.address.toLowerCase();
    if (args.functionName === 'symbol') return (token === TEST_TOKEN.address.toLowerCase() ? TEST_TOKEN.symbol : 'UNKNOWN') as T;
    if (args.functionName === 'decimals') return (token === TEST_TOKEN.address.toLowerCase() ? TEST_TOKEN.decimals : 18) as T;
    if (args.functionName === 'totalSupply') return 100_000_000_000n as T;
    if (args.functionName === 'balanceOf') {
      const owner = String((args.args as unknown[])[0]).toLowerCase();
      return (this.balances.get(`${token}:${owner}`) ?? 0n) as T;
    }
    if (args.functionName === 'allowance') {
      const [owner, spender] = args.args as unknown[];
      return (this.allowances.get(`${token}:${String(owner).toLowerCase()}:${String(spender).toLowerCase()}`) ?? 0n) as T;
    }
    throw new Error(`Fake client does not implement ${args.functionName}`);
  }

  async estimateGas(): Promise<bigint> {
    return this.gasEstimate;
  }

  async getGasPrice(): Promise<bigint> {
    return this.gasPrice;
  }

  async getTransactionCount(): Promise<number> {
    return this.nonce;
  }

  async getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
    return this.receipts.get(hash) ?? null;
  }

  async waitForTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
    if (this.sendMode === 'timeout') return null;
    return this.receipts.get(hash) ?? null;
  }

  async sendTransaction(tx: RpcTransactionRequest): Promise<string> {
    this.sendCalls.push(tx);
    if (this.sendMode === 'throw') throw new Error('simulated RPC send failure');
    if (tx.chainId !== 688689) throw new Error('Wrong chain id');
    this.hashCounter += 1;
    this.nonce += 1;
    const hash = `0x${this.hashCounter.toString(16).padStart(64, '0')}`;
    if (this.sendMode === 'timeout') return hash;
    const reverted = this.sendMode === 'revert';
    const receipt: RpcReceipt = {
      transactionHash: hash,
      blockNumber: '31539565',
      blockHash: `0x${'ab'.repeat(32)}`,
      status: reverted ? 'reverted' : 'success',
      gasUsed: reverted ? '23000' : this.gasEstimate.toString(),
      effectiveGasPrice: this.gasPrice.toString(),
      from: this.address,
      to: tx.to,
      confirmations: 1,
    };
    this.receipts.set(hash, receipt);
    if (!reverted && this.sendMode !== 'no-postcondition') {
      this.applyApprove(tx);
    }
    return hash;
  }

  private applyApprove(tx: RpcTransactionRequest): void {
    if (!tx.data.startsWith('0x095ea7b3')) return;
    const spenderWord = tx.data.slice(10, 74);
    const spender = `0x${spenderWord.slice(-40)}`.toLowerCase();
    const amount = BigInt(`0x${tx.data.slice(74, 138)}`);
    this.allowances.set(`${tx.to.toLowerCase()}:${this.address.toLowerCase()}:${spender}`, amount);
  }

  setBalance(amount: bigint): void {
    this.balances.set(`${TEST_TOKEN.address.toLowerCase()}:${this.address.toLowerCase()}`, amount);
  }

  getAllowance(): bigint {
    return (
      this.allowances.get(
        `${TEST_TOKEN.address.toLowerCase()}:${this.address.toLowerCase()}:${TEST_PROTOCOL.toLowerCase()}`,
      ) ?? 0n
    );
  }
}

export function testConfig(overrides: Partial<TestnetConfig> = {}): TestnetConfig {
  return {
    network: {
      name: 'atlantic-testnet',
      chainId: 688689,
      nativeSymbol: 'PHRS',
      explorerUrl: 'https://atlantic.pharosscan.xyz/',
      rpcUrlEnv: 'PHAROS_TESTNET_RPC_URL',
    },
    tokens: [structuredClone(TEST_TOKEN)],
    swap: {
      name: 'test-fixture-router',
      address: TEST_PROTOCOL,
      kind: 'swap',
      verifiedSource: 'TEST FIXTURE ONLY - not a real deployed protocol',
    },
    deposit: null,
    approvedPlan: null,
    ...overrides,
  };
}
