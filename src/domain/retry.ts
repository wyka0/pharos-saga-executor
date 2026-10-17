import { ConfigurationError } from './errors.js';
import type { RetryConfig, StepName } from './types.js';

export interface JitterInput {
  sagaId: string;
  step: StepName;
  attempt: number;
}

/** Returns a number in [0, 1). Injected so retries are deterministic in tests. */
export type JitterSource = (input: JitterInput) => number;

export const HALF_JITTER: JitterSource = () => 0.5;

export function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value >= 1) return 0.999_999;
  return value;
}

/**
 * A small deterministic PRNG-derived jitter source. Useful for demos and for
 * callers that want reproducible retry timing without hard-coding 0.5.
 */
export function createSeededJitter(seed: string): JitterSource {
  return (input) => {
    const text = `${seed}:${input.sagaId}:${input.step}:${input.attempt}`;
    let hash = 2_166_136_261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return (hash >>> 0) / 4_294_967_296;
  };
}

export function assertRetryConfig(input: Partial<RetryConfig>): Required<RetryConfig> {
  const config: Required<RetryConfig> = {
    maxAttempts: input.maxAttempts ?? 3,
    baseDelayMs: input.baseDelayMs ?? 100,
    maxDelayMs: input.maxDelayMs ?? 1_000,
    backoffFactor: input.backoffFactor ?? 2,
  };

  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 20) {
    throw new ConfigurationError('retry.maxAttempts must be an integer between 1 and 20');
  }
  if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0 || config.baseDelayMs > 60_000) {
    throw new ConfigurationError('retry.baseDelayMs must be between 0 and 60000');
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < 0 || config.maxDelayMs > 300_000) {
    throw new ConfigurationError('retry.maxDelayMs must be between 0 and 300000');
  }
  if (config.maxDelayMs < config.baseDelayMs) {
    throw new ConfigurationError('retry.maxDelayMs must be >= retry.baseDelayMs');
  }
  if (!Number.isFinite(config.backoffFactor) || config.backoffFactor < 1 || config.backoffFactor > 10) {
    throw new ConfigurationError('retry.backoffFactor must be between 1 and 10');
  }

  return config;
}

/**
 * Bounded exponential backoff with equal jitter:
 *
 *   raw   = min(maxDelayMs, baseDelayMs * factor^(attempt - 1))
 *   delay = round(raw / 2 + (raw / 2) * jitter)
 *
 * `attempt` is the attempt that just failed (1-based). With jitter = 0.5 the
 * delay is 75% of the exponential ceiling, which keeps tests easy to assert.
 */
export class RetryPolicy {
  readonly config: Required<RetryConfig>;

  constructor(config: Partial<RetryConfig>) {
    this.config = assertRetryConfig(config);
  }

  attemptsRemain(attemptsUsed: number): boolean {
    return attemptsUsed < this.config.maxAttempts;
  }

  rawDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(this.config.maxDelayMs, this.config.baseDelayMs * this.config.backoffFactor ** exponent);
  }

  delayMs(attempt: number, jitterSource: JitterSource, input: { sagaId: string; step: StepName }): number {
    return this.schedule(attempt, jitterSource, input).delayMs;
  }

  schedule(
    attempt: number,
    jitterSource: JitterSource,
    input: { sagaId: string; step: StepName },
  ): { delayMs: number; jitter: number; rawDelayMs: number } {
    const raw = this.rawDelayMs(attempt);
    if (raw === 0) return { delayMs: 0, jitter: 0, rawDelayMs: 0 };
    const jitter = clampJitter(jitterSource({ ...input, attempt }));
    const delayMs = Math.max(0, Math.min(this.config.maxDelayMs, Math.round(raw / 2 + (raw / 2) * jitter)));
    return { delayMs, jitter, rawDelayMs: raw };
  }
}
