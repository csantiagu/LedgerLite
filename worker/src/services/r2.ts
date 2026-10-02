import type { R2Bucket } from '@cloudflare/workers-types';
import type { Context } from 'hono';
import type { Env } from '../types';
import { fileResponse } from './files';

export async function uploadToR2(
  r2: R2Bucket,
  key: string,
  data: ArrayBuffer,
  contentType: string
): Promise<void> {
  await r2.put(key, data, { httpMetadata: { contentType } });
}

export async function getFileResponse(
  c: Context<{ Bindings: Env }>,
  key: string,
  filename: string
): Promise<Response> {
  const object = await c.env.R2.get(key);
  if (!object) return c.json({ error: 'File not found' }, 404);

  return fileResponse(object.body, object.httpMetadata?.contentType, filename);
}

export async function getSignedUrl(
  r2: R2Bucket,
  key: string,
  expiresInSeconds = 900
): Promise<string | null> {
  const signer = r2 as unknown as {
    createPresignedUrl?: (k: string, options?: { expiresIn?: number; method?: string }) => Promise<string>;
  };
  if (!signer.createPresignedUrl) return null;
  return signer.createPresignedUrl(key, { expiresIn: expiresInSeconds, method: 'GET' });
}
