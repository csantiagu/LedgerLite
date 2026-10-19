import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Env } from '../types';
import type { Context } from 'hono';
import {
  hashPassword, verifyPassword, passwordIterations, issueAccessToken,
  hashRefreshToken, setRefreshCookie, clearRefreshCookie, constantTimeEqual, SESSION_DAYS,
  newPasswordSchema, issueMfaToken, verifyMfaToken,
} from '../middleware/auth';
import {
  newTotpSecret, verifyTotp, currentStep, otpauthUri, newRecoveryCodes, hashRecoveryCode,
} from '../services/totp';
import { encryptSecret, decryptSecret } from '../services/secretBox';
import { loginRateLimit, refreshRateLimit } from '../middleware/rateLimit';
import { writeAudit } from '../middleware/audit';
import { authMiddleware, requireSession } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const auth = new Hono<{ Bindings: Env }>();

/** A replaced refresh token may still arrive from another tab that refreshed at the same time. */
const ROTATION_GRACE_SECONDS = 60;

const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');

/** Creates a refresh token (as the httpOnly cookie) and returns a fresh access token. */
async function startSession(c: Context<{ Bindings: Env }>, user: { id: string; email: string; role: string }) {
  const raw = randomToken();
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?,?,?,?,?)'
  ).bind(
    user.id, await hashRefreshToken(raw),
    new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    c.req.header('CF-Connecting-IP') ?? null,
    c.req.header('User-Agent') ?? null,
  ).run();
  setRefreshCookie(c, raw);
  return issueAccessToken(user.id, user.email, user.role, c.env.JWT_SECRET);
}

/** Revokes refresh tokens, access tokens issued before now, and API keys. */
function endAllSessions(env: Env, userId: string) {
  return env.DB.batch([
    env.DB.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').bind(Date.now(), userId),
    env.DB.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0').bind(userId),
    env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE user_id = ?').bind(userId),
  ]);
}

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
    password:   newPasswordSchema,
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

  const accessToken = await startSession(c, { id, email: parsed.data.email.toLowerCase(), role: 'owner' });
  return c.json({ accessToken, role: 'owner' }, 201);
});

auth.post('/login', loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    email:    z.string().email(),
    password: z.string().min(1).max(256),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid credentials' }, 401);

  const user = await c.env.DB
    .prepare('SELECT id, email, role, password_hash, totp_secret FROM users WHERE email = ? AND is_active = 1')
    .bind(parsed.data.email.toLowerCase())
    .first<{ id: string; email: string; role: string; password_hash: string; totp_secret: string | null }>();

  const iterations = passwordIterations(c.env);
  // For an unknown email, still spend the time of a password check, so response times
  // don't reveal which email addresses have accounts
  const check = user
    ? await verifyPassword(parsed.data.password, user.password_hash, iterations)
    : (await hashPassword(parsed.data.password, iterations), { valid: false, needsRehash: false });
  if (!user || !check.valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  if (check.needsRehash) {
    await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(await hashPassword(parsed.data.password, iterations), user.id).run();
  }

  // With two-factor on, the password only earns a short-lived token to trade for a session
  // at /auth/login/2fa together with a code
  if (user.totp_secret) {
    return c.json({ mfaRequired: true, mfaToken: await issueMfaToken(user.id, c.env.JWT_SECRET) });
  }

  const accessToken = await startSession(c, user);
  await writeAudit(c.env, {
    userId: user.id, action: 'auth.login',
    resourceType: 'user', resourceId: user.id,
    ipAddress: c.req.header('CF-Connecting-IP'),
  });
  return c.json({ accessToken, role: user.role });
});

/**
 * Checks a 6-digit authenticator code, or failing that a recovery code (which is then used
 * up). Each authenticator code works once: the step it matched is recorded atomically.
 */
async function checkSecondFactor(env: Env, userId: string, sealedSecret: string, lastStep: number, code: string) {
  const trimmed = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(trimmed)) {
    const step = await verifyTotp(await decryptSecret(sealedSecret, env.ENCRYPTION_KEY), trimmed, lastStep);
    if (step === null) return null;
    const claimed = await env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?')
      .bind(step, userId, step).run();
    return claimed.meta.changes ? 'totp' as const : null;
  }
  const used = await env.DB.prepare(
    `UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`
  ).bind(userId, await hashRecoveryCode(userId, trimmed)).run();
  return used.meta.changes ? 'recovery_code' as const : null;
}

auth.post('/login/2fa', loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ mfaToken: z.string().max(2000), code: z.string().min(1).max(32) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid code' }, 401);

  const userId = await verifyMfaToken(parsed.data.mfaToken, c.env.JWT_SECRET);
  if (!userId) return c.json({ error: 'Sign-in expired, start again' }, 401);

  // Also limit per account, so guesses can't be spread across many IP addresses
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: `2fa:${userId}` });
  if (!success) return c.json({ error: 'Too many requests' }, 429);

  const user = await c.env.DB.prepare(
    'SELECT id, email, role, totp_secret, totp_last_step FROM users WHERE id = ? AND is_active = 1'
  ).bind(userId).first<{ id: string; email: string; role: string; totp_secret: string | null; totp_last_step: number }>();
  if (!user?.totp_secret) return c.json({ error: 'Sign-in expired, start again' }, 401);

  const method = await checkSecondFactor(c.env, user.id, user.totp_secret, user.totp_last_step, parsed.data.code);
  if (!method) return c.json({ error: 'Invalid code' }, 401);

  const accessToken = await startSession(c, user);
  await writeAudit(c.env, {
    userId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id,
    newValues: { secondFactor: method },
    ipAddress: c.req.header('CF-Connecting-IP'),
  });
  return c.json({ accessToken, role: user.role });
});

auth.post('/refresh', refreshRateLimit, async (c) => {
  const raw = getCookie(c, 'refresh_token');
  if (!raw) return c.json({ error: 'No refresh token' }, 401);

  const row = await c.env.DB.prepare(`
    SELECT rt.id, rt.expires_at, rt.revoked,
           CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', rt.replaced_at) AS INTEGER) AS replaced_secs_ago,
           u.id as uid, u.email, u.role, u.is_active
    FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
    WHERE rt.token_hash = ?
  `).bind(await hashRefreshToken(raw)).first<{
    id: string; expires_at: string; revoked: number; replaced_secs_ago: number | null;
    uid: string; email: string; role: string; is_active: number;
  }>();

  if (!row || !row.is_active) return c.json({ error: 'Invalid token' }, 401);
  const user = { id: row.uid, email: row.email, role: row.role };

  if (row.revoked) {
    if (row.replaced_secs_ago === null) return c.json({ error: 'Invalid token' }, 401); // signed out
    if (row.replaced_secs_ago <= ROTATION_GRACE_SECONDS) {
      // Rotated a moment ago: another tab refreshing at the same time, or a response that never
      // reached the browser (aborted request, dropped connection). Either way the browser may
      // still only hold this cookie, so give it a fresh one rather than strand it.
      return c.json({ accessToken: await startSession(c, user), role: user.role });
    }
    // A token that was replaced a while ago is being reused: someone has a copy of it
    await endAllSessions(c.env, user.id);
    await writeAudit(c.env, {
      userId: user.id, action: 'auth.refresh_reuse', resourceType: 'user', resourceId: user.id,
      ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
    });
    clearRefreshCookie(c);
    return c.json({ error: 'Invalid token' }, 401);
  }
  if (new Date(row.expires_at) < new Date()) return c.json({ error: 'Token expired' }, 401);

  // Rotate. If a concurrent request marked it replaced first, this one still gets its own
  // fresh session, as in the grace window above.
  await c.env.DB.prepare(
    `UPDATE refresh_tokens SET revoked = 1, replaced_at = datetime('now') WHERE id = ? AND revoked = 0`
  ).bind(row.id).run();
  return c.json({ accessToken: await startSession(c, user), role: user.role });
});

// Rate limited per user, so a stolen access token can't be used to guess the current password
auth.post('/change-password', authMiddleware, requireSession, loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword:     newPasswordSchema,
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);

  const me = c.get('user');
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(me.id).first<{ password_hash: string }>();
  const iterations = passwordIterations(c.env);
  if (!row || !(await verifyPassword(parsed.data.currentPassword, row.password_hash, iterations)).valid) {
    return c.json({ error: 'Current password is incorrect' }, 403);
  }

  // Sign out every other browser, then start a fresh session for this one
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(await hashPassword(parsed.data.newPassword, iterations), me.id).run();
  await endAllSessions(c.env, me.id);
  await writeAudit(c.env, {
    userId: me.id, action: 'auth.password_changed', resourceType: 'user', resourceId: me.id,
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ accessToken: await startSession(c, me), role: me.role });
});

auth.post('/logout-all', authMiddleware, requireSession, async (c) => {
  const me = c.get('user');
  await endAllSessions(c.env, me.id);
  clearRefreshCookie(c);
  await writeAudit(c.env, {
    userId: me.id, action: 'auth.logout_all', resourceType: 'user', resourceId: me.id,
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  // The user comes from the refresh token being revoked, never from an unverified JWT
  const raw = getCookie(c, 'refresh_token');
  const revoked = raw
    ? await c.env.DB.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0 RETURNING user_id')
        .bind(await hashRefreshToken(raw)).first<{ user_id: string }>()
    : null;
  clearRefreshCookie(c);

  if (revoked) {
    await writeAudit(c.env, {
      userId: revoked.user_id, action: 'auth.logout',
      resourceType: 'user', resourceId: revoked.user_id,
      ipAddress: c.req.header('CF-Connecting-IP'),
    });
  }
  return c.json({ ok: true });
});

// ── Two-factor management (signed-in session only) ─────────────────────────
auth.use('/2fa', authMiddleware, requireSession);
auth.use('/2fa/*', authMiddleware, requireSession);

async function storeRecoveryCodes(env: Env, userId: string) {
  const codes = newRecoveryCodes();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    ...await Promise.all(codes.map(async code =>
      env.DB.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').bind(userId, await hashRecoveryCode(userId, code))
    )),
  ]);
  return codes;
}

auth.get('/2fa', async (c) => {
  const row = await c.env.DB.prepare(`
    SELECT totp_secret IS NOT NULL AS enabled,
           (SELECT COUNT(*) FROM recovery_codes WHERE user_id = users.id AND used_at IS NULL) AS recovery_codes_left
    FROM users WHERE id = ?
  `).bind(c.get('user').id).first<{ enabled: number; recovery_codes_left: number }>();
  return c.json({ enabled: !!row?.enabled, recoveryCodesLeft: row?.recovery_codes_left ?? 0 });
});

// Step 1: a new secret for the authenticator app, kept as pending until a code confirms it
auth.post('/2fa/setup', async (c) => {
  const me = c.get('user');
  const row = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(me.id).first<{ totp_secret: string | null }>();
  if (row?.totp_secret) return c.json({ error: 'Two-factor sign-in is already on' }, 409);

  const secret = newTotpSecret();
  await c.env.DB.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?')
    .bind(await encryptSecret(secret, c.env.ENCRYPTION_KEY), me.id).run();
  return c.json({ secret, otpauthUri: otpauthUri(secret, me.email) });
});

// Step 2: the first code proves the app is set up. Other sessions signed in without 2FA end.
auth.post('/2fa/enable', loginRateLimit, async (c) => {
  const parsed = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Enter the 6-digit code' }, 400);

  const me = c.get('user');
  const row = await c.env.DB.prepare('SELECT totp_secret, totp_pending_secret FROM users WHERE id = ?')
    .bind(me.id).first<{ totp_secret: string | null; totp_pending_secret: string | null }>();
  if (row?.totp_secret) return c.json({ error: 'Two-factor sign-in is already on' }, 409);
  if (!row?.totp_pending_secret) return c.json({ error: 'Start the setup again' }, 409);

  const secret = await decryptSecret(row.totp_pending_secret, c.env.ENCRYPTION_KEY);
  const step = await verifyTotp(secret, parsed.data.code, 0);
  if (step === null) return c.json({ error: 'That code is not right; check the time on your phone and try again' }, 400);

  await c.env.DB.prepare(
    'UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ? WHERE id = ?'
  ).bind(step, me.id).run();
  const recoveryCodes = await storeRecoveryCodes(c.env, me.id);
  await endAllSessions(c.env, me.id);
  await writeAudit(c.env, {
    userId: me.id, action: 'auth.2fa_enabled', resourceType: 'user', resourceId: me.id,
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ recoveryCodes, accessToken: await startSession(c, me), role: me.role });
});

const passwordAndCode = z.object({ password: z.string().min(1).max(256), code: z.string().min(1).max(32) });

/** Re-checks the password and a second factor before changing 2FA settings. */
async function confirmIdentity(env: Env, userId: string, password: string, code: string) {
  const row = await env.DB.prepare('SELECT password_hash, totp_secret, totp_last_step FROM users WHERE id = ?')
    .bind(userId).first<{ password_hash: string; totp_secret: string | null; totp_last_step: number }>();
  if (!row?.totp_secret) return 'Two-factor sign-in is not on';
  if (!(await verifyPassword(password, row.password_hash, passwordIterations(env))).valid) return 'Password or code is not right';
  if (!(await checkSecondFactor(env, userId, row.totp_secret, row.totp_last_step, code))) return 'Password or code is not right';
  return null;
}

auth.post('/2fa/disable', loginRateLimit, async (c) => {
  const parsed = passwordAndCode.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Enter your password and a code' }, 400);
  const me = c.get('user');
  const problem = await confirmIdentity(c.env, me.id, parsed.data.password, parsed.data.code);
  if (problem) return c.json({ error: problem }, 403);

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = 0 WHERE id = ?').bind(me.id),
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(me.id),
  ]);
  await writeAudit(c.env, {
    userId: me.id, action: 'auth.2fa_disabled', resourceType: 'user', resourceId: me.id,
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ ok: true });
});

auth.post('/2fa/recovery-codes', loginRateLimit, async (c) => {
  const parsed = passwordAndCode.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Enter your password and a code' }, 400);
  const me = c.get('user');
  const problem = await confirmIdentity(c.env, me.id, parsed.data.password, parsed.data.code);
  if (problem) return c.json({ error: problem }, 403);

  const recoveryCodes = await storeRecoveryCodes(c.env, me.id);
  await writeAudit(c.env, {
    userId: me.id, action: 'auth.recovery_codes_regenerated', resourceType: 'user', resourceId: me.id,
    ipAddress: c.req.header('CF-Connecting-IP'),
  });
  return c.json({ recoveryCodes });
});

// API keys: owner only, and managed from a signed-in session (not with another key)
auth.use('/api-keys', authMiddleware, requireSession, requireRole('owner'));
auth.use('/api-keys/*', authMiddleware, requireSession, requireRole('owner'));

auth.get('/api-keys', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    'SELECT id, name, last_used, expires_at, is_active, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return c.json(rows.results);
});

auth.post('/api-keys', async (c) => {
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

auth.delete('/api-keys/:id', async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id).run();
  return c.json({ ok: true });
});

export default auth;
