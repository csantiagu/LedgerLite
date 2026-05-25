import type { Context, Next } from 'hono';
import type { Env } from '../types';

export async function csrfMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  if (c.req.header('X-Requested-With') !== 'XMLHttpRequest') {
    return c.json({ error: 'CSRF check failed' }, 403);
  }
  return next();
}
