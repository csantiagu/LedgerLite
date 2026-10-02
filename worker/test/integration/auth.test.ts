import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import app from '../../src/index';
import { hashPassword, issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...headers },
    body: JSON.stringify(body),
  }), env, ctx);
}

async function createUser(passwordHash: string, role = 'owner') {
  const id = uid();
  const email = `${id}@test.local`;
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', ?, ?)`)
    .bind(id, email, role, passwordHash).run();
  return { id, email };
}

const storedHash = async (id: string) =>
  (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(id).first<{ password_hash: string }>())!.password_hash;

describe('login', () => {
  it('upgrades a legacy password hash on successful login', async () => {
    // Legacy format at 100,000 iterations (what production used before)
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('legacy-pass'), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256));
    const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    const user = await createUser(`pbkdf2:${hex(salt)}:${hex(bits)}`);

    const res = await post('/auth/login', { email: user.email, password: 'legacy-pass' }, { 'CF-Connecting-IP': '10.1.0.1' });
    expect(res.status).toBe(200);
    expect(await storedHash(user.id)).toMatch(/^pbkdf2-sha256\$100000\$/);

    // ...and the upgraded hash still works
    const again = await post('/auth/login', { email: user.email, password: 'legacy-pass' }, { 'CF-Connecting-IP': '10.1.0.2' });
    expect(again.status).toBe(200);
  });

  it('rejects a wrong password without touching the hash', async () => {
    const user = await createUser(await hashPassword('right-pass', 100_000));
    const before = await storedHash(user.id);
    const res = await post('/auth/login', { email: user.email, password: 'wrong-pass' }, { 'CF-Connecting-IP': '10.1.0.3' });
    expect(res.status).toBe(401);
    expect(await storedHash(user.id)).toBe(before);
  });

  it('allows 5 attempts per minute per IP, then returns 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await post('/auth/login', { email: 'nobody@test.local', password: 'x' }, { 'CF-Connecting-IP': '10.9.9.9' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);

    // A different IP is unaffected
    const other = await post('/auth/login', { email: 'nobody@test.local', password: 'x' }, { 'CF-Connecting-IP': '10.9.9.10' });
    expect(other.status).toBe(401);
  });
});

describe('users created by the owner', () => {
  it('can log in (their hash uses the same iteration policy as login)', async () => {
    const owner = await createUser('unused');
    const token = await issueAccessToken(owner.id, owner.email, 'owner', env.JWT_SECRET);
    const email = `${uid()}@test.local`;
    const created = await post('/api/v1/users', { name: 'Acc', email, password: 'accountant-pass', role: 'accountant' },
      { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '10.1.0.4' });
    expect(created.status).toBe(201);

    const login = await post('/auth/login', { email, password: 'accountant-pass' }, { 'CF-Connecting-IP': '10.1.0.5' });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ role: 'accountant' });
  });
});
