// AES-256-GCM encryption for small secrets stored in D1 (TOTP seeds), keyed by the
// ENCRYPTION_KEY Worker secret. Someone with a copy of the database alone can't read them.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

async function keyFrom(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(secret), new TextEncoder().encode(plaintext));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(sealed: string, secret: string): Promise<string> {
  const [version, iv, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !ct) throw new Error('Unknown secret format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFrom(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
