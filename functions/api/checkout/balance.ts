import type { Env } from '../../lib/env';
import { getCase, type CaseRecord } from '../../lib/cases';
import { opsAuthorized } from '../../lib/opsAuth';
import { commitIssuedBalanceCheckout, createBalanceCheckout } from '../../lib/stripe';

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
  if (!(await opsAuthorized(request, env))) return json({ error: 'Unauthorized' }, 401);
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
    const session = await createBalanceCheckout(
      env.STRIPE_SECRET_KEY,
      {
        caseId: record.id,
        email: record.email,
        publicBaseUrl: env.PUBLIC_BASE_URL,
      },
      record.stripeBalanceSessionId,
    );
    const result = await commitIssuedBalanceCheckout(env.CASES, env.STRIPE_SECRET_KEY, record, session);
    if (!result.ok) {
      return json({ error: 'Case already paid in full', case: { id: result.record.id, status: result.record.status } }, 409);
    }
    return json({ url: session.url, caseId: result.record.id, status: result.record.status });
  } catch (err) {
    console.error('Stripe balance checkout failed', err);
    return json({ error: 'Checkout failed' }, 502);
  }
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  return processBalanceCheckout(context.request, context.env);
}
