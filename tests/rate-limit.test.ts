import { describe, it, expect } from 'vitest';
import { consumeRateLimit, rateLimitKey } from '../functions/lib/rate-limit';

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      data.set(key, value);
    },
  };
}

describe('consumeRateLimit', () => {
  it('allows 10 hits then rejects in the same window', async () => {
    const kv = memoryKv();
    const key = rateLimitKey('deposit', '1.2.3.4');
    const now = 1_700_000_000;
    for (let i = 0; i < 10; i++) {
      const r = await consumeRateLimit(kv as unknown as KVNamespace, key, 10, 3600, now);
      expect(r.ok).toBe(true);
    }
    const blocked = await consumeRateLimit(kv as unknown as KVNamespace, key, 10, 3600, now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(3600);
  });
});
