import { describe, it, expect } from 'vitest';
import { processUpload } from '../functions/api/upload';
import { processUploadClaim } from '../functions/api/upload/claim';
import { getCase, putCase, type CaseRecord } from '../functions/lib/cases';
import { mintToken, tokenKey } from '../functions/lib/tokens';

const caseId = '22222222-2222-4222-8222-222222222222';

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
  };
}

function memoryR2() {
  const objects = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: { httpMetadata?: { contentType?: string } }) {
      const body =
        value instanceof ArrayBuffer
          ? value
          : (value.buffer as ArrayBuffer).slice(value.byteOffset, value.byteOffset + value.byteLength);
      objects.set(key, { body, contentType: opts?.httpMetadata?.contentType });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function wavHeader(dataBytes = 100, byteRate = 44100 * 2 * 2): ArrayBuffer {
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
  v.setUint32(28, byteRate, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  enc.encodeInto('data', new Uint8Array(buf, 36, 4));
  v.setUint32(40, dataBytes, true);
  return buf;
}

function mp3Id3(bytes = 64): ArrayBuffer {
  const buf = new ArrayBuffer(bytes);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x49;
  u8[1] = 0x44;
  u8[2] = 0x33;
  return buf;
}

function depositedCase(): CaseRecord {
  return {
    id: caseId,
    email: 'artist@example.com',
    name: 'Ada',
    notes: 'sibilance',
    service: 'Rush vocal cleanup',
    status: 'deposited',
    stripeDepositPi: 'pi_deposit_1',
    stripeBalancePi: null,
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

async function setup(status: CaseRecord['status'] = 'deposited') {
  const kv = memoryKv();
  const r2 = memoryR2();
  const rec = depositedCase();
  rec.status = status;
  await putCase(kv as unknown as KVNamespace, rec);
  const token = await mintToken(kv as unknown as KVNamespace, 'upload', caseId, 3600);
  return { kv, r2, token };
}

function fileFrom(buf: ArrayBuffer, name: string, type: string): File {
  return new File([new Uint8Array(buf)], name, { type });
}

async function postUpload(opts: {
  token?: string;
  bearer?: boolean;
  formToken?: boolean;
  file?: File | null;
  durationSec?: string | null;
  kv: ReturnType<typeof memoryKv>;
  r2: ReturnType<typeof memoryR2>;
  discord?: string[];
  waitUntil?: (p: Promise<unknown>) => void;
}): Promise<Response> {
  const form = new FormData();
  if (opts.file) form.append('file', opts.file);
  if (opts.formToken !== false && opts.token) form.append('token', opts.token);
  if (opts.durationSec !== null) form.append('durationSec', opts.durationSec ?? '1.5');

  const headers: Record<string, string> = {};
  if (opts.bearer !== false && opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const orig = globalThis.fetch;
  if (opts.discord) {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      opts.discord!.push(String(init?.body ?? ''));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  }

  try {
    return await processUpload(
      new Request('http://localhost/api/upload', { method: 'POST', headers, body: form }),
      {
        CASES: opts.kv as unknown as KVNamespace,
        AUDIO: opts.r2 as unknown as R2Bucket,
        DISCORD_WEBHOOK_URL: opts.discord ? 'https://discord.example/webhook' : undefined,
      },
      opts.waitUntil,
    );
  } finally {
    if (opts.discord) globalThis.fetch = orig;
  }
}

describe('POST /api/upload', () => {
  it('puts WAV to R2, marks uploaded, burns token, notifies Discord', async function () {
    const { kv, r2, token } = await setup();
    const discord: string[] = [];
    const pending: Promise<unknown>[] = [];
    const wav = wavHeader(200);
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wav, 'mix.wav', 'audio/wav'),
      durationSec: '2',
      discord,
      waitUntil: (p) => pending.push(p),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      caseId,
      r2Key: `cases/${caseId}/source.wav`,
    });
    await Promise.all(pending);

    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    expect(rec?.status).toBe('uploaded');
    expect(rec?.r2Key).toBe(`cases/${caseId}/source.wav`);
    expect(r2.objects.get(`cases/${caseId}/source.wav`)?.contentType).toBe('audio/wav');
    expect(await kv.get(tokenKey('upload', token))).toBeNull();
    expect(discord.join('')).toContain(`File uploaded ${caseId} artist@example.com`);
    expect(discord.join('')).toContain(`cases/${caseId}/source.wav`);
  });

  it('accepts token from form field without Bearer', async function () {
    const { kv, r2, token } = await setup();
    const res = await postUpload({
      kv,
      r2,
      token,
      bearer: false,
      formToken: true,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
    });
    expect(res.status).toBe(200);
  });

  it('rejects missing token', async function () {
    const { kv, r2 } = await setup();
    const res = await postUpload({
      kv,
      r2,
      bearer: false,
      formToken: false,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
    });
    expect(res.status).toBe(401);
  });

  it('rejects reused token', async function () {
    const { kv, r2, token } = await setup();
    const file = fileFrom(wavHeader(), 'mix.wav', 'audio/wav');
    const first = await postUpload({ kv, r2, token, file });
    expect(first.status).toBe(200);
    const second = await postUpload({ kv, r2, token, file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav') });
    expect(second.status).toBe(401);
  });

  it('rejects durationSec over 300 and sets invalid_file without burning token', async function () {
    const { kv, r2, token } = await setup();
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      durationSec: '301',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'File exceeds 5:00 limit.' });
    expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('invalid_file');
    expect(await kv.get(tokenKey('upload', token))).toBe(caseId);
    expect(r2.objects.size).toBe(0);
  });

  it('rejects WAV whose header duration is over 300 even if client sends a short durationSec', async function () {
    const { kv, r2, token } = await setup();
    const long = wavHeader(301_000, 1000);
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(long, 'long.wav', 'audio/wav'),
      durationSec: '10',
    });
    expect(res.status).toBe(400);
    expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('invalid_file');
    expect(r2.objects.size).toBe(0);
  });

  it('allows a second try after invalid_file with the same token', async function () {
    const { kv, r2, token } = await setup();
    const bad = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      durationSec: '400',
    });
    expect(bad.status).toBe(400);
    const ok = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      durationSec: '12',
    });
    expect(ok.status).toBe(200);
    expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('uploaded');
  });

  it('rejects exe renamed as mp3 and does not write R2', async function () {
    const { kv, r2, token } = await setup();
    const mz = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(mz.buffer, 'hack.mp3', 'audio/mpeg'),
      durationSec: '1',
    });
    expect(res.status).toBe(400);
    expect(r2.objects.size).toBe(0);
    expect((await getCase(kv as unknown as KVNamespace, caseId))?.status).toBe('deposited');
    expect(await kv.get(tokenKey('upload', token))).toBe(caseId);
  });

  it('rejects draft cases', async function () {
    const { kv, r2, token } = await setup('draft');
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
    });
    expect(res.status).toBe(409);
  });

  it('stores MP3 under source.mp3 when durationSec is within cap', async function () {
    const { kv, r2, token } = await setup();
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(mp3Id3(), 'hook.mp3', 'audio/mpeg'),
      durationSec: '299.9',
    });
    expect(res.status).toBe(200);
    expect(r2.objects.get(`cases/${caseId}/source.mp3`)?.contentType).toBe('audio/mpeg');
    expect((await getCase(kv as unknown as KVNamespace, caseId))?.r2Key).toBe(
      `cases/${caseId}/source.mp3`,
    );
  });

  it('requires durationSec', async function () {
    const { kv, r2, token } = await setup();
    const res = await postUpload({
      kv,
      r2,
      token,
      file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      durationSec: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'durationSec is required' });
  });

  it('deletes R2 and leaves deposited if case write fails after AUDIO.put', async function () {
    const { kv, r2, token } = await setup();
    const origPut = kv.put.bind(kv);
    kv.put = async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      if (key.startsWith('case:')) throw new Error('case put failed');
      return origPut(key, value, opts);
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await postUpload({
        kv,
        r2,
        token,
        file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Upload failed' });
      const rec = await getCase(kv as unknown as KVNamespace, caseId);
      expect(rec?.status).toBe('deposited');
      expect(rec?.r2Key).toBeUndefined();
      expect(r2.objects.size).toBe(0);
      expect(await kv.get(tokenKey('upload', token))).toBe(caseId);
    } finally {
      console.error = origErr;
    }
  });

  it('returns 200 if consumeToken fails after the case is uploaded', async function () {
    const { kv, r2, token } = await setup();
    const origDelete = kv.delete.bind(kv);
    kv.delete = async (key: string) => {
      if (key.startsWith('tok:')) throw new Error('consume failed');
      return origDelete(key);
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = await postUpload({
        kv,
        r2,
        token,
        file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        caseId,
        r2Key: `cases/${caseId}/source.wav`,
      });
      const rec = await getCase(kv as unknown as KVNamespace, caseId);
      expect(rec?.status).toBe('uploaded');
      expect(rec?.r2Key).toBe(`cases/${caseId}/source.wav`);
      expect(r2.objects.has(`cases/${caseId}/source.wav`)).toBe(true);
      expect(await kv.get(tokenKey('upload', token))).toBe(caseId);
    } finally {
      console.error = origErr;
    }
  });

  it('rate-limits an IP after 10 upload POSTs in the window', async () => {
    const { kv, r2 } = await setup();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await postUpload({
        kv,
        r2,
        bearer: false,
        formToken: false,
        file: fileFrom(wavHeader(), 'mix.wav', 'audio/wav'),
      });
    }
    expect(last?.status).toBe(429);
    expect(await last!.json()).toEqual({ error: 'Too many requests' });
  });
});

describe('GET /api/upload/claim', () => {
  const sessionId = 'cs_dep_1';

  async function claimWithSession(
    kv: ReturnType<typeof memoryKv>,
    session: Record<string, unknown>,
    extraQuery = '',
  ): Promise<Response> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/checkout/sessions/${sessionId}`);
      return new Response(JSON.stringify(session), { status: 200 });
    }) as typeof fetch;
    try {
      return await processUploadClaim(
        new Request(`http://localhost/api/upload/claim?session_id=${sessionId}${extraQuery}`),
        { CASES: kv as unknown as KVNamespace, STRIPE_SECRET_KEY: 'sk_test_x' },
      );
    } finally {
      globalThis.fetch = orig;
    }
  }

  it('returns a live upload token for a paid deposit session', async () => {
    const { kv, token } = await setup();
    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    rec!.uploadToken = token;
    await putCase(kv as unknown as KVNamespace, rec!);

    const res = await claimWithSession(kv, {
      id: sessionId,
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'deposit', caseId },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caseId, status: 'deposited', token });
    expect(await kv.get(tokenKey('upload', token))).toBe(caseId);
  });

  it('mints a new token when the previous upload token is missing', async () => {
    const { kv, token } = await setup();
    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    rec!.uploadToken = token;
    await putCase(kv as unknown as KVNamespace, rec!);
    await kv.delete(tokenKey('upload', token));

    const res = await claimWithSession(kv, {
      id: sessionId,
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'deposit', caseId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; caseId: string };
    expect(body.caseId).toBe(caseId);
    expect(body.token).not.toBe(token);
    expect(await kv.get(tokenKey('upload', body.token))).toBe(caseId);
  });

  it('rejects an unpaid deposit session', async () => {
    const { kv } = await setup();
    const res = await claimWithSession(kv, {
      id: sessionId,
      status: 'open',
      payment_status: 'unpaid',
      metadata: { type: 'deposit', caseId },
    });
    expect(res.status).toBe(402);
    const rec = await getCase(kv as unknown as KVNamespace, caseId);
    expect(rec?.status).toBe('deposited');
    expect(rec?.uploadToken).toBeUndefined();
  });
});
