import type { Env } from '../../lib/env';
import { getCase, putCase, type CaseRecord } from '../../lib/cases';
import { opsAuthorized } from '../../lib/opsAuth';
import { createBalanceCheckout } from '../../lib/stripe';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BALANCE_OK: ReadonlySet<CaseRecord['status']> = new Set(['rescued', 'balance_due']);

export async function processBalanceCheckout(
  request: Request,
  env: Pick<Env, 'CASES' | 'STRIPE_SECRET_KEY' | 'PUBLIC_BASE_URL' | 'OPS_PASSWORD'>,
): Promise<Response> {
  if (!env.OPS_PASSWORD) return json({ error: 'OPS_PASSWORD is not configured' }, 500);
  if (!opsAuthorized(request, env.OPS_PASSWORD)) return json({ error: 'Unauthorized' }, 401);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
  if (!env.PUBLIC_BASE_URL) return json({ error: 'PUBLIC_BASE_URL is not configured' }, 500);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const caseId =
    body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { caseId?: unknown }).caseId === 'string'
      ? (body as { caseId: string }).caseId.trim()
      : '';
  if (!caseId) return json({ error: 'caseId is required' }, 400);

  const record = await getCase(env.CASES, caseId);
  if (!record) return json({ error: 'Unknown case' }, 400);
  if (!BALANCE_OK.has(record.status)) {
    return json({ error: 'Case is not ready for balance checkout' }, 409);
  }

  try {
    const { url } = await createBalanceCheckout(env.STRIPE_SECRET_KEY, {
      caseId: record.id,
      email: record.email,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
    record.balanceCheckoutUrl = url;
    if (record.status === 'rescued') record.status = 'balance_due';
    await putCase(env.CASES, record);
    return json({ url, caseId: record.id, status: record.status });
  } catch (err) {
    console.error('Stripe balance checkout failed', err);
    return json({ error: 'Checkout failed' }, 502);
  }
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  return processBalanceCheckout(context.request, context.env);
}
