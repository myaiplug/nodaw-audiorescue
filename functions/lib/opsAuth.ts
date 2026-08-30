const COOKIE = 'ops_session';
const MAX_AGE = 60 * 60 * 24 * 7;

function bearerToken(header: string | null): string {
  if (!header) return '';
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m ? m[1] : '';
}

function cookieValue(header: string | null, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return '';
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function randomTokenHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sessionKey(hash: string): string {
  return `ops:sess:${hash}`;
}

export function opsPasswordMatches(provided: string, password: string): boolean {
  if (!password || !provided) return false;
  return timingSafeEqual(provided, password);
}

export async function issueOpsSession(kv: KVNamespace, ttlSec = MAX_AGE): Promise<string> {
  const token = randomTokenHex(32);
  const hash = await sha256hex(token);
  await kv.put(sessionKey(hash), '1', { expirationTtl: Math.max(60, ttlSec) });
  return token;
}

export async function opsSessionValid(kv: KVNamespace, token: string): Promise<boolean> {
  if (!token) return false;
  const hash = await sha256hex(token);
  return (await kv.get(sessionKey(hash))) === '1';
}

export async function revokeOpsSession(kv: KVNamespace, token: string): Promise<void> {
  if (!token) return;
  const hash = await sha256hex(token);
  await kv.delete(sessionKey(hash));
}

export function opsSessionToken(request: Request): string {
  return (
    bearerToken(request.headers.get('Authorization')) ||
    cookieValue(request.headers.get('Cookie'), COOKIE)
  );
}

export async function opsAuthorized(
  request: Request,
  env: { CASES: KVNamespace; OPS_PASSWORD: string },
): Promise<boolean> {
  if (!env.OPS_PASSWORD) return false;
  const provided = opsSessionToken(request);
  if (!provided) return false;
  return opsSessionValid(env.CASES, provided);
}

export function opsCookieHeader(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

export function opsClearCookieHeader(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
