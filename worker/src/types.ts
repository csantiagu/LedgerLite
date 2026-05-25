export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  JWT_SECRET: string;
  API_KEY_SALT: string;
  ALLOWED_ORIGIN: string;
  ENVIRONMENT: string;
};

export type UserRole = 'owner' | 'accountant';

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}
