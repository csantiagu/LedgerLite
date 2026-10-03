import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import app from '../../src/index';
import { hashPassword, issueMfaToken } from '../../src/middleware/auth';
import { currentStep, totpAt } from '../../src/services/totp';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
const PASSWORD = 'first-password-123';
let ip = 0;

async function call(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string } = {}) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      'CF-Connecting-IP': `10.5.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), env, ctx);
  return { status: res.status, body: await res.json() as Record<string, any>, cookie: res.headers.get('Set-Cookie')?.split(';')[0] };
}

/** A signed-in user with two-factor turned on. */
async function userWith2fa() {
  const id = uid();
  const email = `${id}@test.local`;
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', 'owner', ?)`)
    .bind(id, email, await hashPassword(PASSWORD, 1000)).run();
  const login = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  const token = login.body.accessToken as string;

  const setup = await call('POST', '/auth/2fa/setup', { token });
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/LedgerLite/);
  const secret = setup.body.secret as string;

  const enabled = await call('POST', '/auth/2fa/enable', { token, body: { code: await totpAt(secret, currentStep()) } });
  expect(enabled.status).toBe(200);
  return {
    id, email, secret, oldToken: token, oldCookie: login.cookie!,
    token: enabled.body.accessToken as string, recoveryCodes: enabled.body.recoveryCodes as string[],
  };
}

/** Steps 0 and +1 are both inside the window; the enable call already used step 0. */
const nextCode = (secret: string, offset = 1) => totpAt(secret, currentStep() + offset);

describe('turning two-factor on', () => {
  it('needs a correct code, stores the secret encrypted and returns 10 recovery codes', async () => {
    const u = await userWith2fa();
    expect(u.recoveryCodes).toHaveLength(10);
    const row = await env.DB.prepare('SELECT totp_secret, totp_pending_secret FROM users WHERE id = ?').bind(u.id).first<Record<string, string | null>>();
    expect(row?.totp_secret).toMatch(/^v1\./);
    expect(row?.totp_secret).not.toContain(u.secret);
    expect(row?.totp_pending_secret).toBeNull();
    expect((await call('GET', '/auth/2fa', { token: u.token })).body).toEqual({ enabled: true, recoveryCodesLeft: 10 });
  });

  it('rejects a wrong code', async () => {
    const id = uid();
    await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', 'owner', ?)`)
      .bind(id, `${id}@test.local`, await hashPassword(PASSWORD, 1000)).run();
    const { body } = await call('POST', '/auth/login', { body: { email: `${id}@test.local`, password: PASSWORD } });
    await call('POST', '/auth/2fa/setup', { token: body.accessToken });
    expect((await call('POST', '/auth/2fa/enable', { token: body.accessToken, body: { code: '000000' } })).status).toBe(400);
  });

  it('signs out sessions that were started without two-factor', async () => {
    const u = await userWith2fa();
    expect((await call('GET', '/api/v1/expense-categories', { token: u.oldToken })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: u.oldCookie })).status).toBe(401);
    expect((await call('GET', '/api/v1/expense-categories', { token: u.token })).status).toBe(200);
  });
});

describe('signing in with two-factor', () => {
  it('asks for a code after the password, and the interim token is not an access token', async () => {
    const u = await userWith2fa();
    const login = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(login.cookie).toBeUndefined();
    expect((await call('GET', '/api/v1/expense-categories', { token: login.body.mfaToken })).status).toBe(401);
  });

  it('accepts an authenticator code once', async () => {
    const u = await userWith2fa();
    const { body } = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    const code = await nextCode(u.secret);

    const ok = await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code } });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^refresh_token=/);
    expect((await call('GET', '/api/v1/expense-categories', { token: ok.body.accessToken })).status).toBe(200);

    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code } })).status).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const u = await userWith2fa();
    const { body } = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    const code = u.recoveryCodes[3].toLowerCase();
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code } })).status).toBe(200);
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code } })).status).toBe(401);
    expect((await call('GET', '/auth/2fa', { token: u.token })).body.recoveryCodesLeft).toBe(9);
  });

  it('rejects wrong codes, forged interim tokens and access tokens used as interim tokens', async () => {
    const u = await userWith2fa();
    const { body } = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code: '123456' } })).status).toBe(401);
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: u.token, code: await nextCode(u.secret) } })).status).toBe(401);
    const forged = await issueMfaToken(u.id, 'some-other-secret-that-is-32-chars-long');
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: forged, code: await nextCode(u.secret) } })).status).toBe(401);
  });
});

describe('changing two-factor settings', () => {
  it('needs the password and a code to turn it off', async () => {
    const u = await userWith2fa();
    expect((await call('POST', '/auth/2fa/disable', { token: u.token, body: { password: 'wrong', code: await nextCode(u.secret) } })).status).toBe(403);
    expect((await call('POST', '/auth/2fa/disable', { token: u.token, body: { password: PASSWORD, code: '000000' } })).status).toBe(403);
    expect((await call('POST', '/auth/2fa/disable', { token: u.token, body: { password: PASSWORD, code: u.recoveryCodes[0] } })).status).toBe(200);

    expect((await call('GET', '/auth/2fa', { token: u.token })).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    const login = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    expect(login.body.accessToken).toEqual(expect.any(String));
  });

  it('replaces the recovery codes', async () => {
    const u = await userWith2fa();
    const res = await call('POST', '/auth/2fa/recovery-codes', { token: u.token, body: { password: PASSWORD, code: await nextCode(u.secret) } });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    const { body } = await call('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code: u.recoveryCodes[1] } })).status).toBe(401);
    expect((await call('POST', '/auth/login/2fa', { body: { mfaToken: body.mfaToken, code: res.body.recoveryCodes[1] } })).status).toBe(200);
  });

  it('cannot be managed with an API key', async () => {
    const u = await userWith2fa();
    const { body } = await call('POST', '/auth/api-keys', { token: u.token, body: { name: 'k' } });
    expect((await call('GET', '/auth/2fa', { token: body.key })).status).toBe(403);
  });
});
