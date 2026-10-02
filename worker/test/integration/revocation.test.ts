import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { hashPassword, issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ip = 0;

function call(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string } = {}) {
  return app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      'CF-Connecting-IP': `10.3.0.${++ip}`,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), env, ctx);
}

async function createUser(role: 'owner' | 'accountant', password = 'a-long-enough-password') {
  const id = uid();
  const email = `${id}@test.local`;
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', ?, ?)`)
    .bind(id, email, role, await hashPassword(password, 1000)).run();
  return { id, email, token: await issueAccessToken(id, email, role, env.JWT_SECRET) };
}

const refreshCookie = (res: Response) => res.headers.get('Set-Cookie')!.split(';')[0];

let owner: Awaited<ReturnType<typeof createUser>>;
beforeAll(async () => { owner = await createUser('owner'); });

describe('deactivating a user', () => {
  it('cuts off their access token, refresh token and API keys immediately', async () => {
    const acc = await createUser('accountant');
    const login = await call('POST', '/auth/login', { body: { email: acc.email, password: 'a-long-enough-password' } });
    expect(login.status).toBe(200);
    const { accessToken } = await login.json() as { accessToken: string };
    const cookie = refreshCookie(login);
    await env.DB.prepare(`INSERT INTO api_keys (user_id, name, key_hash) VALUES (?, 'k', ?)`)
      .bind(acc.id, 'unused-hash').run();

    expect((await call('GET', '/api/v1/expense-categories', { token: accessToken })).status).toBe(200);

    expect((await call('PATCH', `/api/v1/users/${acc.id}`, { token: owner.token, body: { is_active: false } })).status).toBe(200);

    expect((await call('GET', '/api/v1/expense-categories', { token: accessToken })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie })).status).toBe(401);
    const keys = await env.DB.prepare('SELECT is_active FROM api_keys WHERE user_id = ?').bind(acc.id).all();
    expect(keys.results).toEqual([{ is_active: 0 }]);
  });

  it('uses the role from the database, not the one in the token', async () => {
    const acc = await createUser('accountant');
    const forged = await issueAccessToken(acc.id, acc.email, 'owner', env.JWT_SECRET);
    // Only owners may list API keys / create users; the stale "owner" claim must not count
    const res = await call('POST', '/api/v1/users', {
      token: forged, body: { name: 'X', email: `${uid()}@test.local`, password: 'a-long-enough-password', role: 'accountant' },
    });
    expect(res.status).toBe(403);
  });
});

describe('API keys', () => {
  it('work until their user is deactivated', async () => {
    const o = await createUser('owner');
    const created = await call('POST', '/auth/api-keys', { token: o.token, body: { name: 'script' } });
    expect(created.status).toBe(201);
    const { key } = await created.json() as { key: string };

    expect((await call('GET', '/api/v1/expense-categories', { token: key })).status).toBe(200);
    await env.DB.prepare('UPDATE users SET is_active = 0 WHERE id = ?').bind(o.id).run();
    expect((await call('GET', '/api/v1/expense-categories', { token: key })).status).toBe(401);
  });

  it('cannot be used to create more API keys', async () => {
    const o = await createUser('owner');
    const { key } = await (await call('POST', '/auth/api-keys', { token: o.token, body: { name: 'a' } })).json() as { key: string };
    expect((await call('POST', '/auth/api-keys', { token: key, body: { name: 'b' } })).status).toBe(403);
    expect((await call('GET', '/auth/api-keys', { token: key })).status).toBe(403);
  });

  it('can only be managed by the owner', async () => {
    const acc = await createUser('accountant');
    expect((await call('POST', '/auth/api-keys', { token: acc.token, body: { name: 'a' } })).status).toBe(403);
  });
});
