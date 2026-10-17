/**
 * READ-ONLY Atlantic testnet deployment plan (v2).
 *
 * Collects: chain id, block, wallet balances, pending nonce, gas price,
 * freshly built artifact hashes and the stable plan hash for explicit user
 * approval. The plan now includes the minter-wiring transaction (step 5)
 * required by the restricted TestOnlyReceiptToken controller.
 *
 * It NEVER reads the private key, NEVER signs and NEVER broadcasts. The plan
 * core comes from src/testnet/deployPlan.ts, which the safety gate keeps free
 * of any send/sign path; the gated runner (scripts/testnet-deploy.ts) refuses
 * to send anything unless its freshly recomputed plan hash matches the hash
 * approved on this page.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/testnet-deploy-plan.ts --env-file C:\temp-secrets\.env --address 0x...
 */
import { formatEther, formatGwei, parseAbi } from 'viem';
import type { Address } from 'viem';
import path from 'node:path';
import { createTestnetRuntime } from '../src/testnet/cliSupport.js';
import {
  DEPLOY_STEPS,
  HARD_CEILING_WEI,
  buildPlanCore,
  computePlanHash,
  loadPlanArtifacts,
  predictedDeployAddresses,
} from '../src/testnet/deployPlan.js';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
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

  const artifacts = await loadPlanArtifacts(process.cwd());
  const core = buildPlanCore(address as Address, artifacts);
  const planHash = computePlanHash(core);

  const measuredTotal = DEPLOY_STEPS.reduce((sum, step) => sum + step.measuredGas, 0);
  const maxCostWei = BigInt(core.totalGasCap) * gasPrice;
  const underCeiling = BigInt(core.totalGasCap) * gasPrice <= HARD_CEILING_WEI;
  const predicted = predictedDeployAddresses(address as Address, BigInt(nonce));

  const lines: string[] = [];
  lines.push('='.repeat(78));
  lines.push('ATLANTIC TESTNET DEPLOYMENT PLAN v2 - READ-ONLY PREPARATION');
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
  lines.push('Deployment sequence (test-only wiring; controller = the deployer):');
  for (const step of DEPLOY_STEPS) {
    const artifact = artifacts.get(step.name);
    if (step.kind === 'deploy') {
      lines.push(
        `  ${step.order}. ${step.name.padEnd(22)} args=${step.constructorArgs.padEnd(30)} ` +
          `initcode=${String(artifact?.initCodeBytes).padStart(4)}B ` +
          `measuredGas=${step.measuredGas} gasCap=${step.gasCap} ` +
          `bytecodeSha256=${artifact?.sha256.slice(0, 16)}...`,
      );
    } else {
      lines.push(
        `  ${step.order}. ${step.name.padEnd(22)} call=${step.constructorArgs.padEnd(30)} ` +
          `${' '.repeat(12)} ` +
          `measuredGas=${step.measuredGas} gasCap=${step.gasCap}`,
      );
    }
  }
  lines.push('');
  lines.push(`Measured gas (local EVM):        ${measuredTotal}`);
  lines.push(`Total gas cap (4 deploys + 1 wiring tx): ${core.totalGasCap}`);
  lines.push(`Maximum PHRS expenditure:        ${formatEther(maxCostWei)} PHRS at the current gas price`);
  lines.push(
    `Absolute operator ceiling:       ${formatEther(HARD_CEILING_WEI)} PHRS ` +
      `(${underCeiling ? 'current estimate is under the ceiling' : 'CURRENT ESTIMATE EXCEEDS THE CEILING - DO NOT APPROVE'})`,
  );
  lines.push('');
  lines.push('Predicted CREATE addresses for steps 1-4 (deterministic from nonce;');
  lines.push('VOID if any tx is sent first; step 5 calls the receipt token):');
  for (const item of predicted) {
    lines.push(`  ${item.order}. ${item.name.padEnd(22)} ${item.address}`);
  }
  lines.push('');
  lines.push('PLAN HASH (stable; binds chain, deployer, bytecode, args and gas caps):');
  lines.push(`  ${planHash}`);
  lines.push('');
  lines.push('This plan is NOT an execution authorization. Deployment requires:');
  lines.push('  1. explicit approval of the plan hash above;');
  lines.push('  2. a gated run that force-rebuilds, re-verifies the artifact hashes,');
  lines.push('     chainId/nonce/gas price/balance, journals INTENT before every send');
  lines.push('     and verifies every receipt, bytecode and address:');
  lines.push('       npx tsx scripts/testnet-deploy.ts --mode atlantic \\');
  lines.push('           --env-file <path> --address <deployer> \\');
  lines.push(`           --approve-plan ${planHash} \\`);
  lines.push('           --confirm-atlantic-testnet');
  lines.push('The runner never resends an ambiguous transaction and stops on any mismatch.');
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
