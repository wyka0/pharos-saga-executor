import type { ChainAdapter, CompensationContext, CompensationResult, ReconcileContext, ReconcileResult, SubmitContext } from './types.js';
import { SystemClock, type Clock } from '../domain/clock.js';
import {
  PermanentStepError,
  TransientStepError,
  UnknownSubmissionOutcomeError,
  errorMessage,
} from '../domain/errors.js';
import { verifyCompensationReceipt, verifyStepReceipt } from '../domain/receipts.js';
import type {
  CompensationAction,
  OnChainReceipt,
  PlanApproval,
  ProofReceipt,
  SagaRecord,
  StepName,
  TestnetConfig,
} from '../domain/types.js';
import type { TestnetJournal, TestnetJournalEntry } from '../persistence/testnetJournal.js';
import type { RpcReceipt, TestnetClient } from '../testnet/client.js';
import { TestnetPlanner, type ReadinessParams } from '../testnet/planner.js';
import type { TransactionPlan } from '../testnet/plan.js';
import {
  amountFromRecord,
  buildRevokeReceipt,
  buildStepReceipt,
  checkAllowancePostconditions,
} from '../testnet/receipts.js';
import { parseUnits } from '../testnet/units.js';

export interface PharosTestnetAdapterOptions {
  client: TestnetClient;
  config: TestnetConfig;
  journal: TestnetJournal;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  receiptTimeoutMs?: number;
}

export interface SubmitOptions {
  /** Explicit, user-supplied approval. Never inferred from the mere presence of a config. */
  approval?: PlanApproval;
}

/**
 * Real Pharos Atlantic testnet adapter (chainId 688689).
 *
 * Safety properties:
 *  - live only when an explicit plan-hash approval is supplied;
 *  - refuses any chain other than 688689 before planning or sending;
 *  - writes an INTENT journal entry before broadcasting;
 *  - never resubmits an INTENT/BROADCAST/UNKNOWN idempotency key;
 *  - retries only read operations (3 attempts), never sends.
 */
export class PharosTestnetAdapter implements ChainAdapter {
  readonly id = 'pharos-testnet';
  readonly simulated = false;
  private readonly client: TestnetClient;
  private readonly config: TestnetConfig;
  private readonly journal: TestnetJournal;
  private readonly planner: TestnetPlanner;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly receiptTimeoutMs: number;

  constructor(options: PharosTestnetAdapterOptions) {
    this.client = options.client;
    this.config = options.config;
    this.journal = options.journal;
    this.planner = new TestnetPlanner(options.client, options.config);
    this.clock = options.clock ?? new SystemClock();
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 120_000;
  }

  async readiness(params: ReadinessParams) {
    return this.planner.readiness(params);
  }

  async plan(saga: SagaRecord, step: StepName): Promise<TransactionPlan> {
    await this.ensureNetwork();
    const wallet = this.client.getAddress();
    const nonce = await this.readWithRetry('nonce', () =>
      this.client.getTransactionCount(wallet, 'pending'),
    );
    return this.readWithRetry('plan', () =>
      this.planner.planForStep(saga, step, nonce, this.clock.now().toISOString()),
    );
  }

  async planRevoke(saga: SagaRecord): Promise<TransactionPlan> {
    await this.ensureNetwork();
    const wallet = this.client.getAddress();
    const nonce = await this.readWithRetry('nonce', () =>
      this.client.getTransactionCount(wallet, 'pending'),
    );
    return this.planner.planRevoke(saga, nonce, this.clock.now().toISOString());
  }

  async submit(step: StepName, context: SubmitContext): Promise<ProofReceipt> {
    const config = this.requireTestnetConfig(context.saga);
    const approval = context.approval ?? config.approvedPlan;
    if (!approval) {
      throw new PermanentStepError(
        'PLAN_APPROVAL_REQUIRED',
        'No explicit plan approval is present. Refusing to sign or broadcast.',
      );
    }
    await this.ensureNetwork();

    const key = context.stepRecord.idempotencyKey;
    const existing = await this.journal.get(key);
    if (existing) {
      return this.resolveSubmitEntry(existing, context.saga, step, context.clock, existing.planHash);
    }

    const nonce = await this.readWithRetry('nonce', () =>
      this.client.getTransactionCount(this.client.getAddress(), 'pending'),
    );
    const plan = await this.readWithRetry('plan', () =>
      this.planner.planForStep(context.saga, step, nonce, context.clock.now().toISOString()),
    );
    if (!plan.executable) {
      throw new PermanentStepError(
        'CAPABILITY_UNAVAILABLE',
        `Testnet ${step} is unavailable: ${plan.blockedReasons.join(' | ')}`,
        { plan },
      );
    }
    if (approval.planHash !== plan.planHash) {
      throw new PermanentStepError(
        'PLAN_HASH_MISMATCH',
        'The approved plan hash does not match the current plan. Re-plan and obtain new approval.',
        { approved: approval.planHash, current: plan.planHash },
      );
    }
    const transaction = plan.transactions[0];
    if (!transaction) throw new PermanentStepError('PLAN_EMPTY', 'Approved plan has no transaction');

    const token = this.planner.token(context.saga.request.fromToken);
    if (!token) throw new PermanentStepError('TOKEN_NOT_VERIFIED', 'Input token is not verified');
    const amount = amountFromRecord(context.saga, token.decimals);
    const wallet = this.client.getAddress();

    const balance = await this.readWithRetry('token balance', () =>
      this.client.readContract<bigint>({
        address: token.address,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{ type: 'address' }],
            outputs: [{ type: 'uint256' }],
          },
        ],
        functionName: 'balanceOf',
        args: [wallet],
      }),
    );
    if (balance < amount) {
      throw new PermanentStepError(
        'INSUFFICIENT_TOKEN_BALANCE',
        `Wallet has ${balance.toString()} base units, plan needs ${amount.toString()}`,
      );
    }
    const allowance = await this.readWithRetry('allowance', () =>
      this.planner.allowance(token, wallet, context.saga.request.spender),
    );
    if (allowance > 0n) {
      throw new PermanentStepError(
        'ALLOWANCE_NOT_ZERO',
        'An allowance already exists; refusing to issue a redundant approval.',
      );
    }

    const at = context.clock.now().toISOString();
    await this.journal.put({
      key,
      sagaId: context.saga.id,
      step,
      planHash: plan.planHash,
      nonce,
      txHash: null,
      status: 'INTENT',
      recordedAt: at,
      updatedAt: at,
      receipt: null,
      plan,
      note: 'Intent persisted before any signing or broadcast.',
    });

    let hash: string;
    try {
      hash = await this.client.sendTransaction({
        from: wallet,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gas: transaction.gasEstimate,
        nonce,
        chainId: 688689,
      });
    } catch (error) {
      await this.markJournal(key, { status: 'UNKNOWN', note: `send failed/ambiguous: ${errorMessage(error)}` });
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_SEND_UNKNOWN',
        `Transaction send did not return a hash. The outcome is unknown; do not resubmit. ${errorMessage(error)}`,
      );
    }

    await this.markJournal(key, {
      status: 'BROADCAST',
      txHash: hash,
      note: 'Transaction hash recorded; waiting for receipt.',
    });

    const rpc = await this.waitForReceipt(hash);
    if (!rpc) {
      await this.markJournal(key, {
        status: 'UNKNOWN',
        note: 'Receipt timeout. Transaction hash is preserved; do not resubmit.',
      });
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_RECEIPT_TIMEOUT',
        `No receipt within ${this.receiptTimeoutMs}ms for ${hash}. Outcome unknown; do not resubmit.`,
        { txHash: hash },
      );
    }
    if (rpc.status === 'reverted') {
      await this.markJournal(key, { status: 'REVERTED', note: 'Transaction reverted.', txHash: hash });
      throw new PermanentStepError('TESTNET_TX_REVERTED', `Transaction reverted: ${hash}`, { txHash: hash });
    }

    const post = await checkAllowancePostconditions({
      rpc,
      planTransaction: transaction,
      wallet,
      expectedMinimum: amount,
      expectedExactZero: false,
      readAllowance: () => this.planner.allowance(token, wallet, context.saga.request.spender),
    });
    if (!post.ok) {
      await this.markJournal(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Postcondition not confirmed: ${post.error ?? 'allowance mismatch'}`,
      });
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_POSTCONDITION_UNCONFIRMED',
        `Transaction ${hash} succeeded but the allowance postcondition was not confirmed. Manual reconciliation required.`,
        { txHash: hash, conditions: post.conditions },
      );
    }

    const receipt = buildStepReceipt({
      record: context.saga,
      step,
      plan,
      transaction,
      rpc,
      postconditions: post.conditions,
      allowance: post.allowance,
      observedAt: context.clock.now().toISOString(),
    });
    const verification = verifyStepReceipt(receipt, context.saga, step);
    if (!verification.ok) {
      await this.markJournal(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Receipt verification failed: ${verification.reasons.join('; ')}`,
      });
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_RECEIPT_INVALID',
        `On-chain receipt failed verification after broadcast: ${verification.reasons.join('; ')}`,
        { txHash: hash },
      );
    }

    await this.journal.put({
      ...(await this.requireJournal(key)),
      status: 'CONFIRMED',
      txHash: hash,
      receipt: verification.receipt as OnChainReceipt,
      updatedAt: context.clock.now().toISOString(),
      note: 'Transaction receipt, confirmations, and postconditions verified.',
    });
    return verification.receipt;
  }

  async reconcile(step: StepName, context: ReconcileContext): Promise<ReconcileResult> {
    const entry = await this.journal.get(context.stepRecord.idempotencyKey);
    if (!entry) {
      return { receipt: null, detail: 'No testnet journal entry exists for this idempotency key.' };
    }
    if (entry.receipt) {
      const verification = verifyStepReceipt(entry.receipt, context.saga, step);
      if (verification.ok) return { receipt: verification.receipt, detail: 'Journal already CONFIRMED.' };
    }
    if (!entry.txHash) {
      return {
        receipt: null,
        detail:
          'Journal entry is INTENT without a transaction hash. The outcome is unknown; ' +
          'a transaction may or may not have been broadcast. Manual recovery required.',
      };
    }
    let rpc: RpcReceipt | null;
    try {
      rpc = await this.client.getTransactionReceipt(entry.txHash);
    } catch (error) {
      return { receipt: null, detail: `Receipt lookup failed: ${errorMessage(error)}` };
    }
    if (!rpc) {
      return { receipt: null, detail: `Transaction ${entry.txHash} is not mined yet or was dropped.` };
    }
    if (rpc.status === 'reverted') {
      await this.markJournal(entry.key, { status: 'REVERTED', note: 'Reconciled: reverted.' });
      return { receipt: null, detail: `Transaction ${entry.txHash} reverted.` };
    }
    if (!entry.plan) {
      return { receipt: null, detail: 'Journal entry has no plan snapshot; cannot verify postconditions.' };
    }
    const transaction = entry.plan.transactions[0];
    const token = this.planner.token(context.saga.request.fromToken);
    if (!transaction || !token) {
      return { receipt: null, detail: 'Journal plan/token is incomplete; manual recovery required.' };
    }
    const amount = amountFromRecord(context.saga, token.decimals);
    const post = await checkAllowancePostconditions({
      rpc,
      planTransaction: transaction,
      wallet: this.client.getAddress(),
      expectedMinimum: amount,
      expectedExactZero: false,
      readAllowance: () =>
        this.planner.allowance(token, this.client.getAddress(), context.saga.request.spender),
    });
    if (!post.ok) {
      await this.markJournal(entry.key, {
        status: 'UNKNOWN',
        note: `Reconciled receipt exists but postcondition failed: ${post.error ?? 'mismatch'}`,
      });
      return { receipt: null, detail: `Receipt exists but postcondition is unconfirmed: ${post.error ?? 'mismatch'}` };
    }
    const receipt = buildStepReceipt({
      record: context.saga,
      step,
      plan: entry.plan,
      transaction,
      rpc,
      postconditions: post.conditions,
      allowance: post.allowance,
      observedAt: context.clock.now().toISOString(),
    });
    const verification = verifyStepReceipt(receipt, context.saga, step);
    if (!verification.ok) {
      return { receipt: null, detail: `Reconciled receipt failed verification: ${verification.reasons.join('; ')}` };
    }
    await this.journal.put({
      ...entry,
      status: 'CONFIRMED',
      receipt: verification.receipt as OnChainReceipt,
      updatedAt: context.clock.now().toISOString(),
      note: 'Reconciled and verified without resubmission.',
    });
    return { receipt: verification.receipt, detail: 'Reconciled and verified without resubmission.' };
  }

  supportsCompensation(action: CompensationAction): boolean {
    return action === 'REVOKE_APPROVAL' && (this.config.swap !== null || this.config.deposit !== null);
  }

  async compensate(context: CompensationContext): Promise<CompensationResult> {
    if (context.action !== 'REVOKE_APPROVAL') {
      return { status: 'UNAVAILABLE', receipt: null, note: 'Only approval revocation is supported.' };
    }
    const config = this.requireTestnetConfig(context.saga);
    const approval = context.approval ?? config.approvedPlan;
    if (!approval) {
      throw new PermanentStepError('PLAN_APPROVAL_REQUIRED', 'No approval for the revoke plan.');
    }
    await this.ensureNetwork();
    const nonce = await this.readWithRetry('nonce', () =>
      this.client.getTransactionCount(this.client.getAddress(), 'pending'),
    );
    const plan = await this.readWithRetry('revoke plan', () =>
      this.planner.planRevoke(context.saga, nonce, context.clock.now().toISOString()),
    );
    if (!plan.executable) {
      return { status: 'UNAVAILABLE', receipt: null, note: plan.blockedReasons.join(' | ') };
    }
    if (approval.planHash !== plan.planHash) {
      throw new PermanentStepError('PLAN_HASH_MISMATCH', 'Revoke plan hash does not match approval.');
    }
    const transaction = plan.transactions[0];
    const token = this.planner.token(context.saga.request.fromToken);
    if (!transaction || !token) {
      return { status: 'UNAVAILABLE', receipt: null, note: 'Missing revoke transaction or token.' };
    }
    const key = `${context.saga.id}:COMPENSATION:REVOKE_APPROVAL:v1`;
    const existing = await this.journal.get(key);
    if (existing) {
      if (existing.receipt) {
        return { status: 'SUCCEEDED', receipt: existing.receipt, note: 'Existing confirmed revoke receipt.' };
      }
      if (existing.status === 'REVERTED') {
        return { status: 'FAILED', receipt: null, note: 'Existing revoke transaction reverted; not resubmitted.' };
      }
      if (!existing.txHash) {
        return {
          status: 'FAILED',
          receipt: null,
          note: 'Existing revoke intent has no hash; outcome unknown and must not be resubmitted.',
        };
      }
      const existingReceipt = await this.client.getTransactionReceipt(existing.txHash);
      if (!existingReceipt) {
        return {
          status: 'FAILED',
          receipt: null,
          note: `Existing revoke transaction ${existing.txHash} has no receipt; manual reconciliation required.`,
        };
      }
      if (existingReceipt.status === 'reverted') {
        await this.markJournal(key, { status: 'REVERTED', note: 'Existing revoke reverted.' });
        return { status: 'FAILED', receipt: null, note: 'Existing revoke transaction reverted.' };
      }
      return {
        status: 'FAILED',
        receipt: null,
        note:
          'Existing revoke transaction is mined but not reconciled. Manual verification required; ' +
          'this adapter will not resubmit it.',
      };
    }
    const at = context.clock.now().toISOString();
    await this.journal.put({
      key,
      sagaId: context.saga.id,
      step: context.originalStep,
      planHash: plan.planHash,
      nonce,
      txHash: null,
      status: 'INTENT',
      recordedAt: at,
      updatedAt: at,
      receipt: null,
      plan,
      note: 'Compensation intent persisted before broadcast.',
    });
    let hash: string;
    try {
      hash = await this.client.sendTransaction({
        from: this.client.getAddress(),
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gas: transaction.gasEstimate,
        nonce,
        chainId: 688689,
      });
    } catch (error) {
      await this.markJournal(key, { status: 'UNKNOWN', note: `revoke send ambiguous: ${errorMessage(error)}` });
      return {
        status: 'FAILED',
        receipt: null,
        note: 'Revoke send outcome unknown; do not resubmit.',
        error: new UnknownSubmissionOutcomeError('TESTNET_REVOKE_UNKNOWN', errorMessage(error)),
      };
    }
    await this.markJournal(key, { status: 'BROADCAST', txHash: hash, note: 'Revoke broadcast.' });
    const rpc = await this.waitForReceipt(hash);
    if (!rpc || rpc.status === 'reverted') {
      await this.markJournal(key, {
        status: rpc?.status === 'reverted' ? 'REVERTED' : 'UNKNOWN',
        txHash: hash,
        note: rpc?.status === 'reverted' ? 'Revoke reverted.' : 'Revoke receipt timeout.',
      });
      return {
        status: 'FAILED',
        receipt: null,
        note: rpc?.status === 'reverted' ? 'Revoke transaction reverted.' : 'Revoke receipt timeout.',
      };
    }
    const post = await checkAllowancePostconditions({
      rpc,
      planTransaction: transaction,
      wallet: this.client.getAddress(),
      expectedMinimum: null,
      expectedExactZero: true,
      readAllowance: () =>
        this.planner.allowance(token, this.client.getAddress(), context.saga.request.spender),
    });
    if (!post.ok) {
      await this.markJournal(key, { status: 'UNKNOWN', txHash: hash, note: 'Revoke postcondition failed.' });
      return { status: 'FAILED', receipt: null, note: 'Revoke receipt exists but allowance is not zero.' };
    }
    const receipt = buildRevokeReceipt({
      record: context.saga,
      originalStep: context.originalStep,
      plan,
      transaction,
      rpc,
      postconditions: post.conditions,
      allowance: post.allowance ?? 0n,
      observedAt: context.clock.now().toISOString(),
    });
    const verification = verifyCompensationReceipt(
      receipt,
      context.saga,
      'REVOKE_APPROVAL',
      context.originalStep,
    );
    if (!verification.ok) {
      await this.markJournal(key, {
        status: 'UNKNOWN',
        txHash: hash,
        note: `Revoke receipt invalid: ${verification.reasons.join('; ')}`,
      });
      return { status: 'FAILED', receipt: null, note: 'Revoke receipt failed verification.' };
    }
    await this.journal.put({
      ...(await this.requireJournal(key)),
      status: 'CONFIRMED',
      txHash: hash,
      receipt: verification.receipt as OnChainReceipt,
      updatedAt: context.clock.now().toISOString(),
      note: 'Revoke confirmed; allowance is zero.',
    });
    return { status: 'SUCCEEDED', receipt: verification.receipt, note: 'Approval revoked on testnet.' };
  }

  private async resolveSubmitEntry(
    entry: TestnetJournalEntry,
    saga: SagaRecord,
    step: StepName,
    clock: Clock,
    expectedPlanHash: string,
  ): Promise<ProofReceipt> {
    if (entry.planHash !== expectedPlanHash) {
      throw new PermanentStepError('JOURNAL_PLAN_MISMATCH', 'Journal entry belongs to a different plan.');
    }
    if (entry.status === 'CONFIRMED' && entry.receipt) {
      const verification = verifyStepReceipt(entry.receipt, saga, step);
      if (verification.ok) return verification.receipt;
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_JOURNAL_RECEIPT_INVALID',
        'Journal receipt failed verification; manual recovery required.',
      );
    }
    if (entry.status === 'REVERTED') {
      throw new PermanentStepError('TESTNET_TX_REVERTED', 'Journal shows a reverted transaction.');
    }
    if (!entry.txHash) {
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_OUTCOME_UNKNOWN',
        'Journal has INTENT without a hash. Do not resubmit; manual reconciliation required.',
      );
    }
    const rpc = await this.client.getTransactionReceipt(entry.txHash);
    if (!rpc) {
      throw new UnknownSubmissionOutcomeError(
        'TESTNET_OUTCOME_UNKNOWN',
        `Transaction ${entry.txHash} has no receipt yet. Do not resubmit.`,
        { txHash: entry.txHash },
      );
    }
    if (rpc.status === 'reverted') {
      await this.markJournal(entry.key, { status: 'REVERTED', note: 'Replayed journal: reverted.' });
      throw new PermanentStepError('TESTNET_TX_REVERTED', `Transaction reverted: ${entry.txHash}`);
    }
    const reconciliation = await this.reconcile(step, {
      saga,
      step,
      stepRecord: saga.steps[step],
      clock,
    });
    if (reconciliation.receipt) return reconciliation.receipt;
    throw new UnknownSubmissionOutcomeError(
      'TESTNET_OUTCOME_UNKNOWN',
      `Existing transaction could not be reconciled: ${reconciliation.detail}`,
      { txHash: entry.txHash },
    );
  }

  private async waitForReceipt(hash: string): Promise<RpcReceipt | null> {
    try {
      return await this.client.waitForTransactionReceipt(hash, this.receiptTimeoutMs);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'WaitForTransactionReceiptTimeoutError') return null;
      return null;
    }
  }

  private async ensureNetwork(): Promise<void> {
    const chainId = await this.readWithRetry('chainId', () => this.client.getChainId());
    if (chainId !== 688689) {
      throw new PermanentStepError(
        'WRONG_CHAIN',
        `Refusing to plan or send: RPC reports chainId ${chainId}, expected 688689 (Atlantic testnet). Mainnet is never used.`,
      );
    }
    if (this.config.network.chainId !== 688689 || this.config.network.name !== 'atlantic-testnet') {
      throw new PermanentStepError('WRONG_CONFIGURED_NETWORK', 'Configured network is not Atlantic testnet.');
    }
  }

  private async readWithRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let last: unknown = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (attempt < 4) await this.sleep(250 * 2 ** (attempt - 1));
      }
    }
    throw new TransientStepError(
      'TESTNET_READ_FAILED',
      `Read-only ${label} failed after 4 attempts: ${errorMessage(last)}`,
    );
  }

  private requireTestnetConfig(saga: SagaRecord): TestnetConfig {
    if (saga.config.adapterId !== 'pharos-testnet' || !saga.config.testnet) {
      throw new PermanentStepError('NOT_CONFIGURED', 'Saga is not configured for the testnet adapter.');
    }
    return saga.config.testnet;
  }

  private async requireJournal(key: string): Promise<TestnetJournalEntry> {
    const entry = await this.journal.get(key);
    if (!entry) throw new Error(`Journal entry disappeared: ${key}`);
    return entry;
  }

  private async markJournal(
    key: string,
    update: Partial<Pick<TestnetJournalEntry, 'status' | 'txHash' | 'note'>>,
  ): Promise<void> {
    const entry = await this.requireJournal(key);
    await this.journal.put({
      ...entry,
      ...update,
      updatedAt: this.clock.now().toISOString(),
    });
  }
}

export type { ReadinessParams };
