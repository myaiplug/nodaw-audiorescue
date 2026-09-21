/** Default legacy constants (deposit-ish). Prefer LIMITS.* presets. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_SEC = 60 * 60;

export type RateLimitKind =
  | 'deposit'
  | 'upload'
  | 'claim'
  | 'download_list'
  | 'ops_login';

/** Abuse / cost guards — tune here, not per-route. */
export const LIMITS: Record<
  RateLimitKind,
  { limit: number; windowSec: number; description: string }
> = {
  // Stripe Checkout session create — real money path / API cost
  deposit: { limit: 5, windowSec: 60 * 60, description: '5 deposit checkouts per IP per hour' },
  // Authenticated upload after deposit
  upload: { limit: 8, windowSec: 60 * 60, description: '8 uploads per IP per hour' },
  // Stripe session retrieve to mint upload token
  claim: { limit: 20, windowSec: 60 * 60, description: '20 upload claims per IP per hour' },
  // Stripe session retrieve for download links
  download_list: { limit: 30, windowSec: 60 * 60, description: '30 download list polls per IP per hour' },
  // Ops password guessing
  ops_login: { limit: 5, windowSec: 15 * 60, description: '5 ops login attempts per IP per 15 min' },
};

export function rateLimitKey(kind: RateLimitKind, ip: string): string {
  const safe = (ip || 'unknown').slice(0, 128);
  return `rl:${kind}:${safe}`;
}

export function emailRateLimitKey(kind: RateLimitKind, email: string): string {
  const safe = email.trim().toLowerCase().slice(0, 254) || 'unknown';
  return `rl:${kind}:email:${safe}`;
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
): Promise<{ ok: true; remaining: number } | { ok: false; retryAfterSec: number }> {
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
  const next = n + 1;
  await kv.put(key, JSON.stringify({ n: next, resetAt }), {
    expirationTtl: Math.max(60, resetAt - nowSec),
  });
  return { ok: true, remaining: Math.max(0, limit - next) };
}

export async function enforceLimit(
  kv: KVNamespace,
  kind: RateLimitKind,
  ip: string,
  extraKeys: string[] = [],
): Promise<Response | null> {
  const preset = LIMITS[kind];
  const keys = [rateLimitKey(kind, ip), ...extraKeys];
  let worstRetry = 0;
  for (const key of keys) {
    const r = await consumeRateLimit(kv, key, preset.limit, preset.windowSec);
    if (!r.ok) worstRetry = Math.max(worstRetry, r.retryAfterSec);
  }
  if (worstRetry > 0) {
    return new Response(JSON.stringify({ error: 'Too many requests. Slow down and try again later.' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(worstRetry),
        'Cache-Control': 'no-store',
      },
    });
  }
  return null;
}
