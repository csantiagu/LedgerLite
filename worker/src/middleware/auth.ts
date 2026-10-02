import type { Context, Next } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, AuthUser, UserRole } from '../types';

export async function hashPassword(password: string, iterations = 100000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string, iterations = 100000): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/../g)!.map(h => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const candidate = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return candidate === hashHex;
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
