// Uploaded files are checked by their content, not the type or name the browser claims, and
// are only ever served back with one of these types. That matters because the frontend opens
// attachments as blob: URLs on its own origin, where an HTML or SVG file could run script.

export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const IMAGE_TYPES    = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SafeType = (typeof DOCUMENT_TYPES)[number];

const EXTENSIONS: Record<SafeType, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (s: string) => [...s].map(ch => ch.charCodeAt(0));

/** The file's real type from its first bytes, or null if it isn't a PDF, PNG, JPEG or WebP. */
export function sniffType(bytes: Uint8Array): SafeType | null {
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

type Checked =
  | { ok: true; bytes: ArrayBuffer; type: SafeType; ext: string; name: string }
  | { ok: false; error: string };

/** Validates an uploaded form field against the allowed types and a size limit. */
export async function checkUpload(
  entry: unknown, allowed: readonly SafeType[], maxBytes: number
): Promise<Checked> {
  if (!(entry instanceof File)) return { ok: false, error: 'No file provided' };
  const file = entry;
  if (file.size > maxBytes) return { ok: false, error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)` };
  const bytes = await file.arrayBuffer();
  const type = sniffType(new Uint8Array(bytes.slice(0, 16)));
  if (!type || !allowed.includes(type)) {
    const names = allowed.map(t => EXTENSIONS[t].toUpperCase()).join(', ');
    return { ok: false, error: `Only ${names} files are allowed` };
  }
  return { ok: true, bytes, type, ext: EXTENSIONS[type], name: cleanFilename(file.name) };
}

/** A display name that is safe to store and to put in a Content-Disposition header. */
export function cleanFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 150);
  return cleaned || 'file';
}

/**
 * Streams a stored file as a download. The type is only passed through if it is on the
 * allowlist, and the sandbox CSP stops anything rendered from this response running script.
 */
export function fileResponse(body: ReadableStream | ArrayBuffer | Uint8Array, storedType: string | undefined, filename: string) {
  const type = (DOCUMENT_TYPES as readonly string[]).includes(storedType ?? '') ? storedType! : 'application/octet-stream';
  const name = cleanFilename(filename);
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_');
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
