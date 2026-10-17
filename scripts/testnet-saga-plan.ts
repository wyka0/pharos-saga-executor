/**
 * READ-ONLY Atlantic saga plan (v1). TEST-ONLY MOCK ECOSYSTEM.
 *
 * Re-derives the reviewed five-step saga plan against the live chain:
 * chain id, block, wallet balance, pending nonce, gas price, the four
 * contract addresses recorded as CONFIRMED in the durable deployment journal,
 * fresh artifact hashes (deployed runtime code compared with immutables
 * masked), contract wiring, the live pre-state and the stable plan hash for
 * explicit user approval.
 *
 * It NEVER reads a signing key, NEVER signs and NEVER broadcasts. The plan
 * core comes from src/testnet/sagaPlan.ts, which the safety gate keeps free of
 * any send/sign path; the gated runner (scripts/testnet-saga.ts) refuses to
 * send anything unless its freshly recomputed plan hash matches the hash
 * approved from this page.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/testnet-saga-plan.ts --env-file C:\temp-secrets\.env \
 *       --address 0xE2B8651178ade144003537eA509E37877dba40bb \
 *       [--deploy-journal .local/atlantic-deploy/deploy-journal.json] \
 *       [--expect-plan <64-hex>]
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createPublicClient,
  formatEther,
  formatGwei,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { loadEnvFile, redactRpcUrl } from '../src/testnet/env.js';
import { ATLANTIC_CHAIN_ID, readArtifact } from '../src/testnet/deployPlan.js';
import { verifyRuntimeCode } from '../src/testnet/deploy/verify.js';
import {
  ONE_TUSDC_RAW,
  SAGA_CEILING_WEI,
  SAGA_CONTRACT_ARTIFACTS,
  SAGA_CONTRACT_KEYS,
  SAGA_CONTRACT_NAMES,
  SAGA_EXPECTED_POSTCONDITIONS,
  SAGA_STEPS,
  buildSagaPlanCore,
  buildSagaStepCalldata,
  computeSagaPlanHash,
  officialAtlanticUsdcAddress,
  resolveSagaContractsFromDeployJournal,
} from '../src/testnet/sagaPlan.js';
import { ERC20_READ_ABI, VAULT_VIEW_ABI, checkSagaWiring } from '../src/testnet/saga/verify.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

function formatUnits6(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
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

async function main(): Promise<void> {
  const envFile = argValue('--env-file') ?? process.env.PHAROS_TESTNET_ENV_FILE;
  if (!envFile) {
    throw new Error(
      'Provide --env-file <path> (or PHAROS_TESTNET_ENV_FILE). Only RPC_URL is used; no signing key is read.',
    );
  }
  const addressArg = argValue('--address');
  if (!addressArg || !/^0x[0-9a-fA-F]{40}$/.test(addressArg)) {
    throw new Error('Provide --address <0x...> for the read-only saga plan.');
  }
  const address = getAddress(addressArg);
  const deployJournalPath = path.resolve(
    argValue('--deploy-journal') ?? path.join('.local', 'atlantic-deploy', 'deploy-journal.json'),
  );
  const expectPlan = argValue('--expect-plan');

  const env = loadEnvFile(envFile);
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is missing from the env file');
  if (!/^https:\/\//.test(rpcUrl)) throw new Error('RPC_URL must be an https URL');
  const rpcHost = redactRpcUrl(rpcUrl);
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });

  const chainId = await client.getChainId();
  if (chainId !== ATLANTIC_CHAIN_ID) {
    throw new Error(
      `Refusing to plan: chainId ${chainId} is not Atlantic testnet (${ATLANTIC_CHAIN_ID})`,
    );
  }
  const blockNumber = await client.getBlockNumber();
  const phrsBalance = await client.getBalance({ address });
  const nonce = await client.getTransactionCount({ address, blockTag: 'pending' });
  const gasPrice = await client.getGasPrice();

  const resolved = await resolveSagaContractsFromDeployJournal(deployJournalPath);
  if (!resolved.ok) throw new Error(`Refusing to plan: ${resolved.reason}`);
  const contracts = resolved.contracts;

  const artifactLines: string[] = [];
  for (const key of SAGA_CONTRACT_KEYS) {
    const name = SAGA_CONTRACT_NAMES[key];
    const artifact = await readArtifact(process.cwd(), SAGA_CONTRACT_ARTIFACTS[key]);
    const sha256 = createHash('sha256').update(artifact.bytecode).digest('hex');
    const code = await client.getCode({ address: contracts[key] });
    if (!code || code === '0x') {
      throw new Error(`Refusing to plan: no runtime code at ${name} (${contracts[key]})`);
    }
    let masked: string;
    try {
      masked = verifyRuntimeCode(code, artifact).maskedSha256;
    } catch (error) {
      throw new Error(
        `Refusing to plan: runtime code mismatch at ${name} (${contracts[key]}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const recorded = resolved.artifactSha256[key];
    if (recorded && recorded !== sha256) {
      throw new Error(
        `Refusing to plan: fresh ${name} artifact hash ${sha256} does not match the deployment journal hash ${recorded}; re-run the deployment plan and re-review`,
      );
    }
    artifactLines.push(
      `  ${name.padEnd(22)} ${contracts[key]}  runtime=${(code.length - 2) / 2}B  ` +
        `bytecodeSha256=${sha256.slice(0, 16)}...  maskedRuntimeSha256=${masked.slice(0, 16)}...`,
    );
  }
  const officialUsdc = officialAtlanticUsdcAddress();
  const wiring = await checkSagaWiring({ client, contracts, deployer: address, officialUsdc });
  if (wiring.failures.length > 0) {
    const detail = wiring.failures
      .map((failure) => `${failure.label} is ${failure.actual}, expected ${failure.expected}`)
      .join('; ');
    throw new Error(`Refusing to plan: contract wiring verification failed: ${detail}`);
  }

  const core = buildSagaPlanCore({ deployerAddress: address, contracts });
  const planHash = computeSagaPlanHash(core);
  if (expectPlan && expectPlan.toLowerCase() !== planHash) {
    throw new Error(
      `Refusing to plan: fresh plan hash ${planHash} does not match --expect-plan ${expectPlan.toLowerCase()}`,
    );
  }

  // Live pre-state (review only; the runner re-checks everything before each send).
  const tusdcBalance = await readBig(client, contracts.tUSDC, ERC20_READ_ABI, 'balanceOf', [address]);
  const tusdcAllowance = await readBig(client, contracts.tUSDC, ERC20_READ_ABI, 'allowance', [
    address,
    contracts.swap,
  ]);
  const tsagaBalance = await readBig(client, contracts.tSAGA, ERC20_READ_ABI, 'balanceOf', [address]);
  const tsagaAllowance = await readBig(client, contracts.tSAGA, ERC20_READ_ABI, 'allowance', [
    address,
    contracts.vault,
  ]);
  const tsagaSupply = await readBig(client, contracts.tSAGA, ERC20_READ_ABI, 'totalSupply');
  const swapUsdcBalance = await readBig(client, contracts.tUSDC, ERC20_READ_ABI, 'balanceOf', [
    contracts.swap,
  ]);
  const vaultShares = await readBig(client, contracts.vault, VAULT_VIEW_ABI, 'sharesOf', [address]);
  const vaultTotalShares = await readBig(client, contracts.vault, VAULT_VIEW_ABI, 'totalShares');
  const vaultTsagaBalance = await readBig(client, contracts.tSAGA, ERC20_READ_ABI, 'balanceOf', [
    contracts.vault,
  ]);
  const officialUsdcBalance = wiring.officialUsdcBalance ?? 0n;

  const mintDecision =
    tusdcBalance === ONE_TUSDC_RAW
      ? 'mint can be skipped (balance is already exactly 1.000000 tUSDC)'
      : tusdcBalance === 0n
        ? 'mint required (balance is 0)'
        : 'PRESTATE MISMATCH - the runner will refuse before any send';

  const worstCase = BigInt(core.totalGasCap) * gasPrice;
  const underCeiling = worstCase <= SAGA_CEILING_WEI;
  const balanceCovers = phrsBalance >= worstCase;

  const lines: string[] = [];
  lines.push('='.repeat(78));
  lines.push('ATLANTIC TESTNET SAGA PLAN v1 - READ-ONLY PREPARATION');
  lines.push('CLASSIFICATION: TEST-ONLY MOCK SAGA (tUSDC -> tSAGA -> vault). TESTNET ONLY.');
  lines.push('NOTHING WAS SIGNED OR BROADCAST. NO SIGNING KEY WAS READ.');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push(`RPC host:            ${rpcHost}`);
  lines.push(`Chain id:            ${chainId} (Atlantic testnet)`);
  lines.push(`Block:               ${blockNumber}`);
  lines.push(`Deployer (public):   ${address}`);
  lines.push(`PHRS balance:        ${formatEther(phrsBalance)}`);
  lines.push(`Pending nonce:       ${nonce}`);
  lines.push(`Gas price:           ${gasPrice} wei (${formatGwei(gasPrice)} gwei)`);
  lines.push('');
  lines.push(
    `Contracts (from the verified deployment journal ${path.relative(process.cwd(), deployJournalPath)}):`,
  );
  lines.push(`  tUSDC (TestOnlyUSDC, decimals 6):         ${contracts.tUSDC}`);
  lines.push(`  tSAGA (TestOnlyReceiptToken, decimals 6): ${contracts.tSAGA}`);
  lines.push(`  swap  (TestOnlySwap):                     ${contracts.swap}`);
  lines.push(`  vault (TestOnlyVault):                    ${contracts.vault}`);
  lines.push(`  official USDC (never targeted):           ${officialUsdc}`);
  lines.push('');
  lines.push('Deployed runtime evidence (immutables masked; artifact hashes re-checked):');
  lines.push(...artifactLines);
  lines.push('');
  lines.push('Saga sequence (exact reviewed calldata):');
  for (const spec of SAGA_STEPS) {
    const stepPlan = core.steps[spec.order - 1];
    const data = buildSagaStepCalldata({
      stepName: spec.name,
      deployerAddress: address,
      contracts,
    });
    lines.push(`  ${spec.order}. ${spec.name}`);
    lines.push(`     to=${contracts[spec.target]}  function=${spec.signature}`);
    lines.push(`     args=${JSON.stringify(stepPlan?.args ?? [])}`);
    lines.push(`     calldata=${data}`);
    lines.push(
      `     gasCap=${spec.gasCap}${spec.conditional ? `  conditional: ${spec.conditional}` : ''}`,
    );
  }
  lines.push('');
  lines.push('Live pre-state (the runner re-checks all of this before each send):');
  lines.push(
    `  tUSDC.balanceOf(deployer):         ${formatUnits6(tusdcBalance)} (${tusdcBalance} raw) - ${mintDecision}`,
  );
  lines.push(`  tUSDC.allowance(deployer, swap):   ${tusdcAllowance} raw (expected 0)`);
  lines.push(`  tSAGA.balanceOf(deployer):         ${tsagaBalance} raw (expected 0)`);
  lines.push(`  tSAGA.allowance(deployer, vault):  ${tsagaAllowance} raw (expected 0)`);
  lines.push(`  tSAGA.totalSupply():               ${tsagaSupply} raw (expected 0)`);
  lines.push(`  tUSDC.balanceOf(swap):             ${swapUsdcBalance} raw (expected 0)`);
  lines.push(`  vault.sharesOf(deployer):          ${vaultShares} (expected 0)`);
  lines.push(`  vault.totalShares():               ${vaultTotalShares} (expected 0)`);
  lines.push(`  tSAGA.balanceOf(vault):            ${vaultTsagaBalance} (expected 0)`);
  lines.push(
    `  official USDC balanceOf(deployer): ${formatUnits6(officialUsdcBalance)} (must remain unchanged)`,
  );
  lines.push('');
  lines.push('Expected end state (verified after every step and again at the end):');
  for (const item of SAGA_EXPECTED_POSTCONDITIONS) lines.push(`  ${item}`);
  lines.push('');
  lines.push(`Total gas cap (5 calls):          ${core.totalGasCap}`);
  lines.push(`Worst-case cost at gas price:     ${formatEther(worstCase)} PHRS (${worstCase} wei)`);
  lines.push(
    `Absolute operator ceiling:        ${formatEther(SAGA_CEILING_WEI)} PHRS ` +
      `(${underCeiling ? 'current estimate is under the ceiling' : 'CURRENT ESTIMATE EXCEEDS THE CEILING - DO NOT APPROVE'})`,
  );
  lines.push(`PHRS balance covers worst case:   ${balanceCovers ? 'yes' : 'NO - top up before approving'}`);
  lines.push('');
  lines.push('PLAN HASH (stable; binds chain, addresses, calldata, gas caps and ceiling):');
  lines.push(`  ${planHash}`);
  if (expectPlan) {
    lines.push(
      `  (--expect-plan ${expectPlan.toLowerCase()}: ${expectPlan.toLowerCase() === planHash ? 'MATCH' : 'MISMATCH'})`,
    );
  }
  lines.push('');
  lines.push('This plan is NOT an execution authorization. Execution requires:');
  lines.push('  1. explicit approval of the plan hash above;');
  lines.push('  2. a gated run that force-rebuilds, re-checks this exact hash, the');
  lines.push('     chain id, nonce, gas price, balance, the 0.02 PHRS ceiling, the');
  lines.push('     deployed contracts and their wiring, journals INTENT before every');
  lines.push('     send, and verifies every receipt, calldata hash and postcondition:');
  lines.push('       npx tsx scripts/testnet-saga.ts --mode atlantic \\');
  lines.push('           --env-file <path> --address <deployer> \\');
  lines.push(`           --approve-plan ${planHash} \\`);
  lines.push('           --confirm-atlantic-testnet');
  lines.push('The runner stops on any mismatch or ambiguous outcome and NEVER resends.');
  lines.push('='.repeat(78));

  process.stdout.write(`${lines.join('\n')}\n`);
}

const TRANSIENT_RPC = /RPC Request failed|rate|limit|429|timed out|ECONN|fetch failed/i;

async function mainWithRetry(): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await main();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts || !TRANSIENT_RPC.test(message)) throw error;
      process.stderr.write(
        `read-only plan attempt ${attempt} hit a transient RPC error; retrying in 10s\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

mainWithRetry().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
