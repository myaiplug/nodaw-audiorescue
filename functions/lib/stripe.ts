export const DEPOSIT_AMOUNT_CENTS = 1950;
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;
export const STRIPE_EVENT_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export function stripeEventKey(eventId: string): string {
  return `event:${eventId}`;
}

export async function stripeForm(secret: string, path: string, body: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function depositCheckoutFields(opts: {
  caseId: string;
  email: string;
  publicBaseUrl: string;
  productName?: string;
}): Record<string, string> {
  const base = opts.publicBaseUrl.replace(/\/+$/, '');
  return {
    mode: 'payment',
    customer_email: opts.email,
    success_url: `${base}/upload.html?case=${encodeURIComponent(opts.caseId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(DEPOSIT_AMOUNT_CENTS),
    'line_items[0][price_data][product_data][name]': opts.productName ?? 'Mix Rescue deposit',
    'metadata[type]': 'deposit',
    'metadata[caseId]': opts.caseId,
  };
}

export function parseStripeSignature(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) t = n;
    } else if (k === 'v1' && v) {
      v1.push(v);
    }
  }
  if (t == null || v1.length === 0) return null;
  return { t, v1 };
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!header) return { ok: false, error: 'Missing Stripe-Signature header' };
  const parsed = parseStripeSignature(header);
  if (!parsed) return { ok: false, error: 'Invalid Stripe-Signature header' };
  if (Math.abs(nowSec - parsed.t) > STRIPE_SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, error: 'Timestamp outside tolerance' };
  }
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${payload}`);
  if (!parsed.v1.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, error: 'Signature mismatch' };
  }
  return { ok: true };
}
