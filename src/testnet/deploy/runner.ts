import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ATLANTIC_TESTNET } from '../config.js';
import {
  ATLANTIC_CHAIN_ID,
  DEPLOY_STEPS,
  HARD_CEILING_WEI,
  buildPlanCore,
  computePlanHash,
  loadPlanArtifacts,
  predictedDeployAddresses,
  readArtifact,
  resolveConstructorArgs,
  type AddressBook,
  type ArtifactFile,
  type ArtifactInfo,
  type DeployPlanCore,
} from '../deployPlan.js';
import { DeployJournal, type DeployJournalEntry } from './journal.js';
import {
  DeployVerificationError,
  assertLocalRpcUrl,
  flattenImmutableRanges,
  intrinsicGasForCreation,
  scrubSensitive,
  verifyRuntimeCode,
} from './verify.js';

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

const TOKEN_ABI = parseAbi([
  'function controller() view returns (address)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);
const SWAP_ABI = parseAbi([
  'function controller() view returns (address)',
  'function usdc() view returns (address)',
  'function receipt() view returns (address)',
  'function feeBps() view returns (uint256)',
]);
const VAULT_ABI = parseAbi([
  'function controller() view returns (address)',
  'function asset() view returns (address)',
]);
const RECEIPT_WIRE_ABI = parseAbi([
  'function setMinter(address minter, bool allowed)',
  'function minters(address minter) view returns (bool)',
]);

export interface DeployForgeOptions {
  repoRoot: string;
  wslDistro: string;
  forgeBin: string;
}

export interface DeployTestInjections {
  /**
   * local-anvil only: flip one bit in the middle of the embedded runtime-code
   * region of the init code, skipping the immutable slots. The deployed code
   * then differs from the approved artifact, which the masked bytecode
   * comparison must catch.
   */
  corruptByteFor?: string;
  /**
   * local-anvil only: flip the last byte of the init code, which belongs to
   * the immutable template tail. The constructor therefore patches a
   * corrupted value into an immutable slot; the masked bytecode comparison
   * intentionally ignores those slots, so the getter checks must catch it.
   */
  corruptImmutableFor?: string;
  /** local-anvil only: send this step with intrinsic-gas+1000 so it reverts on-chain. */
  lowGasFor?: string;
  /** local-anvil only: skip waiting for the receipt, forcing an UNKNOWN outcome. */
  ambiguousFor?: string;
}

export interface DeployRunOptions {
  repoRoot: string;
  mode: 'atlantic' | 'local-anvil';
  approvedPlanHash: string;
  deployerAddress: Address;
  rpcUrl: string;
  stateDir: string;
  receiptTimeoutMs: number;
  log: (line: string) => void;
  /** Atlantic only: must confirm the explicit flag; the runner refuses without it. */
  confirmAtlanticTestnet?: boolean;
  /** Atlantic only: called lazily after all gates, immediately before the first send. */
  keyProvider?: () => string;
  forgeCommand?: DeployForgeOptions;
  testInjections?: DeployTestInjections;
}

export interface DeployRunResult {
  status: 'COMPLETE' | 'STOPPED';
  reason: string | null;
  addresses: Record<string, Address>;
  totalGasUsed: bigint;
  totalWeiSpent: bigint;
  journalPath: string;
  predictedAddresses: { order: number; name: string; address: Address }[];
}

/** Internal control-flow signal: stop safely, never resend. */
class DeployStop extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'DeployStop';
    this.reason = reason;
  }
}

type MutableBook = AddressBook & { vault?: Address };

interface RunState {
  book: MutableBook;
  totalGasUsed: bigint;
  totalWeiSpent: bigint;
  predicted: { order: number; name: string; address: Address }[];
}

interface SendParams {
  to?: Address;
  data: Hex;
  gas: bigint;
  gasPrice: bigint;
  nonce: number;
}

interface DeploySigner {
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
 * deployment before a single network call is made.
 */
function runForgeBuild(opts: DeployRunOptions): void {
  const forge = opts.forgeCommand;
  if (!forge) {
    throw new DeployStop('force-rebuild is mandatory but no forge command is configured');
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
    throw new DeployStop(`forge build --force could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new DeployStop(
      `forge build --force failed (exit ${String(result.status)}): ${tailOutput(result.stderr || result.stdout)}`,
    );
  }
}

function makeLocalSigner(rpcUrl: string, address: Address): DeploySigner {
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  const wallet = createWalletClient({ account: address, chain: LOCAL_CHAIN, transport });
  return {
    async send(params) {
      // JSON-RPC account: the disposable Anvil node signs for its own unlocked key.
      return wallet.sendTransaction({
        account: address,
        chain: LOCAL_CHAIN,
        ...(params.to ? { to: params.to } : {}),
        data: params.data,
        gas: params.gas,
        gasPrice: params.gasPrice,
        nonce: params.nonce,
      });
    },
  };
}

function makeAtlanticSigner(rpcUrl: string, privateKey: string, expected: Address): DeploySigner {
  const account = privateKeyToAccount(privateKey as Hex);
  if (getAddress(account.address) !== getAddress(expected)) {
    throw new DeployStop(
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
        ...(params.to ? { to: params.to } : {}),
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

function flipPairAt(body: string, byteIndex: number): string {
  const at = byteIndex * 2;
  const pair = body.slice(at, at + 2);
  const flipped = ((Number.parseInt(pair, 16) ^ 0x01) & 0xff).toString(16).padStart(2, '0');
  return `${body.slice(0, at)}${flipped}${body.slice(at + 2)}`;
}

/** Flip the last byte of the init code (part of the immutable template tail). */
function corruptImmutableTail(data: Hex): Hex {
  const body = data.slice(2);
  return `0x${flipPairAt(body, body.length / 2 - 1)}`;
}

/**
 * Flip one bit in the middle of the embedded runtime-code region of the init
 * code, skipping the immutable slots (patched at construction time). The
 * intact runtime region is located by prefix-searching the init code for the
 * artifact's deployed runtime code; if that fails we fall back to the tail.
 */
function corruptRuntimeByte(data: Hex, artifact: ArtifactFile): Hex {
  const init = data.slice(2).toLowerCase();
  const runtime = artifact.deployedBytecode.slice(2).toLowerCase();
  const needle = runtime.slice(0, 64);
  const start = needle.length === 64 ? init.indexOf(needle) : -1;
  if (start < 0 || start % 2 !== 0) return corruptImmutableTail(data);
  const ranges = flattenImmutableRanges(
    artifact.immutableReferences,
    artifact.deployedBytecode.length,
  );
  const runtimeStart = start / 2;
  const runtimeBytes = runtime.length / 2;
  let index = Math.floor(runtimeStart + runtimeBytes / 2);
  const inSlot = (byteIndex: number) =>
    ranges.some((range) => byteIndex >= range.start && byteIndex < range.start + range.length);
  while (index < runtimeStart + runtimeBytes && inSlot(index - runtimeStart)) index += 1;
  if (index >= runtimeStart + runtimeBytes) return corruptImmutableTail(data);
  return `0x${flipPairAt(init, index)}`;
}

function finalAddresses(book: MutableBook): Record<string, Address> {
  const out: Record<string, Address> = {};
  if (book.usdc) out['TestOnlyUSDC'] = book.usdc;
  if (book.receipt) out['TestOnlyReceiptToken'] = book.receipt;
  if (book.swap) out['TestOnlySwap'] = book.swap;
  if (book.vault) out['TestOnlyVault'] = book.vault;
  return out;
}

async function verifyImmutables(
  opts: DeployRunOptions,
  client: PublicClient,
  stepName: string,
  address: Address,
  book: MutableBook,
): Promise<void> {
  const read = async (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
    }) as Promise<unknown>;
  const expectAddress = (label: string, actual: unknown, expected: Address): void => {
    if (typeof actual !== 'string' || getAddress(actual) !== getAddress(expected)) {
      throw new DeployVerificationError(
        `${label} mismatch (${String(actual)} != ${expected}) for ${stepName}`,
      );
    }
  };
  switch (stepName) {
    case 'TestOnlyUSDC':
    case 'TestOnlyReceiptToken': {
      expectAddress('controller', await read(TOKEN_ABI, 'controller'), opts.deployerAddress);
      const decimals = await read(TOKEN_ABI, 'decimals');
      if (decimals !== 6) {
        throw new DeployVerificationError(`unexpected decimals ${String(decimals)} for ${stepName}`);
      }
      const expectedName = stepName === 'TestOnlyUSDC' ? 'Test Only USD Coin' : 'Test Only Saga Receipt';
      const expectedSymbol = stepName === 'TestOnlyUSDC' ? 'tUSDC' : 'tSAGA';
      const name = await read(TOKEN_ABI, 'name');
      const symbol = await read(TOKEN_ABI, 'symbol');
      if (name !== expectedName || symbol !== expectedSymbol) {
        throw new DeployVerificationError(
          `unexpected token identity "${String(name)}"/"${String(symbol)}" for ${stepName}`,
        );
      }
      break;
    }
    case 'TestOnlySwap': {
      expectAddress('controller', await read(SWAP_ABI, 'controller'), opts.deployerAddress);
      expectAddress('usdc', await read(SWAP_ABI, 'usdc'), book.usdc as Address);
      expectAddress('receipt', await read(SWAP_ABI, 'receipt'), book.receipt as Address);
      const fee = await read(SWAP_ABI, 'feeBps');
      if (fee !== 100n) {
        throw new DeployVerificationError(`unexpected feeBps ${String(fee)} for TestOnlySwap`);
      }
      break;
    }
    case 'TestOnlyVault': {
      expectAddress('controller', await read(VAULT_ABI, 'controller'), opts.deployerAddress);
      expectAddress('asset', await read(VAULT_ABI, 'asset'), book.receipt as Address);
      break;
    }
    default:
      throw new DeployVerificationError(`no immutable checks defined for ${stepName}`);
  }
}

async function execute(
  opts: DeployRunOptions,
  state: RunState,
  planHash: string,
  core: DeployPlanCore,
  artifacts: ReadonlyMap<string, ArtifactInfo>,
): Promise<void> {
  const transport = http(opts.rpcUrl, { timeout: 20_000, retryCount: 2 });
  const client = createPublicClient({ transport });

  const chainId = await client.getChainId();
  const expectedChain = opts.mode === 'atlantic' ? ATLANTIC_CHAIN_ID : LOCAL_CHAIN_ID;
  opts.log(`RPC chainId: ${chainId} (expected ${expectedChain})`);
  if (chainId !== expectedChain) {
    throw new DeployStop(
      `WRONG CHAIN: the RPC reported chainId ${chainId}; this ${opts.mode} run deploys only on chainId ${expectedChain}`,
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
  state.predicted = predictedDeployAddresses(opts.deployerAddress, nonce);
  for (const item of state.predicted) {
    opts.log(`predicted ${item.order} ${item.name}: ${item.address} (VOID if any tx is sent first)`);
  }

  const worstCase = BigInt(core.totalGasCap) * gasPrice;
  if (worstCase > HARD_CEILING_WEI) {
    throw new DeployStop(
      `worst-case gas cost ${worstCase} wei exceeds the 0.05 PHRS hard ceiling at gas price ${gasPrice}`,
    );
  }
  if (balance < worstCase) {
    throw new DeployStop(
      `balance ${balance} wei does not cover the worst-case deployment cost ${worstCase} wei`,
    );
  }
  opts.log(
    `worst-case cost: ${worstCase} wei = total cap ${core.totalGasCap} gas x ${gasPrice} wei; under the 0.05 PHRS ceiling`,
  );

  const journal = new DeployJournal(path.join(opts.stateDir, 'deploy-journal.json'));
  let signer: DeploySigner | null = null;
  const ensureSigner = async (): Promise<DeploySigner> => {
    if (signer) return signer;
    if (opts.mode === 'atlantic') {
      const key = opts.keyProvider?.();
      if (!key) throw new DeployStop('no signing key available for atlantic mode');
      signer = makeAtlanticSigner(opts.rpcUrl, key, opts.deployerAddress);
      opts.log('signing account verified against the approved deployer address');
    } else {
      signer = makeLocalSigner(opts.rpcUrl, opts.deployerAddress);
    }
    return signer;
  };

  const artifactCache = new Map<string, ArtifactFile>();
  const getArtifact = async (relative: string): Promise<ArtifactFile> => {
    const cached = artifactCache.get(relative);
    if (cached) return cached;
    const file = await readArtifact(opts.repoRoot, relative);
    artifactCache.set(relative, file);
    return file;
  };

  let actualNonce = nonce;
  for (const step of DEPLOY_STEPS) {
    const key = `deploy:${planHash}:${step.order}:${step.name}`;
    const existing = await journal.get(key);
    if (existing) {
      if (existing.status === 'CONFIRMED') {
        if (existing.kind === 'deploy' && existing.contractAddress) {
          const recovered = existing.contractAddress as Address;
          if (step.name === 'TestOnlyUSDC') state.book.usdc = recovered;
          if (step.name === 'TestOnlyReceiptToken') state.book.receipt = recovered;
          if (step.name === 'TestOnlySwap') state.book.swap = recovered;
          if (step.name === 'TestOnlyVault') state.book.vault = recovered;
        }
        opts.log(`step ${step.order} ${step.name}: already CONFIRMED for this plan hash; skipping (no resend)`);
        actualNonce += 1n;
        continue;
      }
      throw new DeployStop(
        `journal entry ${key} is ${existing.status}; refusing to resend an unresolved step. Reconcile manually.`,
      );
    }

    let to: Address | undefined;
    let data: Hex;
    let deployArtifact: ArtifactFile | null = null;
    if (step.kind === 'deploy') {
      if (!step.artifact) throw new DeployStop(`${step.name} has no artifact configured`);
      const artifact = await getArtifact(step.artifact);
      deployArtifact = artifact;
      data = encodeDeployData({
        abi: artifact.abi as Abi,
        bytecode: artifact.bytecode,
        args: resolveConstructorArgs(step.name, state.book) as never,
      });
    } else {
      if (!state.book.receipt || !state.book.swap) {
        throw new DeployStop('WireMinter requires the already-verified receipt and swap addresses');
      }
      to = state.book.receipt;
      data = encodeFunctionData({
        abi: RECEIPT_WIRE_ABI,
        functionName: 'setMinter',
        args: [state.book.swap, true],
      });
    }

    const injections = opts.testInjections;
    let injected = '';
    if (injections?.corruptByteFor === step.name) {
      data = deployArtifact ? corruptRuntimeByte(data, deployArtifact) : corruptImmutableTail(data);
      injected += 'INJECTED-CORRUPT-RUNTIME-BYTE ';
    }
    if (injections?.corruptImmutableFor === step.name) {
      data = corruptImmutableTail(data);
      injected += 'INJECTED-CORRUPT-IMMUTABLE-BYTE ';
    }
    let gasLimit = BigInt(step.gasCap);
    if (injections?.lowGasFor === step.name) {
      gasLimit = intrinsicGasForCreation(data) + 1_000n;
      injected += 'INJECTED-LOW-GAS ';
    }
    if (injected) opts.log(`test injection active for ${step.name}: ${injected.trim()}`);

    const signerNow = await ensureSigner();
    const nonceNumber = Number(actualNonce);
    if (!Number.isSafeInteger(nonceNumber)) {
      throw new DeployStop('nonce exceeds the safe integer range; refusing to continue');
    }
    const entry: DeployJournalEntry = {
      key,
      planHash,
      order: step.order,
      name: step.name,
      kind: step.kind,
      nonce: nonceNumber,
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      to: to ?? null,
      dataSha256: createHash('sha256').update(data).digest('hex'),
      artifactSha256: step.artifact ? (artifacts.get(step.name)?.sha256 ?? null) : null,
      txHash: null,
      status: 'INTENT',
      recordedAt: nowIso(),
      updatedAt: nowIso(),
      contractAddress: null,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPrice: null,
      note: 'INTENT persisted before any signing or broadcast.',
    };
    await journal.put(entry);
    opts.log(`INTENT persisted before send: ${step.order} ${step.name} gasLimit=${gasLimit} ${injected}`);

    let txHash: Hash;
    try {
      txHash = await signerNow.send({
        ...(to ? { to } : {}),
        data,
        gas: gasLimit,
        gasPrice,
        nonce: nonceNumber,
      });
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
      throw new DeployStop(`send outcome ambiguous for ${step.name}: ${message}`);
    }
    await journal.put({
      ...entry,
      status: 'BROADCAST',
      txHash,
      note: 'Broadcast observed; awaiting receipt.',
      updatedAt: nowIso(),
    });
    opts.log(`BROADCAST ${step.name}: ${txHash}`);

    if (injections?.ambiguousFor === step.name) {
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        txHash,
        note: 'test injection: receipt deliberately not awaited; ambiguous outcome, never resent.',
        updatedAt: nowIso(),
      });
      throw new DeployStop(`ambiguous outcome injected for ${step.name}; not resubmitted`);
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
      throw new DeployStop(
        `receipt for ${step.name} was not observed within ${opts.receiptTimeoutMs} ms; treat as ambiguous and reconcile manually`,
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
      throw new DeployStop(`${step.name} transaction reverted on-chain; stopping without any resend`);
    }
    if (receipt.gasUsed > gasLimit) {
      throw new DeployStop(`${step.name} reported gasUsed ${receipt.gasUsed} above its gas limit`);
    }
    state.totalGasUsed += receipt.gasUsed;
    state.totalWeiSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice);

    try {
      if (step.kind === 'deploy') {
        const expectedAddress = getContractAddress({ from: opts.deployerAddress, nonce: actualNonce });
        const actualAddress = receipt.contractAddress;
        if (!actualAddress) {
          throw new DeployVerificationError('receipt has no contract address for a deployment');
        }
        if (getAddress(actualAddress) !== expectedAddress) {
          throw new DeployVerificationError(
            `deployed address ${actualAddress} does not match the deterministic expectation ${expectedAddress}`,
          );
        }
        const code = await client.getCode({ address: actualAddress });
        if (!code || code === '0x') {
          throw new DeployVerificationError('no runtime code at the deployed address');
        }
        const artifact = step.artifact ? await getArtifact(step.artifact) : null;
        if (!artifact) throw new DeployVerificationError('missing artifact for verification');
        verifyRuntimeCode(code, artifact);
        if (step.name === 'TestOnlyUSDC') state.book.usdc = actualAddress;
        if (step.name === 'TestOnlyReceiptToken') state.book.receipt = actualAddress;
        if (step.name === 'TestOnlySwap') state.book.swap = actualAddress;
        if (step.name === 'TestOnlyVault') state.book.vault = actualAddress;
        await verifyImmutables(opts, client, step.name, actualAddress, state.book);
        await journal.put({
          ...entry,
          status: 'CONFIRMED',
          txHash,
          ...receiptFields,
          contractAddress: actualAddress,
          note: 'receipt verified; deployed code, immutable slots and getters verified.',
          updatedAt: nowIso(),
        });
        opts.log(`CONFIRMED ${step.name} at ${actualAddress} (gasUsed ${receiptFields.gasUsed})`);
      } else {
        if (receipt.contractAddress) {
          throw new DeployVerificationError('wire step unexpectedly deployed a contract');
        }
        const receiptAddress = state.book.receipt as Address;
        const swapAddress = state.book.swap as Address;
        const wired = (await client.readContract({
          address: receiptAddress,
          abi: RECEIPT_WIRE_ABI,
          functionName: 'minters',
          args: [swapAddress],
        })) as boolean;
        if (!wired) {
          throw new DeployVerificationError('swap was not wired as the receipt-token minter');
        }
        const controllerIsMinter = (await client.readContract({
          address: receiptAddress,
          abi: RECEIPT_WIRE_ABI,
          functionName: 'minters',
          args: [opts.deployerAddress],
        })) as boolean;
        if (controllerIsMinter) {
          throw new DeployVerificationError('controller unexpectedly became a minter');
        }
        await journal.put({
          ...entry,
          status: 'CONFIRMED',
          txHash,
          ...receiptFields,
          note: 'wiring verified: swap is the minter; controller is not.',
          updatedAt: nowIso(),
        });
        opts.log(`CONFIRMED WireMinter (gasUsed ${receiptFields.gasUsed})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await journal.put({
        ...entry,
        status: 'UNKNOWN',
        txHash,
        ...receiptFields,
        contractAddress: receipt.contractAddress ?? null,
        note: `verification failed after a successful send: ${message}`,
        updatedAt: nowIso(),
      });
      throw new DeployStop(`post-deploy verification failed for ${step.name}: ${message}`);
    }

    actualNonce += 1n;
  }

  if (state.totalWeiSpent > HARD_CEILING_WEI) {
    throw new DeployStop(
      `total spend ${state.totalWeiSpent} wei exceeded the 0.05 PHRS ceiling; stopping`,
    );
  }
  opts.log(`total gas used: ${state.totalGasUsed}; total spent: ${state.totalWeiSpent} wei`);
}

/**
 * Gated deployment runner.
 *
 * Order of operations: force-rebuild -> recompute + compare the approved plan
 * hash -> network chain guard -> nonce/gas/balance + ceiling checks -> per-step
 * INTENT journal -> one send -> receipt/bytecode/immutable verification. Any
 * mismatch, revert, timeout or ambiguous send stops the run and is never
 * automatically resent.
 */
export async function runDeployment(opts: DeployRunOptions): Promise<DeployRunResult> {
  const journalPath = path.join(opts.stateDir, 'deploy-journal.json');
  const state: RunState = {
    book: { controller: opts.deployerAddress },
    totalGasUsed: 0n,
    totalWeiSpent: 0n,
    predicted: [],
  };
  const result = (status: 'COMPLETE' | 'STOPPED', reason: string | null): DeployRunResult => ({
    status,
    reason,
    addresses: finalAddresses(state.book),
    totalGasUsed: state.totalGasUsed,
    totalWeiSpent: state.totalWeiSpent,
    journalPath,
    predictedAddresses: state.predicted,
  });

  try {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.approvedPlanHash)) {
      throw new DeployStop('the approved plan hash must be the 64-hex value printed by the plan script');
    }
    if (opts.mode === 'atlantic') {
      if (opts.confirmAtlanticTestnet !== true) {
        throw new DeployStop('atlantic mode requires the explicit --confirm-atlantic-testnet flag');
      }
      if (opts.testInjections) {
        throw new DeployStop('test injections are only available in local-anvil mode');
      }
      if (!opts.keyProvider) {
        throw new DeployStop('atlantic mode requires a signing key provider (never expected in review runs)');
      }
    } else {
      assertLocalRpcUrl(opts.rpcUrl);
    }

    runForgeBuild(opts);
    opts.log('forge build --force: OK');

    const artifacts = await loadPlanArtifacts(opts.repoRoot);
    const core = buildPlanCore(opts.deployerAddress, artifacts);
    const planHash = computePlanHash(core);
    opts.log(`plan hash fresh:   ${planHash}`);
    opts.log(`plan hash approved: ${opts.approvedPlanHash.toLowerCase()}`);
    if (planHash.toLowerCase() !== opts.approvedPlanHash.toLowerCase()) {
      throw new DeployStop(
        'freshly built artifact hashes do not match the approved plan hash; refusing to deploy',
      );
    }

    await execute(opts, state, planHash, core, artifacts);
    opts.log('deployment complete: all steps confirmed and verified');
    return result('COMPLETE', null);
  } catch (error) {
    if (error instanceof DeployStop) {
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
