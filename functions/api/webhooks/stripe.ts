import type { Env } from '../../lib/env';
import { getCase, putCase } from '../../lib/cases';
import { notifyDiscord } from '../../lib/discord';
import {
  STRIPE_EVENT_TTL_SEC,
  stripeEventKey,
  verifyStripeSignature,
} from '../../lib/stripe';
import { mintToken } from '../../lib/tokens';

const UPLOAD_TOKEN_TTL_SEC = 60 * 60;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function paymentIntentId(pi: unknown): string | null {
  if (typeof pi === 'string' && pi) return pi;
  if (pi && typeof pi === 'object' && 'id' in pi) {
    const id = (pi as { id: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

type WebhookEnv = Pick<
  Env,
  'CASES' | 'STRIPE_WEBHOOK_SECRET' | 'DISCORD_WEBHOOK_URL' | 'PUBLIC_BASE_URL'
>;

export async function processStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  env: WebhookEnv,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const verified = await verifyStripeSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET,
    nowSec,
  );
  if (!verified.ok) return json({ error: verified.error }, 400);

  let event: {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!event.id || !event.type) return json({ error: 'Invalid event' }, 400);

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true });
  }

  const session = event.data?.object ?? {};
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (metadata.type !== 'deposit') {
    return json({ received: true });
  }

  const ek = stripeEventKey(event.id);
  if (await env.CASES.get(ek)) {
    return json({ received: true, duplicate: true });
  }

  const caseId = typeof metadata.caseId === 'string' ? metadata.caseId : '';
  if (!caseId) return json({ error: 'Missing caseId metadata' }, 400);

  const record = await getCase(env.CASES, caseId);
  if (!record) return json({ error: 'Unknown case' }, 400);

  if (record.status === 'draft') {
    record.status = 'deposited';
    record.stripeDepositPi = paymentIntentId(session.payment_intent);
    const token = await mintToken(env.CASES, 'upload', record.id, UPLOAD_TOKEN_TTL_SEC);
    await putCase(env.CASES, record);

    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const uploadUrl = `${base}/upload.html?case=${encodeURIComponent(record.id)}&token=${encodeURIComponent(token)}`;
    try {
      await notifyDiscord(
        env.DISCORD_WEBHOOK_URL,
        `New deposit ${record.id} ${record.email} — upload token minted\n${uploadUrl}`,
      );
    } catch {
      // Ops notify is best-effort; Stripe should not retry because Discord failed.
    }
  }

  await env.CASES.put(ek, '1', { expirationTtl: STRIPE_EVENT_TTL_SEC });
  return json({ received: true });
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, 500);
  }
  const rawBody = await request.text();
  return processStripeWebhook(rawBody, request.headers.get('stripe-signature'), env);
}
