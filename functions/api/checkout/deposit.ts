import type { Env } from '../../lib/env';
import { newCaseId, putCase, type CaseRecord } from '../../lib/cases';
import { clientIp, emailRateLimitKey, enforceLimit } from '../../lib/rate-limit';
import { depositCheckoutFields, stripeForm } from '../../lib/stripe';

const NAME_MAX = 200;
const EMAIL_MAX = 254;
const NOTES_MAX = 4000;
const SERVICE_MAX = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DepositInput = {
  name: string;
  email: string;
  notes: string;
  service: string;
};

export function validateDepositInput(
  body: unknown,
): { ok: true; value: DepositInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  const service = typeof b.service === 'string' ? b.service.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: `Name must be 1–${NAME_MAX} characters` };
  }
  if (email.length < 3 || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Valid email is required' };
  }
  if (notes.length > NOTES_MAX) {
    return { ok: false, error: `Notes must be at most ${NOTES_MAX} characters` };
  }
  if (service.length < 1 || service.length > SERVICE_MAX) {
    return { ok: false, error: `Service must be 1–${SERVICE_MAX} characters` };
  }
  return { ok: true, value: { name, email, notes, service } };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function processDeposit(
  request: Request,
  env: Pick<Env, 'CASES' | 'STRIPE_SECRET_KEY' | 'PUBLIC_BASE_URL'>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const parsed = validateDepositInput(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const blocked = await enforceLimit(env.CASES, 'deposit', clientIp(request), [
    emailRateLimitKey('deposit', parsed.value.email),
  ]);
  if (blocked) return blocked;

  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
  if (!env.PUBLIC_BASE_URL) return json({ error: 'PUBLIC_BASE_URL is not configured' }, 500);

  const id = newCaseId();
  const record: CaseRecord = {
    id,
    email: parsed.value.email,
    name: parsed.value.name,
    notes: parsed.value.notes,
    service: parsed.value.service,
    status: 'draft',
    stripeDepositPi: null,
    stripeBalancePi: null,
    createdAt: new Date().toISOString(),
  };
  await putCase(env.CASES, record);

  try {
    const session = (await stripeForm(
      env.STRIPE_SECRET_KEY,
      'checkout/sessions',
      depositCheckoutFields({
        caseId: id,
        email: parsed.value.email,
        publicBaseUrl: env.PUBLIC_BASE_URL,
      }),
    )) as { url?: string };
    if (!session.url) throw new Error('Stripe session missing url');
    return json({ url: session.url, caseId: id });
  } catch (err) {
    console.error('Stripe checkout failed', err);
    return json({ error: 'Checkout failed' }, 502);
  }
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  return processDeposit(context.request, context.env);
}
