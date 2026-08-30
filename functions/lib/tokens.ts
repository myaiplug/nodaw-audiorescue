export type TokenKind = 'upload';

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
