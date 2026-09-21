import type { Env } from '../../lib/env';
import { getCase, putCase } from '../../lib/cases';
import { notifyDiscord } from '../../lib/discord';
import { clientIp, enforceLimit } from '../../lib/rate-limit';
import { stripeGet } from '../../lib/stripe';
import { liveOrMintUploadToken, UPLOAD_TOKEN_TTL_SEC } from '../../lib/tokens';

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

function acceptsUpload(status: string): boolean {
  return status === 'deposited' || status === 'invalid_file';
}

export async function processUploadClaim(
  request: Request,
  env: Pick<Env, 'CASES' | 'STRIPE_SECRET_KEY' | 'DISCORD_WEBHOOK_URL' | 'PUBLIC_BASE_URL'>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
  const blocked = await enforceLimit(env.CASES, 'claim', clientIp(request));
  if (blocked) return blocked;

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get('session_id') || '').trim();
  const caseParam = (url.searchParams.get('case') || '').trim();
  if (!sessionId) return json({ error: 'Missing session_id' }, 400);

  let session: {
    status?: string;
    payment_status?: string;
    payment_intent?: unknown;
    metadata?: Record<string, unknown>;
  };
  try {
    session = (await stripeGet(
      env.STRIPE_SECRET_KEY,
      `checkout/sessions/${encodeURIComponent(sessionId)}`,
    )) as typeof session;
  } catch (err) {
    console.error('Stripe session retrieve failed', err);
    return json({ error: 'Checkout lookup failed' }, 502);
  }

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (metadata.type !== 'deposit' || typeof metadata.caseId !== 'string' || !metadata.caseId) {
    return json({ error: 'Invalid checkout session' }, 403);
  }
  if (caseParam && caseParam !== metadata.caseId) {
    return json({ error: 'Invalid checkout session' }, 403);
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return json(
      { error: 'Deposit required to upload', status: session.payment_status || session.status },
      402,
    );
  }

  const record = await getCase(env.CASES, metadata.caseId);
  if (!record) return json({ error: 'Unknown case' }, 404);

  if (record.status === 'draft') {
    record.status = 'deposited';
    record.stripeDepositPi = paymentIntentId(session.payment_intent) ?? record.stripeDepositPi;
  }
  if (!acceptsUpload(record.status)) {
    return json({ error: 'Case is not accepting uploads', status: record.status }, 409);
  }

  const { token, minted } = await liveOrMintUploadToken(env.CASES, record, UPLOAD_TOKEN_TTL_SEC);
  await putCase(env.CASES, record);

  if (minted) {
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const uploadUrl = `${base}/upload.html?case=${encodeURIComponent(record.id)}&token=${encodeURIComponent(token)}`;
    const discordContent = `New deposit ${record.id} ${record.email} — upload token minted\n${uploadUrl}`;
    const notify = notifyDiscord(env.DISCORD_WEBHOOK_URL, discordContent).catch((err) => {
      console.error('Discord notify failed', err);
    });
    if (waitUntil) waitUntil(notify);
  }

  return json({ caseId: record.id, status: record.status, token });
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  return processUploadClaim(context.request, context.env, context.waitUntil);
}
