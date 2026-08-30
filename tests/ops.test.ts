import { describe, it, expect } from 'vitest';
import { processOpsCases } from '../functions/api/ops/cases';
import { getCase, putCase, type CaseRecord } from '../functions/lib/cases';
import { issueOpsSession } from '../functions/lib/opsAuth';
import { DECLINE_REFUND_CENTS } from '../functions/lib/stripe';
import { parseDownloadTokenPayload, tokenKey } from '../functions/lib/tokens';

const caseId = '33333333-3333-4333-8333-333333333333';
const OPS = 'ops-secret';

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

function memoryR2() {
  const objects = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  return {
    objects,
    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      let body: ArrayBuffer;
      if (typeof value === 'string') {
        body = new TextEncoder().encode(value).buffer;
      } else if (value instanceof ArrayBuffer) {
        body = value;
      } else {
        body = (value.buffer as ArrayBuffer).slice(value.byteOffset, value.byteOffset + value.byteLength);
      }
      objects.set(key, { body, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: obj.body,
        httpMetadata: { contentType: obj.contentType },
        async arrayBuffer() {
          return obj.body;
        },
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function wavHeader(dataBytes = 100): ArrayBuffer {
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const enc = new TextEncoder();
  enc.encodeInto('RIFF', new Uint8Array(buf, 0, 4));
  v.setUint32(4, 36 + dataBytes, true);
  enc.encodeInto('WAVE', new Uint8Array(buf, 8, 4));
  enc.encodeInto('fmt ', new Uint8Array(buf, 12, 4));
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 2 * 2, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  enc.encodeInto('data', new Uint8Array(buf, 36, 4));
  v.setUint32(40, dataBytes, true);
  return buf;
}

function uploadedCase(): CaseRecord {
  return {
    id: caseId,
    email: 'artist@example.com',
    name: 'Ada',
    notes: 'sibilance',
    service: 'Rush vocal cleanup',
    status: 'uploaded',
    stripeDepositPi: 'pi_deposit_1',
    stripeBalancePi: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    r2Key: `cases/${caseId}/source.wav`,
  };
}

function envFor(kv: ReturnType<typeof memoryKv>, r2: ReturnType<typeof memoryR2>) {
  return {
    CASES: kv as unknown as KVNamespace,
    AUDIO: r2 as unknown as R2Bucket,
    OPS_PASSWORD: OPS,
    STRIPE_SECRET_KEY: 'sk_test_x',
    PUBLIC_BASE_URL: 'http://localhost:8788',
    DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
  };
}

async function postOps(opts: {
  kv: ReturnType<typeof memoryKv>;
  r2?: ReturnType<typeof memoryR2>;
  body?: unknown;
  form?: FormData;
  auth?: string | null;
  cookie?: string;
  stripe?: (url: string, init?: RequestInit) => Promise<Response>;
  discord?: string[];
  waitUntil?: (p: Promise<unknown>) => void;
}): Promise<Response> {
  const r2 = opts.r2 ?? memoryR2();
  const headers: Record<string, string> = {};
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  } else if (opts.auth === undefined) {
    const token = await issueOpsSession(opts.kv as unknown as KVNamespace);
    headers.Cookie = `ops_session=${token}`;
  } else if (opts.auth !== null) {
    headers.Authorization = `Bearer ${opts.auth}`;
  }
  if (!opts.form) headers['content-type'] = 'application/json';

  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('discord')) {
      opts.discord?.push(String(init?.body ?? ''));
      return new Response(null, { status: 204 });
    }
    if (opts.stripe) return opts.stripe(u, init);
    return new Response(JSON.stringify({ id: 'cs_bal', url: 'https://checkout.stripe.com/c/pay/cs_bal' }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    return await processOpsCases(
      new Request('http://localhost/api/ops/cases', {
        method: 'POST',
        headers,
        body: opts.form ?? JSON.stringify(opts.body ?? { action: 'list' }),
      }),
      envFor(opts.kv, r2),
      opts.waitUntil,
    );
  } finally {
    globalThis.fetch = orig;
  }
}

describe('POST /api/ops/cases', () => {
  it('rejects missing auth', async () => {
    const kv = memoryKv();
    const res = await postOps({ kv, auth: null, body: { action: 'list' } });
    expect(res.status).toBe(401);
  });

  it('login sets ops_session cookie (not the password) and cookie auth lists cases', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const login = await postOps({ kv, auth: null, body: { action: 'login', password: OPS } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('ops_session=');
    expect(setCookie).not.toContain(OPS);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('secure');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');

    const listed = await postOps({
      kv,
      auth: null,
      cookie: setCookie.split(';')[0],
      body: { action: 'list' },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { cases: Array<{ id: string; status: string }> };
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0].id).toBe(caseId);
    expect(body.cases[0].status).toBe('uploaded');
  });

  it('rejects Bearer OPS_PASSWORD and accepts a Bearer session token', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const withPassword = await postOps({ kv, auth: OPS, body: { action: 'list' } });
    expect(withPassword.status).toBe(401);

    const token = await issueOpsSession(kv as unknown as KVNamespace);
    const withSession = await postOps({ kv, auth: token, body: { action: 'list' } });
    expect(withSession.status).toBe(200);
  });

  it('declines with a 1450 refund, marks declined, notifies Discord', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const stripeCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const discord: string[] = [];
    const pending: Promise<unknown>[] = [];
    const res = await postOps({
      kv,
      body: { action: 'decline', caseId, note: 'not a fit' },
      discord,
      waitUntil: (p) => pending.push(p),
      stripe: async (url, init) => {
        stripeCalls.push({
          url,
          body: String(init?.body ?? ''),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(JSON.stringify({ id: 're_1' }), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(stripeCalls[0].url).toBe('https://api.stripe.com/v1/refunds');
    expect(stripeCalls[0].body).toContain(`amount=${DECLINE_REFUND_CENTS}`);
    expect(stripeCalls[0].body).toContain('payment_intent=pi_deposit_1');
    expect(stripeCalls[0].body).toContain('not_a_fit_review_fee_kept');
    expect(stripeCalls[0].headers['Idempotency-Key']).toBe(`decline:${caseId}`);
    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    expect(rec?.status).toBe('declined');
    expect(rec?.declineNote).toBe('not a fit');
    expect(discord.join('')).toContain(`Declined ${caseId} artist@example.com`);
    expect(discord.join('')).toContain('$14.50');
  });

  it('does not refund twice on a second decline', async () => {
    const kv = memoryKv();
    const rec = uploadedCase();
    rec.status = 'declined';
    await putCase(kv as unknown as KVNamespace, rec);
    let stripeHits = 0;
    const res = await postOps({
      kv,
      body: { action: 'decline', caseId },
      stripe: async () => {
        stripeHits += 1;
        return new Response(JSON.stringify({ id: 're_2' }), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(stripeHits).toBe(0);
    expect(((await res.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('returns generic 502 on refund failure without Stripe body', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await postOps({
        kv,
        body: { action: 'decline', caseId },
        stripe: async () =>
          new Response(JSON.stringify({ error: { message: 'sk_test_leaked_secret_xyz' } }), { status: 400 }),
      });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain('sk_test');
      expect(JSON.parse(text)).toEqual({ error: 'Refund failed' });
      expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('uploaded');
    } finally {
      console.error = origErr;
    }
  });

  it('mark_rescued puts rescue objects, sets balance_due, creates balance Checkout', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const discord: string[] = [];
    const pending: Promise<unknown>[] = [];
    const form = new FormData();
    form.set('action', 'mark_rescued');
    form.set('caseId', caseId);
    form.set('notes', 'low end is tighter');
    form.append('wav', new File([new Uint8Array(wavHeader())], 'rescue.wav', { type: 'audio/wav' }));

    const res = await postOps({
      kv,
      r2,
      form,
      discord,
      waitUntil: (p) => pending.push(p),
    });
    expect(res.status).toBe(200);
    await Promise.all(pending);
    const body = (await res.json()) as { url: string; case: { status: string } };
    expect(body.case.status).toBe('balance_due');
    expect(body.url).toContain('checkout.stripe.com');
    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    expect(rec?.status).toBe('balance_due');
    expect(rec?.r2RescueWav).toBe(`cases/${caseId}/rescue.wav`);
    expect(rec?.r2Notes).toBe(`cases/${caseId}/notes.txt`);
    expect(r2.objects.get(`cases/${caseId}/rescue.wav`)?.contentType).toBe('audio/wav');
    expect(rec?.stripeBalanceSessionId).toBe('cs_bal');
    expect(discord.join('')).toContain(`Rescued ${caseId} artist@example.com`);
    expect(discord.join('')).toContain('$19.50');
  });

  it('expires a previous open balance session before creating another', async () => {
    const kv = memoryKv();
    const rec = uploadedCase();
    rec.status = 'balance_due';
    rec.stripeBalanceSessionId = 'cs_old';
    rec.balanceCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_old';
    await putCase(kv as unknown as KVNamespace, rec);
    const calls: string[] = [];
    const res = await postOps({
      kv,
      body: { action: 'mark_rescued', caseId },
      stripe: async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const u = String(url);
        if (u.endsWith('/expire')) {
          return new Response(JSON.stringify({ id: 'cs_old', status: 'expired' }), { status: 200 });
        }
        if (u.includes('/checkout/sessions/cs_old')) {
          return new Response(
            JSON.stringify({ id: 'cs_old', status: 'open', payment_status: 'unpaid' }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' }),
          { status: 200 },
        );
      },
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.includes('/checkout/sessions/cs_old') && !c.includes('/expire'))).toBe(
      true,
    );
    expect(calls.some((c) => c.includes('/checkout/sessions/cs_old/expire'))).toBe(true);
    const updated = await getCase(kv as unknown as KVNamespace, caseId);
    expect(updated?.stripeBalanceSessionId).toBe('cs_new');
    expect(updated?.balanceCheckoutUrl).toContain('cs_new');
  });

  it('does not create a new balance session if the previous one is already paid', async () => {
    const kv = memoryKv();
    const rec = uploadedCase();
    rec.status = 'balance_due';
    rec.stripeBalanceSessionId = 'cs_paid';
    await putCase(kv as unknown as KVNamespace, rec);
    let created = 0;
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await postOps({
        kv,
        body: { action: 'mark_rescued', caseId },
        stripe: async (url) => {
          const u = String(url);
          if (u.includes('/checkout/sessions/cs_paid')) {
            return new Response(
              JSON.stringify({ id: 'cs_paid', status: 'complete', payment_status: 'paid' }),
              { status: 200 },
            );
          }
          if (u.endsWith('/checkout/sessions')) created += 1;
          return new Response(JSON.stringify({ id: 'cs_new', url: 'https://checkout.stripe.com/x' }), {
            status: 200,
          });
        },
      });
      expect(res.status).toBe(502);
      expect(created).toBe(0);
      expect((await getCase(kv as unknown as KVNamespace, caseId))?.stripeBalanceSessionId).toBe('cs_paid');
    } finally {
      console.error = origErr;
    }
  });

  it('does not create a new session if expire fails because the previous session completed', async () => {
    const kv = memoryKv();
    const rec = uploadedCase();
    rec.status = 'balance_due';
    rec.stripeBalanceSessionId = 'cs_old';
    await putCase(kv as unknown as KVNamespace, rec);
    let created = 0;
    let gets = 0;
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await postOps({
        kv,
        body: { action: 'mark_rescued', caseId },
        stripe: async (url) => {
          const u = String(url);
          if (u.endsWith('/expire')) {
            return new Response(
              JSON.stringify({
                error: { message: 'A Checkout Session can only be expired if it is in the open state.' },
              }),
              { status: 400 },
            );
          }
          if (u.includes('/checkout/sessions/cs_old')) {
            gets += 1;
            if (gets === 1) {
              return new Response(
                JSON.stringify({ id: 'cs_old', status: 'open', payment_status: 'unpaid' }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({ id: 'cs_old', status: 'complete', payment_status: 'paid' }),
              { status: 200 },
            );
          }
          if (u.endsWith('/checkout/sessions')) created += 1;
          return new Response(JSON.stringify({ id: 'cs_new', url: 'https://checkout.stripe.com/x' }), {
            status: 200,
          });
        },
      });
      expect(res.status).toBe(502);
      expect(created).toBe(0);
      expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('balance_due');
    } finally {
      console.error = origErr;
    }
  });

  it('source_url mints an ops download token', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, uploadedCase());
    const res = await postOps({ kv, body: { action: 'source_url', caseId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^\/api\/download\?token=/);
    const token = new URL(body.url, 'http://localhost').searchParams.get('token') || '';
    const raw = await kv.get(tokenKey('download', token));
    const payload = parseDownloadTokenPayload(raw);
    expect(payload?.ops).toBe(true);
    expect(payload?.r2Key).toBe(`cases/${caseId}/source.wav`);
  });

  it('rejects a wrong password', async () => {
    const kv = memoryKv();
    const res = await postOps({ kv, auth: 'nope', body: { action: 'list' } });
    expect(res.status).toBe(401);
  });

  it('rejects login with a wrong password', async () => {
    const kv = memoryKv();
    const res = await postOps({ kv, auth: null, body: { action: 'login', password: 'nope' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});
