import { readFileSync } from 'node:fs';
import { ConfigurationError } from '../domain/errors.js';

export interface EnvCredentials {
  rpcUrl: string;
  privateKey: string;
}

/**
 * Minimal env parser. Values are returned to the caller but MUST never be
 * logged, persisted, or included in errors. Only key names are safe to print.
 */
export function loadEnvFile(filePath: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigurationError(`Cannot read the configured env file: ${filePath}`);
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function readCredentialNames(filePath: string): string[] {
  return Object.keys(loadEnvFile(filePath)).sort();
}

export function resolveCredentials(
  filePath: string,
  options: { rpcVar?: string; keyVar?: string } = {},
): EnvCredentials {
  const rpcVar = options.rpcVar ?? 'RPC_URL';
  const keyVar = options.keyVar ?? 'PRIVATE_KEY';
  const env = loadEnvFile(filePath);
  const rpcUrl = env[rpcVar];
  const privateKey = env[keyVar];
  if (!rpcUrl) throw new ConfigurationError(`Missing ${rpcVar} in the configured env file`);
  if (!privateKey) throw new ConfigurationError(`Missing ${keyVar} in the configured env file`);
  if (!/^https:\/\//.test(rpcUrl)) throw new ConfigurationError(`${rpcVar} must be an https URL`);
  const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(cleanKey)) {
    throw new ConfigurationError(`${keyVar} is not a valid 32-byte hex private key`);
  }
  return { rpcUrl, privateKey: `0x${cleanKey}` };
}

/** Redacts a URL to host only, for safe logging. */
export function redactRpcUrl(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    return `${url.protocol}//${url.host}/<redacted-path>`;
  } catch {
    return '<invalid-url>';
  }
}
