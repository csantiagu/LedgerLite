import { describe, expect, it } from 'vitest';
import { hashPassword, passwordIterations, verifyPassword } from '../../src/middleware/auth';

// Build a hash in the pre-2026 "pbkdf2:<salt>:<hash>" format
async function legacyHash(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

describe('passwordIterations', () => {
  it('uses the Workers maximum outside local dev', () => {
    expect(passwordIterations({ ENVIRONMENT: 'production' })).toBe(100_000);
    expect(passwordIterations({ ENVIRONMENT: 'local' })).toBe(1_000);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('records the iteration count in the hash', async () => {
    expect(await hashPassword('correct horse', 1_000)).toMatch(/^pbkdf2-sha256\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same', 1_000)).not.toBe(await hashPassword('same', 1_000));
  });

  it('verifies regardless of the current target iterations', async () => {
    const stored = await hashPassword('correct horse', 1_000);
    expect(await verifyPassword('correct horse', stored, 1_000)).toEqual({ valid: true, needsRehash: false });
    // Created locally, used in production: still valid, flagged for upgrade
    expect(await verifyPassword('correct horse', stored, 100_000)).toEqual({ valid: true, needsRehash: true });
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse', 1_000);
    expect(await verifyPassword('wrong horse', stored, 1_000)).toEqual({ valid: false, needsRehash: false });
  });

  it('accepts legacy hashes made with either iteration count and asks for a rehash', async () => {
    expect(await verifyPassword('pw', await legacyHash('pw', 1_000), 1_000)).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPassword('pw', await legacyHash('pw', 100_000), 1_000)).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPassword('nope', await legacyHash('pw', 1_000), 1_000)).toEqual({ valid: false, needsRehash: false });
  });

  it.each([
    '', 'garbage', 'pbkdf2:zz:abc', 'pbkdf2-sha256$abc$00$00', 'pbkdf2-sha256$0$00$00', 'pbkdf2-sha256$999999$00$00',
  ])('treats malformed hash %j as invalid', async (stored) => {
    expect(await verifyPassword('pw', stored, 1_000)).toEqual({ valid: false, needsRehash: false });
  });
});
