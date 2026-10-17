import { createHash } from 'node:crypto';
import { TransientStepError } from '../domain/errors.js';
import type { SagaRecord, StepName, TestnetConfig, TestnetToken } from '../domain/types.js';
import type { TestnetClient } from './client.js';
import { explorerAddressUrl, tokenBySymbol } from './config.js';
import { isTransientRpcMessage } from './readErrors.js';
import type {
  CapabilityReadiness,
  PlannedTransaction,
  TestnetReadiness,
  TokenReadiness,
  TransactionPlan,
} from './plan.js';
import { formatUnits, parseUnits } from './units.js';

export const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

/** Deterministic JSON with sorted object keys, for hashing and comparisons. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashPlan(plan: Omit<TransactionPlan, 'planHash'>): string {
  const { createdAt: _createdAt, ...stable } = plan as TransactionPlan;
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

export function encodeApprove(spender: string, amount: bigint): string {
  if (!isEvmAddress(spender)) throw new Error('encodeApprove: invalid spender');
  const selector = '095ea7b3';
  const spenderWord = spender.slice(2).toLowerCase().padStart(64, '0');
  const amountWord = amount.toString(16).padStart(64, '0');
  return `0x${selector}${spenderWord}${amountWord}`;
}

export interface ReadinessParams {
  fromToken: string;
  amountIn: string;
  spender: string;
}

interface PlanRequest {
  fromToken: string;
  amountIn: string;
  spender: string;
  step: StepName | 'COMPENSATION_REVOKE_APPROVAL';
  wallet: string;
  nonce: number;
  createdAt: string;
}

/**
 * Builds readiness reports and transaction plans. It performs read-only calls
 * only; it has no send capability. The adapter is the only code that broadcasts.
 */
export class TestnetPlanner {
  readonly client: TestnetClient;
  readonly config: TestnetConfig;

  constructor(client: TestnetClient, config: TestnetConfig) {
    this.client = client;
    this.config = config;
  }

  token(symbol: string): TestnetToken | null {
    return tokenBySymbol(this.config, symbol);
  }

  async allowance(token: TestnetToken, owner: string, spender: string): Promise<bigint> {
    return this.client.readContract<bigint>({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
  }

  async inspectToken(
    token: TestnetToken,
    owner: string,
    throwOnTransient = false,
  ): Promise<TokenReadiness> {
    const report: TokenReadiness = {
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
      codePresent: false,
      onChainSymbol: null,
      onChainDecimals: null,
      balance: '0',
      balanceRaw: '0',
      totalSupply: '0',
      verified: false,
      error: null,
    };
    try {
      const code = await this.client.getCode(token.address);
      report.codePresent = typeof code === 'string' && code !== '0x' && code.length > 2;
      if (!report.codePresent) {
        report.error = 'No contract code at the documented address';
        return report;
      }
      const [symbol, decimals, balance, supply] = await Promise.all([
        this.client.readContract<string>({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'symbol',
        }),
        this.client.readContract<number | bigint>({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
        this.client.readContract<bigint>({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [owner],
        }),
        this.client.readContract<bigint>({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'totalSupply',
        }),
      ]);
      report.onChainSymbol = symbol;
      report.onChainDecimals = Number(decimals);
      report.balanceRaw = balance.toString();
      report.balance = formatUnits(balance, Number(decimals));
      report.totalSupply = formatUnits(supply, Number(decimals));
      report.verified = symbol === token.symbol && Number(decimals) === token.decimals;
      if (!report.verified) {
        report.error =
          `On-chain metadata does not match the registry: symbol=${symbol}, decimals=${Number(decimals)}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.error = message;
      if (throwOnTransient && isTransientRpcMessage(message)) {
        throw new TransientStepError('TESTNET_READ_RETRY', `Transient token read failure: ${message}`);
      }
    }
    return report;
  }

  private allowedSpenders(): string[] {
    return [this.config.swap?.address, this.config.deposit?.address]
      .filter((value): value is string => typeof value === 'string' && isEvmAddress(value))
      .map((value) => value.toLowerCase());
  }

  private approveReadiness(
    params: ReadinessParams,
    token: TestnetToken | null,
    tokenReport: TokenReadiness | null,
    allowance: bigint | null,
  ): CapabilityReadiness {
    const reasons: string[] = [];
    if (!token) {
      reasons.push(`Token ${params.fromToken} is not in the verified Atlantic registry`);
    } else if (!tokenReport?.verified) {
      reasons.push(`Token ${params.fromToken} failed on-chain metadata verification`);
    }
    const spenders = this.allowedSpenders();
    if (spenders.length === 0) {
      reasons.push(
        'No verified swap or deposit contract is configured, so there is no justified approval spender',
      );
    } else if (!isEvmAddress(params.spender)) {
      reasons.push('Spender is not a valid address');
    } else if (!spenders.includes(params.spender.toLowerCase())) {
      reasons.push('Spender is not one of the verified configured protocols');
    }
    if (token && tokenReport?.verified) {
      try {
        const amount = parseUnits(params.amountIn, token.decimals);
        if (BigInt(tokenReport.balanceRaw) < amount) {
          reasons.push(
            `Wallet holds ${tokenReport.balance} ${token.symbol}, less than the requested ${params.amountIn}`,
          );
        }
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : 'Invalid amount');
      }
    }
    if (token && allowance !== null && allowance > 0n) {
      reasons.push(
        `An allowance already exists (${formatUnits(allowance, token.decimals)}); ` +
          'this adapter will not issue a redundant approval',
      );
    }
    return { available: reasons.length === 0, reasons };
  }

  async readiness(params: ReadinessParams): Promise<TestnetReadiness> {
    const warnings: string[] = [];
    let chainId = -1;
    let blockNumber = '0';
    let nativeBalance = '0';
    let chainError: string | null = null;
    try {
      chainId = await this.client.getChainId();
    } catch (error) {
      chainError = error instanceof Error ? error.message : String(error);
    }
    if (chainId !== -1) {
      try {
        blockNumber = (await this.client.getBlockNumber()).toString();
      } catch {
        blockNumber = '0';
      }
      try {
        nativeBalance = formatUnits(await this.client.getBalance(this.client.getAddress()), 18);
      } catch (error) {
        warnings.push(`Could not read native balance: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (chainError) warnings.push(`Could not read chain id: ${chainError}`);
    if (chainId !== -1 && chainId !== 688689) {
      warnings.push(`RPC reports chainId ${chainId}, expected 688689 (Atlantic testnet). Refusing to plan.`);
    }

    const token = this.token(params.fromToken);
    const tokenReport = token ? await this.inspectToken(token, this.client.getAddress()) : null;
    const tokens: TokenReadiness[] = [];
    for (const entry of this.config.tokens) {
      tokens.push(
        tokenReport && entry.address.toLowerCase() === tokenReport.address.toLowerCase()
          ? tokenReport
          : await this.inspectToken(entry, this.client.getAddress()),
      );
    }

    let allowance: bigint | null = null;
    if (token && isEvmAddress(params.spender)) {
      try {
        allowance = await this.allowance(token, this.client.getAddress(), params.spender);
      } catch (error) {
        warnings.push(
          `Could not read allowance: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const protocols = {
      swap: this.config.swap
        ? {
            address: this.config.swap.address,
            codePresent: await this.hasCode(this.config.swap.address),
          }
        : null,
      deposit: this.config.deposit
        ? {
            address: this.config.deposit.address,
            codePresent: await this.hasCode(this.config.deposit.address),
          }
        : null,
    };

    const approve = this.approveReadiness(params, token, tokenReport, allowance);
    const swapReasons = this.config.swap
      ? ['No verified swap calldata/ABI planner is configured for this protocol; refusing to guess']
      : [
          'No verified swap/router contract is configured. Official Pharos docs list only token, ' +
            'deployment and Permit2 canonical contracts on Atlantic testnet.',
        ];
    const depositReasons = this.config.deposit
      ? ['No verified deposit calldata/ABI planner is configured for this protocol; refusing to guess']
      : [
          'No verified deposit/vault contract is configured. Official Pharos docs list no deployed ' +
            'lending or vault protocol on Atlantic testnet.',
        ];

    if (!tokenReport?.verified) {
      warnings.push('The requested input token is not usable, so APPROVE cannot be proposed.');
    }

    return {
      ok: chainId === 688689,
      checkedAt: new Date().toISOString(),
      network: {
        name: 'atlantic-testnet',
        chainId,
        expectedChainId: 688689,
        nativeSymbol: 'PHRS',
        explorerUrl: this.config.network.explorerUrl,
        blockNumber,
      },
      wallet: this.client.getAddress(),
      nativeBalance,
      tokens,
      protocols,
      faucet: {
        documented: false,
        url: null,
        note:
          'Official docs mention a Pharos faucet for native PHRS but publish no URL. ' +
          'No documented faucet exists for testnet USDC/USDT/WETH/WPHRS.',
      },
      capabilities: {
        approve,
        swap: { available: false, reasons: swapReasons },
        deposit: { available: false, reasons: depositReasons },
      },
      warnings,
    };
  }

  private async hasCode(address: string): Promise<boolean> {
    try {
      const code = await this.client.getCode(address);
      return typeof code === 'string' && code !== '0x' && code.length > 2;
    } catch {
      return false;
    }
  }

  private blockedPlan(request: PlanRequest, reasons: string[], postconditions: string[] = []): TransactionPlan {
    const base: Omit<TransactionPlan, 'planHash'> = {
      step: request.step,
      network: 'atlantic-testnet',
      chainId: 688689,
      wallet: request.wallet,
      nonce: request.nonce,
      createdAt: request.createdAt,
      executable: false,
      blockedReasons: reasons,
      transactions: [],
      expectedPostconditions: postconditions,
      maxTestnetCostWei: '0',
      approvalRequired: true,
    };
    return { ...base, planHash: hashPlan(base) };
  }

  async planApprove(record: SagaRecord, nonce: number, createdAt: string): Promise<TransactionPlan> {
    const request: PlanRequest = {
      fromToken: record.request.fromToken,
      amountIn: record.request.amountIn,
      spender: record.request.spender,
      step: 'APPROVE',
      wallet: this.client.getAddress(),
      nonce,
      createdAt,
    };
    const token = this.token(record.request.fromToken);
    if (!token) {
      return this.blockedPlan(request, [
        `Token ${record.request.fromToken} is not in the verified Atlantic token registry`,
      ]);
    }
    const report = await this.inspectToken(token, request.wallet, true);
    if (!report.verified) {
      return this.blockedPlan(request, [
        `Token ${token.symbol} failed verification: ${report.error ?? 'metadata mismatch'}`,
      ]);
    }
    if (!isEvmAddress(record.request.spender)) {
      return this.blockedPlan(request, ['Spender is not a valid EVM address']);
    }
    const spenders = this.allowedSpenders();
    if (spenders.length === 0) {
      return this.blockedPlan(request, [
        'No verified swap or deposit contract is configured, so there is no justified approval spender. ' +
          'Refusing to approve an arbitrary address.',
      ]);
    }
    if (!spenders.includes(record.request.spender.toLowerCase())) {
      return this.blockedPlan(request, [
        'Spender is not one of the verified configured protocols. Refusing to approve an arbitrary address.',
      ]);
    }

    let amount: bigint;
    try {
      amount = parseUnits(record.request.amountIn, token.decimals);
    } catch (error) {
      return this.blockedPlan(request, [error instanceof Error ? error.message : 'Invalid amount']);
    }
    const balance = BigInt(report.balanceRaw);
    if (balance < amount) {
      return this.blockedPlan(request, [
        `Insufficient ${token.symbol}: wallet has ${report.balance}, plan needs ${record.request.amountIn}`,
      ]);
    }
    const currentAllowance = await this.allowance(token, request.wallet, record.request.spender);
    if (currentAllowance > 0n) {
      return this.blockedPlan(request, [
        `Allowance is already ${formatUnits(currentAllowance, token.decimals)}. ` +
          'No additional approval is justified.',
      ]);
    }

    const data = encodeApprove(record.request.spender, amount);
    let gasEstimate: bigint;
    try {
      gasEstimate = await this.client.estimateGas({
        from: request.wallet,
        to: token.address,
        data,
        value: '0',
        gas: '0x0',
        nonce,
        chainId: 688689,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientRpcMessage(message)) {
        throw new TransientStepError('TESTNET_READ_RETRY', `Transient gas estimate failure: ${message}`);
      }
      return this.blockedPlan(request, [`Gas estimation failed: ${message}`]);
    }
    const gasPrice = await this.client.getGasPrice();
    const maxFeePerGas = gasPrice * 2n;
    const maxCost = gasEstimate * maxFeePerGas;
    const transaction: PlannedTransaction = {
      kind: 'APPROVE',
      from: request.wallet,
      to: token.address,
      data,
      value: '0',
      gasEstimate: gasEstimate.toString(),
      gasPriceWei: gasPrice.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      maxCostWei: maxCost.toString(),
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      amount: record.request.amountIn,
      decimals: token.decimals,
      spender: record.request.spender,
      description:
        `ERC-20 approve: allow ${record.request.amountIn} ${token.symbol} to ` +
        `${record.request.spender} (exact amount, no unlimited approval)`,
    };
    const base: Omit<TransactionPlan, 'planHash'> = {
      step: 'APPROVE',
      network: 'atlantic-testnet',
      chainId: 688689,
      wallet: request.wallet,
      nonce,
      createdAt,
      executable: true,
      blockedReasons: [],
      transactions: [transaction],
      expectedPostconditions: [
        `transaction receipt status is success`,
        `allowance(${token.address}, ${record.request.spender}) >= ${amount.toString()} (${record.request.amountIn} ${token.symbol})`,
      ],
      maxTestnetCostWei: maxCost.toString(),
      approvalRequired: true,
    };
    return { ...base, planHash: hashPlan(base) };
  }

  async planForStep(
    record: SagaRecord,
    step: StepName,
    nonce: number,
    createdAt: string,
  ): Promise<TransactionPlan> {
    if (step === 'APPROVE') return this.planApprove(record, nonce, createdAt);
    const protocol = step === 'SWAP' ? this.config.swap : this.config.deposit;
    const reasons = protocol
      ? [
          `No verified ${step} calldata/ABI planner is configured for ${protocol.name}; refusing to guess`,
        ]
      : [
          `No verified ${step === 'SWAP' ? 'swap/router' : 'deposit/vault'} contract is configured. ` +
            'Official Pharos docs list no such deployed protocol on Atlantic testnet.',
        ];
    return this.blockedPlan(
      {
        fromToken: record.request.fromToken,
        amountIn: record.request.amountIn,
        spender: record.request.spender,
        step,
        wallet: this.client.getAddress(),
        nonce,
        createdAt,
      },
      reasons,
    );
  }

  async planRevoke(
    record: SagaRecord,
    nonce: number,
    createdAt: string,
  ): Promise<TransactionPlan> {
    const token = this.token(record.request.fromToken);
    const request: PlanRequest = {
      fromToken: record.request.fromToken,
      amountIn: record.request.amountIn,
      spender: record.request.spender,
      step: 'COMPENSATION_REVOKE_APPROVAL',
      wallet: this.client.getAddress(),
      nonce,
      createdAt,
    };
    if (!token) {
      return this.blockedPlan(request, ['Token is not in the verified Atlantic registry']);
    }
    if (!isEvmAddress(record.request.spender)) {
      return this.blockedPlan(request, ['Spender is not a valid EVM address']);
    }
    if (!this.allowedSpenders().includes(record.request.spender.toLowerCase())) {
      return this.blockedPlan(request, ['Spender is not a verified configured protocol']);
    }
    const data = encodeApprove(record.request.spender, 0n);
    const gasEstimate = await this.client.estimateGas({
      from: request.wallet,
      to: token.address,
      data,
      value: '0',
      gas: '0x0',
      nonce,
      chainId: 688689,
    });
    const gasPrice = await this.client.getGasPrice();
    const maxFeePerGas = gasPrice * 2n;
    const maxCost = gasEstimate * maxFeePerGas;
    const transaction: PlannedTransaction = {
      kind: 'REVOKE_APPROVAL',
      from: request.wallet,
      to: token.address,
      data,
      value: '0',
      gasEstimate: gasEstimate.toString(),
      gasPriceWei: gasPrice.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      maxCostWei: maxCost.toString(),
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      amount: '0',
      decimals: token.decimals,
      spender: record.request.spender,
      description: `ERC-20 approve(0): revoke the remaining ${token.symbol} allowance for ${record.request.spender}`,
    };
    const base: Omit<TransactionPlan, 'planHash'> = {
      step: 'COMPENSATION_REVOKE_APPROVAL',
      network: 'atlantic-testnet',
      chainId: 688689,
      wallet: request.wallet,
      nonce,
      createdAt,
      executable: true,
      blockedReasons: [],
      transactions: [transaction],
      expectedPostconditions: [
        'transaction receipt status is success',
        `allowance(${token.address}, ${record.request.spender}) == 0`,
      ],
      maxTestnetCostWei: maxCost.toString(),
      approvalRequired: true,
    };
    return { ...base, planHash: hashPlan(base) };
  }

  addressExplorer(address: string): string {
    return explorerAddressUrl(address);
  }
}
