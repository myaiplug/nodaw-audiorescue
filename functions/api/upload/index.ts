import type { Env } from '../../lib/env';
import {
  estimateWavDurationSec,
  MAX_SECONDS,
  validateAudioHeaders,
} from '../../lib/audioValidate';
import { getCase, putCase, type CaseRecord } from '../../lib/cases';
import { notifyDiscord } from '../../lib/discord';
import { clientIp, consumeRateLimit, rateLimitKey } from '../../lib/rate-limit';
import { consumeToken, tokenKey } from '../../lib/tokens';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bearerToken(header: string | null): string {
  if (!header) return '';
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m ? m[1] : '';
}

function formString(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

function extractToken(request: Request, form: FormData): string {
  const fromHeader = bearerToken(request.headers.get('Authorization'));
  if (fromHeader) return fromHeader;
  const fromForm = formString(form, 'token');
  if (fromForm) return fromForm;
  return new URL(request.url).searchParams.get('token')?.trim() || '';
}

function getUploadFile(form: FormData): File | null {
  const direct = form.get('file');
  if (direct instanceof File && direct.name) return direct;
  for (const v of form.values()) {
    if (v instanceof File && v.name) return v;
  }
  return null;
}

function parseDurationSec(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function contentTypeFor(format: 'mp3' | 'wav'): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

async function markInvalidFile(kv: KVNamespace, record: CaseRecord): Promise<void> {
  if (record.status === 'invalid_file') return;
  record.status = 'invalid_file';
  await putCase(kv, record);
}

type UploadEnv = Pick<Env, 'AUDIO' | 'CASES' | 'DISCORD_WEBHOOK_URL'>;

export async function processUpload(
  request: Request,
  env: UploadEnv,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const limited = await consumeRateLimit(env.CASES, rateLimitKey('upload', clientIp(request)));
  if (!limited.ok) return json({ error: 'Too many requests' }, 429);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart form data' }, 400);
  }

  const token = extractToken(request, form);
  if (!token) return json({ error: 'Missing upload token' }, 401);

  const caseId = await env.CASES.get(tokenKey('upload', token));
  if (!caseId) return json({ error: 'Invalid or expired upload token' }, 401);

  const record = await getCase(env.CASES, caseId);
  if (!record) return json({ error: 'Unknown case' }, 400);
  if (record.status !== 'deposited' && record.status !== 'invalid_file') {
    return json({ error: 'Case is not accepting uploads' }, 409);
  }

  const file = getUploadFile(form);
  if (!file) return json({ error: 'Missing audio file' }, 400);

  const bytes = await file.arrayBuffer();
  const header = validateAudioHeaders(bytes, file.name);
  if (!header.ok) return json({ error: header.error }, 400);

  const durationSec = parseDurationSec(form.get('durationSec'));
  if (durationSec == null) return json({ error: 'durationSec is required' }, 400);
  if (durationSec < 0) return json({ error: 'durationSec is invalid' }, 400);

  let wavDuration: number | null = null;
  if (header.format === 'wav') {
    wavDuration = header.durationSec ?? estimateWavDurationSec(bytes);
    if (wavDuration == null) return json({ error: 'Could not determine WAV duration' }, 400);
  }

  const overDuration =
    durationSec > MAX_SECONDS || (wavDuration != null && wavDuration > MAX_SECONDS);
  if (overDuration) {
    await markInvalidFile(env.CASES, record);
    return json({ error: 'File exceeds 5:00 limit.' }, 400);
  }

  const r2Key = `cases/${record.id}/source.${header.format}`;
  try {
    await env.AUDIO.put(r2Key, bytes, {
      httpMetadata: { contentType: contentTypeFor(header.format) },
    });
  } catch (err) {
    console.error('Upload R2 put failed', err);
    return json({ error: 'Upload failed' }, 500);
  }

  const previousStatus = record.status;
  const previousR2Key = record.r2Key;
  record.status = 'uploaded';
  record.r2Key = r2Key;
  try {
    await putCase(env.CASES, record);
  } catch (err) {
    record.status = previousStatus;
    record.r2Key = previousR2Key;
    try {
      await env.AUDIO.delete(r2Key);
    } catch {
      /* ignore partial cleanup errors */
    }
    console.error('Upload case commit failed', err);
    return json({ error: 'Upload failed' }, 500);
  }

  try {
    await consumeToken(env.CASES, 'upload', token);
  } catch (err) {
    // Case is already uploaded with an R2 object; an orphan token is better than
    // deleting the file and 409-ing retries.
    console.error('Upload token consume failed', err);
  }

  const discordContent = `File uploaded ${record.id} ${record.email} — ${r2Key}`;
  const notify = notifyDiscord(env.DISCORD_WEBHOOK_URL, discordContent).catch((err) => {
    console.error('Discord notify failed', err);
  });
  if (waitUntil) waitUntil(notify);

  return json({ ok: true, caseId: record.id, r2Key });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  return processUpload(context.request, context.env, context.waitUntil);
}
