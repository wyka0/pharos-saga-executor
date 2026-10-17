/**
 * READ-ONLY Atlantic testnet deployment plan.
 *
 * Collects: chain id, block, wallet balances, pending nonce, gas price,
 * compiled artifact hashes and a stable plan hash for explicit user approval.
 *
 * It NEVER reads the private key, NEVER signs and NEVER broadcasts. There is
 * no send path in this file by construction; the safety gate enforces that.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/testnet-deploy-plan.ts --env-file C:\temp-secrets\.env --address 0x...
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatEther, formatGwei, getContractAddress, parseAbi } from 'viem';
import { createTestnetRuntime } from '../src/testnet/cliSupport.js';
import type { Address } from 'viem';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

interface DeploymentSpec {
  order: number;
  name: string;
  artifact: string;
  constructorArgs: 'none' | 'usdc,receiptToken,100' | 'receiptToken';
  measuredDeployGas: number;
  gasCap: number;
}

// Measured locally with contracts/test/DeploymentGas.t.sol (chainId 31337).
const DEPLOYMENTS: DeploymentSpec[] = [
  {
    order: 1,
    name: 'TestOnlyUSDC',
    artifact: 'TestOnlyTokens.sol/TestOnlyUSDC.json',
    constructorArgs: 'none',
    measuredDeployGas: 497_738,
    gasCap: 700_000,
  },
  {
    order: 2,
    name: 'TestOnlyReceiptToken',
    artifact: 'TestOnlyTokens.sol/TestOnlyReceiptToken.json',
    constructorArgs: 'none',
    measuredDeployGas: 568_661,
    gasCap: 800_000,
  },
  {
    order: 3,
    name: 'TestOnlySwap',
    artifact: 'TestOnlySwap.sol/TestOnlySwap.json',
    constructorArgs: 'usdc,receiptToken,100',
    measuredDeployGas: 484_536,
    gasCap: 700_000,
  },
  {
    order: 4,
    name: 'TestOnlyVault',
    artifact: 'TestOnlyVault.sol/TestOnlyVault.json',
    constructorArgs: 'receiptToken',
    measuredDeployGas: 421_507,
    gasCap: 600_000,
  },
];

// Absolute ceiling the operator should not exceed regardless of gas price.
const HARD_CEILING_PHRS = 0.05;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

async function artifactInfo(relative: string): Promise<{ sha256: string; initCodeBytes: number }> {
  const file = path.resolve('out', relative);
  let parsed: { bytecode?: { object?: string } };
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { bytecode?: { object?: string } };
  } catch {
    throw new Error(
      `Missing Foundry artifact ${file}. Build first (WSL):\n` +
        "  wsl.exe -d Ubuntu -- /bin/bash --noprofile --norc -c 'cd /mnt/c/pharos-saga-executor && /home/wyka/.foundry/bin/forge build'",
    );
  }
  const object = parsed.bytecode?.object;
  if (typeof object !== 'string' || !object.startsWith('0x') || object.length <= 2) {
    throw new Error(`Artifact ${file} has no init bytecode`);
  }
  return {
    sha256: createHash('sha256').update(object).digest('hex'),
    initCodeBytes: (object.length - 2) / 2,
  };
}

async function main(): Promise<void> {
  const envFile = argValue('--env-file') ?? process.env.PHAROS_TESTNET_ENV_FILE;
  if (!envFile) {
    throw new Error(
      'Provide --env-file <path> (or PHAROS_TESTNET_ENV_FILE). Only RPC_URL is used; the key is never read.',
    );
  }
  const address = argValue('--address');
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('Provide --address <0x...> for the read-only deployment plan.');
  }

  const runtime = await createTestnetRuntime({
    envFile,
    rpcVar: 'RPC_URL',
    address,
    stateDir: path.resolve('.local', 'deploy-plan'),
  });
  const { client, config, rpcHost } = runtime;

  const chainId = await client.getChainId();
  if (chainId !== 688689) {
    throw new Error(`Refusing to plan: chainId ${chainId} is not Atlantic testnet (688689)`);
  }
  const blockNumber = await client.getBlockNumber();
  const phrsBalance = await client.getBalance(address);
  const nonce = await client.getTransactionCount(address, 'pending');
  const gasPrice = await client.getGasPrice();

  const usdcToken = config.tokens.find((token) => token.symbol.toUpperCase() === 'USDC');
  if (!usdcToken) throw new Error('Atlantic USDC token is not configured');
  const usdcDecimals = Number(
    await client.readContract<bigint>({
      address: usdcToken.address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }),
  );
  const usdcBalance = await client.readContract<bigint>({
    address: usdcToken.address,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });

  const artifacts = new Map<string, { sha256: string; initCodeBytes: number }>();
  for (const spec of DEPLOYMENTS) {
    artifacts.set(spec.name, await artifactInfo(spec.artifact));
  }

  const totalGasCap = DEPLOYMENTS.reduce((sum, spec) => sum + spec.gasCap, 0);
  const measuredTotal = DEPLOYMENTS.reduce((sum, spec) => sum + spec.measuredDeployGas, 0);
  const maxCostWei = BigInt(totalGasCap) * gasPrice;
  const maxCostPhrs = Number(formatEther(maxCostWei));

  const planCore = {
    planVersion: 1,
    network: { name: 'Pharos Atlantic Testnet', chainId: 688689 },
    deployerAddress: address.toLowerCase(),
    classification: 'TEST-ONLY MOCK CONTRACTS - NOT A PHAROS PROTOCOL, NOT MAINNET',
    deployments: DEPLOYMENTS.map((spec) => ({
      order: spec.order,
      name: spec.name,
      artifact: spec.artifact,
      bytecodeSha256: artifacts.get(spec.name)?.sha256,
      constructorArgs: spec.constructorArgs,
      gasCap: spec.gasCap,
    })),
    totalGasCap,
  };
  const planHash = createHash('sha256').update(JSON.stringify(planCore)).digest('hex');

  const predicted: { order: number; name: string; address: string }[] = [];
  for (const spec of DEPLOYMENTS) {
    predicted.push({
      order: spec.order,
      name: spec.name,
      address: getContractAddress({ from: address as Address, nonce: BigInt(nonce + spec.order - 1) }),
    });
  }

  const lines: string[] = [];
  lines.push('='.repeat(78));
  lines.push('ATLANTIC TESTNET DEPLOYMENT PLAN - READ-ONLY PREPARATION');
  lines.push('CLASSIFICATION: TEST-ONLY MOCK CONTRACTS. TESTNET ONLY. NOT MAINNET.');
  lines.push('NOTHING WAS SIGNED OR BROADCAST. NO PRIVATE KEY WAS READ.');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push(`RPC host:            ${rpcHost}`);
  lines.push(`Chain id:            ${chainId} (Atlantic testnet)`);
  lines.push(`Block:               ${blockNumber}`);
  lines.push(`Deployer (public):   ${address}`);
  lines.push(`PHRS balance:        ${formatEther(phrsBalance)}`);
  lines.push(`USDC balance:        ${formatUnits6(usdcBalance)} (${usdcBalance} raw, decimals ${usdcDecimals})`);
  lines.push(`Pending nonce:       ${nonce}`);
  lines.push(`Gas price:           ${gasPrice} wei (${formatGwei(gasPrice)} gwei)`);
  lines.push('');
  lines.push('Deployment sequence (constructor args are test-only wiring):');
  for (const spec of DEPLOYMENTS) {
    const artifact = artifacts.get(spec.name);
    lines.push(
      `  ${spec.order}. ${spec.name.padEnd(22)} args=${spec.constructorArgs.padEnd(22)} ` +
        `initcode=${String(artifact?.initCodeBytes).padStart(4)}B ` +
        `measuredGas=${spec.measuredDeployGas} gasCap=${spec.gasCap} ` +
        `bytecodeSha256=${artifact?.sha256.slice(0, 16)}...`,
    );
  }
  lines.push('');
  lines.push(`Measured deploy gas (local EVM): ${measuredTotal}`);
  lines.push(`Total gas cap (4 txs):           ${totalGasCap}`);
  lines.push(`Maximum PHRS expenditure:        ${formatEther(maxCostWei)} PHRS at the current gas price`);
  lines.push(
    `Absolute operator ceiling:       ${HARD_CEILING_PHRS} PHRS ` +
      `(${maxCostPhrs <= HARD_CEILING_PHRS ? 'current estimate is under the ceiling' : 'CURRENT ESTIMATE EXCEEDS THE CEILING - DO NOT APPROVE'})`,
  );
  lines.push('');
  lines.push('Predicted CREATE addresses (deterministic from nonce; VOID if any tx is sent first):');
  for (const item of predicted) {
    lines.push(`  ${item.order}. ${item.name.padEnd(22)} ${item.address}`);
  }
  lines.push('');
  lines.push(`PLAN HASH (stable; binds chain, deployer, bytecode, args and gas caps):`);
  lines.push(`  ${planHash}`);
  lines.push('');
  lines.push('This plan is NOT an execution authorization. Deployment requires a');
  lines.push('separate, explicit approval of the plan hash above, followed by a new');
  lines.push('deploy-plan run that re-verifies nonce, gas price and bytecode hashes.');
  lines.push('='.repeat(78));

  process.stdout.write(`${lines.join('\n')}\n`);

  function formatUnits6(value: bigint): string {
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0');
    return `${whole}.${fraction}`;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
