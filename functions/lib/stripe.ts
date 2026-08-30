import { getCase, putCase, type CaseRecord } from './cases';

export const DEPOSIT_AMOUNT_CENTS = 1950;
export const BALANCE_AMOUNT_CENTS = 1950;
export const DECLINE_REFUND_CENTS = 1450;
export const DECLINE_KEEP_CENTS = 500;
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;
export const STRIPE_EVENT_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export function stripeEventKey(eventId: string): string {
  return `event:${eventId}`;
}

export async function stripeForm(
  secret: string,
  path: string,
  body: Record<string, string>,
  extraHeaders?: Record<string, string>,
) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...extraHeaders,
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function stripeGet(secret: string, path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
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

export function balanceCheckoutFields(opts: {
  caseId: string;
  email: string;
  publicBaseUrl: string;
  productName?: string;
}): Record<string, string> {
  const base = opts.publicBaseUrl.replace(/\/+$/, '');
  return {
    mode: 'payment',
    customer_email: opts.email,
    success_url: `${base}/thanks.html?case=${encodeURIComponent(opts.caseId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(BALANCE_AMOUNT_CENTS),
    'line_items[0][price_data][product_data][name]': opts.productName ?? 'Mix Rescue balance',
    'metadata[type]': 'balance',
    'metadata[caseId]': opts.caseId,
  };
}

export function declineRefundFields(opts: {
  paymentIntentId: string;
  caseId: string;
}): Record<string, string> {
  return {
    payment_intent: opts.paymentIntentId,
    amount: String(DECLINE_REFUND_CENTS),
    reason: 'requested_by_customer',
    'metadata[caseId]': opts.caseId,
    'metadata[reason]': 'not_a_fit_review_fee_kept',
  };
}

export async function expirePreviousBalanceSession(
  secret: string,
  sessionId: string | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  const encoded = encodeURIComponent(sessionId);
  let session: { status?: string; payment_status?: string };
  try {
    session = (await stripeGet(secret, `checkout/sessions/${encoded}`)) as typeof session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/resource_missing|No such checkout/i.test(msg)) return;
    throw err;
  }
  if (isBalanceSessionPaid(session)) {
    throw new Error('Previous balance session already paid');
  }
  if (session.status !== 'open') return;
  try {
    await stripeForm(secret, `checkout/sessions/${encoded}/expire`, {});
  } catch (err) {
    let again: { status?: string; payment_status?: string };
    try {
      again = (await stripeGet(secret, `checkout/sessions/${encoded}`)) as typeof again;
    } catch {
      throw err;
    }
    if (isBalanceSessionPaid(again)) {
      throw new Error('Previous balance session already paid');
    }
    if (again.status === 'expired' || again.status !== 'open') return;
    throw err;
  }
}

function isBalanceSessionPaid(session: { status?: string; payment_status?: string }): boolean {
  return session.payment_status === 'paid' || session.status === 'complete';
}

export async function commitIssuedBalanceCheckout(
  kv: KVNamespace,
  secret: string,
  record: CaseRecord,
  session: { url: string; id: string },
): Promise<{ ok: true; record: CaseRecord } | { ok: false; record: CaseRecord }> {
  const latest = await getCase(kv, record.id);
  if (latest && (latest.status === 'paid_in_full' || latest.status === 'delivered')) {
    try {
      await stripeForm(secret, `checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
    } catch (err) {
      console.error('Expire raced leftover balance session failed', err);
    }
    return { ok: false, record: latest };
  }
  const next: CaseRecord = latest ? { ...latest } : record;
  if (record.r2RescueWav) next.r2RescueWav = record.r2RescueWav;
  if (record.r2RescueMp3) next.r2RescueMp3 = record.r2RescueMp3;
  if (record.r2Notes) next.r2Notes = record.r2Notes;
  next.balanceCheckoutUrl = session.url;
  next.stripeBalanceSessionId = session.id;
  if (next.status !== 'paid_in_full' && next.status !== 'delivered') {
    next.status = 'balance_due';
  }
  await putCase(kv, next);
  return { ok: true, record: next };
}

export async function createBalanceCheckout(
  secret: string,
  opts: { caseId: string; email: string; publicBaseUrl: string },
  previousSessionId?: string | null,
): Promise<{ url: string; id: string }> {
  await expirePreviousBalanceSession(secret, previousSessionId);
  const session = (await stripeForm(secret, 'checkout/sessions', balanceCheckoutFields(opts))) as {
    url?: string;
    id?: string;
  };
  if (!session.url || !session.id) throw new Error('Stripe session missing url');
  return { url: session.url, id: session.id };
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
