import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  BALANCE_AMOUNT_CENTS,
  DEPOSIT_AMOUNT_CENTS,
  DECLINE_KEEP_CENTS,
  DECLINE_REFUND_CENTS,
  balanceCheckoutFields,
  declineRefundFields,
  depositCheckoutFields,
  stripeForm,
  stripeEventKey,
  verifyStripeSignature,
} from '../functions/lib/stripe';
import { onRequestPost as onDepositPost, validateDepositInput } from '../functions/api/checkout/deposit';
import { processStripeWebhook } from '../functions/api/webhooks/stripe';
import { caseKey, getCase, putCase, type CaseRecord } from '../functions/lib/cases';
import { tokenKey } from '../functions/lib/tokens';

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? '';
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true as const };
    },
  };
}

function sign(payload: string, secret: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const secret = 'whsec_test_secret';

describe('depositCheckoutFields', () => {
  it('charges 1950 cents USD with deposit metadata', () => {
    const fields = depositCheckoutFields({
      caseId: 'case-1',
      email: 'a@b.co',
      publicBaseUrl: 'http://localhost:8788/',
    });
    expect(fields['line_items[0][price_data][unit_amount]']).toBe('1950');
    expect(DEPOSIT_AMOUNT_CENTS).toBe(1950);
    expect(fields['line_items[0][price_data][currency]']).toBe('usd');
    expect(fields.mode).toBe('payment');
    expect(fields['metadata[type]']).toBe('deposit');
    expect(fields['metadata[caseId]']).toBe('case-1');
    expect(fields.customer_email).toBe('a@b.co');
    expect(fields.success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
    expect(fields.success_url).toContain('case=case-1');
    expect(fields.cancel_url).toBe('http://localhost:8788/');
  });
});

describe('balanceCheckoutFields + decline refund', () => {
  it('charges 1950 cents USD with balance metadata and thanks success url', () => {
    const fields = balanceCheckoutFields({
      caseId: 'case-1',
      email: 'a@b.co',
      publicBaseUrl: 'http://localhost:8788/',
    });
    expect(BALANCE_AMOUNT_CENTS).toBe(1950);
    expect(fields['line_items[0][price_data][unit_amount]']).toBe('1950');
    expect(fields['line_items[0][price_data][currency]']).toBe('usd');
    expect(fields['metadata[type]']).toBe('balance');
    expect(fields['metadata[caseId]']).toBe('case-1');
    expect(fields.success_url).toContain('/thanks.html?case=case-1');
    expect(fields.success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
  });

  it('refunds 1450 cents and keeps 500', () => {
    expect(DECLINE_REFUND_CENTS).toBe(1450);
    expect(DECLINE_KEEP_CENTS).toBe(500);
    expect(DEPOSIT_AMOUNT_CENTS - DECLINE_REFUND_CENTS).toBe(DECLINE_KEEP_CENTS);
    const fields = declineRefundFields({ paymentIntentId: 'pi_deposit_1', caseId: 'case-1' });
    expect(fields.amount).toBe('1450');
    expect(fields.payment_intent).toBe('pi_deposit_1');
    expect(fields.reason).toBe('requested_by_customer');
    expect(fields['metadata[reason]']).toBe('not_a_fit_review_fee_kept');
  });
});

describe('validateDepositInput', () => {
  it('accepts name, email, notes, service', () => {
    const r = validateDepositInput({
      name: ' Ada ',
      email: 'ada@example.com',
      notes: 'clipped vocal',
      service: 'Rush vocal cleanup',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Ada');
      expect(r.value.email).toBe('ada@example.com');
    }
  });

  it('rejects missing name and bad email', () => {
    expect(validateDepositInput({ name: '', email: 'ada@example.com', service: 'x' }).ok).toBe(
      false,
    );
    expect(validateDepositInput({ name: 'Ada', email: 'not-an-email', service: 'x' }).ok).toBe(
      false,
    );
  });
});

describe('stripeForm', () => {
  it('POSTs form-urlencoded with Bearer secret', async () => {
    const orig = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const out = await stripeForm('sk_test_x', 'checkout/sessions', { mode: 'payment' });
      expect(out).toEqual({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' });
      expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk_test_x');
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(calls[0].init.body).toBeInstanceOf(URLSearchParams);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('POST /api/checkout/deposit errors', () => {
  it('returns a generic 502 and does not proxy Stripe’s body', async () => {
    const orig = globalThis.fetch;
    const origErr = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Invalid API Key provided: sk_test_leaked_secret_xyz',
            type: 'invalid_request_error',
          },
        }),
        { status: 401 },
      )) as typeof fetch;
    try {
      const kv = memoryKv();
      const res = await onDepositPost({
        request: new Request('http://localhost/api/checkout/deposit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Ada',
            email: 'ada@example.com',
            notes: 'n',
            service: 'Rush vocal cleanup',
          }),
        }),
        env: {
          CASES: kv as unknown as KVNamespace,
          STRIPE_SECRET_KEY: 'sk_test_leaked_secret_xyz',
          PUBLIC_BASE_URL: 'http://localhost:8788',
        } as import('../functions/lib/env').Env,
      });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain('sk_test');
      expect(text).not.toContain('leaked_secret');
      expect(JSON.parse(text)).toEqual({ error: 'Checkout failed' });
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = orig;
      console.error = origErr;
    }
  });
});

describe('verifyStripeSignature', () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const t = 1_700_000_000;

  it('accepts a valid v1 HMAC', async () => {
    const r = await verifyStripeSignature(payload, sign(payload, secret, t), secret, t);
    expect(r.ok).toBe(true);
  });

  it('rejects a bad signature', async () => {
    const r = await verifyStripeSignature(payload, `t=${t},v1=${'ab'.repeat(32)}`, secret, t);
    expect(r.ok).toBe(false);
  });

  it('rejects timestamp skew over 300s', async () => {
    const r = await verifyStripeSignature(payload, sign(payload, secret, t), secret, t + 301);
    expect(r.ok).toBe(false);
  });
});

describe('processStripeWebhook deposit', () => {
  const caseId = '11111111-1111-4111-8111-111111111111';
  const eventId = 'evt_deposit_1';
  const now = 1_700_000_000;

  function draftCase(): CaseRecord {
    return {
      id: caseId,
      email: 'artist@example.com',
      name: 'Ada',
      notes: 'sibilance',
      service: 'Rush vocal cleanup',
      status: 'draft',
      stripeDepositPi: null,
      stripeBalancePi: null,
      createdAt: '2026-08-29T00:00:00.000Z',
    };
  }

  function depositEvent(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          payment_intent: 'pi_deposit_1',
          metadata: { type: 'deposit', caseId },
          ...overrides,
        },
      },
    });
  }

  it('marks deposited, stores PI, mints upload token, is idempotent', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, draftCase());
    const discord: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      discord.push(String(init?.body ?? ''));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const payload = depositEvent();
      const env = {
        CASES: kv as unknown as KVNamespace,
        STRIPE_WEBHOOK_SECRET: secret,
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        PUBLIC_BASE_URL: 'http://localhost:8788',
      };

      const pending: Promise<unknown>[] = [];
      const first = await processStripeWebhook(
        payload,
        sign(payload, secret, now),
        env,
        now,
        (p) => pending.push(p),
      );
      expect(first.status).toBe(200);
      expect(await kv.get(stripeEventKey(eventId))).toBe('1');
      await Promise.all(pending);

      const rec = await getCase(env.CASES, caseId);
      expect(rec?.status).toBe('deposited');
      expect(rec?.stripeDepositPi).toBe('pi_deposit_1');

      const tokEntries = [...kv.data.entries()].filter(([k]) =>
        k.startsWith(tokenKey('upload', '')),
      );
      expect(tokEntries).toHaveLength(1);
      expect(tokEntries[0][1]).toBe(caseId);
      expect(discord.join('')).toContain(`New deposit ${caseId} artist@example.com`);
      expect(discord.join('')).toContain('upload.html?');

      const second = await processStripeWebhook(payload, sign(payload, secret, now), env, now);
      expect(second.status).toBe(200);
      const tokAfter = [...kv.data.entries()].filter(([k]) => k.startsWith('tok:upload:'));
      expect(tokAfter).toHaveLength(1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('ignores non-deposit checkout completion', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, draftCase());
    const payload = depositEvent({ metadata: { type: 'balance', caseId } });
    const env = {
      CASES: kv as unknown as KVNamespace,
      STRIPE_WEBHOOK_SECRET: secret,
      PUBLIC_BASE_URL: 'http://localhost:8788',
    };
    const res = await processStripeWebhook(payload, sign(payload, secret, now), env, now);
    expect(res.status).toBe(200);
    expect((await getCase(env.CASES, caseId))?.status).toBe('draft');
    expect(await kv.get(caseKey(caseId))).toBeTruthy();
  });

  it('writes event:{id} before Discord so a hung notify cannot remint', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, draftCase());
    const orig = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    try {
      const payload = depositEvent();
      const env = {
        CASES: kv as unknown as KVNamespace,
        STRIPE_WEBHOOK_SECRET: secret,
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        PUBLIC_BASE_URL: 'http://localhost:8788',
      };
      const first = await processStripeWebhook(payload, sign(payload, secret, now), env, now);
      expect(first.status).toBe(200);
      expect(await kv.get(stripeEventKey(eventId))).toBe('1');
      expect([...kv.data.keys()].filter((k) => k.startsWith('tok:upload:'))).toHaveLength(1);

      const second = await processStripeWebhook(payload, sign(payload, secret, now), env, now);
      expect(second.status).toBe(200);
      expect([...kv.data.keys()].filter((k) => k.startsWith('tok:upload:'))).toHaveLength(1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('processStripeWebhook balance', () => {
  const caseId = '11111111-1111-4111-8111-111111111111';
  const eventId = 'evt_balance_1';
  const now = 1_700_000_000;

  function rescuedCase(): CaseRecord {
    return {
      id: caseId,
      email: 'artist@example.com',
      name: 'Ada',
      notes: 'sibilance',
      service: 'Rush vocal cleanup',
      status: 'balance_due',
      stripeDepositPi: 'pi_deposit_1',
      stripeBalancePi: null,
      createdAt: '2026-08-29T00:00:00.000Z',
      r2Key: `cases/${caseId}/source.wav`,
      r2RescueWav: `cases/${caseId}/rescue.wav`,
      r2Notes: `cases/${caseId}/notes.txt`,
    };
  }

  function balanceEvent() {
    return JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_bal_1',
          payment_intent: 'pi_balance_1',
          metadata: { type: 'balance', caseId },
        },
      },
    });
  }

  it('marks paid_in_full, stores PI, mints download tokens, is idempotent', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, rescuedCase());
    const discord: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      discord.push(String(init?.body ?? ''));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const payload = balanceEvent();
      const env = {
        CASES: kv as unknown as KVNamespace,
        STRIPE_WEBHOOK_SECRET: secret,
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        PUBLIC_BASE_URL: 'http://localhost:8788',
      };
      const pending: Promise<unknown>[] = [];
      const first = await processStripeWebhook(
        payload,
        sign(payload, secret, now),
        env,
        now,
        (p) => pending.push(p),
      );
      expect(first.status).toBe(200);
      await Promise.all(pending);

      const rec = await getCase(env.CASES, caseId);
      expect(rec?.status).toBe('paid_in_full');
      expect(rec?.stripeBalancePi).toBe('pi_balance_1');
      expect(rec?.downloadLinks?.length).toBe(3);
      const tok = [...kv.data.entries()].filter(([k]) => k.startsWith('tok:download:'));
      expect(tok).toHaveLength(3);
      expect(discord.join('')).toContain(`Balance paid ${caseId} artist@example.com`);
      expect(discord.join('')).toContain('/api/download?token=');

      const second = await processStripeWebhook(payload, sign(payload, secret, now), env, now);
      expect(second.status).toBe(200);
      expect([...kv.data.keys()].filter((k) => k.startsWith('tok:download:'))).toHaveLength(3);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('refunds a duplicate balance payment in full and does not remint', async () => {
    const kv = memoryKv();
    const rec = rescuedCase();
    rec.status = 'paid_in_full';
    rec.stripeBalancePi = 'pi_balance_1';
    rec.downloadLinks = [];
    await putCase(kv as unknown as KVNamespace, rec);
    const discord: string[] = [];
    const stripeCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('discord')) {
        discord.push(String(init?.body ?? ''));
        return new Response(null, { status: 204 });
      }
      stripeCalls.push({
        url: u,
        body: String(init?.body ?? ''),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ id: 're_dup' }), { status: 200 });
    }) as typeof fetch;
    try {
      const payload = JSON.stringify({
        id: 'evt_balance_dup',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_bal_2',
            payment_intent: 'pi_balance_2',
            metadata: { type: 'balance', caseId },
          },
        },
      });
      const env = {
        CASES: kv as unknown as KVNamespace,
        STRIPE_WEBHOOK_SECRET: secret,
        STRIPE_SECRET_KEY: 'sk_test_x',
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        PUBLIC_BASE_URL: 'http://localhost:8788',
      };
      const pending: Promise<unknown>[] = [];
      const res = await processStripeWebhook(
        payload,
        sign(payload, secret, now),
        env,
        now,
        (p) => pending.push(p),
      );
      expect(res.status).toBe(200);
      await Promise.all(pending);
      expect(stripeCalls[0].url).toBe('https://api.stripe.com/v1/refunds');
      expect(stripeCalls[0].body).toContain('payment_intent=pi_balance_2');
      expect(stripeCalls[0].body).not.toContain('amount=');
      expect(stripeCalls[0].headers['Idempotency-Key']).toBe('dup-balance:evt_balance_dup');
      expect((await getCase(env.CASES, caseId))?.status).toBe('paid_in_full');
      expect([...kv.data.keys()].filter((k) => k.startsWith('tok:download:'))).toHaveLength(0);
      expect(discord.join('')).toContain('ALERT duplicate balance payment');
      expect(discord.join('')).toContain('pi_balance_2');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
