import { describe, it, expect } from 'vitest';
import { processDownload } from '../functions/api/download';
import { processDownloadList } from '../functions/api/download/list';
import { putCase, type CaseRecord } from '../functions/lib/cases';
import { mintDownloadLinks, mintToken, tokenKey } from '../functions/lib/tokens';

const caseId = '44444444-4444-4444-8444-444444444444';

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
    async list(opts?: { prefix?: string }) {
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
  };
}

function paidCase(): CaseRecord {
  return {
    id: caseId,
    email: 'artist@example.com',
    name: 'Ada',
    notes: 'sibilance',
    service: 'Rush vocal cleanup',
    status: 'paid_in_full',
    stripeDepositPi: 'pi_deposit_1',
    stripeBalancePi: 'pi_balance_1',
    stripeBalanceSessionId: 'cs_bal_1',
    createdAt: '2026-08-29T00:00:00.000Z',
    r2Key: `cases/${caseId}/source.wav`,
    r2RescueWav: `cases/${caseId}/rescue.wav`,
    r2Notes: `cases/${caseId}/notes.txt`,
  };
}

describe('GET /api/download', () => {
  it('streams R2 for a valid token on paid_in_full and burns the token', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    const rec = paidCase();
    const bytes = new TextEncoder().encode('RIFF').buffer;
    await r2.put(rec.r2RescueWav!, bytes, { httpMetadata: { contentType: 'audio/wav' } });
    const links = await mintDownloadLinks(kv as unknown as KVNamespace, rec, 3600);
    rec.downloadLinks = links;
    await putCase(kv as unknown as KVNamespace, rec);
    const rescue = links.find((l) => l.filename.endsWith('.wav') && l.kind === 'rescue');
    expect(rescue).toBeTruthy();

    const res = await processDownload(
      new Request(`http://localhost/api/download?token=${rescue!.token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
    expect(res.headers.get('Content-Disposition')).toContain(`${caseId}-rescue.wav`);
    expect(await kv.get(tokenKey('download', rescue!.token))).toBeNull();

    const replay = await processDownload(
      new Request(`http://localhost/api/download?token=${rescue!.token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(replay.status).toBe(401);
  });

  it('returns 402 before balance is paid', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    const rec = paidCase();
    rec.status = 'balance_due';
    const token = await mintToken(
      kv as unknown as KVNamespace,
      'download',
      JSON.stringify({
        caseId,
        r2Key: rec.r2RescueWav,
        filename: 'rescue.wav',
      }),
      3600,
    );
    await putCase(kv as unknown as KVNamespace, rec);
    const res = await processDownload(
      new Request(`http://localhost/api/download?token=${token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'Balance required to download', status: 'balance_due' });
    expect(await kv.get(tokenKey('download', token))).toBe(JSON.stringify({
      caseId,
      r2Key: rec.r2RescueWav,
      filename: 'rescue.wav',
    }));
  });

  it('returns 404 without burning the token when the R2 object is missing', async () => {
    const kv = memoryKv();
    const rec = paidCase();
    const token = await mintToken(
      kv as unknown as KVNamespace,
      'download',
      JSON.stringify({
        caseId,
        r2Key: rec.r2RescueWav,
        filename: 'rescue.wav',
      }),
      3600,
    );
    await putCase(kv as unknown as KVNamespace, rec);
    const res = await processDownload(
      new Request(`http://localhost/api/download?token=${token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: memoryR2() as unknown as R2Bucket },
    );
    expect(res.status).toBe(404);
    expect(await kv.get(tokenKey('download', token))).toBeTruthy();
  });

  it('returns 500 and does not stream if consume fails', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    const rec = paidCase();
    await r2.put(rec.r2RescueWav!, new TextEncoder().encode('RIFF').buffer, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    const token = await mintToken(
      kv as unknown as KVNamespace,
      'download',
      JSON.stringify({
        caseId,
        r2Key: rec.r2RescueWav,
        filename: 'rescue.wav',
      }),
      3600,
    );
    await putCase(kv as unknown as KVNamespace, rec);
    const origDelete = kv.delete.bind(kv);
    kv.delete = async () => {
      throw new Error('kv down');
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await processDownload(
        new Request(`http://localhost/api/download?token=${token}`),
        { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Download failed' });
    } finally {
      kv.delete = origDelete;
      console.error = origErr;
    }
    expect(await kv.get(tokenKey('download', token))).toBeTruthy();
  });

  it('does not remint from a bare case id', async () => {
    const kv = memoryKv();
    const rec = paidCase();
    rec.downloadLinks = await mintDownloadLinks(kv as unknown as KVNamespace, rec, 3600);
    await putCase(kv as unknown as KVNamespace, rec);
    const res = await processDownload(
      new Request(`http://localhost/api/download?case=${caseId}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: memoryR2() as unknown as R2Bucket },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing download token' });
  });

  it('allows ops tokens before paid_in_full', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    const rec = paidCase();
    rec.status = 'uploaded';
    await putCase(kv as unknown as KVNamespace, rec);
    await r2.put(rec.r2Key!, new TextEncoder().encode('src').buffer, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    const token = await mintToken(
      kv as unknown as KVNamespace,
      'download',
      JSON.stringify({
        caseId,
        r2Key: rec.r2Key,
        filename: 'source.wav',
        ops: true,
      }),
      3600,
    );
    const res = await processDownload(
      new Request(`http://localhost/api/download?token=${token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(res.status).toBe(200);
  });

  it('rejects missing token', async () => {
    const res = await processDownload(new Request('http://localhost/api/download'), {
      CASES: memoryKv() as unknown as KVNamespace,
      AUDIO: memoryR2() as unknown as R2Bucket,
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/download/list', () => {
  async function listWithSession(
    kv: ReturnType<typeof memoryKv>,
    session: Record<string, unknown>,
    sessionId = 'cs_bal_1',
  ): Promise<Response> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/checkout/sessions/${sessionId}`);
      return new Response(JSON.stringify(session), { status: 200 });
    }) as typeof fetch;
    try {
      return await processDownloadList(
        new Request(`http://localhost/api/download/list?session_id=${sessionId}`),
        { CASES: kv as unknown as KVNamespace, STRIPE_SECRET_KEY: 'sk_test_x' },
      );
    } finally {
      globalThis.fetch = orig;
    }
  }

  it('returns live links for a paid Stripe balance session', async () => {
    const kv = memoryKv();
    const rec = paidCase();
    rec.downloadLinks = await mintDownloadLinks(kv as unknown as KVNamespace, rec, 3600);
    await putCase(kv as unknown as KVNamespace, rec);
    const res = await listWithSession(kv, {
      id: 'cs_bal_1',
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'balance', caseId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Array<{ url: string }>; caseId: string };
    expect(body.caseId).toBe(caseId);
    expect(body.links).toHaveLength(3);
    expect(body.links[0].url).toContain('/api/download?token=');
  });

  it('remints only after every token is burned, when the session is still paid', async () => {
    const kv = memoryKv();
    const rec = paidCase();
    const first = await mintDownloadLinks(kv as unknown as KVNamespace, rec, 3600);
    rec.downloadLinks = first;
    await putCase(kv as unknown as KVNamespace, rec);
    for (const l of first) await kv.delete(tokenKey('download', l.token));

    const res = await listWithSession(kv, {
      id: 'cs_bal_1',
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'balance', caseId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Array<{ url: string }> };
    expect(body.links).toHaveLength(3);
    const newToken = new URL(body.links[0].url, 'http://localhost').searchParams.get('token')!;
    expect(first.some((l) => l.token === newToken)).toBe(false);
  });

  it('rejects a bare unpaid or non-balance session', async () => {
    const kv = memoryKv();
    await putCase(kv as unknown as KVNamespace, paidCase());
    const unpaid = await listWithSession(kv, {
      id: 'cs_bal_1',
      status: 'open',
      payment_status: 'unpaid',
      metadata: { type: 'balance', caseId },
    });
    expect(unpaid.status).toBe(402);

    const deposit = await listWithSession(kv, {
      id: 'cs_bal_1',
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'deposit', caseId },
    });
    expect(deposit.status).toBe(403);
  });

  it('does not remint from case id without a Stripe session', async () => {
    const res = await processDownloadList(new Request(`http://localhost/api/download/list?case=${caseId}`), {
      CASES: memoryKv() as unknown as KVNamespace,
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    expect(res.status).toBe(400);
  });
});
