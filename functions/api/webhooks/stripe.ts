import type { Env } from '../../lib/env';
import { getCase, putCase } from '../../lib/cases';
import { notifyDiscord } from '../../lib/discord';
import {
  STRIPE_EVENT_TTL_SEC,
  expirePreviousBalanceSession,
  stripeEventKey,
  stripeForm,
  verifyStripeSignature,
} from '../../lib/stripe';
import { DOWNLOAD_TOKEN_TTL_SEC, mintDownloadLinks, mintToken } from '../../lib/tokens';

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

type WebhookEnv = Pick<Env, 'CASES' | 'STRIPE_WEBHOOK_SECRET' | 'DISCORD_WEBHOOK_URL' | 'PUBLIC_BASE_URL'> & {
  STRIPE_SECRET_KEY?: string;
};

export async function processStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  env: WebhookEnv,
  nowSec = Math.floor(Date.now() / 1000),
  waitUntil?: (promise: Promise<unknown>) => void,
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
  const metaType = metadata.type;
  if (metaType !== 'deposit' && metaType !== 'balance') {
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

  let discordContent: string | null = null;
  const sessionId = typeof session.id === 'string' ? session.id : '';
  if (metaType === 'deposit' && record.status === 'draft') {
    record.status = 'deposited';
    record.stripeDepositPi = paymentIntentId(session.payment_intent);
    const token = await mintToken(env.CASES, 'upload', record.id, UPLOAD_TOKEN_TTL_SEC);
    await putCase(env.CASES, record);
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const uploadUrl = `${base}/upload.html?case=${encodeURIComponent(record.id)}&token=${encodeURIComponent(token)}`;
    discordContent = `New deposit ${record.id} ${record.email} — upload token minted\n${uploadUrl}`;
  } else if (
    metaType === 'balance' &&
    (record.status === 'rescued' || record.status === 'balance_due')
  ) {
    const previousSessionId = record.stripeBalanceSessionId;
    record.status = 'paid_in_full';
    record.stripeBalancePi = paymentIntentId(session.payment_intent);
    if (sessionId) record.stripeBalanceSessionId = sessionId;
    const links = await mintDownloadLinks(env.CASES, record, DOWNLOAD_TOKEN_TTL_SEC);
    record.downloadLinks = links;
    await putCase(env.CASES, record);
    if (previousSessionId && previousSessionId !== sessionId && env.STRIPE_SECRET_KEY) {
      try {
        await expirePreviousBalanceSession(env.STRIPE_SECRET_KEY, previousSessionId);
      } catch (err) {
        console.error('Expire leftover balance session failed', err);
      }
    }
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const listed = links
      .map((l) => `${l.filename} ${base}/api/download?token=${encodeURIComponent(l.token)}`)
      .join('\n');
    discordContent = `Balance paid ${record.id} ${record.email} — download tokens minted${listed ? `\n${listed}` : ''}`;
  } else if (
    metaType === 'balance' &&
    (record.status === 'paid_in_full' || record.status === 'delivered')
  ) {
    const pi = paymentIntentId(session.payment_intent);
    if (!pi) return json({ error: 'Missing payment_intent' }, 400);
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
    try {
      await stripeForm(
        env.STRIPE_SECRET_KEY,
        'refunds',
        {
          payment_intent: pi,
          'metadata[caseId]': record.id,
          'metadata[reason]': 'duplicate_balance_checkout',
        },
        { 'Idempotency-Key': `dup-balance:${event.id}` },
      );
    } catch (err) {
      console.error('Duplicate balance refund failed', err);
      return json({ error: 'Duplicate refund failed' }, 500);
    }
    discordContent = `ALERT duplicate balance payment ${record.id} ${record.email} — refunded ${pi} in full`;
  }

  await env.CASES.put(ek, '1', { expirationTtl: STRIPE_EVENT_TTL_SEC });

  if (discordContent) {
    const notify = notifyDiscord(env.DISCORD_WEBHOOK_URL, discordContent).catch((err) => {
      console.error('Discord notify failed', err);
    });
    if (waitUntil) waitUntil(notify);
  }

  return json({ received: true });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const { request, env, waitUntil } = context;
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, 500);
  }
  const rawBody = await request.text();
  return processStripeWebhook(
    rawBody,
    request.headers.get('stripe-signature'),
    env,
    Math.floor(Date.now() / 1000),
    waitUntil,
  );
}
