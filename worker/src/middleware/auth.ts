import type { Context, Next } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, AuthUser, UserRole } from '../types';

// Password hashes are self-describing: "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>".
// Hashes from before this format ("pbkdf2:<saltHex>:<hashHex>") are still accepted and are
// re-hashed on the next successful login.
const HASH_PREFIX = 'pbkdf2-sha256';

/** Workers caps PBKDF2 at 100,000 iterations; local dev uses fewer so logins are instant. */
export function passwordIterations(env: Pick<Env, 'ENVIRONMENT'>): number {
  return env.ENVIRONMENT === 'local' ? 1_000 : 100_000;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return toHex(new Uint8Array(bits));
}

// Compare without returning early, so timing doesn't reveal how much of the hash matched
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${HASH_PREFIX}$${iterations}$${toHex(salt)}$${await pbkdf2Hex(password, salt, iterations)}`;
}

/**
 * Checks a password against a stored hash. needsRehash is true when the hash uses the legacy
 * format or fewer iterations than targetIterations, so the caller can store a fresh hash.
 */
export async function verifyPassword(
  password: string, stored: string, targetIterations: number
): Promise<{ valid: boolean; needsRehash: boolean }> {
  const fail = { valid: false, needsRehash: false };
  const parseSalt = (hex: string) =>
    /^(?:[0-9a-f]{2})+$/.test(hex) ? new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16))) : null;

  if (stored.startsWith(`${HASH_PREFIX}$`)) {
    const [, itersText, saltHex, hashHex] = stored.split('$');
    const iterations = Number(itersText);
    const salt = parseSalt(saltHex ?? '');
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000 || !salt || !hashHex) return fail;
    const valid = constantTimeEqual(await pbkdf2Hex(password, salt, iterations), hashHex);
    return { valid, needsRehash: valid && iterations < targetIterations };
  }

  // Legacy format didn't record its iteration count: local setup used targetIterations,
  // everything else used 100,000.
  const [scheme, saltHex, hashHex] = stored.split(':');
  const salt = parseSalt(saltHex ?? '');
  if (scheme !== 'pbkdf2' || !salt || !hashHex) return fail;
  for (const iterations of new Set([targetIterations, 100_000])) {
    if (constantTimeEqual(await pbkdf2Hex(password, salt, iterations), hashHex)) {
      return { valid: true, needsRehash: true };
    }
  }
  return fail;
}

export async function issueAccessToken(
  userId: string, email: string, role: string, secret: string
): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify({
    sub: userId, email, role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900, // 15 min
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.${sigB64}`;
}

export async function verifyJwt(token: string, secret: string): Promise<AuthUser | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, sig, new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: payload.sub, email: payload.email, role: payload.role as UserRole };
  } catch {
    return null;
  }
}

export async function hashRefreshToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function setRefreshCookie(c: Context<{ Bindings: Env }>, raw: string) {
  setCookie(c, 'refresh_token', raw, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'local',
    sameSite: 'Strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(c: Context<{ Bindings: Env }>) {
  setCookie(c, 'refresh_token', '', {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'local',
    sameSite: 'Strict',
    path: '/auth/refresh',
    maxAge: 0,
  });
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authorization = c.req.header('Authorization');

  if (authorization?.startsWith('Bearer ak_')) {
    const rawKey = authorization.slice(7);
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(rawKey + c.env.API_KEY_SALT)
    );
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const row = await c.env.DB.prepare(`
      SELECT ak.id, u.id as user_id, u.email, u.role
      FROM api_keys ak JOIN users u ON ak.user_id = u.id
      WHERE ak.key_hash = ? AND ak.is_active = 1
        AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))
    `).bind(keyHash).first<{ id: string; user_id: string; email: string; role: string }>();
    if (!row) return c.json({ error: 'Unauthorized' }, 401);
    c.env.DB.prepare('UPDATE api_keys SET last_used = datetime(\'now\') WHERE id = ?')
      .bind(row.id).run();
    c.set('user', { id: row.user_id, email: row.email, role: row.role as UserRole });
    return next();
  }

  if (authorization?.startsWith('Bearer ')) {
    const user = await verifyJwt(authorization.slice(7), c.env.JWT_SECRET);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    return next();
  }

  return c.json({ error: 'Unauthorized' }, 401);
}
