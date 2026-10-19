import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import app from '../../src/index';
import { hashPassword } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ip = 0;

function call(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string } = {}) {
  return app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      'CF-Connecting-IP': `10.4.0.${++ip}`,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), env, ctx);
}

const cookieOf = (res: Response) => res.headers.get('Set-Cookie')?.split(';')[0] ?? null;
const ok = async (token: string) => (await call('GET', '/api/v1/expense-categories', { token })).status;

/** Creates a user and signs in, returning the access token and refresh cookie. */
async function signIn(password = 'first-password-123') {
  const id = uid();
  const email = `${id}@test.local`;
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', 'owner', ?)`)
    .bind(id, email, await hashPassword(password, 1000)).run();
  const res = await call('POST', '/auth/login', { body: { email, password } });
  expect(res.status).toBe(200);
  const { accessToken } = await res.json() as { accessToken: string };
  return { id, email, accessToken, cookie: cookieOf(res)! };
}

describe('refresh token rotation', () => {
  it('issues a new refresh cookie on every refresh', async () => {
    const s = await signIn();
    const res = await call('POST', '/auth/refresh', { cookie: s.cookie });
    expect(res.status).toBe(200);
    const next = cookieOf(res);
    expect(next).toMatch(/^refresh_token=/);
    expect(next).not.toBe(s.cookie);
    expect((await call('POST', '/auth/refresh', { cookie: next! })).status).toBe(200);
  });

  it('lets two tabs refresh with the same cookie at once', async () => {
    const s = await signIn();
    const results = await Promise.all([
      call('POST', '/auth/refresh', { cookie: s.cookie }),
      call('POST', '/auth/refresh', { cookie: s.cookie }),
    ]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
  });

  it('recovers when the rotated cookie never reached the browser', async () => {
    const s = await signIn();
    // The response to this refresh is "lost": the browser keeps the old cookie
    expect((await call('POST', '/auth/refresh', { cookie: s.cookie })).status).toBe(200);

    const retry = await call('POST', '/auth/refresh', { cookie: s.cookie });
    expect(retry.status).toBe(200);
    const fresh = cookieOf(retry)!;
    expect(fresh).toMatch(/^refresh_token=/);

    // Long after the grace window the fresh cookie still works; only the old one is "reused"
    await env.DB.prepare(`UPDATE refresh_tokens SET replaced_at = datetime('now', '-5 minutes') WHERE user_id = ? AND replaced_at IS NOT NULL`)
      .bind(s.id).run();
    expect((await call('POST', '/auth/refresh', { cookie: fresh })).status).toBe(200);
  });

  it('revokes every session when an old refresh token is replayed', async () => {
    const s = await signIn();
    const rotated = await call('POST', '/auth/refresh', { cookie: s.cookie });
    const current = cookieOf(rotated)!;
    // Pretend the rotation happened 5 minutes ago, past the grace window
    await env.DB.prepare(`UPDATE refresh_tokens SET replaced_at = datetime('now', '-5 minutes') WHERE user_id = ? AND replaced_at IS NOT NULL`)
      .bind(s.id).run();

    expect((await call('POST', '/auth/refresh', { cookie: s.cookie })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: current })).status).toBe(401);
    expect(await ok(s.accessToken)).toBe(401);
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'auth.refresh_reuse'`)
      .bind(s.id).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('does not accept a refresh token after logout', async () => {
    const s = await signIn();
    await call('POST', '/auth/logout', { cookie: s.cookie, token: s.accessToken });
    expect((await call('POST', '/auth/refresh', { cookie: s.cookie })).status).toBe(401);
  });

  it('sets a 14-day cookie', async () => {
    const s = await signIn();
    const res = await call('POST', '/auth/refresh', { cookie: s.cookie });
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=1209600/);
    expect(res.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('Set-Cookie')).toMatch(/SameSite=Strict/);
  });
});

describe('changing the password', () => {
  it('needs the current password', async () => {
    const s = await signIn();
    const res = await call('POST', '/auth/change-password', {
      token: s.accessToken, body: { currentPassword: 'wrong-password', newPassword: 'second-password-456' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a short new password', async () => {
    const s = await signIn();
    const res = await call('POST', '/auth/change-password', {
      token: s.accessToken, body: { currentPassword: 'first-password-123', newPassword: 'short' },
    });
    expect(res.status).toBe(400);
  });

  it('signs out every other session and keeps this one signed in', async () => {
    const s = await signIn();
    const other = await call('POST', '/auth/login', { body: { email: s.email, password: 'first-password-123' } });
    const otherCookie = cookieOf(other)!;
    await env.DB.prepare(`INSERT INTO api_keys (user_id, name, key_hash) VALUES (?, 'k', ?)`).bind(s.id, s.id).run();

    const res = await call('POST', '/auth/change-password', {
      token: s.accessToken, body: { currentPassword: 'first-password-123', newPassword: 'second-password-456' },
    });
    expect(res.status).toBe(200);
    const { accessToken } = await res.json() as { accessToken: string };

    expect(await ok(s.accessToken)).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: s.cookie })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: otherCookie })).status).toBe(401);
    expect(await ok(accessToken)).toBe(200);
    expect((await call('POST', '/auth/refresh', { cookie: cookieOf(res)! })).status).toBe(200);

    expect((await call('POST', '/auth/login', { body: { email: s.email, password: 'first-password-123' } })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: s.email, password: 'second-password-456' } })).status).toBe(200);
    const keys = await env.DB.prepare('SELECT is_active FROM api_keys WHERE user_id = ?').bind(s.id).all();
    expect(keys.results).toEqual([{ is_active: 0 }]);
  });
});

describe('signing out everywhere', () => {
  it('ends every session, including this one', async () => {
    const s = await signIn();
    const other = await call('POST', '/auth/login', { body: { email: s.email, password: 'first-password-123' } });
    await env.DB.prepare(`INSERT INTO api_keys (user_id, name, key_hash) VALUES (?, 'k', ?)`).bind(s.id, s.id).run();
    const res = await call('POST', '/auth/logout-all', { token: s.accessToken });
    expect(res.status).toBe(200);
    const keys = await env.DB.prepare('SELECT is_active FROM api_keys WHERE user_id = ?').bind(s.id).all();
    expect(keys.results).toEqual([{ is_active: 0 }]);
    expect(await ok(s.accessToken)).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: s.cookie })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: cookieOf(other)! })).status).toBe(401);
  });
});
