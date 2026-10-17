import type { TestnetConfig, TestnetToken } from '../domain/types.js';

/**
 * Verified Atlantic testnet constants.
 *
 * Sources (checked 2026-10-17):
 *  - https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md
 *  - https://docs.pharos.xyz/getting-started/token-registry.md
 *  - https://github.com/PharosNetwork/pharos-skill-engine/blob/main/assets/networks.json
 *
 * No swap/router or deposit/vault protocol is included because none is
 * officially documented or deployed. Do not fill these with guesses.
 */
export const ATLANTIC_TESTNET = {
  name: 'atlantic-testnet' as const,
  chainId: 688689 as const,
  nativeSymbol: 'PHRS' as const,
  explorerUrl: 'https://atlantic.pharosscan.xyz/',
  publicRpcUrl: 'https://atlantic.dplabs-internal.com',
  rateLimit: '500 requests / 5 minutes',
} as const;

export const ATLANTIC_TOKENS: TestnetToken[] = [
  {
    symbol: 'USDC',
    address: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B',
    decimals: 6,
    verifiedSource: 'https://docs.pharos.xyz/getting-started/token-registry.md',
  },
  {
    symbol: 'USDT',
    address: '0xE7E84B8B4f39C507499c40B4ac199B050e2882d5',
    decimals: 6,
    verifiedSource: 'https://docs.pharos.xyz/getting-started/token-registry.md',
  },
  {
    symbol: 'WBTC',
    address: '0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4',
    decimals: 18,
    verifiedSource: 'https://docs.pharos.xyz/getting-started/token-registry.md',
  },
  {
    symbol: 'WETH',
    address: '0x7d211F77525ea39A0592794f793cC1036eEaccD5',
    decimals: 18,
    verifiedSource: 'https://docs.pharos.xyz/getting-started/token-registry.md',
  },
  {
    symbol: 'WPHRS',
    address: '0x838800b758277CC111B2d48Ab01e5E164f8E9471',
    decimals: 18,
    verifiedSource: 'https://docs.pharos.xyz/getting-started/token-registry.md',
  },
];

/**
 * Default config intentionally leaves swap and deposit null. The adapter then
 * reports those capabilities as unavailable instead of targeting a random
 * contract.
 */
export function defaultAtlanticTestnetConfig(): TestnetConfig {
  return {
    network: {
      name: ATLANTIC_TESTNET.name,
      chainId: ATLANTIC_TESTNET.chainId,
      nativeSymbol: ATLANTIC_TESTNET.nativeSymbol,
      explorerUrl: ATLANTIC_TESTNET.explorerUrl,
      rpcUrlEnv: 'PHAROS_TESTNET_RPC_URL',
    },
    tokens: structuredClone(ATLANTIC_TOKENS),
    swap: null,
    deposit: null,
    approvedPlan: null,
  };
}

export function tokenBySymbol(config: TestnetConfig, symbol: string): TestnetToken | null {
  return config.tokens.find((token) => token.symbol === symbol) ?? null;
}

export function explorerTxUrl(txHash: string): string {
  return `${ATLANTIC_TESTNET.explorerUrl}tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${ATLANTIC_TESTNET.explorerUrl}address/${address}`;
}
