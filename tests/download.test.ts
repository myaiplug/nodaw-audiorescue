import { describe, it, expect } from 'vitest';
import { processDownload } from '../functions/api/download';
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
  });

  it('lists links for a paid case and remints after burn', async () => {
    const kv = memoryKv();
    const r2 = memoryR2();
    const rec = paidCase();
    const links = await mintDownloadLinks(kv as unknown as KVNamespace, rec, 3600);
    rec.downloadLinks = links;
    await putCase(kv as unknown as KVNamespace, rec);
    await r2.put(rec.r2Key!, new ArrayBuffer(4), { httpMetadata: { contentType: 'audio/wav' } });
    await r2.put(rec.r2RescueWav!, new ArrayBuffer(4), { httpMetadata: { contentType: 'audio/wav' } });
    await r2.put(rec.r2Notes!, new ArrayBuffer(4), { httpMetadata: { contentType: 'text/plain' } });

    const listed = await processDownload(
      new Request(`http://localhost/api/download?case=${caseId}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(listed.status).toBe(200);
    const first = (await listed.json()) as { links: Array<{ url: string; kind: string }> };
    expect(first.links.length).toBe(3);

    const token = new URL(first.links[0].url, 'http://localhost').searchParams.get('token')!;
    const dl = await processDownload(
      new Request(`http://localhost/api/download?token=${token}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    expect(dl.status).toBe(200);

    for (const l of first.links) {
      const t = new URL(l.url, 'http://localhost').searchParams.get('token')!;
      await kv.delete(tokenKey('download', t));
    }

    const again = await processDownload(
      new Request(`http://localhost/api/download?case=${caseId}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: r2 as unknown as R2Bucket },
    );
    const second = (await again.json()) as { links: Array<{ url: string }> };
    expect(second.links.length).toBe(3);
    expect(second.links[0].url).not.toBe(first.links[0].url);
  });

  it('returns 402 when listing a case that is not paid', async () => {
    const kv = memoryKv();
    const rec = paidCase();
    rec.status = 'rescued';
    await putCase(kv as unknown as KVNamespace, rec);
    const res = await processDownload(
      new Request(`http://localhost/api/download?case=${caseId}`),
      { CASES: kv as unknown as KVNamespace, AUDIO: memoryR2() as unknown as R2Bucket },
    );
    expect(res.status).toBe(402);
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
