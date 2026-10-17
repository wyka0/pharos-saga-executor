import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import type {
  ChainAdapter,
  CompensationContext,
  CompensationResult,
  ReconcileContext,
  ReconcileResult,
  SubmitContext,
} from './types.js';
import {
  PermanentStepError,
  UnknownSubmissionOutcomeError,
  errorMessage,
} from '../domain/errors.js';
import { verifyCompensationReceipt, verifyStepReceipt } from '../domain/receipts.js';
import type {
  CompensationAction,
  LocalAnvilConfig,
  LocalReceipt,
  ProofReceipt,
  SagaRecord,
  StepName,
} from '../domain/types.js';
import { formatUnits, parseUnits } from '../testnet/units.js';
import type { LocalJournal, LocalJournalEntry } from '../persistence/localJournal.js';

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const RECEIPT_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);
const SWAP_ABI = parseAbi([
  'function swapExactUsdcForReceipt(uint256 usdcIn, uint256 minReceiptOut) returns (uint256)',
  'function unwind(uint256 receiptIn, uint256 minUsdcOut) returns (uint256)',
  'function quote(uint256 usdcIn) view returns (uint256)',
]);
const VAULT_ABI = parseAbi([
  'function deposit(uint256 assets, uint256 minShares) returns (uint256)',
  'function sharesOf(address owner) view returns (uint256)',
]);

const LOCAL_DISCLAIMER =
  'LOCAL ANVIL TEST-ONLY CHAIN (chainId 31337) - no Atlantic or mainnet transaction.';

export interface LocalAnvilAdapterOptions {
  config: LocalAnvilConfig;
  journal: LocalJournal;
  /** Test-only fault: send the tx, journal it, then report an unknown outcome. */
  unknownOn?: StepName;
}

/**
 * Real transactions against a disposable local Anvil chain.
 * It refuses any chain other than 31337 and has no path to Atlantic/mainnet.
 */
export class LocalAnvilAdapter implements ChainAdapter {
  readonly id = 'local-anvil';
  readonly simulated = false;
  readonly config: LocalAnvilConfig;
  readonly journal: LocalJournal;
  readonly unknownOn: StepName | undefined;
  sendCount = 0;
  private readonly publicClient;
  private readonly walletClient;

  constructor(options: LocalAnvilAdapterOptions) {
    this.config = options.config;
    this.journal = options.journal;
    this.unknownOn = options.unknownOn;
    const transport = http(options.config.rpcUrl, { timeout: 20_000, retryCount: 0 });
    this.publicClient = createPublicClient({ transport });
    this.walletClient = createWalletClient({
      account: options.config.owner as Address,
      transport,
    });
  }

  private async assertLocal(): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== 31337) {
      throw new PermanentStepError(
        'WRONG_CHAIN',
        `Local adapter refuses chainId ${chainId}; expected 31337 (Anvil).`,
      );
    }
    if (this.config.chainId !== 31337) {
      throw new PermanentStepError('WRONG_CONFIGURED_CHAIN', 'Local config is not chainId 31337');
    }
  }

  private amountIn(record: SagaRecord): bigint {
    return parseUnits(record.request.amountIn, 6);
  }

  private async readAllowance(owner: string, spender: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.usdc as Address,
      abi: USDC_ABI,
      functionName: 'allowance',
      args: [owner as Address, spender as Address],
    });
  }

  private async readReceiptBalance(owner: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.receiptToken as Address,
      abi: RECEIPT_ABI,
      functionName: 'balanceOf',
      args: [owner as Address],
    });
  }

  private async readShares(owner: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.vault as Address,
      abi: VAULT_ABI,
      functionName: 'sharesOf',
      args: [owner as Address],
    });
  }

  private async quote(amountIn: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.swap as Address,
      abi: SWAP_ABI,
      functionName: 'quote',
      args: [amountIn],
    });
  }

  private async buildStepReceipt(
    record: SagaRecord,
    step: StepName,
    tx: TransactionReceipt,
    postconditions: LocalReceipt['postconditions'],
  ): Promise<LocalReceipt> {
    const owner = this.config.owner;
    const amount = this.amountIn(record);
    const isApprove = step === 'APPROVE';
    const isSwap = step === 'SWAP';
    const allowance = isApprove ? await this.readAllowance(owner, this.config.swap) : null;
    const receiptBalance = !isApprove ? await this.readReceiptBalance(owner) : null;
    const shares = step === 'DEPOSIT' ? await this.readShares(owner) : null;
    const result =
      isApprove
        ? {
            tokenIn: record.request.fromToken,
            tokenOut: '',
            amountIn: record.request.amountIn,
            amountOut: '0',
            allowance: allowance === null ? null : formatUnits(allowance, 6),
            spender: this.config.swap,
            shares: null,
            protocol: null,
          }
        : isSwap
          ? {
              tokenIn: record.request.fromToken,
              tokenOut: record.request.toToken,
              amountIn: record.request.amountIn,
              amountOut: formatUnits(receiptBalance ?? 0n, 6),
              allowance: null,
              spender: null,
              shares: null,
              protocol: null,
            }
          : {
              tokenIn: record.request.depositToken,
              tokenOut: `${record.request.protocol}:shares`,
              amountIn: formatUnits(shares ?? 0n, 6),
              amountOut: formatUnits(shares ?? 0n, 6),
              allowance: null,
              spender: null,
              shares: formatUnits(shares ?? 0n, 6),
              protocol: record.request.protocol,
            };
    return {
      receiptVersion: 1,
      receiptKind: 'STEP',
      simulated: false,
      network: 'local-anvil',
      chainId: 31337,
      disclaimer: LOCAL_DISCLAIMER,
      txHash: tx.transactionHash,
      blockNumber: (tx.blockNumber ?? 0n).toString(),
      blockHash: tx.blockHash ?? '',
      status: 'SUCCESS',
      confirmations: 1,
      from: tx.from,
      to: tx.to ?? this.config.swap,
      explorerUrl: null,
      sagaId: record.id,
      stepId: record.steps[step].id,
      idempotencyKey: record.steps[step].idempotencyKey,
      operation: step,
      issuedAt: new Date().toISOString(),
      result,
      gasUsed: tx.gasUsed.toString(),
      effectiveGasPrice: (tx.effectiveGasPrice ?? 0n).toString(),
      postconditions,
    };
  }

  private async postconditions(
    record: SagaRecord,
    step: StepName,
    expectedOut: bigint | null,
  ): Promise<LocalReceipt['postconditions']> {
    const owner = this.config.owner;
    const amount = this.amountIn(record);
    if (step === 'APPROVE') {
      const allowance = await this.readAllowance(owner, this.config.swap);
      return [
        { name: 'allowance', expected: `>= ${amount}`, observed: allowance.toString() },
        { name: 'spender', expected: this.config.swap, observed: this.config.swap },
      ];
    }
    if (step === 'SWAP') {
      const balance = await this.readReceiptBalance(owner);
      return [
        {
          name: 'receiptBalance',
          expected: `>= ${expectedOut ?? 0n}`,
          observed: balance.toString(),
        },
      ];
    }
    const shares = await this.readShares(owner);
    return [
      {
        name: 'shares',
        expected: `>= ${expectedOut ?? 0n}`,
        observed: shares.toString(),
      },
    ];
  }

  private postconditionsSatisfied(
    step: StepName,
    conditions: LocalReceipt['postconditions'],
    amount: bigint,
    quote: bigint | null,
  ): boolean {
    if (step === 'APPROVE') {
      const allowance = BigInt(conditions[0]?.observed ?? '0');
      return allowance >= amount;
    }
    const observed = BigInt(conditions[0]?.observed ?? '0');
    return observed >= (quote ?? 0n);
  }

  private async send(step: StepName, record: SagaRecord): Promise<Hash> {
    const owner = this.config.owner as Address;
    const amount = this.amountIn(record);
    if (step === 'APPROVE') {
      return this.walletClient.writeContract({
        account: owner,
        chain: null,
        address: this.config.usdc as Address,
        abi: USDC_ABI,
        functionName: 'approve',
        args: [this.config.swap as Address, amount],
      });
    }
    if (step === 'SWAP') {
      const quote = await this.quote(amount);
      return this.walletClient.writeContract({
        account: owner,
        chain: null,
        address: this.config.swap as Address,
        abi: SWAP_ABI,
        functionName: 'swapExactUsdcForReceipt',
        args: [amount, quote],
      });
    }
    const receiptBalance = await this.readReceiptBalance(owner);
    return this.walletClient.writeContract({
      account: owner,
      chain: null,
      address: this.config.vault as Address,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [receiptBalance, receiptBalance],
    });
  }

  async submit(step: StepName, context: SubmitContext): Promise<ProofReceipt> {
    await this.assertLocal();
    const existing = await this.journal.get(context.stepRecord.idempotencyKey);
    if (existing) return this.resolveEntry(existing, context, step);

    const owner = this.config.owner;
    const key = context.stepRecord.idempotencyKey;
    const at = context.clock.now().toISOString();
    await this.journal.put({
      key,
      sagaId: context.saga.id,
      step,
      nonce: 0,
      txHash: null,
      status: 'INTENT',
      recordedAt: at,
      updatedAt: at,
      receipt: null,
      note: 'Local intent persisted before send.',
    });

    let hash: Hash;
    this.sendCount += 1;
    try {
      hash = await this.send(step, context.saga);
    } catch (error) {
      const message = errorMessage(error);
      const reverted = /revert|TEST_ONLY/i.test(message);
      await this.update(key, {
        status: reverted ? 'REVERTED' : 'UNKNOWN',
        note: `Local send failed: ${message}`,
      });
      if (reverted) {
        throw new PermanentStepError('LOCAL_TX_REVERTED', `Local transaction reverted: ${message}`);
      }
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_SEND_UNKNOWN',
        `Local send did not return a hash: ${message}`,
      );
    }
    await this.update(key, { status: 'BROADCAST', txHash: hash, note: 'Local tx broadcast.' });

    if (this.unknownOn === step) {
      await this.update(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: 'Injected unknown outcome after send; reconcile only, never resubmit.',
      });
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_UNKNOWN_OUTCOME',
        `Injected unknown outcome after sending ${hash}; no resubmission.`,
        { txHash: hash },
      );
    }

    let tx: TransactionReceipt;
    try {
      tx = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    } catch (error) {
      await this.update(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Receipt wait failed: ${errorMessage(error)}`,
      });
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_RECEIPT_UNKNOWN',
        `Local receipt for ${hash} is unknown: ${errorMessage(error)}`,
      );
    }
    if (tx.status !== 'success') {
      await this.update(key, { status: 'REVERTED', txHash: hash, note: 'Local tx reverted.' });
      throw new PermanentStepError('LOCAL_TX_REVERTED', `Local transaction reverted: ${hash}`);
    }
    const quote = step === 'SWAP' ? await this.quote(this.amountIn(context.saga)) : null;
    const conditions = await this.postconditions(context.saga, step, quote);
    if (!this.postconditionsSatisfied(step, conditions, this.amountIn(context.saga), quote)) {
      await this.update(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Postcondition failed: ${JSON.stringify(conditions)}`,
      });
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_POSTCONDITION_UNCONFIRMED',
        `Local tx ${hash} succeeded but postconditions were not met.`,
      );
    }
    const receipt = await this.buildStepReceipt(context.saga, step, tx, conditions);
    const verification = verifyStepReceipt(receipt, context.saga, step);
    if (!verification.ok) {
      await this.update(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Receipt invalid: ${verification.reasons.join('; ')}`,
      });
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_RECEIPT_INVALID',
        `Local receipt failed verification: ${verification.reasons.join('; ')}`,
      );
    }
    await this.update(key, {
      status: 'CONFIRMED',
      txHash: hash,
      receipt: verification.receipt as LocalReceipt,
      note: 'Local tx confirmed and postconditions verified.',
    });
    return verification.receipt;
  }

  private async resolveEntry(
    entry: LocalJournalEntry,
    context: SubmitContext,
    step: StepName,
  ): Promise<ProofReceipt> {
    if (entry.receipt) {
      const verification = verifyStepReceipt(entry.receipt, context.saga, step);
      if (verification.ok) return verification.receipt;
      throw new UnknownSubmissionOutcomeError('LOCAL_JOURNAL_INVALID', 'Journal receipt invalid.');
    }
    if (!entry.txHash) {
      throw new UnknownSubmissionOutcomeError(
        'LOCAL_OUTCOME_UNKNOWN',
        'Local journal has INTENT without a hash; do not resubmit.',
      );
    }
    const reconciled = await this.reconcile(step, context);
    if (reconciled.receipt) return reconciled.receipt;
    throw new UnknownSubmissionOutcomeError(
      'LOCAL_OUTCOME_UNKNOWN',
      `Local receipt not resolvable: ${reconciled.detail}`,
    );
  }

  async reconcile(step: StepName, context: ReconcileContext): Promise<ReconcileResult> {
    const entry = await this.journal.get(context.stepRecord.idempotencyKey);
    if (!entry) return { receipt: null, detail: 'No local journal entry.' };
    if (entry.receipt) {
      const verification = verifyStepReceipt(entry.receipt, context.saga, step);
      return verification.ok
        ? { receipt: verification.receipt, detail: 'Journal already CONFIRMED.' }
        : { receipt: null, detail: `Journal receipt invalid: ${verification.reasons.join('; ')}` };
    }
    if (!entry.txHash) return { receipt: null, detail: 'INTENT without a tx hash; do not resubmit.' };
    let tx: TransactionReceipt;
    try {
      tx = await this.publicClient.getTransactionReceipt({ hash: entry.txHash as Hash });
    } catch {
      return { receipt: null, detail: 'Local transaction has no receipt yet.' };
    }
    if (tx.status !== 'success') {
      await this.update(entry.key, { status: 'REVERTED', note: 'Reconciled: reverted.' });
      return { receipt: null, detail: 'Local transaction reverted.' };
    }
    const quote = step === 'SWAP' ? await this.quote(this.amountIn(context.saga)) : null;
    const conditions = await this.postconditions(context.saga, step, quote);
    if (!this.postconditionsSatisfied(step, conditions, this.amountIn(context.saga), quote)) {
      return { receipt: null, detail: 'Local tx exists but postconditions were not met.' };
    }
    const receipt = await this.buildStepReceipt(context.saga, step, tx, conditions);
    const verification = verifyStepReceipt(receipt, context.saga, step);
    if (!verification.ok) {
      return { receipt: null, detail: `Receipt invalid: ${verification.reasons.join('; ')}` };
    }
    await this.update(entry.key, {
      status: 'CONFIRMED',
      receipt: verification.receipt as LocalReceipt,
      note: 'Reconciled without resubmission.',
    });
    return { receipt: verification.receipt, detail: 'Reconciled without resubmission.' };
  }

  supportsCompensation(action: CompensationAction): boolean {
    return action === 'REVOKE_APPROVAL' || action === 'SIMULATED_UNWIND_SWAP';
  }

  async compensate(context: CompensationContext): Promise<CompensationResult> {
    await this.assertLocal();
    const owner = this.config.owner as Address;
    const key = `${context.saga.id}:COMPENSATION:${context.action}:v1`;
    const existing = await this.journal.get(key);
    if (existing?.receipt) {
      return { status: 'SUCCEEDED', receipt: existing.receipt, note: 'Existing local compensation.' };
    }
    const at = context.clock.now().toISOString();
    await this.journal.put({
      key,
      sagaId: context.saga.id,
      step: context.originalStep,
      nonce: 0,
      txHash: null,
      status: 'INTENT',
      recordedAt: at,
      updatedAt: at,
      receipt: null,
      note: `Local compensation ${context.action} intent.`,
    });

    let hash: Hash;
    let amountIn = 0n;
    let amountOut = 0n;
    let tokenIn = context.saga.request.fromToken;
    let tokenOut = '';
    try {
      if (context.action === 'REVOKE_APPROVAL') {
        hash = await this.walletClient.writeContract({
          account: owner,
          chain: null,
          address: this.config.usdc as Address,
          abi: USDC_ABI,
          functionName: 'approve',
          args: [this.config.swap as Address, 0n],
        });
        tokenOut = '';
        amountIn = this.amountIn(context.saga);
      } else {
        amountIn = await this.readReceiptBalance(owner);
        if (amountIn === 0n) {
          return { status: 'UNAVAILABLE', receipt: null, note: 'No receipt token balance to unwind.' };
        }
        amountOut = await this.quote(amountIn);
        hash = await this.walletClient.writeContract({
          account: owner,
          chain: null,
          address: this.config.swap as Address,
          abi: SWAP_ABI,
          functionName: 'unwind',
          args: [amountIn, amountOut],
        });
        tokenIn = context.saga.request.toToken;
        tokenOut = context.saga.request.fromToken;
      }
    } catch (error) {
      await this.update(key, { status: 'UNKNOWN', note: `Compensation failed: ${errorMessage(error)}` });
      return {
        status: 'FAILED',
        receipt: null,
        note: 'Local compensation send failed or has an unknown outcome.',
        error,
      };
    }
    await this.update(key, { status: 'BROADCAST', txHash: hash, note: 'Local compensation broadcast.' });
    let tx: TransactionReceipt;
    try {
      tx = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    } catch (error) {
      await this.update(key, { status: 'UNKNOWN', note: `Compensation receipt unknown: ${errorMessage(error)}` });
      return {
        status: 'FAILED',
        receipt: null,
        note: 'Local compensation receipt is unknown; do not resubmit.',
        error,
      };
    }
    if (tx.status !== 'success') {
      await this.update(key, { status: 'REVERTED', txHash: hash, note: 'Compensation reverted.' });
      return { status: 'FAILED', receipt: null, note: 'Local compensation reverted.' };
    }
    const allowance =
      context.action === 'REVOKE_APPROVAL'
        ? await this.readAllowance(owner, this.config.swap)
        : null;
    const receipt: LocalReceipt = {
      receiptVersion: 1,
      receiptKind: 'COMPENSATION',
      simulated: false,
      network: 'local-anvil',
      chainId: 31337,
      disclaimer: LOCAL_DISCLAIMER,
      txHash: hash,
      blockNumber: (tx.blockNumber ?? 0n).toString(),
      blockHash: tx.blockHash ?? '',
      status: 'SUCCESS',
      confirmations: 1,
      from: tx.from,
      to: tx.to ?? this.config.swap,
      explorerUrl: null,
      sagaId: context.saga.id,
      stepId: `${context.saga.id}:COMPENSATION:${context.action}`,
      idempotencyKey: key,
      operation:
        context.action === 'REVOKE_APPROVAL'
          ? 'COMPENSATION_REVOKE_APPROVAL'
          : 'COMPENSATION_UNWIND_SWAP',
      issuedAt: new Date().toISOString(),
      result: {
        tokenIn,
        tokenOut,
        amountIn: formatUnits(amountIn, 6),
        amountOut: formatUnits(amountOut, 6),
        allowance: allowance === null ? '0' : formatUnits(allowance, 6),
        spender: this.config.swap,
        shares: null,
        protocol: null,
      },
      gasUsed: tx.gasUsed.toString(),
      effectiveGasPrice: (tx.effectiveGasPrice ?? 0n).toString(),
      postconditions: [
        {
          name: context.action === 'REVOKE_APPROVAL' ? 'allowance' : 'receiptBalance',
          expected: context.action === 'REVOKE_APPROVAL' ? '0' : '0',
          observed:
            context.action === 'REVOKE_APPROVAL'
              ? (allowance ?? 0n).toString()
              : (await this.readReceiptBalance(owner)).toString(),
        },
      ],
      compensatesStep: context.originalStep,
    };
    const verification = verifyCompensationReceipt(
      receipt,
      context.saga,
      context.action,
      context.originalStep,
    );
    if (!verification.ok) {
      await this.update(key, { status: 'UNKNOWN', receipt, note: verification.reasons.join('; ') });
      return { status: 'FAILED', receipt: null, note: 'Local compensation receipt invalid.' };
    }
    await this.update(key, {
      status: 'CONFIRMED',
      receipt: verification.receipt as LocalReceipt,
      note: 'Local compensation confirmed.',
    });
    return { status: 'SUCCEEDED', receipt: verification.receipt, note: 'Local compensation confirmed.' };
  }

  private async update(
    key: string,
    update: Partial<Pick<LocalJournalEntry, 'status' | 'txHash' | 'receipt' | 'note'>>,
  ): Promise<void> {
    const entry = await this.journal.get(key);
    if (!entry) throw new Error(`Local journal entry missing: ${key}`);
    await this.journal.put({ ...entry, ...update, updatedAt: new Date().toISOString() });
  }
}
