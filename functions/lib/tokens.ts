import { downloadAssetsFor, type CaseRecord, type DownloadLink } from './cases';

export type TokenKind = 'upload' | 'download';

export const DOWNLOAD_TOKEN_TTL_SEC = 60 * 60 * 72; // 72h
export const UPLOAD_TOKEN_TTL_SEC = 60 * 60;

export type DownloadTokenPayload = {
  caseId: string;
  r2Key: string;
  filename: string;
  ops?: boolean;
};

export function parseDownloadTokenPayload(raw: string | null): DownloadTokenPayload | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof o.caseId === 'string' &&
      o.caseId &&
      typeof o.r2Key === 'string' &&
      o.r2Key &&
      typeof o.filename === 'string' &&
      o.filename
    ) {
      return {
        caseId: o.caseId,
        r2Key: o.r2Key,
        filename: o.filename,
        ops: o.ops === true,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function tokenKey(kind: TokenKind, token: string): string {
  return `tok:${kind}:${token}`;
}

function randomTokenHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Map-backed mint for unit tests (TTL recorded but not enforced). */
export function mintTokenLogic(
  store: Map<string, string>,
  kind: TokenKind,
  caseId: string,
  _ttlSec: number,
): string {
  const token = randomTokenHex(32);
  store.set(tokenKey(kind, token), caseId);
  return token;
}

/** Map-backed one-time consume for unit tests. */
export function consumeTokenLogic(
  store: Map<string, string>,
  kind: TokenKind,
  token: string,
): string | null {
  const key = tokenKey(kind, token);
  const caseId = store.get(key);
  if (caseId === undefined) return null;
  store.delete(key);
  return caseId;
}

/** KV mint: `tok:{kind}:{token}` → caseId with expirationTtl. */
export async function mintToken(
  kv: KVNamespace,
  kind: TokenKind,
  caseId: string,
  ttlSec: number,
): Promise<string> {
  const token = randomTokenHex(32);
  await kv.put(tokenKey(kind, token), caseId, { expirationTtl: ttlSec });
  return token;
}

export async function mintDownloadLinks(
  kv: KVNamespace,
  record: CaseRecord,
  ttlSec = DOWNLOAD_TOKEN_TTL_SEC,
  extra: Array<{ kind: DownloadLink['kind']; r2Key: string; filename: string; ops?: boolean }> = [],
): Promise<DownloadLink[]> {
  const assets = extra.length ? extra : downloadAssetsFor(record);
  const links: DownloadLink[] = [];
  for (const a of assets) {
    const payload: DownloadTokenPayload = {
      caseId: record.id,
      r2Key: a.r2Key,
      filename: a.filename,
    };
    if ('ops' in a && a.ops) payload.ops = true;
    const token = await mintToken(kv, 'download', JSON.stringify(payload), ttlSec);
    links.push({ kind: a.kind, filename: a.filename, token });
  }
  return links;
}

/** KV peek; does not delete. */
export async function peekToken(
  kv: KVNamespace,
  kind: TokenKind,
  token: string,
): Promise<string | null> {
  return kv.get(tokenKey(kind, token));
}

/** KV one-time consume; deletes key on success. */
export async function consumeToken(
  kv: KVNamespace,
  kind: TokenKind,
  token: string,
): Promise<string | null> {
  const key = tokenKey(kind, token);
  const caseId = await kv.get(key);
  if (!caseId) return null;
  await kv.delete(key);
  return caseId;
}

/** Return the live upload token, or mint a new one. Caller must persist `record`. */
export async function liveOrMintUploadToken(
  kv: KVNamespace,
  record: CaseRecord,
  ttlSec = UPLOAD_TOKEN_TTL_SEC,
): Promise<{ token: string; minted: boolean }> {
  if (record.uploadToken) {
    const live = await peekToken(kv, 'upload', record.uploadToken);
    if (live === record.id) return { token: record.uploadToken, minted: false };
  }
  const token = await mintToken(kv, 'upload', record.id, ttlSec);
  record.uploadToken = token;
  return { token, minted: true };
}
