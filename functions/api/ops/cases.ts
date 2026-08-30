import type { Env } from '../../lib/env';
import { validateAudioHeaders } from '../../lib/audioValidate';
import { getCase, listCases, putCase, type CaseRecord } from '../../lib/cases';
import { notifyDiscord } from '../../lib/discord';
import {
  issueOpsSession,
  opsAuthorized,
  opsClearCookieHeader,
  opsCookieHeader,
  opsPasswordMatches,
  opsSessionToken,
  revokeOpsSession,
} from '../../lib/opsAuth';
import { commitIssuedBalanceCheckout, createBalanceCheckout, declineRefundFields, stripeForm } from '../../lib/stripe';
import { DOWNLOAD_TOKEN_TTL_SEC, mintDownloadLinks } from '../../lib/tokens';

const NOTES_MAX = 4000;
const NOTES_FILE_MAX = 100 * 1024;
const DECLINE_OK: ReadonlySet<CaseRecord['status']> = new Set([
  'uploaded',
  'in_review',
  'invalid_file',
]);
const RESCUE_OK: ReadonlySet<CaseRecord['status']> = new Set([
  'uploaded',
  'in_review',
  'rescued',
  'balance_due',
]);

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers });
}

function formString(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

function formFile(form: FormData, names: string[]): File | null {
  for (const name of names) {
    const v = form.get(name);
    if (v instanceof File && v.name && v.size > 0) return v;
  }
  return null;
}

type OpsBody = {
  action?: string;
  caseId?: string;
  note?: string;
  password?: string;
  notes?: string;
};

async function readBody(
  request: Request,
): Promise<{ ok: true; action: string; fields: OpsBody; form: FormData | null } | { ok: false; error: string }> {
  const ctype = (request.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, error: 'Expected multipart form data' };
    }
    return {
      ok: true,
      action: formString(form, 'action'),
      fields: {
        action: formString(form, 'action'),
        caseId: formString(form, 'caseId'),
        note: formString(form, 'note'),
        password: formString(form, 'password'),
        notes: formString(form, 'notes'),
      },
      form,
    };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const action = str('action');
  return {
    ok: true,
    action,
    fields: {
      action,
      caseId: str('caseId'),
      note: str('note'),
      password: str('password'),
      notes: str('notes'),
    },
    form: null,
  };
}

function publicize(record: CaseRecord) {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    notes: record.notes,
    service: record.service,
    status: record.status,
    createdAt: record.createdAt,
    r2Key: record.r2Key ?? null,
    r2RescueWav: record.r2RescueWav ?? null,
    r2RescueMp3: record.r2RescueMp3 ?? null,
    r2Notes: record.r2Notes ?? null,
    declineNote: record.declineNote ?? null,
    balanceCheckoutUrl: record.balanceCheckoutUrl ?? null,
    stripeDepositPi: record.stripeDepositPi,
    stripeBalancePi: record.stripeBalancePi,
  };
}

async function putRescueFile(
  env: Pick<Env, 'AUDIO'>,
  caseId: string,
  file: File,
  slot: 'wav' | 'mp3',
): Promise<string | { error: string }> {
  const bytes = await file.arrayBuffer();
  const header = validateAudioHeaders(bytes, file.name);
  if (!header.ok) return { error: header.error };
  if (slot === 'wav' && header.format !== 'wav') return { error: 'Rescue WAV must be a real WAV file.' };
  if (slot === 'mp3' && header.format !== 'mp3') return { error: 'Rescue MP3 must be a real MP3 file.' };
  const r2Key = `cases/${caseId}/rescue.${header.format}`;
  await env.AUDIO.put(r2Key, bytes, {
    httpMetadata: { contentType: header.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' },
  });
  return r2Key;
}

type OpsEnv = Pick<
  Env,
  'AUDIO' | 'CASES' | 'STRIPE_SECRET_KEY' | 'OPS_PASSWORD' | 'DISCORD_WEBHOOK_URL' | 'PUBLIC_BASE_URL'
>;

export async function processOpsCases(
  request: Request,
  env: OpsEnv,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (!env.OPS_PASSWORD) return json({ error: 'OPS_PASSWORD is not configured' }, 500);

  const parsed = await readBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { action, fields, form } = parsed;

  if (action === 'login') {
    const password = fields.password || '';
    if (!opsPasswordMatches(password, env.OPS_PASSWORD)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const token = await issueOpsSession(env.CASES);
    return json({ ok: true }, 200, { 'Set-Cookie': opsCookieHeader(token) });
  }
  if (action === 'logout') {
    const existing = opsSessionToken(request);
    if (existing) await revokeOpsSession(env.CASES, existing);
    return json({ ok: true }, 200, { 'Set-Cookie': opsClearCookieHeader() });
  }

  if (!(await opsAuthorized(request, env))) return json({ error: 'Unauthorized' }, 401);

  if (action === 'list') {
    const cases = await listCases(env.CASES);
    return json({ cases: cases.map(publicize) });
  }

  if (action === 'decline') {
    const caseId = fields.caseId || '';
    if (!caseId) return json({ error: 'caseId is required' }, 400);
    const record = await getCase(env.CASES, caseId);
    if (!record) return json({ error: 'Unknown case' }, 400);
    if (record.status === 'declined' || record.status === 'closed') {
      return json({ ok: true, case: publicize(record), duplicate: true });
    }
    if (!DECLINE_OK.has(record.status)) {
      return json({ error: 'Case cannot be declined in this status' }, 409);
    }
    if (!record.stripeDepositPi) return json({ error: 'Missing deposit payment intent' }, 400);
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);

    try {
      await stripeForm(
        env.STRIPE_SECRET_KEY,
        'refunds',
        declineRefundFields({ paymentIntentId: record.stripeDepositPi, caseId: record.id }),
        { 'Idempotency-Key': `decline:${record.id}` },
      );
    } catch (err) {
      console.error('Stripe refund failed', err);
      return json({ error: 'Refund failed' }, 502);
    }

    record.status = 'declined';
    if (fields.note) record.declineNote = fields.note.slice(0, NOTES_MAX);
    await putCase(env.CASES, record);

    const noteBit = record.declineNote ? `\n${record.declineNote}` : '';
    const discordContent = `Declined ${record.id} ${record.email} — refund $14.50 (kept $5)${noteBit}`;
    const notify = notifyDiscord(env.DISCORD_WEBHOOK_URL, discordContent).catch((err) => {
      console.error('Discord notify failed', err);
    });
    if (waitUntil) waitUntil(notify);

    return json({ ok: true, case: publicize(record) });
  }

  if (action === 'mark_rescued') {
    const caseId = fields.caseId || '';
    if (!caseId) return json({ error: 'caseId is required' }, 400);
    const record = await getCase(env.CASES, caseId);
    if (!record) return json({ error: 'Unknown case' }, 400);
    if (!RESCUE_OK.has(record.status)) {
      return json({ error: 'Case cannot be marked rescued in this status' }, 409);
    }
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured' }, 500);
    if (!env.PUBLIC_BASE_URL) return json({ error: 'PUBLIC_BASE_URL is not configured' }, 500);

    if (form) {
      const wav = formFile(form, ['wav', 'rescueWav', 'rescue_wav']);
      const mp3 = formFile(form, ['mp3', 'rescueMp3', 'rescue_mp3']);
      const notesFile = formFile(form, ['notesFile', 'notes_file']);
      try {
        if (wav) {
          const put = await putRescueFile(env, record.id, wav, 'wav');
          if (typeof put !== 'string') return json({ error: put.error }, 400);
          record.r2RescueWav = put;
        }
        if (mp3) {
          const put = await putRescueFile(env, record.id, mp3, 'mp3');
          if (typeof put !== 'string') return json({ error: put.error }, 400);
          record.r2RescueMp3 = put;
        }
        if (notesFile) {
          if (notesFile.size > NOTES_FILE_MAX) return json({ error: 'Notes file is too large' }, 400);
          const bytes = await notesFile.arrayBuffer();
          const r2Key = `cases/${record.id}/notes.txt`;
          await env.AUDIO.put(r2Key, bytes, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
          record.r2Notes = r2Key;
        }
      } catch (err) {
        console.error('Rescue R2 put failed', err);
        return json({ error: 'Upload failed' }, 500);
      }
    }

    const notesText = fields.notes || '';
    if (notesText) {
      if (notesText.length > NOTES_MAX) return json({ error: `Notes must be at most ${NOTES_MAX} characters` }, 400);
      const r2Key = `cases/${record.id}/notes.txt`;
      try {
        await env.AUDIO.put(r2Key, notesText, {
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        });
        record.r2Notes = r2Key;
      } catch (err) {
        console.error('Rescue notes put failed', err);
        return json({ error: 'Upload failed' }, 500);
      }
    }

    let committed: CaseRecord = record;
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
      committed = result.record;
      if (!result.ok) {
        return json({ ok: true, case: publicize(committed), refused: true, reason: 'already_paid' }, 409);
      }
    } catch (err) {
      console.error('Stripe balance checkout failed', err);
      return json({ error: 'Checkout failed' }, 502);
    }

    const discordContent = `Rescued ${committed.id} ${committed.email} — balance due $19.50\n${committed.balanceCheckoutUrl}`;
    const notify = notifyDiscord(env.DISCORD_WEBHOOK_URL, discordContent).catch((err) => {
      console.error('Discord notify failed', err);
    });
    if (waitUntil) waitUntil(notify);

    return json({ ok: true, case: publicize(committed), url: committed.balanceCheckoutUrl });
  }

  if (action === 'source_url') {
    const caseId = fields.caseId || '';
    if (!caseId) return json({ error: 'caseId is required' }, 400);
    const record = await getCase(env.CASES, caseId);
    if (!record) return json({ error: 'Unknown case' }, 400);
    if (!record.r2Key) return json({ error: 'No source file on this case' }, 400);
    const ext = record.r2Key.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
    const links = await mintDownloadLinks(env.CASES, record, DOWNLOAD_TOKEN_TTL_SEC, [
      { kind: 'source', r2Key: record.r2Key, filename: `${record.id}-source.${ext}`, ops: true },
    ]);
    return json({ url: `/api/download?token=${encodeURIComponent(links[0].token)}` });
  }

  return json({ error: 'Unknown action' }, 400);
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  return processOpsCases(context.request, context.env, context.waitUntil);
}
