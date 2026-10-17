import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getContractAddress } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * Shared, strictly read-only deployment plan definition (v2).
 *
 * This module computes the stable plan core and its hash from local Foundry
 * artifacts. It contains no send/sign/broadcast path and no secrets; the
 * safety gate enforces that. Both the read-only plan printer and the gated
 * deployment runner use it, so an approval binds exactly what will be sent.
 */

export const ATLANTIC_CHAIN_ID = 688689;

/** Absolute operator ceiling for the whole deployment, regardless of gas price. */
export const HARD_CEILING_WEI = 50_000_000_000_000_000n; // 0.05 PHRS

export type DeployStepKind = 'deploy' | 'wire';

export interface DeployStepSpec {
  order: number;
  kind: DeployStepKind;
  name: string;
  artifact: string | null;
  constructorArgs: string;
  /** Local Foundry measurement (contracts/test/DeploymentGas.t.sol). */
  measuredGas: number;
  /** Hard per-transaction gas limit used as the tx gasLimit. */
  gasCap: number;
}

/**
 * Gas caps carry ~10% headroom over live read-only eth_estimateGas results
 * from Atlantic (2026-10-17) and exceed the local Foundry measurements.
 */
export const DEPLOY_STEPS: readonly DeployStepSpec[] = [
  {
    order: 1,
    kind: 'deploy',
    name: 'TestOnlyUSDC',
    artifact: 'TestOnlyTokens.sol/TestOnlyUSDC.json',
    constructorArgs: 'controller',
    measuredGas: 557_441,
    gasCap: 850_000,
  },
  {
    order: 2,
    kind: 'deploy',
    name: 'TestOnlyReceiptToken',
    artifact: 'TestOnlyTokens.sol/TestOnlyReceiptToken.json',
    constructorArgs: 'controller',
    measuredGas: 611_864,
    gasCap: 900_000,
  },
  {
    order: 3,
    kind: 'deploy',
    name: 'TestOnlySwap',
    artifact: 'TestOnlySwap.sol/TestOnlySwap.json',
    constructorArgs: 'usdc,receiptToken,100,controller',
    measuredGas: 518_281,
    gasCap: 800_000,
  },
  {
    order: 4,
    kind: 'deploy',
    name: 'TestOnlyVault',
    artifact: 'TestOnlyVault.sol/TestOnlyVault.json',
    constructorArgs: 'receiptToken,controller',
    measuredGas: 478_683,
    gasCap: 750_000,
  },
  {
    order: 5,
    kind: 'wire',
    name: 'WireMinter',
    artifact: null,
    constructorArgs: 'receiptToken.setMinter(swap,true)',
    measuredGas: 23_592,
    gasCap: 100_000,
  },
];

export interface ArtifactInfo {
  sha256: string;
  initCodeBytes: number;
}

export interface ArtifactFile {
  abi: readonly unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}

export interface DeployStepPlan extends DeployStepSpec {
  bytecodeSha256: string | null;
}

export interface DeployPlanCore {
  planVersion: 2;
  network: { name: string; chainId: number };
  deployerAddress: string;
  classification: string;
  steps: DeployStepPlan[];
  totalGasCap: number;
}

export function totalGasCapOf(steps: readonly { gasCap: number }[]): number {
  return steps.reduce((sum, step) => sum + step.gasCap, 0);
}

export async function readArtifact(repoRoot: string, relative: string): Promise<ArtifactFile> {
  const file = path.join(repoRoot, 'out', relative);
  let parsed: {
    abi?: unknown;
    bytecode?: { object?: unknown };
    deployedBytecode?: { object?: unknown; immutableReferences?: unknown };
  };
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as typeof parsed;
  } catch {
    throw new Error(
      `Missing or unreadable Foundry artifact ${file}. Rebuild with: forge build --force`,
    );
  }
  const bytecode = parsed.bytecode?.object;
  const deployed = parsed.deployedBytecode?.object;
  if (!Array.isArray(parsed.abi) || typeof bytecode !== 'string' || typeof deployed !== 'string') {
    throw new Error(`Malformed Foundry artifact ${file}`);
  }
  return {
    abi: parsed.abi,
    bytecode: bytecode as Hex,
    deployedBytecode: deployed as Hex,
    immutableReferences: (parsed.deployedBytecode?.immutableReferences ?? {}) as Record<
      string,
      { start: number; length: number }[]
    >,
  };
}

export async function loadArtifactInfo(repoRoot: string, relative: string): Promise<ArtifactInfo> {
  const artifact = await readArtifact(repoRoot, relative);
  return {
    sha256: createHash('sha256').update(artifact.bytecode).digest('hex'),
    initCodeBytes: (artifact.bytecode.length - 2) / 2,
  };
}

export async function loadPlanArtifacts(repoRoot: string): Promise<Map<string, ArtifactInfo>> {
  const infos = new Map<string, ArtifactInfo>();
  for (const step of DEPLOY_STEPS) {
    if (step.artifact) infos.set(step.name, await loadArtifactInfo(repoRoot, step.artifact));
  }
  return infos;
}

export function buildPlanCore(
  deployerAddress: Address,
  artifacts: ReadonlyMap<string, ArtifactInfo>,
): DeployPlanCore {
  const steps: DeployStepPlan[] = DEPLOY_STEPS.map((spec) => ({
    ...spec,
    bytecodeSha256: spec.artifact ? (artifacts.get(spec.name)?.sha256 ?? null) : null,
  }));
  for (const step of steps) {
    if (step.kind === 'deploy' && !step.bytecodeSha256) {
      throw new Error(`Missing artifact hash for ${step.name}; build the contracts first.`);
    }
  }
  return {
    planVersion: 2,
    network: { name: 'Pharos Atlantic Testnet', chainId: ATLANTIC_CHAIN_ID },
    deployerAddress: deployerAddress.toLowerCase(),
    classification: 'TEST-ONLY MOCK CONTRACTS - NOT A PHAROS PROTOCOL, NOT MAINNET',
    steps,
    totalGasCap: totalGasCapOf(steps),
  };
}

export function computePlanHash(core: DeployPlanCore): string {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

export function predictedDeployAddresses(
  deployer: Address,
  pendingNonce: bigint,
): { order: number; name: string; address: Address }[] {
  return DEPLOY_STEPS.filter((step) => step.kind === 'deploy').map((step) => ({
    order: step.order,
    name: step.name,
    address: getContractAddress({ from: deployer, nonce: pendingNonce + BigInt(step.order - 1) }),
  }));
}

export interface AddressBook {
  controller: Address;
  usdc?: Address;
  receipt?: Address;
  swap?: Address;
}

function requireAddress(value: Address | undefined, step: string, label: string): Address {
  if (!value) throw new Error(`${step} requires the already-verified ${label} address`);
  return value;
}

/** Constructor / call arguments for one step, resolved from verified addresses. */
export function resolveConstructorArgs(stepName: string, book: AddressBook): readonly unknown[] {
  switch (stepName) {
    case 'TestOnlyUSDC':
    case 'TestOnlyReceiptToken':
      return [book.controller];
    case 'TestOnlySwap':
      return [
        requireAddress(book.usdc, stepName, 'usdc'),
        requireAddress(book.receipt, stepName, 'receipt'),
        100n,
        book.controller,
      ];
    case 'TestOnlyVault':
      return [requireAddress(book.receipt, stepName, 'receipt'), book.controller];
    case 'WireMinter':
      return [requireAddress(book.swap, stepName, 'swap'), true];
    default:
      throw new Error(`Unknown deployment step ${stepName}`);
  }
}
