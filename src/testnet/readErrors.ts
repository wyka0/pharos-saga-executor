/** Conservative classification for transient JSON-RPC read failures. */
export function isTransientRpcMessage(message: string): boolean {
  const text = message.toLowerCase();
  return [
    'cu limit exceeded',
    'rate limit',
    'too fast',
    'too many requests',
    '429',
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'eai_again',
    'fetch failed',
    'socket hang up',
    'temporarily unavailable',
  ].some((needle) => text.includes(needle));
}
