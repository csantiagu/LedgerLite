import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hashRecoveryCode, newRecoveryCodes, totpAt, verifyTotp } from '../../src/services/totp';
import { decryptSecret, encryptSecret } from '../../src/services/secretBox';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" (SHA-1)
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('TOTP', () => {
  it('round-trips base32', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe('12345678901234567890');
  });

  it('matches the RFC 6238 test vectors (last 6 digits)', async () => {
    expect(await totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(await totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(await totpAt(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
    expect(await totpAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of clock drift either way, and nothing older than the last used step', async () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(await verifyTotp(RFC_SECRET, await totpAt(RFC_SECRET, step - 1), 0, now)).toBe(step - 1);
    expect(await verifyTotp(RFC_SECRET, await totpAt(RFC_SECRET, step + 1), 0, now)).toBe(step + 1);
    expect(await verifyTotp(RFC_SECRET, await totpAt(RFC_SECRET, step - 2), 0, now)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, await totpAt(RFC_SECRET, step), step, now)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, 'abcdef', 0, now)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('are ten distinct XXXXX-XXXXX codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('hash the same regardless of case and dashes, but differently per user', async () => {
    expect(await hashRecoveryCode('u1', 'abcde-fghij')).toBe(await hashRecoveryCode('u1', 'ABCDEFGHIJ'));
    expect(await hashRecoveryCode('u1', 'B0B1D-22222')).toBe(await hashRecoveryCode('u1', 'BOBID-22222'));
    expect(await hashRecoveryCode('u1', 'ABCDE-FGHIJ')).not.toBe(await hashRecoveryCode('u2', 'ABCDE-FGHIJ'));
  });
});

describe('secretBox', () => {
  it('encrypts with a random IV and decrypts with the same key only', async () => {
    const a = await encryptSecret('JBSWY3DPEHPK3PXP', 'k'.repeat(32));
    const b = await encryptSecret('JBSWY3DPEHPK3PXP', 'k'.repeat(32));
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await decryptSecret(a, 'k'.repeat(32))).toBe('JBSWY3DPEHPK3PXP');
    await expect(decryptSecret(a, 'x'.repeat(32))).rejects.toThrow();
  });
});
