import { getAddress, parseAbi } from 'viem';
import type { Address, PublicClient } from 'viem';
import { ONE_TUSDC_RAW, RECEIPT_OUT_RAW, SAGA_FEE_BPS, type SagaContracts } from '../sagaPlan.js';

/**
 * Pure read-only verification helpers for the gated saga runner and the
 * read-only saga plan verifier. No network sends, no secrets; every check
 * reads state through the caller's public client.
 */

export const ERC20_READ_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function controller() view returns (address)',
]);
export const MINTER_ABI = parseAbi(['function minters(address minter) view returns (bool)']);
export const SWAP_VIEW_ABI = parseAbi([
  'function controller() view returns (address)',
  'function usdc() view returns (address)',
  'function receipt() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function quote(uint256 usdcIn) view returns (uint256)',
]);
export const VAULT_VIEW_ABI = parseAbi([
  'function controller() view returns (address)',
  'function asset() view returns (address)',
  'function totalShares() view returns (uint256)',
  'function sharesOf(address owner) view returns (uint256)',
]);

export interface SagaCheckFailure {
  label: string;
  actual: string;
  expected: string;
}

interface Reader {
  (address: Address, abi: readonly unknown[], functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

function makeReader(client: PublicClient): Reader {
  return (address, abi, functionName, args = []) =>
    client.readContract({ address, abi: abi as never, functionName, args: args as never }) as Promise<unknown>;
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  try {
    return getAddress(value);
  } catch {
    return value;
  }
}

function pushIfMismatch(
  failures: SagaCheckFailure[],
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) failures.push({ label, actual: String(actual), expected: String(expected) });
}

/**
 * Read-only pre-flight for the four reviewed contracts: token identity,
 * immutable controllers, swap/vault wiring, the tSAGA minter set and the
 * official-USDC guard. Returns every mismatch instead of throwing so callers
 * can report all failures at once.
 *
 * When `officialUsdc` is null (local-anvil runs have no official token
 * deployed), the official-address guard and balance baseline are skipped.
 */
export async function checkSagaWiring(params: {
  client: PublicClient;
  contracts: SagaContracts;
  deployer: Address;
  officialUsdc: Address | null;
}): Promise<{ failures: SagaCheckFailure[]; officialUsdcBalance: bigint | null }> {
  const { client, contracts: c } = params;
  const read = makeReader(client);
  const failures: SagaCheckFailure[] = [];
  const deployer = getAddress(params.deployer);

  const targets: [string, Address][] = [
    ['tUSDC', c.tUSDC],
    ['tSAGA', c.tSAGA],
    ['swap', c.swap],
    ['vault', c.vault],
  ];
  if (params.officialUsdc) {
    const official = getAddress(params.officialUsdc);
    for (const [label, address] of targets) {
      if (getAddress(address) === official) {
        failures.push({
          label: `${label} address (the official USDC token must never be targeted)`,
          actual: address,
          expected: `any mock address other than ${official}`,
        });
      }
    }
  }
  const seen = new Map<string, string>();
  for (const [label, address] of targets) {
    const key = getAddress(address).toLowerCase();
    const other = seen.get(key);
    if (other) {
      failures.push({
        label: `${label} address (must differ from ${other})`,
        actual: address,
        expected: 'a distinct contract address',
      });
    }
    seen.set(key, label);
  }

  pushIfMismatch(failures, 'tUSDC.controller', normalizeAddress(await read(c.tUSDC, ERC20_READ_ABI, 'controller')), deployer);
  pushIfMismatch(failures, 'tUSDC.name', await read(c.tUSDC, ERC20_READ_ABI, 'name'), 'Test Only USD Coin');
  pushIfMismatch(failures, 'tUSDC.symbol', await read(c.tUSDC, ERC20_READ_ABI, 'symbol'), 'tUSDC');
  pushIfMismatch(failures, 'tUSDC.decimals', await read(c.tUSDC, ERC20_READ_ABI, 'decimals'), 6);

  pushIfMismatch(failures, 'tSAGA.controller', normalizeAddress(await read(c.tSAGA, ERC20_READ_ABI, 'controller')), deployer);
  pushIfMismatch(failures, 'tSAGA.name', await read(c.tSAGA, ERC20_READ_ABI, 'name'), 'Test Only Saga Receipt');
  pushIfMismatch(failures, 'tSAGA.symbol', await read(c.tSAGA, ERC20_READ_ABI, 'symbol'), 'tSAGA');
  pushIfMismatch(failures, 'tSAGA.decimals', await read(c.tSAGA, ERC20_READ_ABI, 'decimals'), 6);
  pushIfMismatch(failures, 'tSAGA.minters(swap)', await read(c.tSAGA, MINTER_ABI, 'minters', [c.swap]), true);
  pushIfMismatch(failures, 'tSAGA.minters(deployer)', await read(c.tSAGA, MINTER_ABI, 'minters', [deployer]), false);

  pushIfMismatch(failures, 'swap.controller', normalizeAddress(await read(c.swap, SWAP_VIEW_ABI, 'controller')), deployer);
  pushIfMismatch(failures, 'swap.usdc', normalizeAddress(await read(c.swap, SWAP_VIEW_ABI, 'usdc')), getAddress(c.tUSDC));
  pushIfMismatch(failures, 'swap.receipt', normalizeAddress(await read(c.swap, SWAP_VIEW_ABI, 'receipt')), getAddress(c.tSAGA));
  pushIfMismatch(failures, 'swap.feeBps', await read(c.swap, SWAP_VIEW_ABI, 'feeBps'), SAGA_FEE_BPS);
  pushIfMismatch(failures, 'swap.quote(1000000)', await read(c.swap, SWAP_VIEW_ABI, 'quote', [ONE_TUSDC_RAW]), RECEIPT_OUT_RAW);

  pushIfMismatch(failures, 'vault.controller', normalizeAddress(await read(c.vault, VAULT_VIEW_ABI, 'controller')), deployer);
  pushIfMismatch(failures, 'vault.asset', normalizeAddress(await read(c.vault, VAULT_VIEW_ABI, 'asset')), getAddress(c.tSAGA));

  const officialUsdcBalance = params.officialUsdc
    ? ((await read(params.officialUsdc, ERC20_READ_ABI, 'balanceOf', [deployer])) as bigint)
    : null;
  return { failures, officialUsdcBalance };
}

async function readBig(
  client: PublicClient,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<bigint> {
  return (await client.readContract({
    address,
    abi: abi as never,
    functionName,
    args: args as never,
  })) as bigint;
}

function expectValue(
  failures: SagaCheckFailure[],
  label: string,
  actual: bigint,
  expected: bigint,
): void {
  if (actual !== expected) {
    failures.push({ label, actual: actual.toString(), expected: expected.toString() });
  }
}

/**
 * State that must hold BEFORE a step can be sent. Any mismatch means the chain
 * changed since the plan was approved: stop and re-review, never adapt.
 */
export async function sagaStepPreconditions(params: {
  client: PublicClient;
  contracts: SagaContracts;
  deployer: Address;
  stepName: string;
}): Promise<SagaCheckFailure[]> {
  const { client, contracts: c, deployer } = params;
  const f: SagaCheckFailure[] = [];
  switch (params.stepName) {
    case 'MintTusdc': {
      const balance = await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]);
      if (balance !== 0n) {
        f.push({
          label: 'tUSDC.balanceOf(deployer) (mint requires 0 or an exact 1.000000 pre-funding)',
          actual: balance.toString(),
          expected: '0',
        });
      }
      break;
    }
    case 'ApproveTusdcToSwap': {
      expectValue(f, 'tUSDC.balanceOf(deployer)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]), ONE_TUSDC_RAW);
      expectValue(f, 'tUSDC.allowance(deployer, swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'allowance', [deployer, c.swap]), 0n);
      break;
    }
    case 'SwapTusdcForReceipt': {
      expectValue(f, 'tUSDC.balanceOf(deployer)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]), ONE_TUSDC_RAW);
      expectValue(f, 'tUSDC.allowance(deployer, swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'allowance', [deployer, c.swap]), ONE_TUSDC_RAW);
      expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), 0n);
      expectValue(f, 'tSAGA.totalSupply()', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'totalSupply'), 0n);
      expectValue(f, 'tUSDC.balanceOf(swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [c.swap]), 0n);
      break;
    }
    case 'ApproveReceiptToVault': {
      expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), RECEIPT_OUT_RAW);
      expectValue(f, 'tSAGA.allowance(deployer, vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'allowance', [deployer, c.vault]), 0n);
      expectValue(f, 'vault.sharesOf(deployer)', await readBig(client, c.vault, VAULT_VIEW_ABI, 'sharesOf', [deployer]), 0n);
      expectValue(f, 'vault.totalShares()', await readBig(client, c.vault, VAULT_VIEW_ABI, 'totalShares'), 0n);
      expectValue(f, 'tSAGA.balanceOf(vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [c.vault]), 0n);
      break;
    }
    case 'DepositReceiptToVault': {
      expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), RECEIPT_OUT_RAW);
      expectValue(f, 'tSAGA.allowance(deployer, vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'allowance', [deployer, c.vault]), RECEIPT_OUT_RAW);
      expectValue(f, 'vault.sharesOf(deployer)', await readBig(client, c.vault, VAULT_VIEW_ABI, 'sharesOf', [deployer]), 0n);
      expectValue(f, 'vault.totalShares()', await readBig(client, c.vault, VAULT_VIEW_ABI, 'totalShares'), 0n);
      expectValue(f, 'tSAGA.balanceOf(vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [c.vault]), 0n);
      break;
    }
    default:
      throw new Error(`no saga preconditions defined for ${params.stepName}`);
  }
  return f;
}

/** State that must hold AFTER a step's transaction confirmed. */
export async function sagaStepPostconditions(params: {
  client: PublicClient;
  contracts: SagaContracts;
  deployer: Address;
  stepName: string;
}): Promise<SagaCheckFailure[]> {
  const { client, contracts: c, deployer } = params;
  const f: SagaCheckFailure[] = [];
  switch (params.stepName) {
    case 'MintTusdc': {
      expectValue(f, 'tUSDC.balanceOf(deployer)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]), ONE_TUSDC_RAW);
      expectValue(f, 'tUSDC.totalSupply()', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'totalSupply'), ONE_TUSDC_RAW);
      break;
    }
    case 'ApproveTusdcToSwap': {
      expectValue(f, 'tUSDC.allowance(deployer, swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'allowance', [deployer, c.swap]), ONE_TUSDC_RAW);
      break;
    }
    case 'SwapTusdcForReceipt': {
      expectValue(f, 'tUSDC.balanceOf(deployer)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]), 0n);
      expectValue(f, 'tUSDC.allowance(deployer, swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'allowance', [deployer, c.swap]), 0n);
      expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), RECEIPT_OUT_RAW);
      expectValue(f, 'tSAGA.totalSupply()', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'totalSupply'), RECEIPT_OUT_RAW);
      expectValue(f, 'tUSDC.balanceOf(swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [c.swap]), ONE_TUSDC_RAW);
      break;
    }
    case 'ApproveReceiptToVault': {
      expectValue(f, 'tSAGA.allowance(deployer, vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'allowance', [deployer, c.vault]), RECEIPT_OUT_RAW);
      break;
    }
    case 'DepositReceiptToVault': {
      expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), 0n);
      expectValue(f, 'tSAGA.allowance(deployer, vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'allowance', [deployer, c.vault]), 0n);
      expectValue(f, 'vault.sharesOf(deployer)', await readBig(client, c.vault, VAULT_VIEW_ABI, 'sharesOf', [deployer]), RECEIPT_OUT_RAW);
      expectValue(f, 'vault.totalShares()', await readBig(client, c.vault, VAULT_VIEW_ABI, 'totalShares'), RECEIPT_OUT_RAW);
      expectValue(f, 'tSAGA.balanceOf(vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [c.vault]), RECEIPT_OUT_RAW);
      break;
    }
    default:
      throw new Error(`no saga postconditions defined for ${params.stepName}`);
  }
  return f;
}

/**
 * End-of-saga battery: the nine contract postconditions plus (atlantic only)
 * the untouched official-USDC balance. This also re-proves a skipped resume.
 */
export async function sagaFinalPostconditions(params: {
  client: PublicClient;
  contracts: SagaContracts;
  deployer: Address;
  officialUsdc: Address | null;
  officialUsdcBaseline: bigint | null;
}): Promise<SagaCheckFailure[]> {
  const { client, contracts: c, deployer } = params;
  const f: SagaCheckFailure[] = [];
  expectValue(f, 'tUSDC.balanceOf(deployer)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [deployer]), 0n);
  expectValue(f, 'tUSDC.allowance(deployer, swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'allowance', [deployer, c.swap]), 0n);
  expectValue(f, 'tSAGA.balanceOf(deployer)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [deployer]), 0n);
  expectValue(f, 'tSAGA.allowance(deployer, vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'allowance', [deployer, c.vault]), 0n);
  expectValue(f, 'vault.sharesOf(deployer)', await readBig(client, c.vault, VAULT_VIEW_ABI, 'sharesOf', [deployer]), RECEIPT_OUT_RAW);
  expectValue(f, 'vault.totalShares()', await readBig(client, c.vault, VAULT_VIEW_ABI, 'totalShares'), RECEIPT_OUT_RAW);
  expectValue(f, 'tSAGA.balanceOf(vault)', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'balanceOf', [c.vault]), RECEIPT_OUT_RAW);
  expectValue(f, 'tSAGA.totalSupply()', await readBig(client, c.tSAGA, ERC20_READ_ABI, 'totalSupply'), RECEIPT_OUT_RAW);
  expectValue(f, 'tUSDC.balanceOf(swap)', await readBig(client, c.tUSDC, ERC20_READ_ABI, 'balanceOf', [c.swap]), ONE_TUSDC_RAW);
  if (params.officialUsdc && params.officialUsdcBaseline !== null) {
    const balance = await readBig(client, params.officialUsdc, ERC20_READ_ABI, 'balanceOf', [deployer]);
    if (balance !== params.officialUsdcBaseline) {
      f.push({
        label: 'officialUSDC.balanceOf(deployer) (must stay unchanged)',
        actual: balance.toString(),
        expected: params.officialUsdcBaseline.toString(),
      });
    }
  }
  return f;
}
