// ---------------------------------------------------------------------------
// session-token.ts — the session cookie's value: signed, expiring, isomorphic.
//
// `<payload>.<signature>` where payload is base64url JSON and signature is
// HMAC-SHA256 over it. Written with Web Crypto so the SAME function runs in the
// Next middleware (edge runtime) and in a server action (node) — one
// implementation, so the two can never disagree about whether a cookie is valid.
//
// What the cookie proves: this server issued it, to this user id, and it has
// not expired. What it does NOT prove: that the user is still active, still
// holds a role, or still exists. Those are looked up server-side on every
// request, because a cookie is a claim and the database is the fact.
// ---------------------------------------------------------------------------

export type SessionPayload = {
  /** The authenticated user id — the application's user, not the browser's word. */
  uid: string;
  /** Which provider authenticated them. */
  provider: 'local' | 'supabase';
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
};

export type VerifyResult =
  | { valid: true; payload: SessionPayload }
  | { valid: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a cookie value. Signature first, expiry second: an expired token with
 * a forged signature is a forgery, and reporting it as "expired" would tell an
 * attacker their signature was accepted.
 */
export async function verifySession(token: string | undefined | null, secret: string, nowSeconds?: number): Promise<VerifyResult> {
  if (!token) return { valid: false, reason: 'missing' };
  const [body, signature] = token.split('.');
  if (!body || !signature) return { valid: false, reason: 'malformed' };

  let verified = false;
  try {
    verified = await crypto.subtle.verify('HMAC', await key(secret), base64UrlDecode(signature), encoder.encode(body));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!verified) return { valid: false, reason: 'bad_signature' };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!payload?.uid || !payload?.exp) return { valid: false, reason: 'malformed' };

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}

export function newSessionPayload(uid: string, provider: 'local' | 'supabase', ttlSeconds: number): SessionPayload {
  const iat = Math.floor(Date.now() / 1000);
  return { uid, provider, iat, exp: iat + ttlSeconds };
}

export const SESSION_COOKIE = 'purchasing_session';
