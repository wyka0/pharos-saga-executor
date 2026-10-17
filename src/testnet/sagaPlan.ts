import { createHash } from 'node:crypto';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { readJsonIfExists } from '../persistence/atomic.js';
import { ATLANTIC_TOKENS } from './config.js';
import { ATLANTIC_CHAIN_ID } from './deployPlan.js';

/**
 * Shared, strictly read-only saga plan definition (v1).
 *
 * This module computes the stable five-step plan core and its hash for the
 * TestOnly* mock ecosystem. It contains no send/sign/broadcast path and no
 * secrets; the safety gate enforces that. Both the read-only plan verifier and
 * the gated saga runner use it, so an approval binds exactly what will be
 * sent: contract addresses, call order, exact calldata arguments, per-step gas
 * caps and the total PHRS ceiling.
 *
 * The reviewed Atlantic plan (four verified TestOnly* addresses, deployer
 * 0xE2B8651178ade144003537eA509E37877dba40bb) hashes to
 * 8faa2e69e1d4caee46bcc03a7bb9a3bf3542209a5dd4155ae09d6c536faa720f;
 * test/saga-tooling.test.ts locks that reproduction with a golden test.
 */

export interface SagaContracts {
  tUSDC: Address;
  tSAGA: Address;
  swap: Address;
  vault: Address;
}

export type SagaContractKey = keyof SagaContracts;

export const SAGA_CONTRACT_KEYS: readonly SagaContractKey[] = ['tUSDC', 'tSAGA', 'swap', 'vault'];

/** Deploy-step names in the durable deployment journal, per saga target. */
export const SAGA_CONTRACT_NAMES: Record<SagaContractKey, string> = {
  tUSDC: 'TestOnlyUSDC',
  tSAGA: 'TestOnlyReceiptToken',
  swap: 'TestOnlySwap',
  vault: 'TestOnlyVault',
};

/** Fresh Foundry artifacts used to verify the deployed runtime code. */
export const SAGA_CONTRACT_ARTIFACTS: Record<SagaContractKey, string> = {
  tUSDC: 'TestOnlyTokens.sol/TestOnlyUSDC.json',
  tSAGA: 'TestOnlyTokens.sol/TestOnlyReceiptToken.json',
  swap: 'TestOnlySwap.sol/TestOnlySwap.json',
  vault: 'TestOnlyVault.sol/TestOnlyVault.json',
};

export type SagaStepTarget = SagaContractKey;

export interface SagaStepSpec {
  order: number;
  name: string;
  target: SagaStepTarget;
  /** Full canonical signature, e.g. "mint(address,uint256)". */
  signature: string;
  /** Approvals record the spender contract; every other step uses null. */
  spender: 'swap' | 'vault' | null;
  /** Hard per-transaction gas limit sent as the tx gasLimit. */
  gasCap: number;
  /** Present only on the conditional mint step. */
  conditional?: string;
}

/** 1.000000 tUSDC (6 decimals): the exact reviewed input amount. */
export const ONE_TUSDC_RAW = 1_000_000n;
/** 0.990000 tSAGA: the fixed 99% swap output and the exact deposit amount. */
export const RECEIPT_OUT_RAW = 990_000n;
/** Fixed TestOnlySwap fee in basis points (9900/10000 payout). */
export const SAGA_FEE_BPS = 100n;

export const SAGA_CONDITIONAL_MINT =
  'skip if tUSDC balanceOf(controller) >= 1000000; mint exactly 1.000000 tUSDC otherwise';

/**
 * The reviewed five-step saga. Gas caps carry ~74%-130% headroom over the live
 * Atlantic read-only estimates and the local Foundry/Anvil measurements
 * (max local measured 106,280; max live estimate 86,091 on 2026-10-17).
 */
export const SAGA_STEPS: readonly SagaStepSpec[] = [
  {
    order: 1,
    name: 'MintTusdc',
    target: 'tUSDC',
    signature: 'mint(address,uint256)',
    spender: null,
    gasCap: 150_000,
    conditional: SAGA_CONDITIONAL_MINT,
  },
  {
    order: 2,
    name: 'ApproveTusdcToSwap',
    target: 'tUSDC',
    signature: 'approve(address,uint256)',
    spender: 'swap',
    gasCap: 120_000,
  },
  {
    order: 3,
    name: 'SwapTusdcForReceipt',
    target: 'swap',
    signature: 'swapExactUsdcForReceipt(uint256,uint256)',
    spender: null,
    gasCap: 200_000,
  },
  {
    order: 4,
    name: 'ApproveReceiptToVault',
    target: 'tSAGA',
    signature: 'approve(address,uint256)',
    spender: 'vault',
    gasCap: 120_000,
  },
  {
    order: 5,
    name: 'DepositReceiptToVault',
    target: 'vault',
    signature: 'deposit(uint256,uint256)',
    spender: null,
    gasCap: 250_000,
  },
];

export function totalSagaGasCapOf(steps: readonly { gasCap: number }[] = SAGA_STEPS): number {
  return steps.reduce((sum, step) => sum + step.gasCap, 0);
}

/** Reviewed total gas cap across all five steps. */
export const SAGA_TOTAL_GAS_CAP = totalSagaGasCapOf();

/** Absolute operator ceiling for the whole saga, regardless of gas price (0.02 PHRS). */
export const SAGA_CEILING_WEI = 20_000_000_000_000_000n;

export const SAGA_NETWORK_NAME = 'Pharos Atlantic Testnet';
export const SAGA_CLASSIFICATION = 'TEST-ONLY MOCK SAGA - NOT A PHAROS PROTOCOL, NOT MAINNET';

export const SAGA_EXPECTED_POSTCONDITIONS: readonly string[] = [
  'tUSDC.balanceOf(deployer) == 0',
  'tUSDC.allowance(deployer, swap) == 0',
  'tSAGA.balanceOf(deployer) == 0',
  'tSAGA.allowance(deployer, vault) == 0',
  'vault.sharesOf(deployer) == 990000',
  'vault.totalShares() == 990000',
  'tSAGA.balanceOf(vault) == 990000',
  'tSAGA.totalSupply() == 990000',
  'tUSDC.balanceOf(swap) == 1000000',
  'officialUSDC.balanceOf(deployer) == 20000000 (unchanged)',
];

/** The official Atlantic USDC token address; a saga must never target it. */
export function officialAtlanticUsdcAddress(): Address {
  const entry = ATLANTIC_TOKENS.find((token) => token.symbol === 'USDC');
  if (!entry) throw new Error('the official USDC entry is missing from the testnet token registry');
  return getAddress(entry.address);
}

export interface SagaStepPlan {
  order: number;
  name: string;
  kind: 'call';
  target: SagaStepTarget;
  to: string;
  function: string;
  spender: string | null;
  args: string[];
  gasCap: number;
  conditional?: string;
}

export interface SagaPlanCore {
  planVersion: 1;
  kind: 'test-only-saga';
  network: { name: string; chainId: number };
  classification: string;
  deployerAddress: string;
  contracts: { tUSDC: string; tSAGA: string; swap: string; vault: string };
  decimals: { tUSDC: 6; tSAGA: 6 };
  steps: SagaStepPlan[];
  expectedPostconditions: string[];
  totalGasCap: number;
  ceilingWei: string;
}

function normalizeContracts(contracts: SagaContracts): SagaContracts {
  return {
    tUSDC: getAddress(contracts.tUSDC),
    tSAGA: getAddress(contracts.tSAGA),
    swap: getAddress(contracts.swap),
    vault: getAddress(contracts.vault),
  };
}

function sagaStepArgs(name: string, deployer: string, to: SagaContracts): string[] {
  switch (name) {
    case 'MintTusdc':
      return [deployer, ONE_TUSDC_RAW.toString()];
    case 'ApproveTusdcToSwap':
      return [to.swap.toLowerCase(), ONE_TUSDC_RAW.toString()];
    case 'SwapTusdcForReceipt':
      return [ONE_TUSDC_RAW.toString(), RECEIPT_OUT_RAW.toString()];
    case 'ApproveReceiptToVault':
      return [to.vault.toLowerCase(), RECEIPT_OUT_RAW.toString()];
    case 'DepositReceiptToVault':
      return [RECEIPT_OUT_RAW.toString(), RECEIPT_OUT_RAW.toString()];
    default:
      throw new Error(`Unknown saga step ${name}`);
  }
}

/**
 * Build the plan core exactly as reviewed. The step objects are constructed in
 * the reviewed property order (order, name, kind, target, to, function,
 * spender, args, gasCap, conditional) so the JSON serialization - and with it
 * the plan hash - is byte-stable. test/saga-tooling.test.ts pins this against
 * the approved Atlantic hash.
 */
export function buildSagaPlanCore(params: {
  deployerAddress: Address;
  contracts: SagaContracts;
}): SagaPlanCore {
  const deployer = getAddress(params.deployerAddress).toLowerCase();
  const contracts = normalizeContracts(params.contracts);
  const steps: SagaStepPlan[] = SAGA_STEPS.map((spec) => {
    const step: SagaStepPlan = {
      order: spec.order,
      name: spec.name,
      kind: 'call',
      target: spec.target,
      to: contracts[spec.target].toLowerCase(),
      function: spec.signature,
      spender: spec.spender ? contracts[spec.spender].toLowerCase() : null,
      args: sagaStepArgs(spec.name, deployer, contracts),
      gasCap: spec.gasCap,
    };
    if (spec.conditional) step.conditional = spec.conditional;
    return step;
  });
  return {
    planVersion: 1,
    kind: 'test-only-saga',
    network: { name: SAGA_NETWORK_NAME, chainId: ATLANTIC_CHAIN_ID },
    classification: SAGA_CLASSIFICATION,
    deployerAddress: deployer,
    contracts: {
      tUSDC: contracts.tUSDC.toLowerCase(),
      tSAGA: contracts.tSAGA.toLowerCase(),
      swap: contracts.swap.toLowerCase(),
      vault: contracts.vault.toLowerCase(),
    },
    decimals: { tUSDC: 6, tSAGA: 6 },
    steps,
    expectedPostconditions: [...SAGA_EXPECTED_POSTCONDITIONS],
    totalGasCap: totalSagaGasCapOf(),
    ceilingWei: SAGA_CEILING_WEI.toString(),
  };
}

export function computeSagaPlanHash(core: SagaPlanCore): string {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

const TUSDC_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const TSAGA_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const SWAP_ABI = parseAbi([
  'function swapExactUsdcForReceipt(uint256 usdcIn, uint256 minReceiptOut) returns (uint256)',
]);
const VAULT_ABI = parseAbi([
  'function deposit(uint256 assets, uint256 minShares) returns (uint256)',
]);

/** Exact calldata for one reviewed step; the runner refuses anything else. */
export function buildSagaStepCalldata(params: {
  stepName: string;
  deployerAddress: Address;
  contracts: SagaContracts;
}): Hex {
  const deployer = getAddress(params.deployerAddress);
  const contracts = normalizeContracts(params.contracts);
  switch (params.stepName) {
    case 'MintTusdc':
      return encodeFunctionData({ abi: TUSDC_ABI, functionName: 'mint', args: [deployer, ONE_TUSDC_RAW] });
    case 'ApproveTusdcToSwap':
      return encodeFunctionData({
        abi: TUSDC_ABI,
        functionName: 'approve',
        args: [contracts.swap, ONE_TUSDC_RAW],
      });
    case 'SwapTusdcForReceipt':
      return encodeFunctionData({
        abi: SWAP_ABI,
        functionName: 'swapExactUsdcForReceipt',
        args: [ONE_TUSDC_RAW, RECEIPT_OUT_RAW],
      });
    case 'ApproveReceiptToVault':
      return encodeFunctionData({
        abi: TSAGA_ABI,
        functionName: 'approve',
        args: [contracts.vault, RECEIPT_OUT_RAW],
      });
    case 'DepositReceiptToVault':
      return encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [RECEIPT_OUT_RAW, RECEIPT_OUT_RAW],
      });
    default:
      throw new Error(`Unknown saga step ${params.stepName}`);
  }
}

interface DeployJournalEntryLike {
  name?: string;
  kind?: string;
  status?: string;
  contractAddress?: string | null;
  artifactSha256?: string | null;
}

export interface SagaAddressResolution {
  ok: true;
  contracts: SagaContracts;
  artifactSha256: Partial<Record<SagaContractKey, string>>;
}

export type SagaAddressResolutionResult = SagaAddressResolution | { ok: false; reason: string };

/**
 * Read-only: resolve the four saga contract addresses from the durable,
 * verified deployment journal. Atlantic runs always derive addresses from
 * this file (never from CLI flags), so the approved plan hash binds the exact
 * addresses that the deployment run recorded as CONFIRMED.
 */
export async function resolveSagaContractsFromDeployJournal(
  deployJournalPath: string,
): Promise<SagaAddressResolutionResult> {
  const file = await readJsonIfExists<{ entries?: Record<string, DeployJournalEntryLike> }>(
    deployJournalPath,
  );
  if (!file?.entries) {
    return { ok: false, reason: `the deployment journal at ${deployJournalPath} is missing or unreadable` };
  }
  const byName = new Map<string, DeployJournalEntryLike>();
  for (const entry of Object.values(file.entries)) {
    if (entry && typeof entry.name === 'string') byName.set(entry.name, entry);
  }
  const contracts = {} as SagaContracts;
  const artifactSha256: Partial<Record<SagaContractKey, string>> = {};
  for (const key of SAGA_CONTRACT_KEYS) {
    const name = SAGA_CONTRACT_NAMES[key];
    const entry = byName.get(name);
    if (!entry) {
      return { ok: false, reason: `the deployment journal does not record a ${name} deployment` };
    }
    if (entry.kind !== 'deploy' || entry.status !== 'CONFIRMED' || !entry.contractAddress) {
      return {
        ok: false,
        reason: `the deployment journal entry for ${name} is not a CONFIRMED deployment (status ${String(entry.status)})`,
      };
    }
    try {
      contracts[key] = getAddress(entry.contractAddress);
    } catch {
      return { ok: false, reason: `the deployment journal records an invalid address for ${name}` };
    }
    if (typeof entry.artifactSha256 === 'string') artifactSha256[key] = entry.artifactSha256;
  }
  const wire = byName.get('WireMinter');
  if (wire && (wire.kind !== 'wire' || wire.status !== 'CONFIRMED')) {
    return {
      ok: false,
      reason: `the deployment journal entry for WireMinter is not CONFIRMED (status ${String(wire.status)})`,
    };
  }
  return { ok: true, contracts, artifactSha256 };
}
