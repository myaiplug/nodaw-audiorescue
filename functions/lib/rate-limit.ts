export const RATE_LIMIT = 10;
export const RATE_WINDOW_SEC = 60 * 60;

export type RateLimitKind = 'deposit' | 'upload';

export function rateLimitKey(kind: RateLimitKind, ip: string): string {
  return `rl:${kind}:${ip}`;
}

export function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP')?.trim();
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (xff) return xff;
  return 'unknown';
}

export async function consumeRateLimit(
  kv: KVNamespace,
  key: string,
  limit = RATE_LIMIT,
  windowSec = RATE_WINDOW_SEC,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const raw = await kv.get(key);
  let n = 0;
  let resetAt = nowSec + windowSec;
  if (raw) {
    try {
      const o = JSON.parse(raw) as { n?: unknown; resetAt?: unknown };
      if (typeof o.resetAt === 'number' && o.resetAt > nowSec) {
        n = typeof o.n === 'number' && Number.isFinite(o.n) ? o.n : 0;
        resetAt = o.resetAt;
      }
    } catch {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) n = parsed;
    }
  }
  if (n >= limit) return { ok: false, retryAfterSec: Math.max(1, resetAt - nowSec) };
  await kv.put(key, JSON.stringify({ n: n + 1, resetAt }), {
    expirationTtl: Math.max(60, resetAt - nowSec),
  });
  return { ok: true };
}
