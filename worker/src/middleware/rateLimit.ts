import type { Context, Next } from 'hono';
import type { Env } from '../types';

interface RateLimitConfig { limit: number; windowSeconds: number; }

export const rateLimit = (config: RateLimitConfig) =>
  async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const windowKey = Math.floor(Date.now() / (config.windowSeconds * 1000));
    const kvKey = `ratelimit:${ip}:${windowKey}`;

    const current = Number(await c.env.KV.get(kvKey) ?? '0');
    if (current >= config.limit) return c.json({ error: 'Too many requests' }, 429);

    await c.env.KV.put(kvKey, String(current + 1), {
      expirationTtl: config.windowSeconds * 2,
    });
    return next();
  };

export const loginRateLimit   = rateLimit({ limit: 5,   windowSeconds: 60 });
export const refreshRateLimit = rateLimit({ limit: 20,  windowSeconds: 60 });
export const apiRateLimit     = rateLimit({ limit: 200, windowSeconds: 60 });
