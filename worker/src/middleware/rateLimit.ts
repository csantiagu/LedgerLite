import type { Context, Next } from 'hono';
import type { Env } from '../types';

type LimiterBinding = 'LOGIN_LIMITER' | 'REFRESH_LIMITER' | 'API_LIMITER';

// Limits and periods are configured on the bindings in wrangler.toml.
// Authenticated routes are keyed per user, everything else per client IP.
export const rateLimit = (binding: LimiterBinding) =>
  async (c: Context<{ Bindings: Env }>, next: Next) => {
    const userId = c.get('user')?.id;
    const key = userId ? `user:${userId}` : `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
    const { success } = await c.env[binding].limit({ key });
    if (!success) return c.json({ error: 'Too many requests' }, 429);
    return next();
  };

export const loginRateLimit   = rateLimit('LOGIN_LIMITER');   // 5/min per IP
export const refreshRateLimit = rateLimit('REFRESH_LIMITER'); // 20/min per IP
export const apiRateLimit     = rateLimit('API_LIMITER');     // 200/min per user
