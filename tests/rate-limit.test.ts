import { describe, it, expect } from 'vitest';
import {
  LIMITS,
  consumeRateLimit,
  emailRateLimitKey,
  enforceLimit,
  rateLimitKey,
} from '../functions/lib/rate-limit';

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
  it('allows N hits then rejects in the same window', async () => {
    const kv = memoryKv();
    const key = rateLimitKey('deposit', '1.2.3.4');
    const now = 1_700_000_000;
    for (let i = 0; i < 5; i++) {
      const r = await consumeRateLimit(kv as unknown as KVNamespace, key, 5, 3600, now);
      expect(r.ok).toBe(true);
    }
    const blocked = await consumeRateLimit(kv as unknown as KVNamespace, key, 5, 3600, now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(3600);
  });
});

describe('enforceLimit', () => {
  it('returns 429 with Retry-After when IP or email bucket is exhausted', async () => {
    const kv = memoryKv();
    const ip = '9.9.9.9';
    const emailKey = emailRateLimitKey('deposit', 'a@b.com');
    for (let i = 0; i < LIMITS.deposit.limit; i++) {
      expect(await enforceLimit(kv as unknown as KVNamespace, 'deposit', ip, [emailKey])).toBeNull();
    }
    const res = await enforceLimit(kv as unknown as KVNamespace, 'deposit', ip, [emailKey]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(res!.headers.get('Retry-After')).toBeTruthy();
    const body = await res!.json();
    expect(body.error).toMatch(/Too many requests/i);
  });

  it('uses tighter ops_login window', () => {
    expect(LIMITS.ops_login.limit).toBe(5);
    expect(LIMITS.ops_login.windowSec).toBe(15 * 60);
  });
});
