const COOKIE = 'ops';
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

export function opsAuthorized(request: Request, password: string): boolean {
  if (!password) return false;
  const provided =
    bearerToken(request.headers.get('Authorization')) || cookieValue(request.headers.get('Cookie'), COOKIE);
  return timingSafeEqual(provided, password);
}

export function opsCookieHeader(password: string): string {
  return `${COOKIE}=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function opsClearCookieHeader(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
