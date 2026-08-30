import type { Env } from '../../lib/env';
import { getCase } from '../../lib/cases';
import { consumeToken, parseDownloadTokenPayload, peekToken } from '../../lib/tokens';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function paidStatus(status: string): boolean {
  return status === 'paid_in_full' || status === 'delivered';
}

function safeFilename(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return base || 'download';
}

function contentTypeFor(filename: string, fallback?: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return fallback || 'application/octet-stream';
}

export async function processDownload(
  request: Request,
  env: Pick<Env, 'AUDIO' | 'CASES'>,
): Promise<Response> {
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'Missing download token' }, 401);

  const peeked = await peekToken(env.CASES, 'download', token);
  const payload = parseDownloadTokenPayload(peeked);
  if (!payload) return json({ error: 'Invalid or expired download token' }, 401);

  const record = await getCase(env.CASES, payload.caseId);
  if (!record) return json({ error: 'Unknown case' }, 400);
  if (!payload.ops && !paidStatus(record.status)) {
    return json({ error: 'Balance required to download', status: record.status }, 402);
  }

  const obj = await env.AUDIO.get(payload.r2Key);
  if (!obj) return json({ error: 'File not found' }, 404);

  let consumed: string | null;
  try {
    consumed = await consumeToken(env.CASES, 'download', token);
  } catch (err) {
    console.error('Download token consume failed', err);
    return json({ error: 'Download failed' }, 500);
  }
  if (!consumed) return json({ error: 'Invalid or expired download token' }, 401);

  const filename = safeFilename(payload.filename);
  const body =
    'arrayBuffer' in obj && typeof obj.arrayBuffer === 'function'
      ? await obj.arrayBuffer()
      : (obj.body as BodyInit);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(filename, obj.httpMetadata?.contentType),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  return processDownload(context.request, context.env);
}
