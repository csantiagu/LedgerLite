// Time-based one-time passwords (RFC 6238) as used by Google Authenticator, 1Password, etc:
// HMAC-SHA1, 6 digits, 30-second steps.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new random 160-bit secret, base32-encoded for authenticator apps. */
export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

export async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32));
  counter.setUint32(4, step >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Checks a code against the current step and one step either side (allowing for clock
 * drift). Steps at or before lastUsedStep are refused so a code can't be replayed.
 * Returns the matching step, or null.
 */
export async function verifyTotp(secret: string, code: string, lastUsedStep: number, nowMs = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    // Check every candidate so timing doesn't reveal which step matched
    const expected = await totpAt(secret, step);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && step > lastUsedStep) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: string, account: string, issuer = 'LedgerLite'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** Ten single-use recovery codes like "7KQ2M-X4PZB" (50 random bits each). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const code = base32Encode(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10);
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/**
 * Recovery codes are stored hashed, per user, ignoring case and dashes. 0, 1 and 8 aren't in
 * the alphabet, so they're read as the letters people mistake them for.
 */
export async function hashRecoveryCode(userId: string, code: string): Promise<string> {
  const normalised = code.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${normalised}`));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
