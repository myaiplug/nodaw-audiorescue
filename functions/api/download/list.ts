import type { Env } from '../../lib/env';
import { getCase, putCase } from '../../lib/cases';
import { stripeGet } from '../../lib/stripe';
import {
  DOWNLOAD_TOKEN_TTL_SEC,
  mintDownloadLinks,
  peekToken,
} from '../../lib/tokens';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function paidStatus(status: string): boolean {
  return status === 'paid_in_full' || status === 'delivered';
}

function downloadUrl(token: string): string {
  return `/api/download?token=${encodeURIComponent(token)}`;
}

export async function processDownloadList(
  request: Request,
  env: Pick<Env, 'CASES' | 'STRIPE_SECRET_KEY'>,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
  const sessionId = (new URL(request.url).searchParams.get('session_id') || '').trim();
  if (!sessionId) return json({ error: 'Missing session_id' }, 400);

  let session: {
    status?: string;
    payment_status?: string;
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
  if (metadata.type !== 'balance' || typeof metadata.caseId !== 'string' || !metadata.caseId) {
    return json({ error: 'Invalid checkout session' }, 403);
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return json({ error: 'Balance required to download', status: session.payment_status || session.status }, 402);
  }

  const record = await getCase(env.CASES, metadata.caseId);
  if (!record) return json({ error: 'Unknown case' }, 404);
  if (!paidStatus(record.status)) {
    return json({ error: 'Balance required to download', status: record.status }, 402);
  }

  const live = [];
  for (const l of record.downloadLinks ?? []) {
    if (await peekToken(env.CASES, 'download', l.token)) live.push(l);
  }
  if (live.length === 0) {
    record.downloadLinks = await mintDownloadLinks(env.CASES, record, DOWNLOAD_TOKEN_TTL_SEC);
    await putCase(env.CASES, record);
  }

  const links = (live.length > 0 ? live : record.downloadLinks ?? []).map((l) => ({
    kind: l.kind,
    filename: l.filename,
    url: downloadUrl(l.token),
  }));
  return json({ caseId: record.id, status: record.status, links });
}

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  return processDownloadList(context.request, context.env);
}
