import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ATLANTIC_TESTNET } from '../config.js';
import { ATLANTIC_CHAIN_ID, readArtifact, type ArtifactFile } from '../deployPlan.js';
import { assertLocalRpcUrl, scrubSensitive, verifyRuntimeCode } from '../deploy/verify.js';
import {
  SAGA_CEILING_WEI,
  SAGA_CONTRACT_ARTIFACTS,
  SAGA_CONTRACT_KEYS,
  SAGA_CONTRACT_NAMES,
  SAGA_STEPS,
  ONE_TUSDC_RAW,
  buildSagaPlanCore,
  buildSagaStepCalldata,
  computeSagaPlanHash,
  officialAtlanticUsdcAddress,
  resolveSagaContractsFromDeployJournal,
  type SagaContractKey,
  type SagaContracts,
  type SagaPlanCore,
  type SagaStepSpec,
} from '../sagaPlan.js';
import {
  ERC20_READ_ABI,
  checkSagaWiring,
  sagaFinalPostconditions,
  sagaStepPostconditions,
  sagaStepPreconditions,
} from './verify.js';
import { SagaJournal, type SagaJournalEntry } from './journal.js';

/**
 * GATED SAGA RUNNER - TEST-ONLY MOCK ECOSYSTEM.
 *
 * The only path that can sign and broadcast the reviewed five-step saga
 * (mint 1 tUSDC -> approve -> swap -> approve -> deposit). Order of operations:
 *
 *   force-rebuild -> addresses from the deployment journal (atlantic) ->
 *   recompute + compare the approved plan hash -> chain guard -> nonce / gas
 *   price / balance re-read -> 0.02 PHRS ceiling -> on-chain contract + wiring
 *   verification -> per-step precondition re-check -> INTENT journal -> one
 *   send -> receipt + transaction-input hash + postcondition verification ->
 *   end-of-saga battery including the untouched official USDC balance.
 *
 * Any mismatch, revert, timeout or ambiguous send stops the run; INTENT,
 * BROADCAST, REVERTED and UNKNOWN entries are never automatically resent.
 * Test injections exist for the local Anvil harness only and are refused in
 * atlantic mode.
 */

const LOCAL_CHAIN_ID = 31337;

const ATLANTIC_CHAIN = {
  id: ATLANTIC_CHAIN_ID,
  name: 'Pharos Atlantic Testnet',
  nativeCurrency: { name: 'PHRS', symbol: 'PHRS', decimals: 18 },
  rpcUrls: { default: { http: [ATLANTIC_TESTNET.publicRpcUrl] } },
} as const;

const LOCAL_CHAIN = {
  id: LOCAL_CHAIN_ID,
  name: 'Local Anvil (test-only)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
} as const;

/** Test-injection caliber for the postcondition breaker; never used in atlantic mode. */
const BREAKER_USDC_MINT_ABI = parseAbi(['function mint(address to, uint256 amount)']);
const BREAKER_ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export interface SagaForgeOptions {
  repoRoot: string;
  wslDistro: string;
  forgeBin: string;
}

export interface SagaTestInjections {
  /**
   * local-anvil only: send this step with its final calldata byte flipped.
   * The recorded approved-calldata hash must catch the mismatch on receipt.
   */
  alterCalldataFor?: string;
  /**
   * local-anvil only: after this step's receipt, send one extra conflicting
   * transaction so the step's postcondition check must catch the drift.
   */
  breakPostconditionFor?: string;
  /** local-anvil only: skip waiting for the receipt, forcing an UNKNOWN outcome. */
  ambiguousFor?: string;
}

export interface SagaRunOptions {
  repoRoot: string;
  mode: 'atlantic' | 'local-anvil';
  approvedPlanHash: string;
  deployerAddress: Address;
  rpcUrl: string;
  stateDir: string;
  receiptTimeoutMs: number;
  log: (line: string) => void;
  /** local-anvil: the four already-deployed contract addresses. */
  contracts?: SagaContracts;
  /** atlantic: the durable deployment journal that records the verified addresses. */
  deployJournalPath?: string;
  /** Atlantic only: must confirm the explicit flag; the runner refuses without it. */
  confirmAtlanticTestnet?: boolean;
  /** Atlantic only: called lazily after all gates, immediately before the first send. */
  keyProvider?: () => string;
  forgeCommand?: SagaForgeOptions;
  testInjections?: SagaTestInjections;
}

export interface SagaRunResult {
  status: 'COMPLETE' | 'STOPPED';
  reason: string | null;
  journalPath: string;
  contracts: SagaContracts | null;
  totalGasUsed: bigint;
  totalWeiSpent: bigint;
  steps: { order: number; name: string; outcome: 'SENT' | 'SKIPPED_CONFIRMED' | 'SKIPPED_NOT_REQUIRED' }[];
}

/** Internal control-flow signal: stop safely, never resend. */
class SagaStop extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SagaStop';
    this.reason = reason;
  }
}

interface RunState {
  contracts: SagaContracts | null;
  artifacts: Record<SagaContractKey, ArtifactFile> | null;
  officialUsdc: Address | null;
  officialUsdcBaseline: bigint | null;
  totalGasUsed: bigint;
  totalWeiSpent: bigint;
  steps: { order: number; name: string; outcome: 'SENT' | 'SKIPPED_CONFIRMED' | 'SKIPPED_NOT_REQUIRED' }[];
}

interface SendParams {
  to: Address;
  data: Hex;
  gas: bigint;
  gasPrice: bigint;
  nonce: number;
}

interface SagaSigner {
  send(params: SendParams): Promise<Hash>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tailOutput(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `...${trimmed.slice(-max)}`;
}

/** C:\path\to\repo -> /mnt/c/path/to/repo */
function toWslPath(winPath: string): string {
  const match = /^([A-Za-z]):\\(.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, '/');
  const drive = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * Force-rebuild the contracts before anything else. Any failure aborts the
 * saga before a single network call is made.
 */
function runForgeBuild(opts: SagaRunOptions): void {
  const forge = opts.forgeCommand;
  if (!forge) {
    throw new SagaStop('force-rebuild is mandatory but no forge command is configured');
  }
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'wsl.exe',
          [
            '-d',
            forge.wslDistro,
            '--',
            '/bin/bash',
            '--noprofile',
            '--norc',
            '-c',
            `cd ${toWslPath(forge.repoRoot)} && ${forge.forgeBin} build --force`,
          ],
          { encoding: 'utf8', timeout: 600_000, windowsHide: true },
        )
      : spawnSync(forge.forgeBin, ['build', '--force'], {
          cwd: forge.repoRoot,
          encoding: 'utf8',
          timeout: 600_000,
        });
  if (result.error) {
    throw new SagaStop(`forge build --force could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SagaStop(
      `forge build --force failed (exit ${String(result.status)}): ${tailOutput(result.stderr || result.stdout)}`,
    );
  }
}

function makeLocalSigner(rpcUrl: string, address: Address): SagaSigner {
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  const wallet = createWalletClient({ account: address, chain: LOCAL_CHAIN, transport });
  return {
    async send(params) {
      // JSON-RPC account: the disposable Anvil node signs for its own unlocked key.
      return wallet.sendTransaction({
        account: address,
        chain: LOCAL_CHAIN,
        to: params.to,
        data: params.data,
        gas: params.gas,
        gasPrice: params.gasPrice,
        nonce: params.nonce,
      });
    },
  };
}

function makeAtlanticSigner(rpcUrl: string, privateKey: string, expected: Address): SagaSigner {
  const account = privateKeyToAccount(privateKey as Hex);
  if (getAddress(account.address) !== getAddress(expected)) {
    throw new SagaStop(
      `the signing key derives ${account.address}, which does not match the approved deployer ${expected}; refusing to sign`,
    );
  }
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  const wallet = createWalletClient({ account, chain: ATLANTIC_CHAIN, transport });
  return {
    async send(params) {
      return wallet.sendTransaction({
        account,
        chain: ATLANTIC_CHAIN,
        to: params.to,
        data: params.data,
        gas: params.gas,
        gasPrice: params.gasPrice,
        nonce: params.nonce,
      });
    },
  };
}

async function waitForReceipt(
  client: PublicClient,
  hash: Hash,
  timeoutMs: number,
): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionReceiptNotFoundError') throw error;
    }
    if (Date.now() >= deadline) return null;
    await delay(Math.min(2_000, Math.max(250, deadline - Date.now())));
  }
}

/** Flip the least significant bit of the final calldata byte (test injection). */
function flipLastDataByte(data: Hex): Hex {
  const body = data.slice(2);
  const at = body.length - 2;
  const flipped = (Number.parseInt(body.slice(at), 16) ^ 0x01) & 0xff;
  return `0x${body.slice(0, at)}${flipped.toString(16).padStart(2, '0')}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function formatFailures(failures: { label: string; actual: string; expected: string }[]): string {
  return failures.map((failure) => `${failure.label} is ${failure.actual}, expected ${failure.expected}`).join('; ');
}

async function loadArtifactsByTarget(repoRoot: string): Promise<Record<SagaContractKey, ArtifactFile>> {
  const out = {} as Record<SagaContractKey, ArtifactFile>;
  for (const key of SAGA_CONTRACT_KEYS) {
    out[key] = await readArtifact(repoRoot, SAGA_CONTRACT_ARTIFACTS[key]);
  }
  return out;
}

function artifactSha256Of(artifact: ArtifactFile): string {
  return sha256Hex(artifact.bytecode);
}

/**
 * Pre-flight requirement 2: every target contract still matches the freshly
 * built artifact (masked immutables), and in atlantic mode the artifact hash
 * also matches the hash recorded by the verified deployment run.
 */
async function verifyDeployedContracts(
  opts: SagaRunOptions,
  client: PublicClient,
  contracts: SagaContracts,
  artifacts: Record<SagaContractKey, ArtifactFile>,
  journalArtifactSha256: Partial<Record<SagaContractKey, string>>,
): Promise<void> {
  for (const key of SAGA_CONTRACT_KEYS) {
    const name = SAGA_CONTRACT_NAMES[key];
    const address = contracts[key];
    const artifact = artifacts[key];
    const code = await client.getCode({ address });
    if (!code || code === '0x') {
      throw new SagaStop(`no runtime code at ${name} (${address}); refusing to execute`);
    }
    try {
      verifyRuntimeCode(code, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SagaStop(`deployed runtime code verification failed for ${name} at ${address}: ${message}`);
    }
    const recordedSha = journalArtifactSha256[key];
    if (recordedSha) {
      const freshSha = artifactSha256Of(artifact);
      if (freshSha !== recordedSha) {
        throw new SagaStop(
          `fresh ${name} artifact hash ${freshSha} does not match the deployment journal hash ${recordedSha}; re-run the plan and re-review`,
        );
      }
    }
    opts.log(`${name} at ${address}: runtime code matches the fresh artifact (immutables masked)`);
  }
}

/**
 * TEST INJECTION (local-anvil only): send one extra conflicting transaction
 * from the same account so the step's postcondition check must catch state
 * drift. This exists solely to prove the postcondition layer in the local
 * harness; it is refused in atlantic mode.
 */
async function sendPostconditionBreaker(params: {
  opts: SagaRunOptions;
  signer: SagaSigner;
  client: PublicClient;
  state: RunState;
  spec: SagaStepSpec;
  contracts: SagaContracts;
  nonce: number;
  gasPrice: bigint;
}): Promise<void> {
  const { opts, state, spec, contracts } = params;
  if (opts.mode !== 'local-anvil') {
    throw new SagaStop('test injections are only available in local-anvil mode');
  }
  let to: Address;
  let data: Hex;
  let label: string;
  switch (spec.name) {
    case 'MintTusdc':
      to = contracts.tUSDC;
      data = encodeFunctionData({
        abi: BREAKER_USDC_MINT_ABI,
        functionName: 'mint',
        args: [opts.deployerAddress, 1n],
      });
      label = 'extra mint(deployer, 1)';
      break;
    case 'ApproveTusdcToSwap':
      to = contracts.tUSDC;
      data = encodeFunctionData({
        abi: BREAKER_ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [contracts.swap, 424_242n],
      });
      label = 'conflicting re-approve(swap, 424242)';
      break;
    case 'ApproveReceiptToVault':
      to = contracts.tSAGA;
      data = encodeFunctionData({
        abi: BREAKER_ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [contracts.vault, 1n],
      });
      label = 'conflicting re-approve(vault, 1)';
      break;
    default:
      throw new SagaStop(`breakPostconditionFor is not supported for ${spec.name}`);
  }
  opts.log(`test injection active for ${spec.name}: sending ${label} to break the postcondition`);
  const hash = await params.signer.send({
    to,
    data,
    gas: 100_000n,
    gasPrice: params.gasPrice,
    nonce: params.nonce,
  });
  const receipt = await waitForReceipt(params.client, hash, opts.receiptTimeoutMs);
  if (!receipt || receipt.status !== 'success') {
    throw new SagaStop(`test injection conflict transaction for ${spec.name} did not confirm`);
  }
  state.totalGasUsed += receipt.gasUsed;
  state.totalWeiSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? params.gasPrice);
}

async function execute(
  opts: SagaRunOptions,
  state: RunState,
  planHash: string,
  core: SagaPlanCore,
  journalArtifactSha256: Partial<Record<SagaContractKey, string>>,
): Promise<void> {
  const contracts = state.contracts;
  const artifacts = state.artifacts;
  if (!contracts || !artifacts) throw new SagaStop('internal: contracts/artifacts not resolved');
  const client = createPublicClient({ transport: http(opts.rpcUrl, { timeout: 20_000, retryCount: 2 }) });

  const chainId = await client.getChainId();
  const expectedChain = opts.mode === 'atlantic' ? ATLANTIC_CHAIN_ID : LOCAL_CHAIN_ID;
  opts.log(`RPC chainId: ${chainId} (expected ${expectedChain})`);
  if (chainId !== expectedChain) {
    throw new SagaStop(
      `WRONG CHAIN: the RPC reported chainId ${chainId}; this ${opts.mode} run executes the saga only on chainId ${expectedChain}`,
    );
  }

  const nonce = BigInt(
    await client.getTransactionCount({ address: opts.deployerAddress, blockTag: 'pending' }),
  );
  const gasPrice = await client.getGasPrice();
  const balance = await client.getBalance({ address: opts.deployerAddress });
  opts.log(`pending nonce: ${nonce}`);
  opts.log(`gas price: ${gasPrice} wei`);
  opts.log(`balance: ${balance} wei`);

  const worstCase = BigInt(core.totalGasCap) * gasPrice;
  if (worstCase > SAGA_CEILING_WEI) {
    throw new SagaStop(
      `worst-case gas cost ${worstCase} wei exceeds the 0.02 PHRS saga ceiling at gas price ${gasPrice} wei; re-run the plan and re-review`,
    );
  }
  if (balance < worstCase) {
    throw new SagaStop(`balance ${balance} wei does not cover the worst-case saga cost ${worstCase} wei`);
  }
  opts.log(
    `worst-case cost: ${worstCase} wei = total cap ${core.totalGasCap} gas x ${gasPrice} wei; under the 0.02 PHRS ceiling`,
  );

  await verifyDeployedContracts(opts, client, contracts, artifacts, journalArtifactSha256);

  const wiring = await checkSagaWiring({
    client,
    contracts,
    deployer: opts.deployerAddress,
    officialUsdc: state.officialUsdc,
  });
  if (wiring.failures.length > 0) {
    throw new SagaStop(
      `contract wiring verification failed: ${formatFailures(wiring.failures)}; refusing to execute`,
    );
  }
  state.officialUsdcBaseline = wiring.officialUsdcBalance;
  opts.log(
    `target token: TestOnlyUSDC (tUSDC) at ${contracts.tUSDC} - mock identity, controllers, fee and wiring verified`,
  );
  if (state.officialUsdc) {
    opts.log(
      `official USDC ${state.officialUsdc} is never targeted; deployer balance baseline ${String(state.officialUsdcBaseline)} must remain unchanged`,
    );
  }

  const journal = new SagaJournal(path.join(opts.stateDir, 'saga-journal.json'));
  let signer: SagaSigner | null = null;
  const ensureSigner = async (): Promise<SagaSigner> => {
    if (signer) return signer;
    if (opts.mode === 'atlantic') {
      const key = opts.keyProvider?.();
      if (!key) throw new SagaStop('no signing key available for atlantic mode');
      signer = makeAtlanticSigner(opts.rpcUrl, key, opts.deployerAddress);
      opts.log('signing account verified against the approved deployer address');
    } else {
      signer = makeLocalSigner(opts.rpcUrl, opts.deployerAddress);
    }
    return signer;
  };

  let actualNonce = nonce;
  for (const spec of SAGA_STEPS) {
    const key = `saga:${planHash}:${spec.order}:${spec.name}`;
    const existing = await journal.get(key);
    if (existing) {
      if (existing.status === 'CONFIRMED') {
        opts.log(`step ${spec.order} ${spec.name}: already CONFIRMED for this plan hash; skipping (no resend)`);
        actualNonce += 1n;
        state.steps.push({ order: spec.order, name: spec.name, outcome: 'SKIPPED_CONFIRMED' });
        continue;
      }
      throw new SagaStop(
        `journal entry ${key} is ${existing.status}; refusing to resend an unresolved step. Reconcile manually.`,
      );
    }

    // Mint step - exact reviewed policy, enforced here outside the hashed
    // plan core: the tUSDC balance must be exactly 0 (then mint exactly
    // 1.000000) or exactly 1000000 (then skip the step); any other balance
    // stops the run here, before any signing, broadcast or journal write.
    if (spec.name === 'MintTusdc') {
      const nextEntry = await journal.get(`saga:${planHash}:2:ApproveTusdcToSwap`);
      if (nextEntry) {
        // A previous run already passed the mint decision. A sent mint would
        // have left an entry under this key, so it was skipped with no nonce
        // consumed: skip it again and never mint twice.
        opts.log(
          'step 1 MintTusdc: a previous run already passed the mint decision without a transaction; skipping (no resend)',
        );
        state.steps.push({ order: spec.order, name: spec.name, outcome: 'SKIPPED_NOT_REQUIRED' });
        continue;
      }
      const balance = (await client.readContract({
        address: contracts.tUSDC,
        abi: ERC20_READ_ABI,
        functionName: 'balanceOf',
        args: [opts.deployerAddress],
      })) as bigint;
      if (balance === ONE_TUSDC_RAW) {
        opts.log(
          'step 1 MintTusdc: mint not required - the tUSDC balance is already exactly 1.000000; skipping (no transaction)',
        );
        state.steps.push({ order: spec.order, name: spec.name, outcome: 'SKIPPED_NOT_REQUIRED' });
        continue;
      }
      if (balance !== 0n) {
        throw new SagaStop(
          `tUSDC balance ${balance} does not match the reviewed pre-state (0 or 1000000); re-run the plan and re-review`,
        );
      }
    } else {
      const preFailures = await sagaStepPreconditions({
        client,
        contracts,
        deployer: opts.deployerAddress,
        stepName: spec.name,
      });
      if (preFailures.length > 0) {
        throw new SagaStop(
          `precondition failed for ${spec.name}: ${formatFailures(preFailures)}; state changed since the plan was approved - re-run the plan and re-review`,
        );
      }
    }

    const planData = buildSagaStepCalldata({
      stepName: spec.name,
      deployerAddress: opts.deployerAddress,
      contracts,
    });
    const injections = opts.testInjections;
    let sendData = planData;
    let injected = '';
    if (injections?.alterCalldataFor === spec.name) {
      sendData = flipLastDataByte(planData);
      injected = 'INJECTED-ALTERED-CALLDATA ';
    }
    if (injected) {
      opts.log(
        `test injection active for ${spec.name}: ${injected.trim()} (the approved-calldata hash must catch it)`,
      );
    }

    const signerNow = await ensureSigner();
    const nonceNumber = Number(actualNonce);
    if (!Number.isSafeInteger(nonceNumber)) {
      throw new SagaStop('nonce exceeds the safe integer range; refusing to continue');
    }
    const gasLimit = BigInt(spec.gasCap);
    const to = getAddress(contracts[spec.target]);
    const entry: SagaJournalEntry = {
      key,
      planHash,
      order: spec.order,
      name: spec.name,
      kind: 'call',
      nonce: nonceNumber,
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      to,
      dataSha256: sha256Hex(planData),
      artifactSha256: artifactSha256Of(artifacts[spec.target]),
      txHash: null,
      status: 'INTENT',
      recordedAt: nowIso(),
      updatedAt: nowIso(),
      blockNumber: null,
      gasUsed: null,
      effectiveGasPrice: null,
      note: 'INTENT persisted before any signing or broadcast.',
    };
    await journal.put(entry);
    opts.log(`INTENT persisted before send: ${spec.order} ${spec.name} gasLimit=${gasLimit} ${injected}`);

    let txHash: Hash;
    try {
      txHash = await signerNow.send({ to, data: sendData, gas: gasLimit, gasPrice, nonce: nonceNumber });
    } catch (error) {
      const message = scrubSensitive(
        error instanceof Error ? error.message : String(error),
        opts.rpcUrl,
      );
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        note: `send outcome ambiguous: ${message}. Never resent automatically.`,
        updatedAt: nowIso(),
      });
      throw new SagaStop(`send outcome ambiguous for ${spec.name}: ${message}`);
    }
    await journal.put({
      ...entry,
      status: 'BROADCAST',
      txHash,
      note: 'Broadcast observed; awaiting receipt.',
      updatedAt: nowIso(),
    });
    opts.log(`BROADCAST ${spec.name}: ${txHash}`);

    if (injections?.ambiguousFor === spec.name) {
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        txHash,
        note: 'test injection: receipt deliberately not awaited; ambiguous outcome, never resent.',
        updatedAt: nowIso(),
      });
      throw new SagaStop(`ambiguous outcome injected for ${spec.name}; not resubmitted`);
    }

    const receipt = await waitForReceipt(client, txHash, opts.receiptTimeoutMs);
    if (!receipt) {
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        txHash,
        note: `receipt not observed within ${opts.receiptTimeoutMs} ms; ambiguous outcome. Never resent automatically.`,
        updatedAt: nowIso(),
      });
      throw new SagaStop(
        `receipt for ${spec.name} was not observed within ${opts.receiptTimeoutMs} ms; treat as ambiguous and reconcile manually`,
      );
    }

    const receiptFields = {
      blockNumber: (receipt.blockNumber ?? 0n).toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: (receipt.effectiveGasPrice ?? gasPrice).toString(),
    };

    if (receipt.status !== 'success') {
      await journal.put({
        ...entry,
        status: 'REVERTED',
        txHash,
        ...receiptFields,
        note: 'transaction reverted on-chain; stopping without any resend.',
        updatedAt: nowIso(),
      });
      throw new SagaStop(`${spec.name} transaction reverted on-chain; stopping without any resend`);
    }
    if (receipt.gasUsed > gasLimit) {
      throw new SagaStop(`${spec.name} reported gasUsed ${receipt.gasUsed} above its gas limit`);
    }
    state.totalGasUsed += receipt.gasUsed;
    state.totalWeiSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice);

    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (!tx.to || getAddress(tx.to) !== to) {
        throw new Error(`transaction target ${String(tx.to)} does not match the approved target ${to}`);
      }
      if (getAddress(tx.from) !== getAddress(opts.deployerAddress)) {
        throw new Error(
          `transaction sender ${tx.from} does not match the approved deployer ${opts.deployerAddress}`,
        );
      }
      if (Number(tx.nonce) !== nonceNumber) {
        throw new Error(`transaction nonce ${tx.nonce} does not match the journaled nonce ${nonceNumber}`);
      }
      const inputSha256 = sha256Hex(tx.input);
      if (inputSha256 !== entry.dataSha256) {
        throw new Error(
          `transaction input hash ${inputSha256.slice(0, 16)}... does not match the approved calldata ${entry.dataSha256.slice(0, 16)}... (sent and approved calldata differ)`,
        );
      }
      opts.log(
        `${spec.name}: transaction input matches the approved calldata hash ${entry.dataSha256.slice(0, 16)}...`,
      );

      if (injections?.breakPostconditionFor === spec.name) {
        await sendPostconditionBreaker({
          opts,
          signer: signerNow,
          client,
          state,
          spec,
          contracts,
          nonce: nonceNumber + 1,
          gasPrice,
        });
        actualNonce += 1n;
      }

      const postFailures = await sagaStepPostconditions({
        client,
        contracts,
        deployer: opts.deployerAddress,
        stepName: spec.name,
      });
      if (postFailures.length > 0) {
        throw new Error(`postcondition failed for ${spec.name}: ${formatFailures(postFailures)}`);
      }

      await journal.put({
        ...entry,
        status: 'CONFIRMED',
        txHash,
        ...receiptFields,
        note: 'receipt, calldata hash and postconditions verified.',
        updatedAt: nowIso(),
      });
      state.steps.push({ order: spec.order, name: spec.name, outcome: 'SENT' });
      opts.log(`CONFIRMED ${spec.name} (gasUsed ${receiptFields.gasUsed})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        txHash,
        ...receiptFields,
        note: `verification failed after a successful send: ${message}`,
        updatedAt: nowIso(),
      });
      throw new SagaStop(`saga verification failed for ${spec.name}: ${message}`);
    }

    actualNonce += 1n;
  }

  const finalFailures = await sagaFinalPostconditions({
    client,
    contracts,
    deployer: opts.deployerAddress,
    officialUsdc: state.officialUsdc,
    officialUsdcBaseline: state.officialUsdcBaseline,
  });
  if (finalFailures.length > 0) {
    throw new SagaStop(
      `end-of-saga postconditions failed: ${formatFailures(finalFailures)}; re-run the plan and re-review`,
    );
  }
  if (state.totalWeiSpent > SAGA_CEILING_WEI) {
    throw new SagaStop(
      `total spend ${state.totalWeiSpent} wei exceeded the 0.02 PHRS ceiling; stopping`,
    );
  }
  opts.log(`total gas used: ${state.totalGasUsed}; total spent: ${state.totalWeiSpent} wei`);
}

/**
 * Gated saga runner.
 *
 * Order of operations: force-rebuild -> resolve + recompute + compare the
 * approved plan hash -> network chain guard -> nonce/gas/balance + ceiling
 * checks -> deployed-contract and wiring verification -> per-step prechecks
 * and INTENT journal -> one send per step -> receipt, calldata-hash and
 * postcondition verification. Any mismatch, revert, timeout or ambiguous
 * outcome stops the run and is never automatically resent.
 */
export async function runSaga(opts: SagaRunOptions): Promise<SagaRunResult> {
  const journalPath = path.join(opts.stateDir, 'saga-journal.json');
  const state: RunState = {
    contracts: null,
    artifacts: null,
    officialUsdc: null,
    officialUsdcBaseline: null,
    totalGasUsed: 0n,
    totalWeiSpent: 0n,
    steps: [],
  };
  const result = (status: 'COMPLETE' | 'STOPPED', reason: string | null): SagaRunResult => ({
    status,
    reason,
    journalPath,
    contracts: state.contracts,
    totalGasUsed: state.totalGasUsed,
    totalWeiSpent: state.totalWeiSpent,
    steps: state.steps,
  });

  try {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.approvedPlanHash)) {
      throw new SagaStop('the approved plan hash must be the 64-hex value printed by the plan script');
    }
    if (opts.mode === 'atlantic') {
      if (opts.confirmAtlanticTestnet !== true) {
        throw new SagaStop('atlantic mode requires the explicit --confirm-atlantic-testnet flag');
      }
      if (opts.testInjections) {
        throw new SagaStop('test injections are only available in local-anvil mode');
      }
      if (!opts.keyProvider) {
        throw new SagaStop('atlantic mode requires a signing key provider (never expected in review runs)');
      }
      if (opts.contracts) {
        throw new SagaStop('atlantic mode always derives the contract addresses from the deployment journal');
      }
      if (!opts.deployJournalPath) {
        throw new SagaStop('atlantic mode requires the deployment journal path with the verified addresses');
      }
      state.officialUsdc = officialAtlanticUsdcAddress();
    } else {
      if (!opts.contracts) {
        throw new SagaStop('local-anvil mode requires the four already-deployed contract addresses');
      }
      try {
        assertLocalRpcUrl(opts.rpcUrl);
      } catch (error) {
        throw new SagaStop(
          `local-anvil mode rejected the RPC URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    runForgeBuild(opts);
    opts.log('forge build --force: OK');

    let journalArtifactSha256: Partial<Record<SagaContractKey, string>> = {};
    let contractsResolved: SagaContracts;
    if (opts.mode === 'atlantic') {
      const resolved = await resolveSagaContractsFromDeployJournal(opts.deployJournalPath as string);
      if (!resolved.ok) throw new SagaStop(resolved.reason);
      contractsResolved = resolved.contracts;
      journalArtifactSha256 = resolved.artifactSha256;
      opts.log(
        `contracts from the deployment journal: tUSDC ${contractsResolved.tUSDC}, tSAGA ${contractsResolved.tSAGA}, swap ${contractsResolved.swap}, vault ${contractsResolved.vault}`,
      );
    } else {
      const provided = opts.contracts as SagaContracts;
      contractsResolved = {
        tUSDC: getAddress(provided.tUSDC),
        tSAGA: getAddress(provided.tSAGA),
        swap: getAddress(provided.swap),
        vault: getAddress(provided.vault),
      };
    }
    state.contracts = contractsResolved;

    const core = buildSagaPlanCore({
      deployerAddress: opts.deployerAddress,
      contracts: contractsResolved,
    });
    const planHash = computeSagaPlanHash(core);
    opts.log(`plan hash fresh:    ${planHash}`);
    opts.log(`plan hash approved: ${opts.approvedPlanHash.toLowerCase()}`);
    if (planHash.toLowerCase() !== opts.approvedPlanHash.toLowerCase()) {
      throw new SagaStop(
        'the freshly rebuilt plan (addresses, calldata, gas caps, ceiling) does not match the approved plan hash; refusing to execute',
      );
    }

    state.artifacts = await loadArtifactsByTarget(opts.repoRoot);
    await execute(opts, state, planHash, core, journalArtifactSha256);
    opts.log('saga complete: all steps confirmed and verified');
    return result('COMPLETE', null);
  } catch (error) {
    if (error instanceof SagaStop) {
      opts.log(`STOPPED: ${error.reason}`);
      return result('STOPPED', error.reason);
    }
    const message = scrubSensitive(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      opts.rpcUrl,
    );
    opts.log(`STOPPED (unexpected): ${message}`);
    return result('STOPPED', `unexpected error: ${message}`);
  }
}
