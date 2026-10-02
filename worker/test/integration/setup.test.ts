import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/index';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
let ip = 0;

function setup(body: Record<string, unknown>, e: typeof env = env) {
  return app.fetch(new Request('http://api.test/auth/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      'CF-Connecting-IP': `10.2.0.${++ip}`,
    },
    body: JSON.stringify({ name: 'Owner', email: `owner${ip}@test.local`, password: 'a-long-enough-password', ...body }),
  }), e, ctx);
}

const owners = async () =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM refresh_tokens').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('first-owner setup', () => {
  it('reports that a setup token is required', async () => {
    const res = await app.fetch(new Request('http://api.test/auth/setup/status'), env, ctx);
    expect(await res.json()).toEqual({ setupRequired: true, setupTokenRequired: true });
  });

  it('rejects a missing or wrong setup token', async () => {
    expect((await setup({})).status).toBe(403);
    expect((await setup({ setupToken: 'wrong' })).status).toBe(403);
    expect(await owners()).toBe(0);
  });

  it('creates the owner with the right token, then refuses a second setup', async () => {
    expect((await setup({ setupToken: env.SETUP_TOKEN })).status).toBe(201);
    expect((await setup({ setupToken: env.SETUP_TOKEN })).status).toBe(403);
    expect(await owners()).toBe(1);
  });

  it('creates exactly one owner when two setups race', async () => {
    const results = await Promise.all([setup({ setupToken: env.SETUP_TOKEN }), setup({ setupToken: env.SETUP_TOKEN })]);
    expect(results.map(r => r.status).sort()).toEqual([201, 403]);
    expect(await owners()).toBe(1);
  });

  it('is disabled outside local dev when no SETUP_TOKEN is configured', async () => {
    const res = await setup({}, { ...env, SETUP_TOKEN: undefined });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/SETUP_TOKEN/) });
  });

  it('needs no token in local dev when none is configured', async () => {
    const res = await setup({}, { ...env, ENVIRONMENT: 'local', SETUP_TOKEN: undefined });
    expect(res.status).toBe(201);
  });
});
