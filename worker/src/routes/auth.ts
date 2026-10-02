import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Env } from '../types';
import {
  hashPassword, verifyPassword, passwordIterations, issueAccessToken, verifyJwt,
  hashRefreshToken, setRefreshCookie, clearRefreshCookie, constantTimeEqual,
} from '../middleware/auth';
import { loginRateLimit, refreshRateLimit } from '../middleware/rateLimit';
import { writeAudit } from '../middleware/audit';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono<{ Bindings: Env }>();

// Anyone who can reach a fresh deployment could otherwise claim it, so creating the first
// owner needs SETUP_TOKEN (a secret set with `wrangler secret put`). Local dev may skip it.
const setupTokenRequired = (env: Env) => env.ENVIRONMENT !== 'local' || !!env.SETUP_TOKEN;

auth.get('/setup/status', async (c) => {
  const count = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM users')
    .first<{ n: number }>();
  return c.json({ setupRequired: (count?.n ?? 0) === 0, setupTokenRequired: setupTokenRequired(c.env) });
});

auth.post('/setup', loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name:       z.string().min(1),
    email:      z.string().email(),
    password:   z.string().min(8),
    setupToken: z.string().optional(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  if (setupTokenRequired(c.env)) {
    if (!c.env.SETUP_TOKEN) {
      return c.json({ error: 'Setup is disabled until SETUP_TOKEN is configured on the server' }, 403);
    }
    if (!constantTimeEqual(parsed.data.setupToken ?? '', c.env.SETUP_TOKEN)) {
      return c.json({ error: 'Invalid setup token' }, 403);
    }
  }

  // The NOT EXISTS makes this atomic: two concurrent setups can't both create an owner
  const hash = await hashPassword(parsed.data.password, passwordIterations(c.env));
  const id = crypto.randomUUID();
  const inserted = await c.env.DB.prepare(`
    INSERT INTO users (id, email, name, role, password_hash)
    SELECT ?, ?, ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM users)
  `).bind(id, parsed.data.email.toLowerCase(), parsed.data.name, hash).run();
  if (!inserted.meta.changes) return c.json({ error: 'Setup already completed' }, 403);

  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const refreshHash = await hashRefreshToken(raw);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)'
  ).bind(id, refreshHash, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()).run();

  const accessToken = await issueAccessToken(id, parsed.data.email.toLowerCase(), 'owner', c.env.JWT_SECRET);
  setRefreshCookie(c, raw);
  return c.json({ accessToken, role: 'owner' }, 201);
});

auth.post('/login', loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    email:    z.string().email(),
    password: z.string().min(1),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid credentials' }, 401);

  const user = await c.env.DB
    .prepare('SELECT id, email, role, password_hash FROM users WHERE email = ? AND is_active = 1')
    .bind(parsed.data.email.toLowerCase())
    .first<{ id: string; email: string; role: string; password_hash: string }>();

  const iterations = passwordIterations(c.env);
  const check = user
    ? await verifyPassword(parsed.data.password, user.password_hash, iterations)
    : { valid: false, needsRehash: false };
  if (!user || !check.valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  if (check.needsRehash) {
    await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(await hashPassword(parsed.data.password, iterations), user.id).run();
  }

  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const refreshHash = await hashRefreshToken(raw);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?,?,?,?,?)'
  ).bind(
    user.id, refreshHash,
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    c.req.header('CF-Connecting-IP') ?? null,
    c.req.header('User-Agent') ?? null
  ).run();

  const accessToken = await issueAccessToken(user.id, user.email, user.role, c.env.JWT_SECRET);
  setRefreshCookie(c, raw);

  await writeAudit(c.env, {
    userId: user.id, action: 'auth.login',
    resourceType: 'user', resourceId: user.id,
    ipAddress: c.req.header('CF-Connecting-IP'),
  });

  return c.json({ accessToken, role: user.role });
});

auth.post('/refresh', refreshRateLimit, async (c) => {
  const raw = getCookie(c, 'refresh_token');
  if (!raw) return c.json({ error: 'No refresh token' }, 401);

  const refreshHash = await hashRefreshToken(raw);
  const row = await c.env.DB.prepare(`
    SELECT rt.id, rt.expires_at, rt.revoked,
           u.id as uid, u.email, u.role, u.is_active
    FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
    WHERE rt.token_hash = ?
  `).bind(refreshHash)
    .first<{ id: string; expires_at: string; revoked: number; uid: string; email: string; role: string; is_active: number }>();

  if (!row || row.revoked || !row.is_active) return c.json({ error: 'Invalid token' }, 401);
  if (new Date(row.expires_at) < new Date()) return c.json({ error: 'Token expired' }, 401);

  const accessToken = await issueAccessToken(row.uid, row.email, row.role, c.env.JWT_SECRET);
  return c.json({ accessToken, role: row.role });
});

auth.post('/logout', async (c) => {
  const raw = getCookie(c, 'refresh_token');
  if (raw) {
    const refreshHash = await hashRefreshToken(raw);
    await c.env.DB.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?')
      .bind(refreshHash).run();
  }
  clearRefreshCookie(c);

  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer ') && !authorization.startsWith('Bearer ak_')) {
    const payload = authorization.slice(7).split('.')[1];
    if (payload) {
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).catch?.(() => null);
      if (decoded?.sub) {
        await writeAudit(c.env, {
          userId: decoded.sub, action: 'auth.logout',
          resourceType: 'user', resourceId: decoded.sub,
          ipAddress: c.req.header('CF-Connecting-IP'),
        });
      }
    }
  }

  return c.json({ ok: true });
});

// API Keys (owner only)
auth.get('/api-keys', authMiddleware, async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    'SELECT id, name, last_used, expires_at, is_active, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return c.json(rows.results);
});

auth.post('/api-keys', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name:      z.string().min(1),
    expiresAt: z.string().datetime().optional(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const user = c.get('user');
  const rawKey = `ak_${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(rawKey + c.env.API_KEY_SALT)
  );
  const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, name, key_hash, expires_at) VALUES (?,?,?,?,?)'
  ).bind(id, user.id, parsed.data.name, keyHash, parsed.data.expiresAt ?? null).run();

  return c.json({ id, name: parsed.data.name, key: rawKey }, 201);
});

auth.delete('/api-keys/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id).run();
  return c.json({ ok: true });
});

export default auth;
