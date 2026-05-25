import type { Context, Next } from 'hono';
import type { UserRole } from '../types';

export const requireRole = (...roles: UserRole[]) =>
  async (c: Context, next: Next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  };
