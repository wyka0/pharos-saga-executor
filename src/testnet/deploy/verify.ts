import { createHash } from 'node:crypto';

/**
 * Pure verification helpers for the gated deployment runner.
 * No network, no secrets; unit-tested in test/deploy-tooling.test.ts.
 */

export class DeployVerificationError extends Error {
  constructor(message: string) {
    super(`DEPLOY VERIFICATION FAILED: ${message}`);
    this.name = 'DeployVerificationError';
  }
}

export interface ImmutableRange {
  start: number;
  length: number;
}

/** Flatten + validate solc `immutableReferences` for one artifact. */
export function flattenImmutableRanges(
  references: Record<string, { start: number; length: number }[]>,
  codeHexLength: number,
): ImmutableRange[] {
  const ranges: ImmutableRange[] = [];
  for (const list of Object.values(references)) {
    for (const range of list) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.length)) {
        throw new DeployVerificationError('non-integer immutable reference range');
      }
      if (range.start < 0 || range.length <= 0) {
        throw new DeployVerificationError('invalid immutable reference range');
      }
      if ((range.start + range.length) * 2 + 2 > codeHexLength) {
        throw new DeployVerificationError('immutable reference out of code bounds');
      }
      ranges.push({ start: range.start, length: range.length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && previous.start + previous.length > current.start) {
      throw new DeployVerificationError('overlapping immutable reference ranges');
    }
  }
  return ranges;
}

/** Zero out the immutable slots of a runtime-code hex string. */
export function maskImmutableRanges(codeHex: string, ranges: ImmutableRange[]): string {
  if (!/^0x[0-9a-fA-F]*$/.test(codeHex) || (codeHex.length - 2) % 2 !== 0) {
    throw new DeployVerificationError('runtime code is not valid hex');
  }
  const chars = codeHex.slice(2).split('');
  for (const range of ranges) {
    const offset = range.start * 2;
    for (let i = 0; i < range.length * 2; i += 1) {
      charSet(chars, offset + i, '0');
    }
  }
  return `0x${chars.join('')}`;
}

function charSet(chars: string[], index: number, value: string): void {
  if (index >= 0 && index < chars.length) chars[index] = value;
}

/**
 * Compare on-chain runtime code with the artifact bytecode while ignoring the
 * immutable slots (patched at construction time) and re-checks that the code
 * structure is otherwise identical. Returns the masked hash for the journal.
 */
export function verifyRuntimeCode(
  actualCode: string,
  artifact: { deployedBytecode: string; immutableReferences: Record<string, { start: number; length: number }[]> },
): { maskedSha256: string; immutableSlotCount: number } {
  if (!actualCode || actualCode === '0x') {
    throw new DeployVerificationError('no deployed runtime code at the expected address');
  }
  if (actualCode.length !== artifact.deployedBytecode.length) {
    throw new DeployVerificationError(
      `runtime code length mismatch (on-chain ${(actualCode.length - 2) / 2} bytes vs artifact ${(artifact.deployedBytecode.length - 2) / 2} bytes)`,
    );
  }
  const ranges = flattenImmutableRanges(artifact.immutableReferences, artifact.deployedBytecode.length);
  const actualMasked = maskImmutableRanges(actualCode, ranges);
  const expectedMasked = maskImmutableRanges(artifact.deployedBytecode, ranges);
  if (actualMasked.toLowerCase() !== expectedMasked.toLowerCase()) {
    throw new DeployVerificationError(
      'deployed bytecode differs from the approved artifact outside immutable slots',
    );
  }
  return {
    maskedSha256: createHash('sha256').update(actualMasked).digest('hex'),
    immutableSlotCount: ranges.reduce((sum, range) => sum + range.length, 0),
  };
}

/** Intrinsic gas for a contract-creation transaction (base + EIP-2 + calldata). */
export function intrinsicGasForCreation(dataHex: string): bigint {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(dataHex)) {
    throw new DeployVerificationError('init code is not valid even-length hex');
  }
  const body = dataHex.slice(2);
  let gas = 53_000n; // 21000 transaction base + 32000 EIP-2 contract creation
  for (let i = 0; i < body.length; i += 2) {
    gas += body.slice(i, i + 2) === '00' ? 4n : 16n;
  }
  const words = BigInt(Math.ceil(body.length / 2 / 32)); // EIP-3860 initcode word cost
  return gas + words * 2n;
}

/** Redact RPC URLs and 64-hex secrets before any log or journal note. */
export function scrubSensitive(text: string, rpcUrl?: string): string {
  let output = text;
  if (rpcUrl) output = output.split(rpcUrl).join('<rpc-url>');
  output = output.replace(/https?:\/\/[^\s'"]+/g, '<redacted-url>');
  output = output.replace(/0x[0-9a-fA-F]{64}/g, '<redacted-64-hex>');
  return output;
}

/** Local-anvil mode accepts loopback HTTP endpoints only. */
export function assertLocalRpcUrl(rpcUrl: string): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new DeployVerificationError('local RPC URL is not a valid URL');
  }
  const host = url.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol !== 'http:' || !loopback) {
    throw new DeployVerificationError(
      `local-anvil mode accepts only http:// loopback RPC URLs (got ${url.protocol}//${url.host})`,
    );
  }
}
